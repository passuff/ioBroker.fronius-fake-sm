'use strict';

const assert = require('assert');
const {
    froniusAutoSettings,
    clampFakeSmDefaults,
    pickMasterFronius,
    applyMasterSelection,
} = require('../lib/adminMessages');
const { noteRateLimit, hasFreshSample, staleAfterS } = require('../lib/adapterPoll');

const auto = froniusAutoSettings(
    {
        ip: '192.168.1.80',
        serial: 'SN',
        hostname: 'gen24',
        suggestedLocation: 3,
        suggestedUnitId: 1, // invalid for secondary → clamp to 3
        suggestedModbusPort: 502,
    },
    ['192.168.1.19'],
);
assert.strictEqual(auto.modbusUnitId, 3);
assert.strictEqual(auto.fakeUniqueId, 3);
assert.strictEqual(auto.modbusPort, 502);
assert.strictEqual(auto.modbusHost, '0.0.0.0');
assert.strictEqual(auto.advertisedModbusIp, '192.168.1.19');

const empty = froniusAutoSettings({ ip: '1.2.3.4' }, []);
assert.strictEqual(empty.modbusUnitId, 3);
assert.strictEqual(empty.fakeUniqueId, 3);
assert.strictEqual(empty.modbusPort, 502);

assert.deepStrictEqual(
    clampFakeSmDefaults({ modbusUnitId: 3, fakeUniqueId: 3, modbusPort: 502, modbusHost: '0.0.0.0' }),
    {},
);
assert.deepStrictEqual(clampFakeSmDefaults({ modbusUnitId: 1, fakeUniqueId: 0, modbusPort: 0, modbusHost: '' }), {
    modbusUnitId: 3,
    fakeUniqueId: 3,
    modbusPort: 502,
    modbusHost: '0.0.0.0',
});

const found = [
    { ip: '192.168.1.81', meterCount: 0 },
    { ip: '192.168.1.80', meterCount: 2 },
    { ip: '192.168.1.82', meterCount: 1 },
];
const master = pickMasterFronius(found);
assert.strictEqual(master.ip, '192.168.1.80');
applyMasterSelection(found, master);
assert.strictEqual(found[1].enabled, true);
assert.strictEqual(found[0].enabled, false);
assert.strictEqual(found[2].enabled, false);
assert.strictEqual(pickMasterFronius([{ ip: 'x', meterCount: 0 }]).ip, 'x');
assert.strictEqual(pickMasterFronius([]), null);

const adapter = {
    _rateLimitBackoffS: 0,
    _rateLimitUntil: 0,
    _pollFloorS: 120,
    _lastPollOkAt: Date.now(),
    config: { pollIntervalS: 120 },
};
// Floor 120 → +30 = 150; cooldown max(180,150) = 180
assert.strictEqual(noteRateLimit(adapter), 180);
assert.strictEqual(adapter._pollFloorS, 150);
assert.ok(adapter._rateLimitUntil > Date.now());
assert.ok(hasFreshSample(adapter));
assert.ok(staleAfterS(adapter) >= 180);

adapter._lastPollOkAt = Date.now() - 400000;
assert.ok(!hasFreshSample(adapter));

console.log('adminDefaults.test.js OK');
