'use strict';

const assert = require('assert');
const {
    upsertStick,
    removeStick,
    getStickEntry,
    listRedirectedSns,
    deriveAggregateFlags,
} = require('../lib/stickRedirectRegistry');
const { maybeFallbackUnpatchedLocal } = require('../lib/stickRedirectGuard');
const { computeFeedStickSns } = require('../lib/localProxyMode');
const { buildRegistrySummary } = require('../lib/localWorkflowStatus');
const { loadAllStickOptions, _clearStickListCache } = require('../lib/localShineAdmin');

(async () => {
    // Patching B must not clear A
    const cfg = { stickRedirects: {} };
    upsertStick(cfg, 'AAAA', { state: 'verified' });
    upsertStick(cfg, 'BBBB', { state: 'pending' });
    assert.strictEqual(getStickEntry(cfg, 'AAAA').state, 'verified');
    assert.strictEqual(getStickEntry(cfg, 'BBBB').state, 'pending');
    assert.deepStrictEqual(listRedirectedSns(cfg), ['AAAA', 'BBBB']);
    const flags = deriveAggregateFlags(cfg);
    assert.strictEqual(flags.localSetupVerified, true);
    assert.strictEqual(flags.localSetupPending, true);

    // Remove B — A remains local
    removeStick(cfg, 'BBBB');
    assert.strictEqual(getStickEntry(cfg, 'AAAA').state, 'verified');
    assert.strictEqual(cfg.localSetupVerified, true);
    assert.strictEqual(cfg.cloudStickRedirectActive, true);

    // Fallback for unpatched SN keeps feed mode
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: {
            growattFeedMode: 'local',
            advertisedModbusIp: '192.168.1.19',
            stickRedirects: { AAAA: { state: 'verified', since: 1 } },
            localSetupVerified: true,
            cloudStickRedirectActive: true,
            cloudStickRedirectSn: 'AAAA',
        },
        log: { warn() {}, info() {} },
        async setStateAsync() {},
        async getForeignObjectAsync() {
            return { native: { ...adapter.config } };
        },
        async setForeignObjectAsync() {},
    };
    const fb = await maybeFallbackUnpatchedLocal(adapter, 'server.growatt.com', 'NEWSTICK');
    assert.strictEqual(fb.fellBack, false);
    assert.strictEqual(adapter.config.growattFeedMode, 'local');
    assert.ok(getStickEntry(adapter.config, 'AAAA'));

    // Feed sticks: without devices → verified SNs
    assert.deepStrictEqual(
        computeFeedStickSns({
            stickRedirects: {
                AAAA: { state: 'verified' },
                BBBB: { state: 'pending' },
            },
        }),
        ['AAAA'],
    );

    // Summary
    const summary = buildRegistrySummary(
        { stickRedirects: { AAAA: { state: 'verified' }, BBBB: { state: 'pending' } } },
        {
            _stickBySn: new Map([['AAAA', {}]]),
            hasStickSn(sn) {
                return this._stickBySn.has(sn);
            },
        },
    );
    assert.ok(summary.includes('AAAA: verbunden'));
    assert.ok(summary.includes('BBBB: wartet'));

    // listLocalSticks across plants (no plantId required)
    _clearStickListCache();
    const session = {
        async listPlants() {
            return [
                { id: '1', plantName: 'Haus' },
                { id: '2', plantName: 'Garage' },
            ];
        },
        async listDataloggers(pid) {
            if (pid === '1') {
                return [{ sn: 'S1', lost: false, plantName: 'Haus' }];
            }
            return [{ sn: 'S2', lost: true, plantName: 'Garage' }];
        },
    };
    const { options, plantBySn } = await loadAllStickOptions(session, 'user1', {
        stickRedirects: { S2: { state: 'verified' } },
    });
    assert.strictEqual(options.length, 2);
    assert.ok(options.find((o) => o.value === 'S1').label.includes('Haus'));
    assert.ok(options.find((o) => o.value === 'S2').label.includes('Umleitung: hier'));
    assert.strictEqual(plantBySn.S1, '1');
    assert.strictEqual(plantBySn.S2, '2');

    console.log('multiStickRedirect.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
