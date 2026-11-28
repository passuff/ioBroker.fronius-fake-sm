'use strict';

const assert = require('assert');
const { GrowattRateLimitError } = require('../lib/growattOpenApi');
const {
    pollOnce,
    smoothTick,
    hardStaleAfterS,
    noteRateLimit,
    clearRateLimit,
    isThrottleAmpSuppress,
} = require('../lib/adapterPoll');
const { Smoother } = require('../lib/smoother');
const {
    isKnownLocalRedirect,
    armLocalOfflineKnown,
} = require('../lib/stickSetup');

async function testPollOnceRateLimitKeepsGreen() {
    const makeAdapter = (lastPollOkAt) => {
        const states = {};
        const adapter = {
            config: {
                growattToken: 't',
                growattFeedMode: 'cloud',
                pollIntervalS: 120,
                u1: 230,
                frequency: 50,
            },
            _enabledDevices: [{ deviceSn: 'SN1', enabled: true }],
            _pollFloorS: 120,
            _rateLimitUntil: 0,
            _rateLimitBackoffS: 0,
            _lastFailWasRateLimit: false,
            _lastPollOkAt: lastPollOkAt,
            _lastSample: null,
            log: { info() {}, warn() {}, debug() {} },
            states,
            _getEnabledDevices() {
                return this._enabledDevices;
            },
            _clientFor() {
                return {
                    async fetch() {
                        throw new GrowattRateLimitError('FREQUENTLY_ACCESS');
                    },
                };
            },
            async setStateAsync(id, st) {
                states[id] = st;
            },
            async setStateChangedAsync(id, st) {
                states[id] = st;
            },
        };
        return adapter;
    };

    const cold = makeAdapter(0);
    await pollOnce(cold);
    // No successful sample yet — do not paint green forever on a cold-start 429.
    assert.strictEqual(cold.states['info.connection'].val, false, 'cold-start 429 must not fake green');
    assert.ok(String(cold.states['info.lastError'].val).includes('OpenAPI-Cooldown'));
    assert.strictEqual(cold._lastFailWasRateLimit, true);
    assert.ok(cold._rateLimitUntil > Date.now());

    // After at least one OK poll, throttle keeps the amp green.
    const warm = makeAdapter(Date.now());
    await pollOnce(warm);
    assert.strictEqual(warm.states['info.connection'].val, true, '429 after OK sample keeps amp green');
}

async function testHardStaleSuppressAfterCooldownCleared() {
    const states = {};
    const cloudCfg = {
        pollIntervalS: 120,
        growattFeedMode: 'cloud',
        u1: 230,
        u2: 230,
        u3: 230,
        frequency: 50,
        powerEpsilonW: 5,
    };
    const adapter = {
        config: cloudCfg,
        _pollFloorS: 120,
        _rateLimitUntil: 0,
        _lastFailWasRateLimit: true,
        _lastPollOkAt:
            Date.now() - hardStaleAfterS({ config: cloudCfg, _pollFloorS: 120 }) * 1000 - 1000,
        _lastSample: { power_w: -400, e_total_kwh: 50, u1: 230, f: 50 },
        _staleWarned: false,
        _hardStaleCleared: false,
        smoother: new Smoother({ emaTauS: 1, maxDeltaWPerTick: 5000, powerEpsilonW: 1 }),
        modbus: {
            updateFromMeter(m) {
                return { i1: m.powerW / 230 };
            },
        },
        log: { info() {}, warn() {} },
        async setStateAsync(id, st) {
            states[id] = st;
        },
        async setStateChangedAsync(id, st) {
            states[id] = st;
        },
    };
    assert.strictEqual(isThrottleAmpSuppress(adapter), true);
    clearRateLimit(adapter);
    assert.strictEqual(adapter._rateLimitUntil, 0);
    assert.strictEqual(isThrottleAmpSuppress(adapter), true, 'marker survives clearRateLimit');

    adapter.smoother.update(-400, 50, undefined, 1, {});
    smoothTick(adapter, 1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(states['info.connection'].val, true, 'hard-stale after throttle stays green');
}

async function testOfflineArmKnownRedirect() {
    const states = {};
    let foreign = null;
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: {
            growattFeedMode: 'cloud',
            localSetupPending: false,
            cloudStickRedirectActive: true,
            stickOnlineLabel: 'WR nicht verbunden',
        },
        log: { info() {}, warn() {} },
        async setStateAsync(id, st) {
            states[id] = st;
        },
        async getForeignObjectAsync() {
            return { native: { localSetupPending: false, growattFeedMode: 'cloud' } };
        },
        async setForeignObjectAsync(_id, obj) {
            foreign = obj.native;
        },
    };
    assert.strictEqual(isKnownLocalRedirect(adapter), true);
    const res = await armLocalOfflineKnown(adapter, '192.168.1.19');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.armedOffline, true);
    assert.strictEqual(res.native.localSetupPending, true);
    assert.strictEqual(res.native.growattFeedMode, 'local');
    assert.strictEqual(adapter.config.localSetupPending, true);
    assert.ok(foreign);
    assert.strictEqual(foreign.localSetupPending, true);
    assert.ok(String(states['info.setupStatus'].val).includes('offline'));
}

function testOfflineWithoutPatchIsErrorContract() {
    // Without known redirect, setup must NOT arm — same gate used by runStickSetup.
    assert.strictEqual(isKnownLocalRedirect({ config: {} }), false);
    assert.strictEqual(
        isKnownLocalRedirect({ config: { stickCloudOnline: false, growattFeedMode: 'local' } }),
        false,
    );
    // Simulated branch outcome when remote.offline && !known
    const known = isKnownLocalRedirect({ config: {} });
    const result = known
        ? { ok: true }
        : { ok: false, error: 'Stick offline' };
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
}

(async () => {
    noteRateLimit({ _pollFloorS: 120, _rateLimitUntil: 0, _rateLimitBackoffS: 0 });
    await testPollOnceRateLimitKeepsGreen();
    await testHardStaleSuppressAfterCooldownCleared();
    await testOfflineArmKnownRedirect();
    testOfflineWithoutPatchIsErrorContract();
    console.log('offlineArmRateLimit.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
