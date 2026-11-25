'use strict';

const assert = require('assert');
const {
    applyGen24MeterProbe,
    INVISIBLE_ERR_PREFIX,
    MISS_THRESHOLD,
} = require('../lib/gen24MeterHealth');

function mockAdapter() {
    const states = {};
    return {
        config: { froniusIp: '192.168.1.80', fakeUniqueId: 3 },
        modbus: { listening: true },
        log: { info() {}, warn() {}, debug() {} },
        async setStateAsync(id, obj) {
            states[id] = obj && obj.val;
        },
        async getStateAsync(id) {
            return states[id] != null ? { val: states[id] } : null;
        },
        _states: states,
    };
}

(async () => {
    const a = mockAdapter();
    await applyGen24MeterProbe(a, {
        visible: true,
        powerW: 19.5,
        location: 3,
        deviceId: '3',
        serial: '2095449517',
    });
    assert.strictEqual(a._states['info.gen24MeterVisible'], true);
    assert.strictEqual(a._states['info.gen24MeterPower'], 19.5);
    assert.ok(a._states['info.gen24MeterLastSeen'] > 0);
    assert.strictEqual(a._gen24MeterMisses, 0);

    for (let i = 0; i < MISS_THRESHOLD; i++) {
        await applyGen24MeterProbe(a, {
            visible: false,
            powerW: null,
            location: 3,
            deviceId: null,
            serial: '',
            error: 'no Loc3 in Solar API',
        });
    }
    assert.strictEqual(a._states['info.gen24MeterVisible'], false);
    assert.ok(String(a._states['info.lastError'] || '').startsWith(INVISIBLE_ERR_PREFIX));

    await applyGen24MeterProbe(a, {
        visible: true,
        powerW: 12,
        location: 3,
        deviceId: '3',
        serial: '2095449517',
    });
    assert.strictEqual(a._states['info.gen24MeterVisible'], true);
    assert.strictEqual(a._states['info.lastError'], '');

    console.log('gen24MeterHealth.test.js ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
