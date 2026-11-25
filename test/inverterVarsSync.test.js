'use strict';

const assert = require('assert');
const { syncInverterVarsFromSample, ensureInverterVarObjects } = require('../lib/inverterVarsStates');
const { defaultInverterVarsConfig } = require('../lib/inverterVarsCatalog');

function mockAdapter() {
    const states = new Map();
    const objects = new Map();
    return {
        config: {
            inverterVars: defaultInverterVarsConfig().map((r) => ({
                ...r,
                enabled: ['pac', 'eTotal', 'vac1', 'fac', 'status'].includes(r.id),
            })),
            devices: [{ enabled: true, deviceSn: 'MINSN1', deviceType: 'min' }],
        },
        _enabledDevices: [{ enabled: true, deviceSn: 'MINSN1', deviceType: 'min' }],
        log: { debug() {}, info() {}, warn() {} },
        async setObjectNotExistsAsync(id, obj) {
            if (!objects.has(id)) {
                objects.set(id, obj);
            }
        },
        async setStateChangedAsync(id, st) {
            states.set(id, st);
        },
        async setStateAsync(id, st) {
            states.set(id, st);
        },
        _states: states,
        _objects: objects,
    };
}

(async () => {
    const adapter = mockAdapter();
    await ensureInverterVarObjects(adapter);
    assert.ok(adapter._objects.has('inverter.MINSN1.values.pac'));
    assert.ok(!adapter._objects.has('inverter.MINSN1.values.soc'), 'soc not for min family when only defaults');

    await syncInverterVarsFromSample(adapter, {
        deviceSn: 'MINSN1',
        deviceType: 'min',
        transport: 'openapi',
        force: true,
        raw: { pac: 1234.5, eTotal: 88.1, vAc1: 230.1, fAc: 50.02, status: 1 },
    });
    assert.strictEqual(adapter._states.get('inverter.MINSN1.values.pac').val, 1234.5);
    assert.strictEqual(adapter._states.get('inverter.MINSN1.values.eTotal').val, 88.1);
    assert.strictEqual(adapter._states.get('inverter.MINSN1.values.vac1').val, 230.1);

    // Interval gate: second sync without force should skip
    adapter._states.clear();
    await syncInverterVarsFromSample(adapter, {
        deviceSn: 'MINSN1',
        deviceType: 'min',
        transport: 'openapi',
        raw: { pac: 999 },
    });
    assert.ok(!adapter._states.has('inverter.MINSN1.values.pac'), 'due() should skip immediate re-write');

    console.log('inverterVarsSync.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
