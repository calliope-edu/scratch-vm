/**
 * Calliope Remote — postMessage-only IO class for the calliope-edu Scratch
 * fork's embedded "controller" mode.
 *
 * Drop-in replacement for `io/ble.js` (or `extensions/calliopeMini/ble.js`).
 * Speaks the same API the calliopeMini extension expects (read, write,
 * startNotifications, …) but never touches Web Bluetooth / ScratchLink.
 * All I/O is forwarded to the embedding parent window via postMessage —
 * the parent does the actual BLE/USB work using whatever transport it
 * has.
 *
 * From scratch-vm's perspective the device is "connected" immediately
 * after construction. Real device availability is the host's problem;
 * when there's no device, reads return empty and writes are dropped.
 * This intentionally makes the iframe a stupid puppet — no environment
 * detection, no Scratch-Link socket, no error paths back into scratch-vm
 * that would tear down the connection.
 *
 * Protocol (window.parent receives):
 *   { type: 'calliope.write',       serviceId, characteristicId, message, encoding, withResponse }
 *   { type: 'calliope.read',        serviceId, characteristicId, reqId }
 *   { type: 'calliope.subscribe',   serviceId, characteristicId }
 *   { type: 'calliope.unsubscribe', serviceId, characteristicId }
 *
 * Iframe receives:
 *   { type: 'calliope.readResult', reqId, message, encoding }
 *   { type: 'calliope.notify',     serviceId, characteristicId, message, encoding }
 *
 * Message/encoding follow Scratch's existing extension contract: base64
 * strings. Service / characteristic IDs are full lowercase UUID strings
 * (or the short numeric form the extension already uses).
 */

const SOURCE = 'calliope-scratch-vm';

const isFramed = () =>
    typeof window !== 'undefined' && window.parent && window.parent !== window;

const parentOriginFromSearch = () => {
    if (typeof window === 'undefined') return '*';
    try {
        const params = new URLSearchParams(window.location.search);
        const v = params.get('parentOrigin');
        return v && v.trim() ? v.trim() : '*';
    } catch (_e) {
        return '*';
    }
};

class CalliopeRemote {
    /**
     * Construct a Calliope remote-IO instance. The extension calls this in
     * place of `new BLE(...)` / `new WebSerial(...)`. We immediately mark
     * ourselves connected and emit the same lifecycle events the BLE class
     * would, so the rest of the extension's flow is unchanged.
     *
     * @param {Runtime} runtime - the Runtime for sending/receiving GUI update events.
     * @param {string} extensionId - the id of the extension using this socket.
     * @param {object} _peripheralOptions - ignored; the host picks the device.
     * @param {function} connectCallback - run after we report connected.
     * @param {function} resetCallback - run when the host signals a disconnect.
     */
    constructor(runtime, extensionId, _peripheralOptions, connectCallback, resetCallback = null) {
        this._runtime = runtime;
        this._extensionId = extensionId;
        this._connectCallback = connectCallback;
        this._resetCallback = resetCallback;

        this._connected = false;
        this._pendingReads = new Map(); // reqId → {resolve, reject}
        this._notifySubscribers = new Map(); // `${service}|${char}` → callback
        this._nextReqId = 1;

        // Singleton message listener for parent → iframe events. Multiple
        // CalliopeRemote instances share the same listener.
        this._messageHandler = this._onParentMessage.bind(this);
        if (typeof window !== 'undefined') {
            window.addEventListener('message', this._messageHandler);
        }

        // Treat ourselves as connected immediately. The host can be told
        // the real device isn't reachable, but from scratch-vm's POV we're
        // always "online" — that way the user never sees a Reconnect alert
        // and the extension's blocks just run (writes go to /dev/null when
        // there's no device, reads return empty).
        this._connected = true;
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
        // Schedule connectCallback in a microtask so callers that immediately
        // chain on it don't observe a half-initialised instance.
        Promise.resolve().then(() => {
            try {
                this._connectCallback();
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('[calliopeRemote] connectCallback threw', e);
            }
        });
    }

    /** Outbound postMessage to parent. */
    _post(message) {
        if (typeof window === 'undefined' || !isFramed()) return;
        const payload = Object.assign({source: SOURCE}, message);
        try {
            window.parent.postMessage(payload, parentOriginFromSearch());
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[calliopeRemote] postMessage failed', e);
        }
    }

