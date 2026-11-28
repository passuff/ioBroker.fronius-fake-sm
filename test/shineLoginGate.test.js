'use strict';

const assert = require('assert');
const { GrowattShineSession } = require('../lib/growattShineSession');
const { handleConnectShineLocal } = require('../lib/localShineAdmin');
const { runRemoteRedirect } = require('../lib/stickSetup');
const {
    seedShineAuthBackoff,
    clearShineAuthBackoff,
    shineLoginBlockedReason,
} = require('../lib/localStatusAdmin');

(async () => {
    let loginCalls = 0;
    const origLogin = GrowattShineSession.prototype.login;
    GrowattShineSession.prototype.login = async function login() {
        loginCalls += 1;
        throw new Error('login must not run while backing off');
    };

    const adapter = {
        config: {
            growattUser: 'u',
            growattPassword: 'secret',
            localStickSn: 'XGD6CK737N',
        },
        log: { info: () => {}, warn: () => {}, debug: () => {} },
        setStateAsync: async () => {},
        sendTo(_from, _cmd, payload) {
            adapter._lastSend = payload;
        },
    };

    clearShineAuthBackoff(adapter);
    seedShineAuthBackoff(adapter, 60 * 60 * 1000, 'test');
    assert.ok(shineLoginBlockedReason(adapter));

    // Admin Connect must early-return with error, zero logins
    loginCalls = 0;
    adapter._lastSend = null;
    await handleConnectShineLocal(adapter, {
        from: 'admin.0',
        command: 'connectShineLocal',
        message: { growattUser: 'u', growattPassword: 'secret' },
        callback: 1,
    });
    assert.strictEqual(loginCalls, 0, 'connectShineLocal must not login under backoff');
    assert.ok(adapter._lastSend && adapter._lastSend.error, 'connect returns error payload');
    assert.ok(/Shine-Backoff/i.test(String(adapter._lastSend.error)));

    // Setup remote redirect must skip without login
    loginCalls = 0;
    const redirect = await runRemoteRedirect(adapter, '192.168.1.19', {});
    assert.strictEqual(loginCalls, 0, 'runRemoteRedirect must not login under backoff');
    assert.strictEqual(redirect.ok, false);
    assert.strictEqual(redirect.error, 'shine_backoff');
    assert.ok(redirect.skipped);

    GrowattShineSession.prototype.login = origLogin;
    clearShineAuthBackoff(adapter);
    console.log('shineLoginGate.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
