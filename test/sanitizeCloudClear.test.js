'use strict';

const assert = require('assert');
const { sanitizeLocalEnabled, shouldRunLocalProxy } = require('../lib/localProxy');
const { MSG } = require('../lib/stickMessages');
const { proxyAlwaysOn, rememberStickRedirect } = require('../lib/stickRedirectGuard');

(async () => {
    // Cloud + stick still pending → keep flags + proxy, only localEnabled off
    let stopped = false;
    let writes = 0;
    let setupStatus = '';
    const native = {
        growattFeedMode: 'cloud',
        localEnabled: true,
        localSetupPending: true,
        localSetupVerified: false,
    };
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: {
            growattFeedMode: 'cloud',
            localEnabled: true,
            localSetupPending: true,
            localSetupVerified: false,
            manufacturer: 'growatt',
        },
        localServer: {
            listening: true,
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
        setStateAsync: async (id, state) => {
            if (id === 'info.setupStatus') {
                setupStatus = state.val;
            }
        },
    };

    await sanitizeLocalEnabled(adapter);
    assert.strictEqual(adapter.config.localEnabled, false);
    assert.strictEqual(adapter.config.localSetupPending, true, 'pending kept until Restore');
    assert.strictEqual(adapter.config.localSetupVerified, false);
    assert.strictEqual(stopped, false, 'proxy must stay up to avoid orphan stick');
    assert.ok(adapter.localServer, 'proxy reference kept');
    assert.ok(String(setupStatus).includes('Growatt-Cloud') || setupStatus === MSG.restoreBeforeCloud);
    assert.strictEqual(shouldRunLocalProxy(adapter), true);

    // Clean cloud → proxy stays (Growatt always-on)
    stopped = false;
    writes = 0;
    const native2 = {
        growattFeedMode: 'cloud',
        localEnabled: false,
        localSetupPending: false,
        localSetupVerified: false,
    };
    const adapter2 = {
        namespace: 'fronius-fake-sm.0',
        config: { manufacturer: 'growatt', ...native2 },
        localServer: {
            async stop() {
                stopped = true;
            },
        },
        log: { warn: () => {}, info: () => {} },
        getForeignObjectAsync: async () => ({ native: native2 }),
        setForeignObjectAsync: async () => {
            writes += 1;
        },
        setStateAsync: async () => {},
    };
    await sanitizeLocalEnabled(adapter2);
    assert.strictEqual(stopped, false, 'always-on keeps proxy in clean cloud mode');
    assert.ok(adapter2.localServer);
    assert.strictEqual(shouldRunLocalProxy(adapter2), true);
    assert.strictEqual(proxyAlwaysOn(adapter2.config), true);

    // Legacy localProxyAlwaysOn=false + no redirect flags → proxy still stays
    stopped = false;
    const native3 = {
        growattFeedMode: 'cloud',
        localEnabled: false,
        localSetupPending: false,
        localSetupVerified: false,
        localProxyAlwaysOn: false,
        cloudStickRedirectActive: false,
    };
    const adapter3 = {
        namespace: 'fronius-fake-sm.0',
        config: { manufacturer: 'growatt', ...native3 },
        localServer: {
            async stop() {
                stopped = true;
            },
        },
        log: { warn: () => {}, info: () => {} },
        getForeignObjectAsync: async () => ({ native: native3 }),
        setForeignObjectAsync: async () => {},
        setStateAsync: async () => {},
    };
    await sanitizeLocalEnabled(adapter3);
    assert.strictEqual(stopped, false, 'legacy opt-out ignored');
    assert.ok(adapter3.localServer);
    assert.strictEqual(shouldRunLocalProxy(adapter3), true);

    // Reinstall: fresh native, stick connects → remember redirect flag
    const native4 = {
        growattFeedMode: 'cloud',
        cloudStickRedirectActive: false,
        localStickSn: 'XGD6CK737N',
    };
    const adapter4 = {
        namespace: 'fronius-fake-sm.0',
        config: { manufacturer: 'growatt', ...native4 },
        log: { warn: () => {}, info: () => {} },
        getForeignObjectAsync: async () => ({ native: { ...native4 } }),
        setForeignObjectAsync: async (_id, obj) => {
            Object.assign(native4, obj.native);
        },
    };
    assert.strictEqual(shouldRunLocalProxy(adapter4), true, 'reinstall: always-on starts proxy');
    const remembered = await rememberStickRedirect(adapter4);
    assert.strictEqual(remembered, true);
    assert.strictEqual(native4.cloudStickRedirectActive, true);
    assert.strictEqual(native4.cloudStickRedirectSn, 'XGD6CK737N');

    console.log('sanitizeCloudClear.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
