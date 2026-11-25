'use strict';

const assert = require('assert');
const {
    beginPostSetupQuiet,
    shouldDeferNativeVerify,
    shouldDeferAutoPersist,
    POST_SETUP_QUIET_MS,
} = require('../lib/setupQuiet');

assert.ok(POST_SETUP_QUIET_MS >= 30_000);

const adapter = { localServer: {} };
assert.strictEqual(shouldDeferNativeVerify(adapter), false);
assert.strictEqual(shouldDeferAutoPersist(adapter.localServer), false);

beginPostSetupQuiet(adapter, 60_000);
assert.strictEqual(shouldDeferNativeVerify(adapter), true);
assert.strictEqual(shouldDeferAutoPersist(adapter.localServer), true);

adapter._setupInProgress = true;
adapter._postSetupQuietUntil = 0;
assert.strictEqual(shouldDeferNativeVerify(adapter), true);

adapter._setupInProgress = false;
adapter._postSetupQuietUntil = Date.now() - 1000;
assert.strictEqual(shouldDeferNativeVerify(adapter), false);

console.log('setupQuiet.test.js OK');
