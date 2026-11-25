'use strict';

const assert = require('assert');
const { isLocalFeedActive, pollOnce, staleAfterS } = require('../lib/adapterPoll');

function makeAdapter(overrides) {
    const states = {};
    let fetchCalls = 0;
    const adapter = {
        config: {
            growattFeedMode: 'local',
            localSetupVerified: false,
            localEnabled: false,
            growattToken: 'tok',
            pollIntervalS: 60,
            ...((overrides && overrides.config) || {}),
        },
        _enabledDevices: [{ deviceSn: 'DEV1', enabled: true }],
        _lastLocalOkAt: overrides && overrides._lastLocalOkAt,
        _lastPollOkAt: 0,
        _rateLimitUntil: 0,
        _rateLimitBackoffS: 0,
        log: { info() {}, warn() {}, debug() {}, error() {} },
        _getEnabledDevices() {
            return this._enabledDevices;
        },
        _clientFor() {
            return {
                async fetch() {
                    fetchCalls += 1;
                    return { power_w: 100, e_total_kwh: 1, u1: 230, f: 50 };
                },
            };
        },
        async setStateAsync(id, st) {
            states[id] = st.val;
        },
        async setStateChangedAsync(id, st) {
            states[id] = st.val;
        },
        _fetchCalls: () => fetchCalls,
        _states: states,
    };
    Object.assign(adapter, overrides || {});
    return adapter;
}

(async () => {
    // Helper: not verified → inactive
    assert.strictEqual(
        isLocalFeedActive(
            makeAdapter({ config: { growattFeedMode: 'local', localSetupVerified: false }, _lastLocalOkAt: Date.now() }),
        ),
        false,
    );
    // verified + fresh → active
    assert.strictEqual(
        isLocalFeedActive(
            makeAdapter({
                config: { growattFeedMode: 'local', localSetupVerified: true },
                _lastLocalOkAt: Date.now(),
            }),
        ),
        true,
    );
    // verified + stale → inactive
    const staleMs = staleAfterS(makeAdapter({ config: { growattFeedMode: 'local', localSetupVerified: true } })) * 1000;
    assert.strictEqual(
        isLocalFeedActive(
            makeAdapter({
                config: { growattFeedMode: 'local', localSetupVerified: true },
                _lastLocalOkAt: Date.now() - staleMs - 5000,
            }),
        ),
        false,
    );

    // pollOnce: verified + fresh → skip fetch
    const a1 = makeAdapter({
        config: { growattFeedMode: 'local', localSetupVerified: true, growattToken: 'tok' },
        _lastLocalOkAt: Date.now(),
    });
    await pollOnce(a1);
    assert.strictEqual(a1._fetchCalls(), 0, 'fresh local must skip OpenAPI');

    // pollOnce: not verified → fetch
    const a2 = makeAdapter({
        config: { growattFeedMode: 'local', localSetupVerified: false, growattToken: 'tok' },
        _lastLocalOkAt: 0,
    });
    // applyEnergySamples needs energy baselines helpers — poll may throw if missing;
    // count fetch before energy commit by wrapping
    let fetched = false;
    a2._clientFor = () => ({
        async fetch() {
            fetched = true;
            throw new Error('stop-after-fetch');
        },
    });
    await pollOnce(a2);
    assert.strictEqual(fetched, true, 'bridge must poll when not verified');

    // pollOnce: verified but stale → fetch
    let fetched3 = false;
    const a3 = makeAdapter({
        config: { growattFeedMode: 'local', localSetupVerified: true, growattToken: 'tok' },
        _lastLocalOkAt: Date.now() - staleMs - 10000,
    });
    a3._clientFor = () => ({
        async fetch() {
            fetched3 = true;
            throw new Error('stop-after-fetch');
        },
    });
    await pollOnce(a3);
    assert.strictEqual(fetched3, true, 'stale local must fall back to OpenAPI');

    console.log('localBridge.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
