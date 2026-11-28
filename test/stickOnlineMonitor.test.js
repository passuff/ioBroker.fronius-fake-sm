'use strict';

const assert = require('assert');
const {
    startStickOnlineMonitor,
    stopStickOnlineMonitor,
    publishLocalOnlyStatus,
} = require('../lib/stickOnlineMonitor');
const { seedShineAuthBackoff, clearShineAuthBackoff, isShineAuthBackingOff } = require('../lib/localStatusAdmin');

(async () => {
    let loginCalls = 0;
    let published = [];
    const adapter = {
        config: {
            manufacturer: 'growatt',
            localStickSn: 'XGD6CK737N',
            advertisedModbusIp: '192.168.1.19',
            growattUser: 'u',
            growattPassword: 'p',
        },
        localServer: { _clients: new Set([{}]) },
        log: { info: () => {}, warn: () => {}, debug: () => {} },
        setStateAsync: async () => {},
        _stopping: false,
    };

    // publishLocalOnlyStatus never needs Shine
    const snap = await publishLocalOnlyStatus(adapter, true, 'Shine-Backoff — nur lokaler Proxy-Status');
    assert.ok(snap.text.includes('lokal am Proxy') || snap.text.includes('Shine-Backoff'));
    assert.strictEqual(snap.localConnected, true);

    // With backoff active, monitor tick must not call GrowattShineSession.login
    const Shine = require('../lib/growattShineSession').GrowattShineSession;
    const origLogin = Shine.prototype.login;
    Shine.prototype.login = async function login() {
        loginCalls += 1;
        throw new Error('login should not run during backoff');
    };

    clearShineAuthBackoff(adapter);
    seedShineAuthBackoff(adapter, 60 * 60 * 1000, 'test-lock');
    assert.strictEqual(isShineAuthBackingOff(adapter), true);

    // Drive one tick by using a tiny firstDelay and waiting
    startStickOnlineMonitor(adapter, { firstDelayMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    stopStickOnlineMonitor(adapter);
    assert.strictEqual(loginCalls, 0, 'monitor must skip Shine login while backing off');

    Shine.prototype.login = origLogin;
    clearShineAuthBackoff(adapter);
    console.log('stickOnlineMonitor.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
