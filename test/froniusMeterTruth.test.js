'use strict';

const assert = require('assert');
const {
    pickSecondaryMeter,
    producedKwhFromMeterRow,
    seedFromGen24Truth,
} = require('../lib/froniusMeterTruth');
const { Smoother } = require('../lib/smoother');

const sample = {
    '0': {
        Meter_Location_Current: 0,
        EnergyReal_WAC_Sum_Produced: 23775455,
        Details: { Model: 'Smart Meter TS 65A-3', Serial: 'grid' },
    },
    '3': {
        Meter_Location_Current: 3,
        EnergyReal_WAC_Sum_Produced: 1397,
        Details: { Model: 'Smart Meter TS 65A-3', Serial: '2095449517' },
    },
};

const picked = pickSecondaryMeter(sample, 3);
assert.ok(picked);
assert.strictEqual(picked.deviceId, '3');
assert.strictEqual(producedKwhFromMeterRow(picked.row), 1.397);

assert.strictEqual(pickSecondaryMeter(sample, 0).deviceId, '0');
assert.strictEqual(producedKwhFromMeterRow(pickSecondaryMeter(sample, 0).row), 23775.455);

const diverge = {
    '1': { Meter_Location_Current: 3, EnergyReal_WAC_Sum_Produced: 5000 },
    '3': { Meter_Location_Current: 1, EnergyReal_WAC_Sum_Produced: 100 },
};
assert.strictEqual(pickSecondaryMeter(diverge, 3).deviceId, '1');
assert.strictEqual(producedKwhFromMeterRow(pickSecondaryMeter(diverge, 3).row), 5);

assert.strictEqual(producedKwhFromMeterRow(null), null);
assert.strictEqual(producedKwhFromMeterRow({}), null);
assert.strictEqual(pickSecondaryMeter({}, 3), null);

function mockAdapter(cfg) {
    return {
        config: cfg,
        smoother: new Smoother({ eTotalOffsetKwh: 0 }),
        log: { warn() {}, info() {}, debug() {} },
        setStateAsync: async () => {},
        setStateChangedAsync: async () => {},
        getStateAsync: async () => null,
        getForeignObjectAsync: async () => null,
        setForeignObjectAsync: async () => {},
    };
}

function fakeTruth(kwh) {
    return async () => ({
        kwh,
        wh: kwh * 1000,
        deviceId: '3',
        location: 3,
        model: 'Smart Meter TS 65A-3',
        serial: '2095449517',
    });
}

(async () => {
    // Keep baselines when Gen24 matches lastPublished
    const keep = mockAdapter({
        froniusIp: '192.168.1.80',
        fakeUniqueId: 3,
        lastPublishedEProducedKwh: 1.397,
        devices: [{ enabled: true, deviceSn: 'A', eBaselineLocked: true, eBaselineKwh: 100 }],
    });
    const rKeep = await seedFromGen24Truth(keep, { fetchFn: fakeTruth(1.397) });
    assert.ok(rKeep.ok);
    assert.strictEqual(rKeep.baselinesUnlocked, false);
    assert.strictEqual(keep.config.devices[0].eBaselineLocked, true);
    assert.strictEqual(keep.config.lastPublishedEProducedKwh, 1.397);

    // Unlock when Gen24 diverges from lastPublished
    const unlock = mockAdapter({
        froniusIp: '192.168.1.80',
        lastPublishedEProducedKwh: 1.397,
        devices: [{ enabled: true, deviceSn: 'A', eBaselineLocked: true, eBaselineKwh: 100 }],
    });
    const rUnlock = await seedFromGen24Truth(unlock, { fetchFn: fakeTruth(5.0) });
    assert.ok(rUnlock.ok);
    assert.strictEqual(rUnlock.baselinesUnlocked, true);
    assert.strictEqual(unlock.config.devices[0].eBaselineLocked, false);
    assert.strictEqual(unlock.config.lastPublishedEProducedKwh, 5.0);

    // Transient zero with prior → reject
    const zero = mockAdapter({
        froniusIp: '192.168.1.80',
        lastPublishedEProducedKwh: 1.397,
        devices: [],
    });
    const rZero = await seedFromGen24Truth(zero, { fetchFn: fakeTruth(0) });
    assert.strictEqual(rZero.ok, false);
    assert.ok(String(rZero.error).includes('transient zero'));
    assert.strictEqual(zero.config.lastPublishedEProducedKwh, 1.397);

    console.log('froniusMeterTruth.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
