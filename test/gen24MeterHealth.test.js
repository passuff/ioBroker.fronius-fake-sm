'use strict';

const assert = require('assert');
const {
    applyGen24MeterProbe,
    INVISIBLE_ERR_PREFIX,
    MISS_THRESHOLD,
} = require('../lib/gen24MeterHealth');

function mockAdapter() {
    const states = {};
    const warns = [];
    return {
        config: {
            froniusIp: '192.168.1.80',
            fakeUniqueId: 3,
            advertisedModbusIp: '192.168.1.19',
            modbusUnitId: 3,
        },
        modbus: { listening: true },
        log: {
            info() {},
            warn(m) {
                warns.push(m);
            },
            debug() {},
        },
        async setStateAsync(id, obj) {
            states[id] = obj && obj.val;
        },
        async getStateAsync(id) {
            return states[id] != null ? { val: states[id] } : null;
        },
        _states: states,
        _warns: warns,
    };
}

(async () => {
    const a = mockAdapter();
    a._proxyClientCountLive = 1;
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
    assert.ok(
        String(a._states['info.lastError'] || '').includes('192.168.1.19'),
        'lastError should hint advertisedModbusIp',
    );
    assert.ok(a._warns.some((w) => String(w).includes('192.168.1.19')));

    await applyGen24MeterProbe(a, {
        visible: true,
        powerW: 12,
        location: 3,
        deviceId: '3',
        serial: '2095449517',
    });
    assert.strictEqual(a._states['info.gen24MeterVisible'], true);
    assert.strictEqual(a._states['info.lastError'], '');

    // No stick at proxy → no WARN, no lastError
    const b = mockAdapter();
    b._proxyClientCountLive = 0;
    b._gen24MeterVisible = true;
    const debugs = [];
    b.log.debug = (m) => debugs.push(m);
    for (let i = 0; i < MISS_THRESHOLD; i++) {
        await applyGen24MeterProbe(b, {
            visible: false,
            powerW: null,
            location: 3,
            deviceId: null,
            serial: '',
            error: 'no Loc3 in Solar API',
        });
    }
    assert.strictEqual(b._warns.length, 0, 'no stick → no Loc3 WARN');
    assert.ok(!b._states['info.lastError'], 'no stick → no lastError');
    assert.ok(debugs.some((m) => String(m).includes('no stick at proxy')));

    console.log('gen24MeterHealth.test.js ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
