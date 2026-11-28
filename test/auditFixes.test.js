'use strict';

const assert = require('assert');
const {
    isCloudOk,
    isPermissionDenied,
    onlineLabel,
    plantSelectOption,
    stickSelectOption,
    MSG,
} = require('../lib/stickOnline');
const { trySeedLayout, AutoCalibrator, SEED_LAYOUTS } = require('../lib/growattRecord');
const { Smoother } = require('../lib/smoother');
const { encodeFrame } = require('../lib/growattProto');
const { GrowattServer } = require('../lib/growattServer');
const {
    staleAfterS,
    hardStaleAfterS,
    noteRateLimit,
    commitPollSample,
    pollIntervalMs,
    smoothTick,
} = require('../lib/adapterPoll');
const {
    markLocalSetupVerified,
    resolveCloudTruth,
    fetchCalibrateTruthOnce,
} = require('../lib/localProxy');
const { froniusAutoSettings } = require('../lib/adminMessages');

// isCloudOk: HTML / plain text must fail
assert.strictEqual(isCloudOk('<html>login</html>'), false);
assert.strictEqual(isCloudOk('not-json'), false);
assert.strictEqual(isCloudOk(null), false);
assert.strictEqual(isCloudOk({ success: true, msg: '192.168.1.19' }), true);
assert.strictEqual(isCloudOk({ success: true, msg: '' }), true);
assert.strictEqual(isCloudOk({ success: true, msg: 'inv_set_datalog_lost' }), false);
assert.strictEqual(isCloudOk({ success: false }), false);
assert.strictEqual(isCloudOk({ msg: '47.1.2.3' }), true);
assert.strictEqual(isPermissionDenied({ success: false, msg: 'error_permission_denied' }), true);
assert.strictEqual(isCloudOk({ success: false, msg: 'error_permission_denied' }), false);
assert.ok(MSG.permissionDenied('XGD6CJH2Y0').includes('XGD6CJH2Y0'));
assert.ok(MSG.noStickSn.includes('wählen') || MSG.noStickSn.includes('Auswahl'));
assert.deepStrictEqual(plantSelectOption({ id: '10053900', plantName: 'PV-Spielhaus' }), {
    value: '10053900',
    label: 'PV-Spielhaus (10053900)',
    noTranslation: true,
});
assert.deepStrictEqual(
    stickSelectOption({ sn: 'XGD6CK737N', lost: false, lastUpdateTime: '2026-11-22 13:35:00' }),
    {
        value: 'XGD6CK737N',
        label: 'XGD6CK737N — online · 2026-11-22 13:35:00 · Umleitung: —',
        noTranslation: true,
    },
);
assert.deepStrictEqual(
    stickSelectOption({
        sn: 'XGD6CJH2Y0',
        lost: false,
        lastUpdateTime: '2026-11-24 00:17:01',
        raw: { firmwareVersion: '3.1.0.5' },
    }),
    {
        value: 'XGD6CJH2Y0',
        label: 'XGD6CJH2Y0 — online · FW 3.1.0.5 · 2026-11-24 00:17:01 · Umleitung: —',
        noTranslation: true,
    },
);
assert.ok(stickSelectOption({ sn: 'OLD', lost: true }).label.includes('offline'));

assert.strictEqual(onlineLabel(true), 'WR verbunden');

// Seed layout plausibility
const body = Buffer.alloc(128, 0);
const seed = SEED_LAYOUTS.tlx;
body.writeUInt32BE(Math.round(1500 / seed.pacScale), seed.pacOff);
body.writeUInt32BE(Math.round(120.5 / seed.etotalScale), seed.etotalOff);
const locked = trySeedLayout(body);
assert.ok(locked, 'seed layout should lock on plausible pac+e');
assert.ok(locked.pacOff != null);

const nightBody = Buffer.alloc(128, 0);
nightBody.writeUInt32BE(0, seed.pacOff);
nightBody.writeUInt32BE(Math.round(500 / seed.etotalScale), seed.etotalOff);
const nightSeed = trySeedLayout(nightBody);
assert.ok(nightSeed, 'seed may lock on energy-only at night');

// Calibrator: night pac must not burn fail budget
const cal = new AutoCalibrator({ neededHits: 2, failAfterAttempts: 3, tolerance: 0.1 });
for (let i = 0; i < 5; i++) {
    cal.observe(body, { pac: 5, etotal: 100 });
}
assert.strictEqual(cal.failed, false);
assert.strictEqual(cal.observeAttempts, 0);

// Smoother hard-stale clears power
const sm = new Smoother({ emaTauS: 1, maxDeltaWPerTick: 1000, powerEpsilonW: 1 });
sm.update(-500, 100, undefined, 1, {});
const frozen = sm.update(0, 100, undefined, 1, { freezeEnergy: true, forcePowerZero: true });
assert.strictEqual(frozen.powerW, 0);
assert.ok(frozen.changed);

