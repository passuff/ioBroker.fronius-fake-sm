'use strict';

const assert = require('assert');
const {
    tryLockDeviceBaseline,
    deviceRelativeKwh,
    sumRelativeKwh,
    rebuildBaselinesToMatchPublished,
    lockBaselinesAtCurrent,
    resetAllBaselines,
    applyEnergySamples,
    pipelineETotal,
    seedSmootherFromPublished,
    getLastPublished,
} = require('../lib/energyBaselines');
const { Smoother } = require('../lib/smoother');

function mockAdapter(cfg) {
    return {
        config: cfg,
        log: { warn() {}, info() {} },
        setStateChangedAsync: async () => {},
        setStateAsync: async () => {},
        getForeignObjectAsync: async () => null,
        setForeignObjectAsync: async () => {},
    };
}

// lock + relative
const d1 = { enabled: true, deviceSn: 'A', eBaselineLocked: false, eBaselineKwh: null };
assert.strictEqual(tryLockDeviceBaseline(d1, 0.5), false, 'ignore tiny eTotal');
assert.strictEqual(tryLockDeviceBaseline(d1, 100), true);
assert.strictEqual(d1.eBaselineKwh, 100);
assert.strictEqual(d1.eBaselineStatus, 'fixiert');
assert.strictEqual(tryLockDeviceBaseline(d1, 110), false, 'already locked');
assert.strictEqual(deviceRelativeKwh(d1, 130), 30);
assert.strictEqual(deviceRelativeKwh(d1, 90), 0, 'never negative');

// multi-device sum
const d2 = { enabled: true, deviceSn: 'B', eBaselineLocked: true, eBaselineKwh: 50 };
assert.strictEqual(
    sumRelativeKwh([
        { device: d1, e_total_kwh: 130 },
        { device: d2, e_total_kwh: 80 },
    ]),
    60,
);

// rebuild single device to match lastPublished
const r1 = { device: { enabled: true, deviceSn: 'X', eBaselineLocked: false }, e_total_kwh: 1000 };
assert.ok(rebuildBaselinesToMatchPublished([r1], 200));
assert.ok(Math.abs(r1.device.eBaselineKwh - 800) < 1e-9);
assert.ok(Math.abs(deviceRelativeKwh(r1.device, 1000) - 200) < 1e-9);

// rebuild proportional multi
const m1 = { device: { enabled: true, deviceSn: 'M1', eBaselineLocked: false }, e_total_kwh: 600 };
const m2 = { device: { enabled: true, deviceSn: 'M2', eBaselineLocked: false }, e_total_kwh: 400 };
assert.ok(rebuildBaselinesToMatchPublished([m1, m2], 100));
assert.ok(Math.abs(sumRelativeKwh([m1, m2]) - 100) < 1e-6);

// soft zero lock
const z = [{ device: { enabled: true, deviceSn: 'Z', eBaselineLocked: false }, e_total_kwh: 500 }];
assert.ok(lockBaselinesAtCurrent(z));
assert.strictEqual(sumRelativeKwh(z), 0);

// reset
assert.strictEqual(resetAllBaselines([z[0].device]), 1);
assert.strictEqual(z[0].device.eBaselineLocked, false);
assert.strictEqual(z[0].device.eBaselineStatus, '—');

// applyEnergySamples: rebuild preferred over soft lock when lastPublished set
const adapter = mockAdapter({
    eOffsetMode: 'auto',
    lastPublishedEProducedKwh: 50,
    devices: [{ enabled: true, deviceSn: 'P1', eBaselineLocked: false, eBaselineKwh: null }],
});
const rows = [{ device: adapter.config.devices[0], e_total_kwh: 250 }];
const out = applyEnergySamples(adapter, rows);
assert.ok(out.rebuilt);
assert.ok(Math.abs(out.relSum - 50) < 1e-6);
assert.strictEqual(pipelineETotal(adapter, out.rawSum, out.relSum), out.relSum);

// manual: raw sum
const man = mockAdapter({ eOffsetMode: 'manual', devices: [] });
assert.strictEqual(pipelineETotal(man, 999, 10), 999);

