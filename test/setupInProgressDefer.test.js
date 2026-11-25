'use strict';

const assert = require('assert');
const { markLocalSetupVerified } = require('../lib/localProxy');
const { rememberStickRedirect } = require('../lib/stickRedirectGuard');

(async () => {
    let writes = 0;
    const native = {
        growattFeedMode: 'local',
        stickRedirects: {},
        localSetupVerified: false,
        localSetupPending: true,
        localEnabled: false,
    };
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        _setupInProgress: true,
        _deferredVerifySn: null,
        config: {
            growattFeedMode: 'local',
            stickRedirects: {},
            localSetupVerified: false,
            localSetupPending: true,
            localEnabled: false,
            advertisedModbusIp: '192.168.1.19',
        },
        localServer: null,
        log: { warn: () => {}, info: () => {}, debug: () => {} },
        getForeignObjectAsync: async () => ({ native }),
        setForeignObjectAsync: async () => {
            writes += 1;
        },
        setStateAsync: async () => {},
    };

    await markLocalSetupVerified(adapter, 'GPG0CHF1CT');
    assert.strictEqual(writes, 0, 'markLocalSetupVerified must not persist during setup');
    assert.strictEqual(adapter._deferredVerifySn, 'GPG0CHF1CT');
    assert.ok(adapter.config.stickRedirects.GPG0CHF1CT);
    assert.strictEqual(adapter.config.stickRedirects.GPG0CHF1CT.state, 'verified');

    writes = 0;
    adapter.config.stickRedirects = {};
    adapter._deferredVerifySn = null;
    const remembered = await rememberStickRedirect(adapter, 'XGD6C8737N');
    assert.strictEqual(remembered, false);
    assert.strictEqual(writes, 0, 'rememberStickRedirect must not persist during setup');
    assert.ok(adapter.config.stickRedirects.XGD6C8737N);

    // Post-setup quiet also defers
    adapter._setupInProgress = false;
    adapter._postSetupQuietUntil = Date.now() + 60_000;
    adapter.config.stickRedirects = {};
    adapter._deferredVerifySn = null;
    writes = 0;
    await markLocalSetupVerified(adapter, 'GPG0CHF1CT');
    assert.strictEqual(writes, 0, 'quiet window must not persist');

    // After quiet ends, persist is allowed
    adapter._postSetupQuietUntil = 0;
    adapter.config.stickRedirects = {};
    adapter._deferredVerifySn = null;
    await markLocalSetupVerified(adapter, 'GPG0CHF1CT');
    assert.ok(writes >= 1, 'markLocalSetupVerified persists after quiet');

    console.log('setupInProgressDefer.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
