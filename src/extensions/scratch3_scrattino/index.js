const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const log = require('../../util/log');
// const formatMessage = require('format-message');

const JSONRPCWebSocket = require('../../util/jsonrpc-web-socket.js');

const RPC_SERVER_URL = 'ws://localhost:2020';

const MODES = {
    INPUT: 0x00,
    OUTPUT: 0x01,
    ANALOG: 0x02,
    PWM: 0x03,
    SERVO: 0x04,
    SHIFT: 0x05,
    I2C: 0x06,
    ONEWIRE: 0x07,
    STEPPER: 0x08,
    SERIAL: 0x0A,
    PULLUP: 0x0B,
    IGNORE: 0x7F,
    PING_READ: 0x75,
    UNKOWN: 0x10
};

class FirmataSocket extends JSONRPCWebSocket {

    /**
     * A Firmata peripheral socket object.  It handles connecting, over web sockets, to
     * Firmata peripherals, and reading and writing data to them.
     * @param {Runtime} runtime - the Runtime for sending/receiving GUI update events.
     * @param {string} extensionId - the id of the extension using this socket.
     * @param {object} peripheralOptions - the list of options for peripheral discovery.
     * @param {object} connectCallback - a callback for connection.
     */
    constructor (runtime, extensionId, peripheralOptions, connectCallback) {
        const ws = new WebSocket(RPC_SERVER_URL);
        super(ws);

        this._ws = ws;
        this._ws.onopen = this.requestPeripheral.bind(this); // only call request peripheral after socket opens
        this._ws.onerror = this._sendRequestError.bind(this, 'ws onerror');
        this._ws.onclose = this._sendDisconnectError.bind(this, 'ws onclose');

        this._availablePeripherals = {};
        this._connectCallback = connectCallback;
        this._characteristicDidChangeCallback = null;
        this._extensionId = extensionId;
        this._peripheralOptions = peripheralOptions;
        this._discoverTimeoutID = null;
        this._runtime = runtime;
        this.board = null;
    }

    /**
     * Request connection to the peripheral.
     * If the web socket is not yet open, request when the socket promise resolves.
     */
    requestPeripheral () {
        if (this._ws.readyState === 1) { // is this needed since it's only called on ws.onopen?
            this._availablePeripherals = {};
            if (this._discoverTimeoutID) {
                clearTimeout(this._discoverTimeoutID);
            }
            this._discoverTimeoutID = setTimeout(this._sendDiscoverTimeout.bind(this), 15000);
            this.sendRemoteRequest('scan', this._peripheralOptions)
                .then(result => {
                    this._availablePeripherals = result;
                    if (this._runtime) {
                        this._runtime.emit(
                            this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                            this._availablePeripherals
                        );
                    }
                })
                .catch(e => {
                    this._sendRequestError(e);
                })
                .finally(() => {
                    clearTimeout(this._discoverTimeoutID);
                });
        }
    }

    /**
     * Try connecting to the input peripheral id, and then call the connect
     * callback if connection is successful.
     * @param {number} id - the id of the peripheral to connect to
     */
    connectPeripheral (id) {
        id = id ? id : Object.keys(this._availablePeripherals)[0];
        this.sendRemoteRequest('connect', {portPath: id})
            .then(boardProperty => {
                this.board = boardProperty;
                if (this._runtime) {
                    this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                }
                this._connectCallback(this.board);
            })
            .catch(e => {
                this._sendRequestError(e);
            });
    }


    _releaseBoard () {
        if (this.board) {
            this.sendRemoteRequest('disconnect', {portPath: this.board.transport.path})
                .catch(e => {
                    this._sendRequestError(e);
                })
                .finally(() => {
                    this.board = null;
                });
        }
    }

    /**
     * Close the websocket.
     */
    disconnect () {
        if (this._discoverTimeoutID) {
            clearTimeout(this._discoverTimeoutID);
        }
        this._releaseBoard();
        this._ws.close();
    }

    /**
     * @return {boolean} whether the peripheral is connected.
     */
    isConnected () {
        if (!this.board) return false;
        if (!this.board.transport.isOpen) {
            return false;
        }
        return true;
    }

    getPinValue (pinIndex) {
        if (!this.board) return 0;
        return this.board.pins[pinIndex].value;
    }