// staleAfter longer in local mode; cloud stale follows effective ~120s poll
const cloudAdapter = { config: { pollIntervalS: 120, growattFeedMode: 'cloud' } };
const localAdapter = { config: { pollIntervalS: 120, growattFeedMode: 'local' } };
assert.ok(staleAfterS(localAdapter) >= 300);
assert.ok(staleAfterS(cloudAdapter) >= 180);
assert.ok(hardStaleAfterS(localAdapter) > staleAfterS(localAdapter));

// Rate-limit: partial commit must keep cooldown
async function testRateLimitKeepCooldown() {
    const states = {};
    const adapter = {
        config: {},
        _enabledDevices: [{ deviceSn: 'A' }],
        _rateLimitUntil: 0,
        _rateLimitHits: 0,
        log: { info() {}, warn() {}, debug() {} },
        async setStateAsync(id, st) {
            states[id] = st;
        },
        async setStateChangedAsync(id, st) {
            states[id] = st;
        },
    };
    const cooldownS = noteRateLimit(adapter);
    assert.ok(adapter._rateLimitUntil > Date.now());
    const until = adapter._rateLimitUntil;
    await commitPollSample(
        adapter,
        { powerSum: 123.4, eSum: 10, u1: 230, f: 50, ok: 1, errors: ['B: rate'] },
        { keepRateLimit: true },
    );
    assert.strictEqual(adapter._rateLimitUntil, until, 'cooldown must survive partial commit');
    assert.ok(cooldownS >= 60);
    assert.strictEqual(adapter._lastSample.power_w, 123.4);
    assert.strictEqual(states['info.connection'].val, true);

    await commitPollSample(adapter, {
        powerSum: 200,
        eSum: 11,
        u1: 230,
        f: 50,
        ok: 1,
        errors: [],
    });
    assert.strictEqual(adapter._rateLimitUntil, 0, 'full success clears cooldown');
}

// markLocalSetupVerified: second call must not persist again
async function testVerifyIdempotent() {
    let foreignWrites = 0;
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: {
            growattFeedMode: 'local',
            localSetupVerified: true,
            localSetupPending: false,
            localEnabled: true,
        },
        log: { warn() {}, info() {} },
        async getForeignObjectAsync() {
            return { native: {} };
        },
        async setForeignObjectAsync() {
            foreignWrites += 1;
        },
        async setStateAsync() {},
    };
    await markLocalSetupVerified(adapter);
    assert.strictEqual(foreignWrites, 0, 'already verified → no Object write');

    adapter.config.localSetupVerified = false;
    adapter.config.localSetupPending = true;
    await markLocalSetupVerified(adapter);
    assert.strictEqual(foreignWrites, 1, 'state change → one Object write');
    assert.strictEqual(adapter.config.localSetupVerified, true);
    assert.strictEqual(adapter.config.localSetupPending, false);
}

// Discover: valid user Modbus port/unit survive froniusAutoSettings overwrite
function testDiscoverPortPreserve() {
    const suggested = froniusAutoSettings(
        {
            ip: '10.0.0.5',
            serial: 'X',
            hostname: 'fr',
            suggestedLocation: 3,
            suggestedUnitId: 3,
            suggestedModbusPort: 502,
        },
        ['192.168.1.19'],
    );
    const existingUnit = 7;
    const existingPort = 1502;
    const nativeUpdate = Object.assign({}, suggested);
    if (Number.isFinite(existingUnit) && existingUnit >= 2 && existingUnit <= 127) {
        nativeUpdate.modbusUnitId = existingUnit;
    }
    if (Number.isFinite(existingPort) && existingPort >= 1 && existingPort <= 65535) {
        nativeUpdate.modbusPort = existingPort;
    }
    assert.strictEqual(nativeUpdate.modbusUnitId, 7);
    assert.strictEqual(nativeUpdate.modbusPort, 1502);
}

function testResolveCloudTruthPrefersCache() {
    const adapter = {
        _calibrateTruth: { pac: 900, etotal: 12.5 },
        _lastSample: { power_w: -100, e_total_kwh: 1 },
    };
    const t = resolveCloudTruth(adapter);
    assert.strictEqual(t.pac, 900);
    assert.strictEqual(t.etotal, 12.5);

    delete adapter._calibrateTruth;
    const fromSample = resolveCloudTruth(adapter);
    assert.strictEqual(fromSample.pac, 100);
    assert.strictEqual(fromSample.etotal, 1);
}

async function testFetchCalibrateTruthOnce() {
    let fetches = 0;
    const adapter = {
        config: { growattToken: 'tok' },
        _calibrateTruthTried: false,
        log: { info() {} },
        _getEnabledDevices() {
            return [{ deviceSn: 'SN1', deviceType: 'min' }];
        },
        _clientFor() {
            return {
                async fetch() {
                    fetches += 1;
                    return { power_w: -432, e_total_kwh: 88.2 };
                },
            };
        },
    };
    const first = await fetchCalibrateTruthOnce(adapter);
    assert.deepStrictEqual(first, { pac: 432, etotal: 88.2 });
    const second = await fetchCalibrateTruthOnce(adapter);
    assert.strictEqual(fetches, 1, 'one-shot only');
    assert.strictEqual(second.pac, 432);
}

