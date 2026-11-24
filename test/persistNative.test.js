'use strict';

const assert = require('assert');
const {
    diffNativeKeys,
    cloneNative,
    persistNative,
    mergeDeviceBaselinesIntoNative,
} = require('../lib/persistNative');

function testDiffNativeKeys() {
    const changed = diffNativeKeys({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 2 }, c: 3 });
    assert.deepStrictEqual(changed, ['b', 'c']);
    assert.deepStrictEqual(diffNativeKeys({ a: 1 }, { a: 1 }), []);
}

function testMergeBaselinesOnly() {
    const native = {
        devices: [
            {
                deviceSn: 'FRJ7CJD0S7',
                enabled: true,
                stickSn: 'XGD6CK737N',
                plantName: 'PV-Spielhaus',
                eBaselineKwh: 1000,
                eBaselineLocked: true,
            },
        ],
    };
    const mem = [
        {
            deviceSn: 'FRJ7CJD0S7',
            enabled: false, // in-memory churn must NOT overwrite enabled
            stickSn: 'XGD6CK737N',
            plantName: 'MUTATED',
            eBaselineKwh: 2634.9,
            eBaselineLocked: true,
            eBaselineStatus: 'fixiert',
        },
    ];
    mergeDeviceBaselinesIntoNative(native, mem);
    assert.strictEqual(native.devices[0].enabled, true, 'enabled preserved');
    assert.strictEqual(native.devices[0].plantName, 'PV-Spielhaus', 'non-baseline fields preserved');
    assert.strictEqual(native.devices[0].eBaselineKwh, 2634.9);
    assert.strictEqual(native.devices[0].eBaselineStatus, 'fixiert');
}

async function testPersistNativeNoopAndWrite() {
    const writes = [];
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        log: { info: () => {}, warn: () => {} },
        async getForeignObjectAsync() {
            return { native: { localEnabled: true, localPacOffset: 87 } };
        },
        async setForeignObjectAsync(id, obj) {
            writes.push({ id, native: cloneNative(obj.native) });
        },
    };
    const noop = await persistNative(adapter, { localEnabled: true }, 'noop');
    assert.strictEqual(noop.wrote, false);
    assert.strictEqual(writes.length, 0);

    const wrote = await persistNative(adapter, { localEnabled: false }, 'toggle');
    assert.strictEqual(wrote.wrote, true);
    assert.deepStrictEqual(wrote.keys, ['localEnabled']);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].native.localEnabled, false);
}

testDiffNativeKeys();
testMergeBaselinesOnly();
testPersistNativeNoopAndWrite()
    .then(() => {
        console.log('persistNative.test.js OK');
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
