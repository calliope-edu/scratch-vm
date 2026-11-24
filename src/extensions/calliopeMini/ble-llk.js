const BLE = require('../../io/ble');
const WebBLE = require('./ble-web');

module.exports = typeof navigator !== 'undefined' && navigator.bluetooth ? WebBLE : BLE;