function makeDataFrame(bodyBuf) {
    const snPad = Buffer.alloc(30);
    Buffer.from('XGDTEST01').copy(snPad);
    const payload = Buffer.concat([snPad, bodyBuf]);
    return encodeFrame({ proto: 0x0006, func: 0x04, payloadPlain: payload, txn: 1 });
}

function testSeedRetryUntilLock() {
    let calibrated = 0;
    const server = new GrowattServer({
        autoCalibrate: true,
        getCloudTruth: () => null,
        onCalibrated: () => {
            calibrated += 1;
        },
        onSample: () => {},
        log: () => {},
        debug: () => {},
        error: () => {},
    });
    const sock = { write() {} };
    const bad = Buffer.alloc(128, 0xff);
    server._handleFrame(makeDataFrame(bad), sock);
    assert.strictEqual(server.calibrator.calibrated, false);
    assert.strictEqual(server._seedTried, undefined);
    assert.strictEqual(calibrated, 0);

    const good = Buffer.alloc(128, 0);
    good.writeUInt32BE(Math.round(1500 / seed.pacScale), seed.pacOff);
    good.writeUInt32BE(Math.round(120.5 / seed.etotalScale), seed.etotalOff);
    server._handleFrame(makeDataFrame(good), sock);
    assert.strictEqual(server.calibrator.calibrated, true);
    assert.strictEqual(server._seedTried, true);
    assert.strictEqual(calibrated, 1);
}

function testSoftBackoff() {
    const adapter = {
        config: { pollIntervalS: 120, nightPollIntervalS: 300, powerEpsilonW: 5, growattFeedMode: 'cloud' },
        _rateLimitUntil: 0,
        _pollFloorS: 120,
        _lastPollOkAt: Date.now() - 10 * 60 * 1000,
        _lastSample: { power_w: -200, e_total_kwh: 10 },
    };
    const ms = pollIntervalMs(adapter);
    assert.ok(ms <= 180000);
    assert.ok(ms >= 120000, `soft backoff should stay near day, got ${ms}`);
    assert.ok(ms < 300000, 'must not jump to full night when lastP active');

    adapter._lastSample = { power_w: 0, e_total_kwh: 10 };
    const night = pollIntervalMs(adapter);
    assert.strictEqual(night, 300000);
}

async function testSmoothTickHardStale() {
    const states = {};
    const cloudCfg = { pollIntervalS: 120, growattFeedMode: 'cloud', u1: 230, u2: 230, u3: 230, frequency: 50 };
    const adapter = {
        config: cloudCfg,
        _pollFloorS: 120,
        _rateLimitUntil: 0,
        _lastPollOkAt: Date.now() - hardStaleAfterS({ config: cloudCfg, _pollFloorS: 120 }) * 1000 - 1000,
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
    adapter.smoother.update(-400, 50, undefined, 1, {});
    smoothTick(adapter, 1);
    // hard-stale side effects run in a void async IIFE
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(adapter.smoother.state.powerW, 0);
    assert.strictEqual(states['info.connection'].val, false);
    // hard-stale must not force localConnection=false (proxy stick can still be up)
    assert.strictEqual(states['info.localConnection'], undefined);
}

/** powerSmooth must publish absolute moves even when per-tick EMA delta < powerEpsilonW. */
async function testSmoothTickPublishesAbsolutePower() {
    const states = {};
    const adapter = {
        config: {
            pollIntervalS: 300,
            growattFeedMode: 'local',
            u1: 230,
            u2: 230,
            u3: 230,
            frequency: 50,
            powerEpsilonW: 5,
        },
        _pollFloorS: 300,
        _rateLimitUntil: 0,
        _lastPollOkAt: Date.now(),
        _lastSample: { power_w: -100, e_total_kwh: 10, u1: 230, f: 50 },
        _staleWarned: false,
        _hardStaleCleared: false,
        // Slow EMA: each 1s tick moves << 5 W toward -100 from 0
        smoother: new Smoother({ emaTauS: 20, maxDeltaWPerTick: 5000, powerEpsilonW: 5 }),
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
    for (let i = 0; i < 3; i++) {
        smoothTick(adapter, 1);
        await new Promise((r) => setImmediate(r));
    }
    assert.ok(states['meter.powerSmooth'], 'powerSmooth state written');
    assert.ok(
        Math.abs(states['meter.powerSmooth'].val) > 0,
        `powerSmooth must leave 0 (got ${states['meter.powerSmooth'].val})`,
    );
    assert.ok(
        Math.abs(states['meter.powerSmooth'].val - adapter.smoother.state.powerW) < 0.2,
        'published powerSmooth tracks smoother state',
    );
}

(async () => {
    await testRateLimitKeepCooldown();
    await testVerifyIdempotent();
    testDiscoverPortPreserve();
    testResolveCloudTruthPrefersCache();
    await testFetchCalibrateTruthOnce();
    testSeedRetryUntilLock();
    testSoftBackoff();
    await testSmoothTickHardStale();
    await testSmoothTickPublishesAbsolutePower();
    console.log('auditFixes.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
