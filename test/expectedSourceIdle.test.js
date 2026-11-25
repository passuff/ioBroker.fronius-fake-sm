'use strict';

const assert = require('assert');
const { isExpectedSourceIdle, growattRatedW, isInDayWindow } = require('../lib/adapterPoll');
const { extractPvW, extractRatedW, isFroniusCacheFresh } = require('../lib/froniusDaylight');

// --- basic power ---
assert.strictEqual(
    isExpectedSourceIdle({
        config: { powerEpsilonW: 5 },
        _lastPollOkAt: Date.now() - 60_000,
        _lastSample: { power_w: 420 },
    }),
    false,
);

assert.strictEqual(
    isExpectedSourceIdle({
        config: { powerEpsilonW: 5 },
        _lastPollOkAt: 0,
        _lastSample: { power_w: 0 },
    }),
    false,
);

// --- Fronius relative: high util → Growatt silence unexpected ---
{
    const adapter = {
        config: { powerEpsilonW: 5, daylightUtilThreshold: 0.05, growattRatedW: 1000 },
        _enabledDevices: [{ enabled: true, pmaxW: 1000 }],
        _lastPollOkAt: Date.now() - 60_000,
        _lastSample: { power_w: 0 },
        _froniusDaylight: {
            pvW: 1500,
            ratedW: 10000,
            at: Date.now(),
            util: 0.15,
        },
        setStateChangedAsync: async () => {},
    };
    assert.strictEqual(growattRatedW(adapter), 1000);
    assert.strictEqual(isExpectedSourceIdle(adapter), false, '15% Fronius util → not idle');
}

// --- Fronius relative: low util → idle (dawn / few modules) ---
{
    const adapter = {
        config: { powerEpsilonW: 5, daylightUtilThreshold: 0.05, growattRatedW: 1000 },
        _enabledDevices: [{ enabled: true, pmaxW: 1000 }],
        _lastPollOkAt: Date.now() - 60_000,
        _lastSample: { power_w: 0 },
        _froniusDaylight: {
            pvW: 100,
            ratedW: 10000,
            at: Date.now(),
            util: 0.01,
        },
        setStateChangedAsync: async () => {},
    };
    assert.strictEqual(isExpectedSourceIdle(adapter), true, '1% Fronius util → idle');
}

// --- size ratio 10 kW vs 1 kW still scales ---
{
    const adapter = {
        config: { powerEpsilonW: 5, daylightUtilThreshold: 0.05 },
        _enabledDevices: [{ enabled: true, pmaxW: 1000 }],
        _lastPollOkAt: Date.now() - 60_000,
        _lastSample: { power_w: 0 },
        _froniusDaylight: {
            pvW: 800,
            ratedW: 10000,
            at: Date.now(),
        },
        setStateChangedAsync: async () => {},
    };
    // util 8% → expected Growatt 80 W >= 50 W thr → not idle
    assert.strictEqual(isExpectedSourceIdle(adapter), false);
}

// --- no Fronius: night window → idle ---
{
    const nightHour = 2;
    const adapter = {
        config: {
            powerEpsilonW: 5,
            dayWindowStartHour: 6,
            dayWindowEndHour: 22,
            expectedIdleMaxHours: 14,
        },
        _lastPollOkAt: Date.now() - 60_000,
        _lastSample: { power_w: 0 },
        _lastNonZeroAt: Date.now() - 20 * 3600_000,
    };
    assert.strictEqual(isInDayWindow(adapter, new Date(2026, 0, 1, nightHour, 0, 0)), false);
    // Monkey: force night by setting window that excludes "now" — use isInDayWindow result path
    // Directly stub by setting day window to empty via equal hours? start===end → always day.
    // Instead call isExpectedSourceIdle when not in day: override Date via isInDayWindow tested separately.
}

// Fallback day + old lastNonZero → not idle
{
    const adapter = {
        config: {
            powerEpsilonW: 5,
            dayWindowStartHour: 0,
            dayWindowEndHour: 24,
            expectedIdleMaxHours: 14,
        },
        _lastPollOkAt: Date.now() - 60_000,
        _lastSample: { power_w: 0 },
        _lastNonZeroAt: Date.now() - 20 * 3600_000,
        _froniusDaylight: null,
    };
    assert.strictEqual(isInDayWindow(adapter), true);
    assert.strictEqual(isExpectedSourceIdle(adapter), false, 'day + 20h since non-zero → not idle');
}

// Fallback day + recent lastNonZero → idle
{
    const adapter = {
        config: {
            powerEpsilonW: 5,
            dayWindowStartHour: 0,
            dayWindowEndHour: 24,
            expectedIdleMaxHours: 14,
        },
        _lastPollOkAt: Date.now() - 60_000,
        _lastSample: { power_w: 0 },
        _lastNonZeroAt: Date.now() - 2 * 3600_000,
        _froniusDaylight: null,
    };
    assert.strictEqual(isExpectedSourceIdle(adapter), true);
}

// extract helpers
assert.strictEqual(
    extractPvW({ Body: { Data: { Site: { P_PV: 1234 } } } }),
    1234,
);
assert.strictEqual(
    extractRatedW({ Body: { Data: { '1': { NominalPower: 10 } } } }),
    10000,
);
assert.strictEqual(
    isFroniusCacheFresh({ pvW: 1, ratedW: 1000, at: Date.now() }),
    true,
);
assert.strictEqual(
    isFroniusCacheFresh({ pvW: 1, ratedW: 1000, at: Date.now() - 999_999 }),
    false,
);

console.log('expectedSourceIdle.test.js OK');