// seed smoother
const s = new Smoother({ eTotalOffsetKwh: 0 });
assert.ok(seedSmootherFromPublished(s, 12.5));
assert.strictEqual(s.state.eProducedKwh, 12.5);
assert.ok(s.state.seeded);

// Number(null) must not become lastPublished=0
assert.strictEqual(getLastPublished(mockAdapter({ lastPublishedEProducedKwh: null })), null);
assert.strictEqual(getLastPublished(mockAdapter({})), null);
assert.strictEqual(getLastPublished(mockAdapter({ lastPublishedEProducedKwh: 0 })), 0);
assert.strictEqual(getLastPublished(mockAdapter({ lastPublishedEProducedKwh: 42.5 })), 42.5);

// disabled device not in relative sum
const dis = { enabled: false, deviceSn: 'D', eBaselineLocked: true, eBaselineKwh: 10 };
assert.strictEqual(deviceRelativeKwh(dis, 50), 0);
assert.strictEqual(sumRelativeKwh([{ device: dis, e_total_kwh: 50 }, { device: d1, e_total_kwh: 130 }]), 30);

// newly enabled unlocked device locks on apply when others already locked
const lockedPeer = {
    enabled: true,
    deviceSn: 'L1',
    eBaselineLocked: true,
    eBaselineKwh: 200,
};
const newPeer = { enabled: true, deviceSn: 'L2', eBaselineLocked: false, eBaselineKwh: null };
const peerAdapter = mockAdapter({
    eOffsetMode: 'auto',
    lastPublishedEProducedKwh: 50,
    devices: [lockedPeer, newPeer],
});
const peerOut = applyEnergySamples(peerAdapter, [
    { device: lockedPeer, e_total_kwh: 250 },
    { device: newPeer, e_total_kwh: 80 },
]);
assert.strictEqual(newPeer.eBaselineLocked, true);
assert.strictEqual(newPeer.eBaselineKwh, 80);
assert.ok(Math.abs(peerOut.relSum - 50) < 1e-9); // only L1 contributes until new grows

// baselines present, lastPublished missing → seed from relSum
const orphan = {
    enabled: true,
    deviceSn: 'O1',
    eBaselineLocked: true,
    eBaselineKwh: 100,
};
const orphanAdapter = mockAdapter({
    eOffsetMode: 'auto',
    lastPublishedEProducedKwh: null,
    devices: [orphan],
});
orphanAdapter.smoother = new Smoother({ eTotalOffsetKwh: 0 });
const orphanOut = applyEnergySamples(orphanAdapter, [{ device: orphan, e_total_kwh: 140 }]);
assert.ok(Math.abs(orphanOut.relSum - 40) < 1e-9);
assert.strictEqual(getLastPublished(orphanAdapter), 40);
assert.strictEqual(orphanAdapter.smoother.state.eProducedKwh, 40);

// Sample-path lockedNew must NOT write native (restart loop gate)
let foreignWrites = 0;
const noPersistAdapter = mockAdapter({
    eOffsetMode: 'auto',
    lastPublishedEProducedKwh: 50,
    devices: [{ enabled: true, deviceSn: 'NP1', eBaselineLocked: false, eBaselineKwh: null }],
});
noPersistAdapter.getForeignObjectAsync = async () => ({
    native: { devices: noPersistAdapter.config.devices, lastPublishedEProducedKwh: 50 },
});
noPersistAdapter.setForeignObjectAsync = async () => {
    foreignWrites += 1;
};
const noPersistOut = applyEnergySamples(noPersistAdapter, [
    { device: noPersistAdapter.config.devices[0], e_total_kwh: 250 },
]);
assert.ok(noPersistOut.lockedNew || noPersistOut.rebuilt);
assert.strictEqual(foreignWrites, 0, 'applyEnergySamples must not persist native on lockedNew');
assert.strictEqual(noPersistAdapter._persistBaselineTimer, undefined);

console.log('energyBaselines.test.js OK');
