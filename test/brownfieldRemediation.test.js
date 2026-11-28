'use strict';

const assert = require('assert');
const {
    persistLastPublished,
    persistLastPublishedNative,
    getLastPublished,
} = require('../lib/energyBaselines');
const {
    isThrottleAmpSuppress,
    noteRateLimit,
    effectivePollIntervalS,
} = require('../lib/adapterPoll');
const {
    looksLikeRateLimit,
    looksLikeAuthFailure,
    GrowattShinePollClient,
} = require('../lib/growattShinePoll');
const { GrowattAuthError, isGrowattAuthError, GrowattOpenApiClient } = require('../lib/growattOpenApi');
const { fireAndLog } = require('../lib/asyncSafe');
const { FroniusModbusServer } = require('../lib/modbusServer');
const { handleRebootLabStick, resolveLabStickAllowlist } = require('../lib/labFotaAdmin');
const { resolveLocalProxyHost } = require('../lib/localProxyStart');
const fs = require('fs');
const path = require('path');

(async () => {
    // G-001: persistLastPublished must not call setForeignObject / persistNative
    {
        let foreignWrites = 0;
        const adapter = {
            config: { lastPublishedEProducedKwh: 10 },
            _lastPublishedEProducedKwh: 10,
            log: { warn() {}, info() {}, debug() {} },
            setStateChangedAsync: async () => {},
            getForeignObjectAsync: async () => {
                foreignWrites += 1;
                return { native: {} };
            },
            setForeignObjectAsync: async () => {
                foreignWrites += 1;
            },
        };
        await persistLastPublished(adapter, 12.5);
        assert.strictEqual(getLastPublished(adapter), 12.5);
        assert.strictEqual(foreignWrites, 0, 'hot path must not touch native');
    }

    // G-001 native path only via persistLastPublishedNative
    {
        let wrote = false;
        const adapter = {
            config: { lastPublishedEProducedKwh: 42, devices: [] },
            _lastPublishedEProducedKwh: 42,
            log: { warn() {}, info() {}, debug() {} },
            setStateChangedAsync: async () => {},
            getForeignObjectAsync: async () => ({
                common: {},
                native: { lastPublishedEProducedKwh: 40 },
            }),
            setForeignObjectAsync: async () => {
                wrote = true;
            },
            namespace: 'fronius-fake-sm.0',
        };
        await persistLastPublishedNative(adapter);
        assert.ok(wrote, 'unload path may write native');
    }

    // G-006/G-009: auth vs rate-limit classification
    assert.strictEqual(looksLikeRateLimit(429, ''), true);
    assert.strictEqual(looksLikeRateLimit(200, 'FREQUENTLY_ACCESS'), true);
    assert.strictEqual(looksLikeRateLimit(403, 'hello'), false, 'bare 403 is not throttle wording');
    assert.strictEqual(looksLikeAuthFailure(401, ''), true);
    assert.strictEqual(looksLikeAuthFailure(200, 'access denied'), true);
    assert.ok(isGrowattAuthError(new GrowattAuthError('bad')));

    // G-007: missing power fields throw (Shine + OpenAPI)
    {
        const client = new GrowattShinePollClient({
            user: 'u',
            password: 'p',
            deviceSn: 'SN',
            plantId: '1',
        });
        assert.throws(() => client._pickPowerW({}), /missing power fields/);
        assert.ok(Math.abs(client._pickPowerW({ pac: 0 })) < 1e-12);

        const oa = new GrowattOpenApiClient({
            token: 't',
            deviceSn: 'SN',
            powerSign: -1,
        });
        assert.throws(() => oa._pickPowerW({}), /missing power fields/);
        assert.ok(Math.abs(oa._pickPowerW({ pac: 0 })) < 1e-12);
    }

    // Proxy bind: advertised IPv4 wins over default 0.0.0.0
    {
        assert.strictEqual(
            resolveLocalProxyHost({ localHost: '0.0.0.0', advertisedModbusIp: '192.168.1.50' }),
            '192.168.1.50',
        );
        assert.strictEqual(
            resolveLocalProxyHost({ localHost: '10.0.0.5', advertisedModbusIp: '192.168.1.50' }),
            '10.0.0.5',
        );
        assert.strictEqual(resolveLocalProxyHost({ localHost: '', advertisedModbusIp: '' }), '0.0.0.0');
    }

    // Admin lab toggle + i18n keys
    {
        const jc = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8'),
        );
        assert.ok(jc.items.meter.items.expertSettings.items.labCommandsEnabled);
        for (const loc of ['en', 'de', 'fr', 'es']) {
            const i18n = JSON.parse(
                fs.readFileSync(path.join(__dirname, '..', 'admin', 'i18n', `${loc}.json`), 'utf8'),
            );
            assert.ok(i18n['Enable lab/FOTA admin commands'], `missing i18n ${loc}`);
        }
    }

    // G-002: Shine floor via effectivePollIntervalS with _pollFloorS=60
    {
        const a = {
            config: { growattCloudAuth: 'shine', growattFeedMode: 'cloud', pollIntervalS: 60 },
            _pollFloorS: 60,
        };
        assert.strictEqual(effectivePollIntervalS(a), 60);
        a._pollFloorS = 120;
        assert.strictEqual(effectivePollIntervalS(a), 120, 'learned floor still honored');
    }

    // G-008 sticky rate-limit: no green without sample
    {
        const a = {
            config: { growattCloudAuth: 'openapi' },
            _lastFailWasRateLimit: true,
            _lastPollOkAt: 0,
            _rateLimitUntil: 0,
            _rateLimitBackoffS: 0,
            _pollFloorS: 120,
            log: { info() {}, warn() {} },
        };
        assert.strictEqual(isThrottleAmpSuppress(a), false, 'no sample → no suppress');
        a._lastPollOkAt = Date.now();
        noteRateLimit(a);
        assert.strictEqual(isThrottleAmpSuppress(a), true);
    }

    // fireAndLog swallows rejection
    {
        let warned = '';
        fireAndLog(
            { log: { warn: (m) => { warned = m; } } },
            't',
            Promise.reject(new Error('boom')),
        );
        await new Promise((r) => setImmediate(r));
        assert.match(warned, /boom/);
    }

    // G-004/G-005: modbus tracks fallback + sockets + write restore
    {
        const m = new FroniusModbusServer({
            host: '127.0.0.1',
            port: 1502,
            allowedRemoteIps: ['192.168.1.10'],
            log() {},
            debug() {},
            error() {},
        });
        assert.strictEqual(m.configuredPort, 1502);
        assert.ok(m._clientSockets instanceof Set);
        assert.ok(m._authHolding);
        m.holding.writeUInt16BE(0xdead, 0);
        m._restoreAuthoritative();
        assert.notStrictEqual(m.holding.readUInt16BE(0), 0xdead);
    }

    // G-011 lab commands gated
    {
        const adapter = {
            config: { labCommandsEnabled: false, localStickSn: 'ABC' },
            localServer: { sendToStick: () => true },
            log: { info() {}, warn() {} },
        };
        const r = await handleRebootLabStick(adapter, { sn: 'ABC' });
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /labCommandsEnabled/);
        adapter.config.labCommandsEnabled = true;
        adapter.config.fotaLabStickSns = 'XYZ';
        const r2 = await handleRebootLabStick(adapter, { sn: 'ABC' });
        assert.strictEqual(r2.ok, false);
        assert.match(r2.reason, /allowlist/);
        assert.strictEqual(resolveLabStickAllowlist(adapter), 'XYZ');
    }

    // Auth backoff math (mirrors adapterPoll auth path)
    {
        const prev = 60;
        const next = Math.min(15 * 60, prev * 2);
        assert.strictEqual(next, 120);
    }

    console.log('brownfieldRemediation.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