    getAnalogPinValue (analogPinIndex) {
        if (!this.board) return 0;
        return this.getPinValue([this.board.analogPins[analogPinIndex]]);
    }

    _sendRequestError (/* e */) {
        // log.error(`FirmataSocket error: ${JSON.stringify(e)}`);
        if (this._runtime) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
                message: `Scratch lost connection to`,
                extensionId: this._extensionId
            });
        }
    }

    _sendDisconnectError (/* e */) {
        this.board = null;
        if (this._runtime) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECT_ERROR, {
                message: `Scratch lost connection to`,
                extensionId: this._extensionId
            });
        }
    }

    _sendDiscoverTimeout () {
        if (this._discoverTimeoutID) {
            clearTimeout(this._discoverTimeoutID);
        }
        if (this._runtime) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_SCAN_TIMEOUT);
        }
    }

    updateBoardState () {
        if (!this.board) return;
        this.sendRemoteRequest('getBoardState', {portPath: this.board.transport.path})
            .then(boardState => {
                Object.assign(this.board, boardState);
                if (!this.board.transport.isOpen) this._sendDisconnectError();
            })
            .catch(e => {
                this._sendRequestError(e);
            });
    }

    getAllPinIndex () {
        if (!this.board) return [0];
        return Object.keys(this.board.pins);
    }

    digitalWrite (pin, value) {
        if (!this.board) return;
        this.sendRemoteRequest('digitalWrite', {portPath: this.board.transport.path, pin: pin, value: value})
            .catch(e => {
                this._sendRequestError(e);
            });
    }

    pwmWrite (pin, value) {
        if (!this.board) return;
        value = Math.floor(Math.min(Math.max(value, 0), this.board.RESOLUTION.PWM));
        this.sendRemoteRequest('pwmWrite', {portPath: this.board.transport.path, pin: pin, value: value})
            .catch(e => {
                this._sendRequestError(e);
            });
    }

    servoWrite (pin, value) {
        if (!this.board) return;
        this.sendRemoteRequest('servoWrite', {portPath: this.board.transport.path, pin: pin, value: value})
            .catch(e => {
                this._sendRequestError(e);
            });
    }

    getPinMode (pin) {
        if (!this.board) return null;
        return this.board.pins[pin].mode;
    }

    setPinMode (pin, mode) {
        if (!this.board) return;
        this.sendRemoteRequest('pinMode', {portPath: this.board.transport.path, pin: pin, mode: mode})
            .catch(e => {
                this._sendRequestError(e);
            });
    }
}


class Scrattino {

    /**
     * Construct a Scrattino communication object.
     * @param {Runtime} runtime - the Scratch 3.0 runtime
     * @param {string} extensionId - the id of the extension
     */
    constructor (runtime, extensionId) {

        /**
         * The Scratch 3.0 runtime used to trigger the green flag button.
         * @type {Runtime}
         * @private
         */
        this._runtime = runtime;

        /**
         * Register using peripheral connection.
         */
        if (this._runtime) {
            this._runtime.registerPeripheralExtension(extensionId, this);
        }

        /**
         * The id of the extension this peripheral belongs to.
         */
        this._extensionId = extensionId;

        this._firmata = null;

        this._updateBoardStateInterval = null;
        this.updateBoardIntervalTime = 100;

        this.disconnect = this.disconnect.bind(this);
        this._onConnect = this._onConnect.bind(this);
        this._updateBoardState = this._updateBoardState.bind(this);

        this._startUpdateBoardState();
    }

    /**
     * Called by the runtime when user wants to scan for a peripheral.
     */

    scan () {
        if (this._firmata) {
            this._firmata.disconnect();
        }
        this._firmata = new FirmataSocket(this._runtime, this._extensionId, {}, this._onConnect);
    }

    /**
     * Called by the runtime when user wants to connect to a certain peripheral.
     * @param {number} id - the id of the peripheral to connect to.
     */
    connect (id) {
        if (this._firmata) {
            this._firmata.connectPeripheral(id);
        }
    }

    /**
     * Disconnect from the Firmata board.
     */
    disconnect () {
        clearInterval(this._updateBoardStateInterval);
        if (this._firmata) {
            this._firmata.disconnect();
        }
    }

