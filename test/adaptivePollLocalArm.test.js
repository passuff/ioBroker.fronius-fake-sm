'use strict';

const assert = require('assert');
const {
    effectivePollIntervalS,
    noteRateLimit,
    clearRateLimit,
    OPENAPI_POLL_FLOOR_DEFAULT_S,
    OPENAPI_POLL_FLOOR_CAP_S,
} = require('../lib/adapterPoll');
const { isKnownLocalRedirect } = require('../lib/stickSetup');
const { maybeFallbackUnpatchedLocal } = require('../lib/stickOnline');

// Effective poll = max(config, floor), config clamped to >=90
{
    const a = { config: { pollIntervalS: 60 }, _pollFloorS: 120 };
    assert.strictEqual(effectivePollIntervalS(a), 120);
    a.config.pollIntervalS = 180;
    assert.strictEqual(effectivePollIntervalS(a), 180);
    a._pollFloorS = 240;
    assert.strictEqual(effectivePollIntervalS(a), 240);
}

// Rate-limit raises floor by 30, cooldown >= 180, cap 300; clear keeps floor
{
    const a = { _pollFloorS: OPENAPI_POLL_FLOOR_DEFAULT_S, _rateLimitUntil: 0, _rateLimitBackoffS: 0 };
    assert.strictEqual(noteRateLimit(a), 180);
    assert.strictEqual(a._pollFloorS, 150);
    const until = a._rateLimitUntil;
    clearRateLimit(a);
    assert.strictEqual(a._rateLimitUntil, 0);
    assert.strictEqual(a._pollFloorS, 150, 'learned floor must survive clearRateLimit');
    assert.ok(until > Date.now());

    a._pollFloorS = 290;
    noteRateLimit(a);
    assert.strictEqual(a._pollFloorS, OPENAPI_POLL_FLOOR_CAP_S);
    assert.ok(a._rateLimitBackoffS >= 180);
}

// Known local redirect detection
assert.strictEqual(isKnownLocalRedirect({ config: {} }), false);
assert.strictEqual(isKnownLocalRedirect({ config: { cloudStickRedirectActive: true } }), true);
assert.strictEqual(isKnownLocalRedirect({ config: { localSetupPending: true } }), true);
assert.strictEqual(isKnownLocalRedirect({ config: { localSetupVerified: true } }), true);
assert.strictEqual(
    isKnownLocalRedirect({ config: { devices: [{ stickRedirected: true }] } }),
    true,
);

// Unpatched SERVERIP → cloud fallback only when SN is in the registry (last stick)
async function testUnpatchedFallback() {
    const states = {};
    let foreign = null;
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: {
            growattFeedMode: 'local',
            advertisedModbusIp: '192.168.1.10',
            localStickSn: 'AAA',
            localSetupPending: true,
            stickRedirects: { AAA: { state: 'pending', since: 1 } },
            cloudStickRedirectActive: true,
            cloudStickRedirectSn: 'AAA',
        },
        log: { warn() {}, info() {} },
        async setStateAsync(id, st) {
            states[id] = st;
        },
        async getForeignObjectAsync() {
            return {
                native: {
                    growattFeedMode: 'local',
                    localSetupPending: true,
                    stickRedirects: { AAA: { state: 'pending', since: 1 } },
                },
            };
        },
        async setForeignObjectAsync(_id, obj) {
            foreign = obj.native;
        },
    };
    const ok = await maybeFallbackUnpatchedLocal(adapter, '192.168.1.10', 'AAA');
    assert.strictEqual(ok.fellBack, false, 'matching proxy IP must not fall back');

    // Stick not in registry → status only, keep local mode
    const stranger = await maybeFallbackUnpatchedLocal(adapter, 'server.growatt.com', 'BBB');
    assert.strictEqual(stranger.fellBack, false, 'unpatched other SN must not kill local mode');
    assert.strictEqual(adapter.config.growattFeedMode, 'local');

    // pending + cloud SERVERIP: keep waiting for stick (Shine lags until reboot)
    const pendingCloud = await maybeFallbackUnpatchedLocal(adapter, 'server.growatt.com', 'AAA');
    assert.strictEqual(pendingCloud.removed, false, 'pending must not demote on cloud SERVERIP');
    assert.strictEqual(adapter.config.growattFeedMode, 'local');
    assert.ok(adapter.config.stickRedirects.AAA);

    // verified + wrong LAN IP demotes when last registry SN
    adapter.config.stickRedirects = { AAA: { state: 'verified', since: 1 } };
    adapter.config.localSetupPending = false;
    adapter.config.localSetupVerified = true;
    foreign = null;
    const wrongLan = await maybeFallbackUnpatchedLocal(adapter, '192.168.1.99', 'AAA');
    assert.strictEqual(wrongLan.fellBack, true, 'wrong LAN IP must fall back when last registry SN');

    // verified + cloud SERVERIP still demotes when last registry SN
    adapter.config.growattFeedMode = 'local';
    adapter.config.stickRedirects = { AAA: { state: 'verified', since: 1 } };
    adapter.config.localSetupPending = false;
    adapter.config.localSetupVerified = true;
    adapter.config.cloudStickRedirectActive = true;
    foreign = null;
    const bad = await maybeFallbackUnpatchedLocal(adapter, 'server.growatt.com', 'AAA');
    assert.strictEqual(bad.fellBack, true);
    assert.strictEqual(adapter.config.growattFeedMode, 'cloud');
    assert.strictEqual(adapter.config.localSetupPending, false);
    assert.strictEqual(states['info.connection'].val, false);
    assert.ok(foreign);
    assert.strictEqual(foreign.growattFeedMode, 'cloud');
}

testUnpatchedFallback()
    .then(() => {
        console.log('adaptivePollLocalArm.test.js OK');
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
