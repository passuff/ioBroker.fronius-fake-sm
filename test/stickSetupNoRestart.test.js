'use strict';

const assert = require('assert');
const { ensureLocalProxyReady, persistLocalSetupArmed } = require('../lib/stickSetup');

(async () => {
    // ensureLocalProxyReady must NOT write native — that restarts mid-setup ("DB closed")
    let objectWrites = 0;
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: {
            growattFeedMode: 'local',
            localSetupPending: false,
            localPort: 5279,
            advertisedModbusIp: '192.168.1.19',
        },
        localServer: {
            redirectServerIp: '',
            redirectServerPort: 0,
            autoPersistRedirect: false,
        },
        log: { warn: () => {}, info: () => {}, debug: () => {} },
        getForeignObjectAsync: async () => {
            throw new Error('ensureLocalProxyReady must not read/write native');
        },
        setForeignObjectAsync: async () => {
            objectWrites += 1;
            throw new Error('ensureLocalProxyReady must not write native');
        },
        setStateAsync: async () => {},
    };

    const ok = await ensureLocalProxyReady(adapter, '192.168.1.19');
    assert.strictEqual(ok, true);
    assert.strictEqual(objectWrites, 0, 'arming proxy must not restart the instance');
    assert.strictEqual(adapter.config.localSetupPending, true);
    assert.strictEqual(adapter.localServer.redirectServerIp, '192.168.1.19');
    assert.strictEqual(adapter.localServer.redirectServerPort, 5279);

    // persistLocalSetupArmed skips write when already pending+local
    let writes = 0;
    const native = { localSetupPending: true, growattFeedMode: 'local' };
    const adapter2 = {
        namespace: 'fronius-fake-sm.0',
        config: { localSetupPending: false, growattFeedMode: 'cloud' },
        log: { warn: () => {} },
        getForeignObjectAsync: async () => ({ native }),
        setForeignObjectAsync: async () => {
            writes += 1;
        },
    };
    assert.strictEqual(await persistLocalSetupArmed(adapter2), false);
    assert.strictEqual(writes, 0);
    assert.strictEqual(adapter2.config.localSetupPending, true);
    assert.strictEqual(adapter2.config.growattFeedMode, 'local');

    // First arm after a fresh install does write once
    const nativeFresh = { localSetupPending: false, growattFeedMode: 'local' };
    const adapter3 = {
        namespace: 'fronius-fake-sm.0',
        config: { localSetupPending: false, growattFeedMode: 'local' },
        log: { warn: () => {} },
        getForeignObjectAsync: async () => ({ native: nativeFresh }),
        setForeignObjectAsync: async (_id, obj) => {
            writes += 1;
            Object.assign(nativeFresh, obj.native);
        },
    };
    assert.strictEqual(await persistLocalSetupArmed(adapter3), true);
    assert.strictEqual(writes, 1);
    assert.strictEqual(nativeFresh.localSetupPending, true);

    console.log('stickSetupNoRestart.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
