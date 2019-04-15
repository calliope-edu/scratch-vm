const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const log = require('../../util/log');
const formatMessage = require('format-message');

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
                .then(() => {
                    this._ws.close();
                    this.board = null;
                    if (this._runtime) {
                        this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
                    }
                })
                .catch(e => {
                    this._sendRequestError(e);
                });
        }
    }

    /**
     * Close the websocket.
     */
    disconnect () {
        if (this.board) {
            this._releaseBoard();
        }
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
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTION_LOST_ERROR, {
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
                if (!this.board.transport.isOpen) {
                    if (this._runtime) {
                        this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
                    }
                }
            })
            .catch(e => {
                this._sendRequestError(e);
            });
    }

    getPins () {
        if (!this.board) return [];
        return this.board.pins;
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

    }

    /**
     * Called by the runtime when user wants to scan for a peripheral.
     */

    scan () {
        this.disconnect();
        this._firmata = new FirmataSocket(this._runtime, this._extensionId, {}, this._onConnect);
    }

    /**
     * Called by the runtime when user wants to connect to a certain peripheral.
     * @param {number} id - the id of the peripheral to connect to.
     */
    connect (id) {
        if (this._firmata) {
            this._firmata.connectPeripheral(id);
            this._startUpdateBoardState();
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
        if (!this._firmata) return [];
        return Object.keys(this._firmata.getPins());
    }

    getPWMPinIndex () {
        const pinIndex = [];
        if (!this._firmata) return pinIndex;
        this._firmata.getPins().forEach((pin, index) => {
            if (pin.supportedModes.includes(MODES.PWM)) {
                pinIndex.push(index);
            }
        });
        return pinIndex;
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
        if (this.isConnected()) {
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
    LOW: '0',
    HIGH: '1'
};

const INPUT_MODES = {
    INPUT: '0',
    PULLUP: '11'
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
                    text: formatMessage({
                        id: 'scrattino.A0',
                        default: 'A0',
                        description: 'Arduino Analog Input 0'
                    }),
                    func: 'a0',
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'a1',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: formatMessage({
                        id: 'scrattino.A1',
                        default: 'A1',
                        description: 'Arduino Analog Input 1'
                    }),
                    func: 'a1',
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'a2',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: formatMessage({
                        id: 'scrattino.A2',
                        default: 'A2',
                        description: 'Arduino Analog Input 2'
                    }),
                    func: 'a2',
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'a3',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: formatMessage({
                        id: 'scrattino.A3',
                        default: 'A3',
                        description: 'Arduino Analog Input 3'
                    }),
                    func: 'a3',
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'a4',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: formatMessage({
                        id: 'scrattino.A4',
                        default: 'A4',
                        description: 'Arduino Analog Input 4'
                    }),
                    func: 'a4',
                    filter: ['sprite', 'stage']
                },
                {
                    opcode: 'a5',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: formatMessage({
                        id: 'scrattino.A5',
                        default: 'A5',
                        description: 'Arduino Analog Input 5'
                    }),
                    func: 'a5',
                    filter: ['sprite', 'stage']
                },
                '---',
                {
                    opcode: 'getPinValue',
                    blockType: BlockType.REPORTER,
                    branchCount: 0,
                    isTerminal: false,
                    blockAllThreads: false,
                    text: formatMessage({
                        id: 'scrattino.getPinValue',
                        default: 'D[PINS]',
                        description: 'Arduino Digital Input value of the pin'
                    }),
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
                    text: formatMessage({
                        id: 'scrattino.setPinModeInput',
                        default: 'Set D[PINS] Input [MODE] ',
                        description: 'Set the Arduino pin to Digital Input Pullup/Pulldown'
                    }),
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
                            defaultValue: INPUT_MODES.PULLUP
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
                    text: formatMessage({
                        id: 'scrattino.setPinValueDigital',
                        default: 'Set D[PINS] Output [VALUE] ',
                        description: 'Set the Arduino pin to Digital Output 0/1'
                    }),
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
                    text: formatMessage({
                        id: 'scrattino.setPinValuePwm',
                        default: 'Set D[PINS] PWM [VALUE] ',
                        description: 'Set the Arduino pin to PWM value'
                    }),
                    func: 'setPinValuePwm',
                    arguments: {
                        PINS: {
                            type: ArgumentType.STRING,
                            // menu: 'pwmPins', // Error in Blockly module when taking the block from pallet.
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
                    text: formatMessage({
                        id: 'scrattino.setPinValueServo',
                        default: 'Set D[PINS] Servo [VALUE] ',
                        description: 'Set the Arduino pin to Servo value'
                    }),
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
                pwmPins: 'getPWMPinIndexMenu',
                digitalValue: this.DIGITAL_VALUE_MENU,
                inputModes: this.INPUT_MODES_MENU
            }
        };
    }

    get DIGITAL_VALUE_MENU () {
        return [
            {
                text: formatMessage({
                    id: 'scrattino.digitalValueMenu.Low',
                    default: 'Low',
                    description: 'label for low value in digital output menu for Scrattino extension'
                }),
                value: DIGITAL_VALUE.LOW
            },
            {
                text: formatMessage({
                    id: 'scrattino.digitalValueMenu.High',
                    default: 'High',
                    description: 'label for high value in digital output menu for Scrattino extension'
                }),
                value: DIGITAL_VALUE.HIGH}
        ];
    }

    get INPUT_MODES_MENU () {
        return [
            {
                text: formatMessage({
                    id: 'scrattino.digitalValueMenu.PullUp',
                    default: 'Pull-Up',
                    description: 'label for pull-up value in digital input menu for Scrattino extension'
                }),
                value: INPUT_MODES.PULLUP
            },
            {
                text: formatMessage({
                    id: 'scrattino.digitalValueMenu.PullDown',
                    default: 'Pull-Down',
                    description: 'label for pull-down value in digital input menu for Scrattino extension'
                }),
                value: INPUT_MODES.INPUT
            }
        ];
    }

    getAllPinIndexMenu () {
        const menu = this.scrattino.getAllPinIndex()
            .map(value => ({value: value, text: value.toString(10)}));
        if (menu.length === 0) menu.push(''); // Avoid to break menu
        return menu;
    }

    getPWMPinIndexMenu () {
        const menu = this.scrattino.getPWMPinIndex()
            .map(value => ({value: value, text: value.toString(10)}));
        if (menu.length === 0) menu.push(''); // Avoid to break menu
        return menu;
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
        const mode = Cast.toNumber(args.MODE);
        log.debug(`setPinModeInput(arg.PINS=${args.PINS}, arg.MODE=${args.MODE})` +
            `=> setPinModeInput(${pin}, ${mode})`);
        return this.scrattino.setPinModeInput(pin, mode);
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
