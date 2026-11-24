/**
 * Preloaded into every tap test (see "node-arg" in package.json).
 *
 * The VM loads the calliopeMini extension as a core extension on start, but
 * that extension is an ES module that imports SVG/JSON through webpack loaders
 * and touches `document` in its constructor, so plain Node cannot load it.
 * This puts a minimal stand-in into the require cache so the VM tests run;
 * lint and the webpack build cover the real extension.
 */
const Module = require('module');
const path = require('path');

class CalliopeMiniStub {
    constructor (runtime) {
        this.runtime = runtime;
    }

    getInfo () {
        return {
            id: 'calliopeMini',
            name: 'Calliope mini',
            blocks: [],
            menus: {}
        };
    }
}

const filename = path.resolve(__dirname, '../../src/extensions/calliopeMini/index.js');
const stub = new Module(filename);
stub.filename = filename;
stub.loaded = true;
stub.exports = {default: CalliopeMiniStub, blockClass: CalliopeMiniStub};
Module._cache[filename] = stub;
