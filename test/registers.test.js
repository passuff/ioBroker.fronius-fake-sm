'use strict';

const assert = require('assert');
const {
    get32BitsFromValue,
    convertValuesToRegisters,
    buildMeterValues,
} = require('../lib/froniusRegisters');

assert.deepStrictEqual(get32BitsFromValue(2376), [2376, 0]);
assert.deepStrictEqual(get32BitsFromValue(0), [0, 0]);

const meter = buildMeterValues({
    powerW: 0,
    eProducedKwh: 1912.1,
    u1: 237,
    u2: 237,
    u3: 239,
    f: 50,
});
const { reg258, reg286, reg1024 } = convertValuesToRegisters(meter);

assert.strictEqual(reg258.length, 16);
assert.strictEqual(reg286.length, 42);
assert.strictEqual(reg1024.length, 16);

// u_mean = (237+237+239)/3 = 237.666... → *10 → 2376
assert.strictEqual(reg258[0], 2376);
assert.strictEqual(reg258[14], 500); // 50 Hz * 10

// e_produced 1912.1 → trunc 1912, frac*1000 ≈ 100
assert.strictEqual(reg1024[8], 1912);
assert.ok(reg1024[10] >= 99 && reg1024[10] <= 100, `frac Wh got ${reg1024[10]}`);

// phase1 u1*10
assert.strictEqual(reg286[2], 2370);

console.log('registers.test.js OK');
