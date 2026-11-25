'use strict';

const assert = require('assert');
const { handleConnectShineLocal } = require('../lib/localShineAdmin');
const { handleShineStatus, _clearStatusCaches } = require('../lib/localStatusAdmin');

(async () => {
    _clearStatusCaches();
    const GrowattShineSession = require('../lib/growattShineSession').GrowattShineSession;
    const origLogin = GrowattShineSession.prototype.login;
    const origList = GrowattShineSession.prototype.listPlants;
    const origLogs = GrowattShineSession.prototype.listDataloggers;
    let loginCalls = 0;
    GrowattShineSession.prototype.login = async function login() {
        loginCalls += 1;
    };
    GrowattShineSession.prototype.listPlants = async function listPlants() {
        return [{ id: '100', plantName: 'A' }];
    };
    GrowattShineSession.prototype.listDataloggers = async function listDataloggers() {
        return [{ sn: 'XGD1', lost: false }];
    };

    const replies = [];
    const adapter = {
        config: {},
        log: { warn() {}, info() {} },
        async setStateAsync() {},
        sendTo(_from, _cmd, payload) {
            replies.push(payload);
        },
    };

    await handleConnectShineLocal(adapter, {
        from: 'admin',
        command: 'connectShineLocal',
        message: { growattUser: 'user1', growattPassword: 'secret' },
        callback: 1,
    });
    assert.ok(replies[0] && replies[0].native && replies[0].native.shineStatusTick > 0);
    assert.strictEqual(typeof replies[0].native.shineStatusTick, 'number');

    // shineStatus must hit seeded cache (no extra login beyond connect's login)
    const loginsAfterConnect = loginCalls;
    await handleShineStatus(adapter, {
        from: 'admin',
        command: 'shineStatus',
        message: { growattUser: 'user1', growattPassword: 'secret' },
        callback: 1,
    });
    assert.strictEqual(replies[1], 'verbunden (1 Anlage)');
    assert.strictEqual(loginCalls, loginsAfterConnect, 'seeded after connect');

    GrowattShineSession.prototype.login = origLogin;
    GrowattShineSession.prototype.listPlants = origList;
    GrowattShineSession.prototype.listDataloggers = origLogs;
    console.log('connectShineRefresh.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
