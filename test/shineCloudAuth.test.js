'use strict';

const assert = require('assert');
const {
    hashPasswordShinePhone,
    isShineCloudAuth,
    GrowattShinePollClient,
    looksLikeRateLimit,
} = require('../lib/growattShinePoll');
const {
    effectivePollIntervalS,
    noteRateLimit,
    SHINE_POLL_FLOOR_DEFAULT_S,
    SHINE_POLL_MIN_S,
    OPENAPI_POLL_FLOOR_DEFAULT_S,
} = require('../lib/adapterPoll');

// Password hash: even-index 0 → c
{
    const h = hashPasswordShinePhone('test');
    assert.strictEqual(h.length, 32);
    assert.ok(/^[0-9a-f]+$/.test(h));
}

assert.strictEqual(looksLikeRateLimit(403, ''), true);
assert.strictEqual(looksLikeRateLimit(200, 'FREQUENTLY_ACCESS'), true);
assert.strictEqual(looksLikeRateLimit(200, 'ok'), false);

assert.strictEqual(isShineCloudAuth({ config: { growattFeedMode: 'cloud', growattCloudAuth: 'shine' } }), true);
assert.strictEqual(isShineCloudAuth({ config: { growattFeedMode: 'cloud', growattCloudAuth: 'openapi' } }), false);
assert.strictEqual(isShineCloudAuth({ config: { growattFeedMode: 'local', growattCloudAuth: 'shine' } }), false);
assert.strictEqual(isShineCloudAuth({ config: { growattFeedMode: 'cloud' } }), false);

// OpenAPI floor unchanged
{
    const a = { config: { pollIntervalS: 60, growattFeedMode: 'cloud', growattCloudAuth: 'openapi' }, _pollFloorS: 120 };
    assert.strictEqual(effectivePollIntervalS(a), 120);
}

// Shine: default 60, min 30, no OpenAPI 120 floor
{
    const a = {
        config: { pollIntervalS: 60, growattFeedMode: 'cloud', growattCloudAuth: 'shine' },
        _pollFloorS: SHINE_POLL_FLOOR_DEFAULT_S,
    };
    assert.strictEqual(effectivePollIntervalS(a), 60);
    a._pollFloorS = SHINE_POLL_MIN_S;
    a.config.pollIntervalS = 30;
    assert.strictEqual(effectivePollIntervalS(a), 30);
    a.config.pollIntervalS = 20;
    assert.strictEqual(effectivePollIntervalS(a), SHINE_POLL_MIN_S);
    a.config.pollIntervalS = 90;
    a._pollFloorS = 60;
    assert.strictEqual(effectivePollIntervalS(a), 90);
}

// Shine rate-limit raises floor from 60
{
    const a = {
        config: { growattFeedMode: 'cloud', growattCloudAuth: 'shine' },
        _pollFloorS: 60,
        _rateLimitUntil: 0,
        _rateLimitBackoffS: 0,
    };
    const cd = noteRateLimit(a);
    assert.strictEqual(a._pollFloorS, 90);
    assert.ok(cd >= 90);
    assert.strictEqual(a._lastFailWasRateLimit, true);
}

// Client shape / missing plant
async function testClientGate() {
    const c = new GrowattShinePollClient({
        user: 'u',
        password: 'p',
        deviceSn: 'SN',
        plantId: '',
        log() {},
    });
    c._loggedIn = true;
    await assert.rejects(() => c.fetch(), /plantId/);
}

testClientGate()
    .then(() => {
        assert.ok(OPENAPI_POLL_FLOOR_DEFAULT_S >= 120);
        console.log('shineCloudAuth.test.js OK');
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