    /**
     * Return true if connected to the micro:bit.
     * @return {boolean} - whether the micro:bit is connected.
     */
    isConnected () {
        let connected = false;
        if (this._firmata) {
            connected = this._firmata.isConnected();
        }
        return connected;
    }

    getAllPinIndex () {
        if (!this._firmata) return [0];
        return this._firmata.getAllPinIndex();
    }

    getPinValue (pinIndex) {
        if (!this._firmata) return 0;
        return this._firmata.getPinValue(pinIndex);
    }

    getAnalogPinValue (analogPinIndex) {
        if (!this._firmata) return 0;
        return this._firmata.getAnalogPinValue(analogPinIndex);
    }

    setPinModeInput (pin, mode) {
        if (!this._firmata) return;
        this._firmata.setPinMode(pin, mode);
    }

    setPinValueDigital (pin, value) {
        if (!this._firmata) return;
        this._firmata.digitalWrite(pin, value);
    }

    setPinValuePwm (pin, value) {
        if (!this._firmata) return;
        if (this._firmata.getPinMode(pin) !== MODES.PWM) {
            this._firmata.setPinMode(pin, MODES.PWM);
        }
        this._firmata.pwmWrite(pin, value);
    }

    setPinValueServo (pin, value) {
        if (!this._firmata) return;
        if (this._firmata.getPinMode(pin) !== MODES.SERVO) {
            this._firmata.setPinMode(pin, MODES.SERVO);
        }
        this._firmata.servoWrite(pin, value);
    }

    _updateBoardState () {
        if (this._firmata) {
            this._firmata.updateBoardState();
        }
    }

    _startUpdateBoardState () {
        this._updateBoardStateInterval = setInterval(this._updateBoardState, this.updateBoardIntervalTime);
    }

    _onConnect (board) {
        log.info(`Connected to ${board.name}`);
    }

}

/**
 * Icon png to be displayed at the left edge of each extension block, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const blockIconURI = 'data:image/png;base64,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';

const DIGITAL_VALUE = {
    LOW: 0,
    HIGH: 1
};

/**
 * Scratch 3.0 blocks to interact with a MicroBit peripheral.
 */
class Scratch3ScrattinoBlocks {

    /**
     * @return {string} - the name of this extension.
     */
    static get EXTENSION_NAME () {
        return 'scrattino';
    }

    /**
     * @return {string} - the ID of this extension.
     */
    static get EXTENSION_ID () {
        return 'scrattino';
    }

    /**
     * Construct a set of Scrattino blocks.
     * @param {Runtime} runtime - the Scratch 3.0 runtime.
     */
    constructor (runtime) {
        this._runtime = runtime;
        this.scrattino = new Scrattino(runtime, Scratch3ScrattinoBlocks.EXTENSION_ID);
    }


