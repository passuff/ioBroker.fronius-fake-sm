'use strict';

const assert = require('assert');
const {
    handleShineStatus,
    handleStickStatusText,
    handleLocalWorkflowSnapshot,
    _clearStatusCaches,
} = require('../lib/localStatusAdmin');
const { probeStickStatus } = require('../lib/stickOnline');

(async () => {
    _clearStatusCaches();

    // probeStickStatus: remote ok → verbunden
    const okSession = {
        async listDataloggers() {
            return [{ sn: 'XGD1', lost: false, lastUpdateTime: '2026-11-22 10:00:00' }];
        },
        async getRegister() {
            return { success: true, msg: '192.168.1.19' };
        },
    };
    const ok = await probeStickStatus(okSession, '100', 'XGD1');
    assert.strictEqual(ok.online, true);
    assert.ok(ok.text.startsWith('verbunden'));

    // list online but remote fail → nicht verbunden
    const remoteFail = {
        async listDataloggers() {
            return [{ sn: 'XGD1', lost: false }];
        },
        async getRegister() {
            return { success: false, msg: 'inv_set_datalog_lost' };
        },
    };
    const rf = await probeStickStatus(remoteFail, '100', 'XGD1');
    assert.strictEqual(rf.online, false);
    assert.ok(rf.text.includes('Remote-Befehl') || rf.text.includes('nicht verbunden'));

    // handleShineStatus success + cache
    let loginCalls = 0;
    const GrowattShineSession = require('../lib/growattShineSession').GrowattShineSession;
    const origLogin = GrowattShineSession.prototype.login;
    const origList = GrowattShineSession.prototype.listPlants;
    GrowattShineSession.prototype.login = async function login() {
        loginCalls += 1;
    };
    GrowattShineSession.prototype.listPlants = async function listPlants() {
        return [{ id: '1', plantName: 'A' }, { id: '2', plantName: 'B' }];
    };

    const replies = [];
    const adapter = {
        config: {},
        log: { warn() {}, info() {} },
        sendTo(_from, _cmd, payload) {
            replies.push(payload);
        },
    };
    const obj = {
        from: 'admin',
        command: 'shineStatus',
        message: { growattUser: 'u', growattPassword: 'p' },
        callback: 1,
    };
    await handleShineStatus(adapter, obj);
    assert.strictEqual(replies[0], 'verbunden (2 Anlagen)');
    assert.strictEqual(loginCalls, 1);
    await handleShineStatus(adapter, obj);
    assert.strictEqual(replies[1], 'verbunden (2 Anlagen)');
    assert.strictEqual(loginCalls, 1, 'cache must skip second login');

    // After connect: clear + seed → shineStatus returns seeded text without new login
    const { clearStatusCaches, seedShineStatus } = require('../lib/localStatusAdmin');
    clearStatusCaches();
    seedShineStatus('u', 'verbunden (2 Anlagen)');
    loginCalls = 0;
    await handleShineStatus(adapter, obj);
    assert.strictEqual(replies[2], 'verbunden (2 Anlagen)');
    assert.strictEqual(loginCalls, 0, 'seeded cache must skip login');

    // clear after connect must force re-login
    clearStatusCaches();
    await handleShineStatus(adapter, obj);
    assert.strictEqual(loginCalls, 1, 'cleared cache must login again');

    GrowattShineSession.prototype.login = origLogin;
    GrowattShineSession.prototype.listPlants = origList;

    // stickStatusText without SN
    replies.length = 0;
    _clearStatusCaches();
    await handleStickStatusText(adapter, {
        from: 'admin',
        command: 'stickStatusText',
        message: { growattUser: 'u', growattPassword: 'p' },
        callback: 1,
    });
    assert.ok(String(replies[0]).includes('kein Stick'));

    clearStatusCaches();
    seedShineStatus('u', 'verbunden (2 Anlagen)');
    replies.length = 0;
    const snapAdapter = {
        config: {
            localStickSn: 'XGD1',
            localPort: 5279,
            stickRedirects: { XGD1: { state: 'verified', plantName: 'A' } },
        },
        localServer: { listening: true, _clients: new Set() },
        _localFrameStatus: 'ok',
        log: { warn() {}, info() {} },
        async getStateAsync() {
            return { val: 'ok' };
        },
        sendTo(_from, _cmd, payload) {
            replies.push(payload);
        },
    };
    await handleLocalWorkflowSnapshot(snapAdapter, {
        from: 'admin',
        command: 'localWorkflowSnapshot',
        message: { growattUser: 'u', growattPassword: 'p', localStickSn: 'XGD1' },
        callback: 1,
    });
    assert.ok(replies[0] && typeof replies[0] === 'object');
    assert.strictEqual(replies[0].shine.connected, true);
    assert.strictEqual(replies[0].proxy.port, 5279);
    assert.strictEqual(replies[0].setup.canRestore, true);

    console.log('localStatusAdmin.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
