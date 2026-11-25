'use strict';

const assert = require('assert');
const { seriesFromDtc, formatPmaxLabel, parsePmaxW } = require('../lib/growattDtc');

assert.strictEqual(seriesFromDtc(5200), 'MIC/MIN TL-X');
assert.strictEqual(seriesFromDtc('5200'), 'MIC/MIN TL-X');
assert.strictEqual(seriesFromDtc(5201), 'MIN TL-X');
assert.strictEqual(seriesFromDtc(5100), 'MIN TL-XH');
assert.strictEqual(seriesFromDtc(3502), 'SPH TL BL-UP');
assert.strictEqual(seriesFromDtc(210), 'MIC MTL-S');
assert.strictEqual(seriesFromDtc(99999), '');
assert.strictEqual(seriesFromDtc(null), '');
assert.strictEqual(seriesFromDtc(0), '');

assert.strictEqual(formatPmaxLabel(1000), '1000 W');
assert.strictEqual(formatPmaxLabel(0), '—');
assert.strictEqual(formatPmaxLabel(null), '—');
assert.strictEqual(formatPmaxLabel(15000), '15 kW');
assert.strictEqual(formatPmaxLabel(10000), '10 kW');
assert.strictEqual(formatPmaxLabel(9999), '9999 W');

assert.strictEqual(parsePmaxW(1000), 1000);
assert.strictEqual(parsePmaxW('1000'), 1000);
assert.strictEqual(parsePmaxW(0), null);
assert.strictEqual(parsePmaxW(''), null);

console.log('growattDtc.test.js OK');
