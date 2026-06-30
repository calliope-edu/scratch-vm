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

const SOURCE = 'calliope-blocks-vm';

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
        // Whether this editor is the ACTIVE one in the host. The host keeps the
        // Blocks iframe mounted (hidden) when another editor is shown, but
        // scratch-vm keeps its ~50ms sensor-poll loop running — which would
        // hammer the device + flood the bridge in the background. When inactive
        // we short-circuit read/write so no device I/O leaves the iframe; the
        // poll loop still ticks but does nothing. Defaults active (the common
        // case is the iframe being created while it's the visible editor).
        this._active = true;
        this._pendingReads = new Map(); // reqId → {resolve, reject}
        this._notifySubscribers = new Map(); // `${service}|${char}` → callback
        this._nextReqId = 1;

        // Singleton message listener for parent → iframe events. Multiple
        // CalliopeRemote instances share the same listener.
        this._messageHandler = this._onParentMessage.bind(this);
        if (typeof window !== 'undefined') {
            window.addEventListener('message', this._messageHandler);
        }

        // Lifecycle diagnostic (rare, always-on): confirms CalliopeRemote was
        // constructed and records its frame context + target origin. If device
        // I/O is silent, this is the first thing to check — "was the IO class
        // even created, and is the iframe framed with a parent origin?".
        // eslint-disable-next-line no-console
        console.info(
            `[calliopeRemote] constructed: extensionId=${extensionId} ` +
            `framed=${isFramed()} parentOrigin=${parentOriginFromSearch()}`
        );

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
        if (typeof window === 'undefined') return;
        if (!isFramed()) {
            // Critical + rare: device I/O cannot reach the host because the
            // editor isn't running inside a parent frame. Warn loudly rather
            // than silently dropping every read/write/subscribe.
            // eslint-disable-next-line no-console
            console.warn(
                '[calliopeRemote] _post skipped: not framed ' +
                `(window.parent===window? ${typeof window !== 'undefined' && window.parent === window}). ` +
                'No device I/O will reach the host.'
            );
            return;
        }
        const origin = parentOriginFromSearch();
        // Per-message trace is opt-in (set window.__CALLIOPE_DEBUG_IO = true)
        // so a healthy ~50ms read loop doesn't flood the console.
        if (window.__CALLIOPE_DEBUG_IO) {
            // eslint-disable-next-line no-console
            console.debug(`[calliopeRemote] _post ${message.type || '?'} -> ${origin}`);
        }
        const payload = Object.assign({source: SOURCE}, message);
        try {
            window.parent.postMessage(payload, origin);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[calliopeRemote] postMessage failed', e);
        }
    }

    /**
     * Report blocks runtime-version status up to the host (campus). The
     * calliopeMini extension calls this on connect after reading the device's
     * COMMAND version byte, so the host can show an "outdated firmware" banner
     * and the connection widget can display the version. Namespaced `blocks.*`
     * (not `calliope.*`) so it routes to the host's blocks-message handler.
     * @param {{runtimeVersion: number, expectedVersion: number, outdated: boolean}} status
     */
    reportStatus(status) {
        this._post(Object.assign({type: 'blocks.runtimeVersion'}, status));
    }

    /**
     * Report touch/pin input arming status up to the host (campus). The
     * calliopeMini extension calls this when the program's touch pads switch
     * between "still arming / calibrating" and "ready", so campus can show a
     * transient "preparing inputs" banner instead of acting as if touch is
     * already responsive. Namespaced `blocks.*` so it routes to the host's
     * blocks-message handler.
     * @param {{preparing: boolean}} status
     */
    reportTouchStatus(status) {
        this._post(Object.assign({type: 'blocks.touchStatus'}, status));
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
        if (data.type === 'calliope.setActive') {
            // Host tells us whether the Blocks editor is the visible/active one.
            // When inactive, read()/write() below become no-ops so the hidden
            // iframe stops polling the device in the background.
            const nextActive = data.active !== false;
            const becameActive = nextActive && !this._active;
            this._active = nextActive;
            // Returning to the Blocks editor: the device may have been reset or
            // changed while we were paused (we weren't polling it). Force a fresh
            // version handshake + touch reconcile so the host banner and touch
            // arming re-sync immediately rather than after the periodic poll.
            if (becameActive) {
                try {
                    this._runtime.emit('CALLIOPE_HOST_REHANDSHAKE');
                } catch (_e) { /* ignore */ }
            }
            return;
        }
        if (data.type === 'calliope.rehandshake') {
            // Host (re)connected a transport. The puppet never sees the real
            // device's reconnect, so force the extension to re-read COMMAND and
            // re-report the runtime version even if unchanged (otherwise the host
            // can lose the version on disconnect and never re-learn it, leaving
            // its program banner stuck "detecting"). The same COMMAND read runs
            // the data[4] touch-armed reconcile, so touch re-arms promptly too.
            try {
                this._runtime.emit('CALLIOPE_HOST_REHANDSHAKE');
            } catch (_e) { /* ignore */ }
            return;
        }
        if (data.type === 'calliope.rearmInputs') {
            // Host (dev-only "Re-arm inputs" button) asked the program to re-arm
            // its touch pads / pin events without a full reconnect. Surface it as
            // a runtime event the calliopeMini extension listens for.
            try {
                this._runtime.emit('CALLIOPE_HOST_REARM_INPUTS');
            } catch (_e) { /* ignore */ }
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
        // Paused (editor not visible): resolve empty immediately, no postMessage
        // to the host → no background device reads while another editor is open.
        if (!this._active) {
            return Promise.resolve({message: '', encoding: 'base64'});
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
        // Paused (editor not visible): drop writes so a backgrounded Blocks
        // project can't keep driving the device while another editor is open.
        if (!this._active) {
            return Promise.resolve();
        }
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
