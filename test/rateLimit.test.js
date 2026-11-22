'use strict';

const assert = require('assert');
const {
    GrowattRateLimitError,
    isGrowattRateLimitError,
} = require('../lib/growattOpenApi');

assert.ok(isGrowattRateLimitError(new GrowattRateLimitError('HTTP 429')));
assert.ok(isGrowattRateLimitError(new Error('Growatt OpenAPI HTTP 429: ')));
assert.ok(isGrowattRateLimitError(new Error('No last-data: FREQUENTLY_ACCESS')));
assert.ok(!isGrowattRateLimitError(new Error('timeout')));
assert.ok(!isGrowattRateLimitError(null));

console.log('rateLimit.test.js OK');
