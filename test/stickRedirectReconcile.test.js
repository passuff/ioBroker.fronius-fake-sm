'use strict';

const assert = require('assert');
const {
    upsertStick,
    getStickEntry,
    listRedirectedSns,
} = require('../lib/stickRedirectRegistry');
const { reconcileRedirectRegistry } = require('../lib/stickRedirectReconcile');
const { buildLocalWorkflowSnapshot } = require('../lib/localWorkflowStatus');

(async () => {
    // --- Multi-stick: A on proxy, B SERVERIP cloud → only B demoted, mode stays local ---
    {
        const cfg = {
            growattFeedMode: 'local',
            advertisedModbusIp: '192.168.1.19',
            localSetupVerified: true,
            cloudStickRedirectActive: true,
            stickRedirects: {},
        };
        upsertStick(cfg, 'AAAA', { state: 'verified' });
        upsertStick(cfg, 'BBBB', { state: 'verified' });
        const server = {
            _stickBySn: new Map([['AAAA', { destroyed: false }]]),
            hasStickSn(sn) {
                return this._stickBySn.has(sn);
            },
        };
        const adapter = {
            namespace: 'fronius-fake-sm.0',
            config: cfg,
            localServer: server,
            log: { warn() {}, info() {}, debug() {} },
            async setStateAsync() {},
            async getForeignObjectAsync() {
                return { native: { ...adapter.config } };
            },
            async setForeignObjectAsync(_id, obj) {
                Object.assign(adapter.config, obj.native || {});
            },
        };
        const out = await reconcileRedirectRegistry(adapter, {
            probeServerIp: async (sn) => (sn === 'BBBB' ? 'server.growatt.com' : null),
        });
        assert.strictEqual(out.removed.length, 1);
        assert.deepStrictEqual(out.removed, ['BBBB']);
        assert.ok(getStickEntry(adapter.config, 'AAAA'), 'A stays verified');
        assert.strictEqual(getStickEntry(adapter.config, 'BBBB'), null);
        assert.strictEqual(adapter.config.growattFeedMode, 'local');
        const snap = buildLocalWorkflowSnapshot(adapter);
        assert.deepStrictEqual(
            snap.sticks.map((s) => s.sn),
            ['AAAA'],
        );
        assert.strictEqual(snap.sticks[0].redirectState, 'verified');
        assert.strictEqual(snap.sticks[0].online, true);
    }

    // --- Night / no live SERVERIP → keep entry ---
    {
        const cfg = {
            growattFeedMode: 'local',
            advertisedModbusIp: '192.168.1.19',
            stickRedirects: {},
            localSetupVerified: true,
        };
        upsertStick(cfg, 'NIGHT', { state: 'verified' });
        const adapter = {
            namespace: 'fronius-fake-sm.0',
            config: cfg,
            localServer: { hasStickSn: () => false, _stickBySn: new Map() },
            log: { warn() {}, info() {}, debug() {} },
            async setStateAsync() {},
            async getForeignObjectAsync() {
                return { native: { ...adapter.config } };
            },
            async setForeignObjectAsync() {},
        };
        const out = await reconcileRedirectRegistry(adapter, {
            probeServerIp: async () => null,
        });
        assert.deepStrictEqual(out.removed, []);
        assert.ok(getStickEntry(adapter.config, 'NIGHT'));
    }

    // --- Last SN cloud SERVERIP → registry empty + feedMode cloud ---
    {
        const cfg = {
            growattFeedMode: 'local',
            advertisedModbusIp: '192.168.1.19',
            stickRedirects: {},
            localSetupVerified: true,
            localSetupPending: false,
            cloudStickRedirectActive: true,
            cloudStickRedirectSn: 'ONLY',
        };
        upsertStick(cfg, 'ONLY', { state: 'verified' });
        const adapter = {
            namespace: 'fronius-fake-sm.0',
            config: cfg,
            localServer: { hasStickSn: () => false, _stickBySn: new Map() },
            log: { warn() {}, info() {}, debug() {} },
            async setStateAsync() {},
            async getForeignObjectAsync() {
                return { native: { ...adapter.config } };
            },
            async setForeignObjectAsync(_id, obj) {
                Object.assign(adapter.config, obj.native || {});
            },
        };
        const out = await reconcileRedirectRegistry(adapter, {
            probeServerIp: async () => '47.254.130.145',
        });
        assert.deepStrictEqual(out.removed, ['ONLY']);
        assert.strictEqual(out.fellBack, true);
        assert.deepStrictEqual(listRedirectedSns(adapter.config), []);
        assert.strictEqual(adapter.config.growattFeedMode, 'cloud');
        assert.strictEqual(adapter.config.localSetupVerified, false);
    }

    // --- Orphan demote even when feedMode already cloud ---
    {
        const cfg = {
            growattFeedMode: 'cloud',
            advertisedModbusIp: '192.168.1.19',
            stickRedirects: {},
            localSetupVerified: false,
        };
        upsertStick(cfg, 'ORPHAN', { state: 'verified' });
        const adapter = {
            namespace: 'fronius-fake-sm.0',
            config: cfg,
            localServer: { hasStickSn: () => false, _stickBySn: new Map() },
            log: { warn() {}, info() {}, debug() {} },
            async setStateAsync() {},
            async getForeignObjectAsync() {
                return { native: { ...adapter.config } };
            },
            async setForeignObjectAsync(_id, obj) {
                Object.assign(adapter.config, obj.native || {});
            },
        };
        const out = await reconcileRedirectRegistry(adapter, {
            probeServerIp: async () => 'server.growatt.com',
        });
        assert.deepStrictEqual(out.removed, ['ORPHAN']);
        assert.strictEqual(getStickEntry(adapter.config, 'ORPHAN'), null);
    }

    // --- Proxy IP must not demote ---
    {
        const cfg = {
            growattFeedMode: 'local',
            advertisedModbusIp: '192.168.1.19',
            stickRedirects: {},
        };
        upsertStick(cfg, 'WAIT', { state: 'verified' });
        const adapter = {
            namespace: 'fronius-fake-sm.0',
            config: cfg,
            localServer: { hasStickSn: () => false, _stickBySn: new Map() },
            log: { warn() {}, info() {}, debug() {} },
            async setStateAsync() {},
            async getForeignObjectAsync() {
                return { native: { ...adapter.config } };
            },
            async setForeignObjectAsync() {},
        };
        const out = await reconcileRedirectRegistry(adapter, {
            probeServerIp: async () => '192.168.1.19',
        });
        assert.deepStrictEqual(out.removed, []);
        assert.ok(getStickEntry(adapter.config, 'WAIT'));
    }

    // --- Pending redirect: Shine still shows cloud SERVERIP — keep entry ---
    {
        const cfg = {
            growattFeedMode: 'local',
            advertisedModbusIp: '192.168.1.19',
            stickRedirects: {},
            localSetupPending: true,
        };
        upsertStick(cfg, 'GPG0CHF1CT', { state: 'pending', serverIp: '192.168.1.19' });
        const adapter = {
            namespace: 'fronius-fake-sm.0',
            config: cfg,
            localServer: { hasStickSn: () => false, _stickBySn: new Map() },
            log: { warn() {}, info() {}, debug() {} },
            async setStateAsync() {},
            async getForeignObjectAsync() {
                return { native: { ...adapter.config } };
            },
            async setForeignObjectAsync() {
                throw new Error('pending must not persist demotion');
            },
        };
        const out = await reconcileRedirectRegistry(adapter, {
            probeServerIp: async () => '47.254.130.145',
        });
        assert.deepStrictEqual(out.removed, []);
        assert.ok(getStickEntry(adapter.config, 'GPG0CHF1CT'));
        assert.strictEqual(getStickEntry(adapter.config, 'GPG0CHF1CT').state, 'pending');
    }

    // --- Mid-setup: no demotion at all (avoids restart aborting redirect) ---
    {
        const cfg = {
            growattFeedMode: 'local',
            advertisedModbusIp: '192.168.1.19',
            stickRedirects: {},
        };
        upsertStick(cfg, 'GPG0CHF1CT', { state: 'verified' });
        const adapter = {
            namespace: 'fronius-fake-sm.0',
            _setupInProgress: true,
            config: cfg,
            localServer: { hasStickSn: () => false, _stickBySn: new Map() },
            log: { warn() {}, info() {}, debug() {} },
            async setStateAsync() {},
            async getForeignObjectAsync() {
                return { native: { ...adapter.config } };
            },
            async setForeignObjectAsync() {
                throw new Error('setup must not demote');
            },
        };
        const out = await reconcileRedirectRegistry(adapter, {
            probeServerIp: async () => '47.254.130.145',
        });
        assert.deepStrictEqual(out.removed, []);
        assert.ok(getStickEntry(adapter.config, 'GPG0CHF1CT'));
    }

    console.log('stickRedirectReconcile.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
