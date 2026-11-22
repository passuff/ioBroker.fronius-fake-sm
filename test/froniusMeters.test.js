'use strict';

const assert = require('assert');
const {
    parseMeterRealtime,
    suggestMeterLocation,
    formatExistingMeters,
} = require('../lib/froniusDiscover');

const body = {
    Body: {
        Data: {
            '0': { Meter_Location_Current: 0 },
        },
    },
};
const parsed = parseMeterRealtime(body);
assert.strictEqual(parsed.count, 1);
assert.deepStrictEqual(parsed.locations, [0]);
assert.ok(parsed.summary.includes('0:grid'));

assert.strictEqual(suggestMeterLocation([0]), 3);
assert.strictEqual(suggestMeterLocation([0, 3]), 1);
assert.strictEqual(suggestMeterLocation([]), 3);

assert.strictEqual(formatExistingMeters(0, ''), '0');
assert.strictEqual(formatExistingMeters(1, '0:grid'), '1 (Loc 0:grid)');

console.log('froniusMeters.test.js OK');
