'use strict';

const assert = require('assert');
const {
    mergeInverterVarsConfig,
    getCatalogEntry,
    kindLabelFor,
} = require('../lib/inverterVarsCatalog');
const { ensureInverterVarObjects, deviceFamiliesUnion } = require('../lib/inverterVarsStates');
const { parseReadHoldingResponse, buildReadHoldingFrame } = require('../lib/growattInverterModbus');
const { GrowattSettingsQueue } = require('../lib/growattCloudSettings');
const { decodeFrame, encodeFrame } = require('../lib/growattProto');

// --- family filter ---
const minOnly = mergeInverterVarsConfig([], { families: ['min'] });
assert.ok(minOnly.some((r) => r.id === 'pac'));
assert.ok(!minOnly.some((r) => r.id === 'soc'), 'soc filtered out for min');
assert.ok(minOnly.some((r) => r.id === 'clock'));
assert.strictEqual(minOnly.find((r) => r.id === 'pac').kindLabel, 'Read');
assert.strictEqual(minOnly.find((r) => r.id === 'onOff').kindLabel, 'Write');
assert.strictEqual(kindLabelFor({ kind: 'write' }, 'de'), 'Schreiben');

const tlxHybrid = mergeInverterVarsConfig([{ id: 'soc', enabled: true, intervalS: 60 }], {
    families: ['tlx'],
});
assert.ok(tlxHybrid.find((r) => r.id === 'soc').enabled);

assert.deepStrictEqual(deviceFamiliesUnion([{ enabled: true, deviceType: 'min' }]), ['min']);
assert.strictEqual(deviceFamiliesUnion([]), null);

assert.ok(getCatalogEntry('clock'), 'clock setting present');
assert.strictEqual(getCatalogEntry('clock').apiType.default, 'pf_sys_year');

// --- orphan prune ---
(async () => {
    const deleted = [];
    const objects = new Map();
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: {
            inverterVars: mergeInverterVarsConfig([], { families: ['min'] }).map((r) => ({
                ...r,
                enabled: r.id === 'pac' || r.id === 'eTotal',
            })),
            devices: [{ enabled: true, deviceSn: 'SN1', deviceType: 'min' }],
        },
        _enabledDevices: [{ enabled: true, deviceSn: 'SN1', deviceType: 'min' }],
        log: { debug() {}, info() {}, warn() {} },
        async setObjectNotExistsAsync(id, obj) {
            if (!objects.has(id)) {
                objects.set(id, obj);
            }
        },
        async delObjectAsync(id) {
            deleted.push(id);
            objects.delete(id);
            for (const k of [...objects.keys()]) {
                if (k.startsWith(`${id}.`)) {
                    objects.delete(k);
                }
            }
        },
        async setStateChangedAsync() {},
        async setStateAsync() {},
    };

    await ensureInverterVarObjects(adapter);
    assert.ok(objects.has('inverter.SN1.values.pac'));
    assert.ok(objects.has('inverter.SN1.values.eTotal'));
    assert.ok(!objects.has('inverter.SN1.values.vac1'), 'vac1 not enabled');

    // Simulate leftover vac1 then re-ensure with still disabled → prune
    objects.set('inverter.SN1.values.vac1', {
        type: 'state',
        native: { catalogId: 'vac1', kind: 'read' },
    });
    await ensureInverterVarObjects(adapter);
    assert.ok(deleted.includes('inverter.SN1.values.vac1'), 'orphan vac1 deleted');

    // --- holding response parse ---
    const snBuf = Buffer.alloc(30, 0);
    Buffer.from('STICK1', 'ascii').copy(snBuf);
    const mid = Buffer.alloc(4);
    mid.writeUInt16BE(3, 0);
    mid.writeUInt16BE(1, 2);
    const val = Buffer.alloc(2);
    val.writeUInt16BE(50, 0);
    const payload = Buffer.concat([snBuf, mid, val]);
    const parsed = parseReadHoldingResponse(payload);
    assert.strictEqual(parsed.register, 3);
    assert.strictEqual(parsed.values[0], 50);

    const req = buildReadHoldingFrame({ sn: 'STICK1', register: 3, quantity: 1 });
    assert.strictEqual(decodeFrame(req).func, 0x05);

    // Round-trip encode a fake 0x05 response frame
    const resp = encodeFrame({
        proto: 0x0006,
        unit: 1,
        func: 0x05,
        payloadPlain: payload,
        txn: 9,
    });
    assert.ok(decodeFrame(resp).crcOk);

    // --- write fail → ack false ---
    const states = new Map();
    const failAdapter = {
        log: { warn() {}, info() {}, debug() {} },
        config: {},
        localServer: null,
        async setStateAsync(id, st) {
            states.set(id, st);
        },
        async getStateAsync(id) {
            return states.get(id) || { val: 10, ack: true };
        },
    };
    const q = new GrowattSettingsQueue(failAdapter);
    await q._fail({ deviceSn: 'SN1', catalogId: 'activePowerRate', value: 40 }, 'boom');
    assert.strictEqual(states.get('inverter.SN1.settings.activePowerRate.msg').val, 'boom');
    assert.strictEqual(states.get('inverter.SN1.settings.activePowerRate.value').ack, false);

    console.log('inverterVarsRemediation.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
