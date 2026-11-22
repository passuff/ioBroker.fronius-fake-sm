'use strict';

const assert = require('assert');
const { Smoother } = require('../lib/smoother');

const s = new Smoother({
    emaTauS: 20,
    maxDeltaWPerTick: 200,
    powerEpsilonW: 5,
    eTotalOffsetKwh: 771.9,
});

let r = s.update(0, 2684.0, 1000, 5);
assert.ok(Math.abs(r.eProducedKwh - (2684 - 771.9)) < 0.01, 'seed energy');
assert.ok(Math.abs(r.powerW) < 1, 'start near 0');

r = s.update(-800, 2684.0, 1005, 5);
assert.ok(r.powerW > -201 && r.powerW < 0, `rate-limited toward -800, got ${r.powerW}`);

const e1 = r.eProducedKwh;
r = s.update(-800, 2684.0, 1010, 5);
assert.ok(r.eProducedKwh >= e1, 'energy monotonic');

const eFreeze = r.eProducedKwh;
const pFreeze = r.powerW;
r = s.update(-800, 2684.0, 1020, 10, { freezeEnergy: true });
assert.strictEqual(r.eProducedKwh, eFreeze, 'freezeEnergy keeps energy');
assert.strictEqual(r.powerW, pFreeze, 'freezeEnergy keeps power');
assert.ok(r.frozen, 'frozen flag');

console.log('smoother.test.js OK');