    /**
     * @returns {object} metadata for this extension and its blocks.
     */
    getInfo () {
        return {
            id: Scratch3ScrattinoBlocks.EXTENSION_ID,
            name: Scratch3ScrattinoBlocks.EXTENSION_NAME,
            docsURI: 'https://github.com/yokobond/scrattino3',
            blockIconURI: blockIconURI,
            showStatusButton: true,
            blocks: [
                {
                    opcode: 'a0',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: 'A0',
                    func: 'a0',
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'a1',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: 'A1',
                    func: 'a1',
                    filter: ['sprite', 'stage']
                },
                '---',
                {
                    opcode: 'getPinValue',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: 'D[PINS]',
                    func: 'getPinValue',
                    arguments: {
                        PINS: {
                            type: ArgumentType.STRING,
                            menu: 'pins',
                            defaultValue: '0'
                        }
                    },
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'setPinModeInput',
                    blockType: BlockType.COMMAND,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: 'Set D[PINS] Input [MODE] ',
                    func: 'setPinModeInput',
                    arguments: {
                        PINS: {
                            type: ArgumentType.STRING,
                            menu: 'pins',
                            defaultValue: '0'
                        },
                        MODE: {
                            type: ArgumentType.STRING,
                            menu: 'inputModes',
                            defaultValue: MODES.PULLUP
                        }
                    },
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'setPinValueDigital',
                    blockType: BlockType.COMMAND,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: 'Set D[PINS] Digital [VALUE] ',
                    func: 'setPinValueDigital',
                    arguments: {
                        PINS: {
                            type: ArgumentType.STRING,
                            menu: 'pins',
                            defaultValue: '0'
                        },
                        VALUE: {
                            type: ArgumentType.STRING,
                            menu: 'digitalValue',
                            defaultValue: DIGITAL_VALUE.LOW
                        }
                    },
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'setPinValuePwm',
                    blockType: BlockType.COMMAND,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: 'Set D[PINS] PWM [VALUE] ',
                    func: 'setPinValuePwm',
                    arguments: {
                        PINS: {
                            type: ArgumentType.STRING,
                            menu: 'pins',
                            defaultValue: '0'
                        },
                        VALUE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        }
                    },
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'setPinValueServo',
                    blockType: BlockType.COMMAND,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: 'Set D[PINS] Servo [VALUE] ',
                    func: 'setPinValueServo',
                    arguments: {
                        PINS: {
                            type: ArgumentType.STRING,
                            menu: 'pins',
                            defaultValue: '0'
                        },
                        VALUE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        }
                    },
                    filter: ['sprite', 'stage']
                }
            ],
            menus: {
                pins: 'getAllPinIndexMenu',
                digitalValue: this.DIGITAL_VALUE_MENU,
                inputModes: this.INPUT_MODES_MENU
            }
        };
    }

    get DIGITAL_VALUE_MENU () {
        return [
            {text: 'LOW', value: DIGITAL_VALUE.LOW},
            {text: 'HIGH', value: DIGITAL_VALUE.HIGH}
        ];
    }

    get INPUT_MODES_MENU () {
        return [
            {text: 'PULLUP', value: MODES.PULLUP},
            {text: 'PULLDOWN', value: MODES.INPUT}
        ];
    }

    getAllPinIndexMenu () {
        return this.scrattino.getAllPinIndex()
            .map(value => ({value: value, text: value.toString(10)}));
    }


    a0 () {
        return this.scrattino.getAnalogPinValue(0);
    }

    a1 () {
        return this.scrattino.getAnalogPinValue(1);
    }

    a2 () {
        return this.scrattino.getAnalogPinValue(2);
    }

    a3 () {
        return this.scrattino.getAnalogPinValue(3);
    }

    a4 () {
        return this.scrattino.getAnalogPinValue(4);
    }

    a5 () {
        return this.scrattino.getAnalogPinValue(5);
    }

    getPinValue (args) {
        const pin = parseInt(args.PINS, 10);
        return this.scrattino.getPinValue(pin);
    }

    setPinValueDigital (args) {
        const pin = parseInt(Cast.toNumber(args.PINS), 10);
        const value = Cast.toNumber(args.VALUE) ? 1 : 0;
        log.debug(`setPinValueDigital(arg.PINS=${args.PINS}, arg.VALUE=${args.VALUE})` +
            ` => setPinValueDigital(${pin}, ${value})`);
        return this.scrattino.setPinValueDigital(pin, value);
    }

    setPinValuePwm (args) {
        const pin = parseInt(Cast.toNumber(args.PINS), 10);
        const value = Cast.toNumber(args.VALUE);
        log.debug(`setPinValuePwm(arg.PINS=${args.PINS}, arg.VALUE=${args.VALUE}) => setPinValuePwm(${pin}, ${value})`);
        return this.scrattino.setPinValuePwm(pin, value);
    }

    setPinModeInput (args) {
        const pin = parseInt(Cast.toNumber(args.PINS), 10);
        log.debug(`setPinModeInput(arg.PINS=${args.PINS}, arg.MODE=${args.MODE})` +
            `=> setPinModeInput(${pin}, ${args.MODE})`);
        return this.scrattino.setPinModeInput(pin, args.MODE);
    }

    setPinValueServo (args) {
        const pin = parseInt(Cast.toNumber(args.PINS), 10);
        const value = Math.floor(Math.max(Cast.toNumber(args.VALUE), 0));
        log.debug(`setPinValueServo(arg.PINS=${args.PINS}, arg.VALUE=${args.VALUE})` +
            `=> setPinValueServo(${pin}, ${value})`);
        return this.scrattino.setPinValueServo(pin, value);
    }

    scan () {
        this.scrattino.scan();
    }

    connect () {
        this.scrattino.connect(null);
    }

}

module.exports = Scratch3ScrattinoBlocks;
