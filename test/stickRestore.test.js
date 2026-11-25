'use strict';

const assert = require('assert');
const { MSG } = require('../lib/stickMessages');
const { clearLocalModeToCloud, tryLocalTcpRestore, CLOUD_HOST, CLOUD_PORT } = require('../lib/stickRestore');

(async () => {
    assert.strictEqual(CLOUD_HOST, 'server.growatt.com');
    assert.strictEqual(CLOUD_PORT, 5279);
    assert.ok(MSG.restoreOk('XGD').includes('server.growatt.com'));

    let stopped = false;
    let writes = 0;
    const native = {
        growattFeedMode: 'local',
        localEnabled: true,
        localSetupPending: true,
        localSetupVerified: true,
        manufacturer: 'growatt',
    };
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: { ...native },
        localServer: {
            async stop() {
                stopped = true;
            },
        },
        log: { warn: () => {}, info: () => {} },
        getForeignObjectAsync: async () => ({ native }),
        setForeignObjectAsync: async (_id, obj) => {
            writes += 1;
            Object.assign(native, obj.native);
        },
        setStateAsync: async () => {},
    };

    await clearLocalModeToCloud(adapter);
    assert.strictEqual(adapter.config.growattFeedMode, 'cloud');
    assert.strictEqual(adapter.config.localEnabled, false);
    assert.strictEqual(adapter.config.localSetupPending, false);
    assert.strictEqual(adapter.config.localSetupVerified, false);
    assert.strictEqual(native.growattFeedMode, 'cloud');
    assert.strictEqual(native.localSetupVerified, false);
    assert.strictEqual(writes, 1);
    assert.strictEqual(stopped, false, 'Growatt always-on → proxy stays after restore');
    assert.ok(adapter.localServer);

    // Legacy localProxyAlwaysOn=false is ignored — proxy still kept
    stopped = false;
    const nativeKeep = {
        growattFeedMode: 'local',
        localEnabled: true,
        localSetupPending: true,
        localSetupVerified: true,
        localProxyAlwaysOn: false,
        manufacturer: 'growatt',
    };
    const adapterKeep = {
        namespace: 'fronius-fake-sm.0',
        config: { ...nativeKeep },
        localServer: {
            async stop() {
                stopped = true;
            },
        },
        log: { warn: () => {}, info: () => {} },
        getForeignObjectAsync: async () => ({ native: nativeKeep }),
        setForeignObjectAsync: async (_id, obj) => {
            Object.assign(nativeKeep, obj.native);
        },
        setStateAsync: async () => {},
    };
    await clearLocalModeToCloud(adapterKeep);
    assert.strictEqual(stopped, false);
    assert.ok(adapterKeep.localServer);

    // Second clear — no native write if already cloud-clean
    writes = 0;
    adapter.localServer = null;
    adapter.config.growattFeedMode = 'cloud';
    await clearLocalModeToCloud(adapter);
    assert.strictEqual(writes, 0);

    // Local TCP restore uses persistRedirect
    let redirected = null;
    const adapter2 = {
        localServer: {
            persistRedirect(sn, host, port) {
                redirected = { sn, host, port };
                return true;
            },
        },
    };
    const local = tryLocalTcpRestore(adapter2, 'XGD6CK737N');
    assert.strictEqual(local.ok, true);
    assert.deepStrictEqual(redirected, { sn: 'XGD6CK737N', host: CLOUD_HOST, port: CLOUD_PORT });

    assert.strictEqual(tryLocalTcpRestore({ localServer: null }, 'X').ok, false);

    console.log('stickRestore.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