    /** Inbound messages from parent. */
    _onParentMessage(event) {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'calliope.readResult') {
            const pending = this._pendingReads.get(data.reqId);
            if (pending) {
                this._pendingReads.delete(data.reqId);
                pending.resolve({
                    message: data.message || '',
                    encoding: data.encoding || 'base64'
                });
            }
            return;
        }
        if (data.type === 'calliope.notify') {
            const key = `${data.serviceId}|${data.characteristicId}`;
            const cb = this._notifySubscribers.get(key);
            if (cb) {
                try {
                    cb(data.message || '');
                } catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn('[calliopeRemote] notify callback threw', e);
                }
            }
            return;
        }
        if (data.type === 'calliope.disconnect') {
            // Host signalled the device is gone for good. Stay "connected"
            // from scratch-vm's view (no Reconnect alert) but invoke the
            // extension's reset callback so it clears its caches.
            if (this._resetCallback) {
                try {
                    this._resetCallback();
                } catch (e) { /* ignore */ }
            }
            return;
        }
    }

    // ---- Public API matching scratch-vm's BLE class ---------------------

    /**
     * Whether the peripheral is "connected". Always true once constructed
     * — the host manages the real-device state behind the scenes.
     * @return {boolean}
     */
    isConnected() {
        return this._connected;
    }

    /**
     * Read a characteristic. Returns a Promise that resolves with
     * `{message, encoding}`. If the host has no live device the response
     * is an empty base64 string.
     *
     * @param {number|string} serviceId
     * @param {number|string} characteristicId
     * @param {boolean} [optStartNotifications]
     * @param {function} [onCharacteristicChanged]
     */
    read(serviceId, characteristicId, optStartNotifications = false, onCharacteristicChanged = null) {
        if (optStartNotifications) {
            this.startNotifications(serviceId, characteristicId, onCharacteristicChanged);
        }
        const reqId = this._nextReqId++;
        const p = new Promise((resolve, reject) => {
            this._pendingReads.set(reqId, {resolve, reject});
        });
        this._post({
            type: 'calliope.read',
            serviceId,
            characteristicId,
            reqId
        });
        return p;
    }

    /**
     * Write to a characteristic. Fire-and-forget — the iframe does NOT
     * wait for the host or the device. If the host has no live device
     * the write is silently dropped.
     *
     * Returns a resolved Promise so existing `.then()` chains in the
     * calliopeMini extension keep working.
     *
     * @param {number|string} serviceId
     * @param {number|string} characteristicId
     * @param {string} message - base64 (default) or utf8 bytes
     * @param {string} [encoding]
     * @param {boolean} [withResponse]
     */
    write(serviceId, characteristicId, message, encoding = null, withResponse = null) {
        this._post({
            type: 'calliope.write',
            serviceId,
            characteristicId,
            message,
            encoding,
            withResponse
        });
        return Promise.resolve();
    }

    /**
     * Subscribe to notifications on a characteristic. The callback fires
     * for each `calliope.notify` message from the host on this UUID
     * tuple. Returns a Promise that resolves immediately (the host
     * doesn't ack subscriptions).
     */
    startNotifications(serviceId, characteristicId, onCharacteristicChanged = null) {
        if (onCharacteristicChanged) {
            const key = `${serviceId}|${characteristicId}`;
            this._notifySubscribers.set(key, onCharacteristicChanged);
        }
        this._post({
            type: 'calliope.subscribe',
            serviceId,
            characteristicId
        });
        return Promise.resolve();
    }

    /** Unsubscribe — mirrors startNotifications. */
    stopNotifications(serviceId, characteristicId) {
        const key = `${serviceId}|${characteristicId}`;
        this._notifySubscribers.delete(key);
        this._post({
            type: 'calliope.unsubscribe',
            serviceId,
            characteristicId
        });
        return Promise.resolve();
    }

    /**
     * Called by the extension after the user picks a peripheral. There
     * is no picker in remote mode — we report success synchronously and
     * emit the same events as the BLE class would.
     */
    connectPeripheral(/* id */) {
        if (this._connected) return;
        this._connected = true;
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
        try {
            this._connectCallback();
        } catch (_e) { /* ignore */ }
    }

    /**
     * Disconnect — keep the listener installed so reconnects work, but
     * mark not-connected and detach pending readers.
     */
    disconnect() {
        if (!this._connected) return;
        this._connected = false;
        // Reject pending reads with empty results so the extension's
        // promise chains complete cleanly.
        for (const {resolve} of this._pendingReads.values()) {
            try {
                resolve({message: '', encoding: 'base64'});
            } catch (_e) { /* ignore */ }
        }
        this._pendingReads.clear();
        this._notifySubscribers.clear();
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
    }

    /**
     * Called by the extension when a BLE error needs to surface as a
     * disconnect. In remote mode we treat this as informational —
     * scratch-vm's "Reconnect" alert would be misleading because the
     * host owns the real connection. Log + ignore.
     */
    handleDisconnectError(/* err */) {
        // No-op: the host is the authority on connection state.
        // We don't tear down the extension's pipeline because the next
        // read/write will succeed once the host has a device again.
    }

    /** No-op compatibility — old code may call this. */
    sendRemoteRequest() {
        return Promise.resolve();
    }
}

module.exports = CalliopeRemote;
