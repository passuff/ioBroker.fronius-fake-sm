'use strict';

// Regression: restore cleared flags + stopped the proxy before the stick switched
// (2026-11-22 15:06) → stick kept reg17=ioBroker, proxy dead, Shine offline = lockout.

const assert = require('assert');
const { decodeFrame } = require('../lib/growattProto');
const { buildRebootFrame } = require('../lib/growattCommands');
const { stickMayPointAtProxy, verifyStickLeftProxy, hasStickSession } = require('../lib/stickRedirectGuard');
const { shouldRunLocalProxy } = require('../lib/localProxy');
const { runRestoreCloud, RESTORE_TIMING } = require('../lib/stickRestore');

delete process.env.GROWATT_USER;
delete process.env.GROWATT_PASSWORD;

Object.assign(RESTORE_TIMING, {
    waitStickMs: 500,
    waitShineMs: 50,
    waitShineNoLocalMs: 50,
    shinePollMs: 10,
    disconnectMs: 200,
    quietMs: 400,
    clearDelayMs: 10,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeServer({ reconnect }) {
    const sock = {};
    const server = {
        _clients: new Set([sock]),
        _stickBySn: new Map([['XGD6CK737N', sock]]),
        connectCount: 1,
        autoPersistRedirect: true,
        stopped: false,
        sent: [],
        resolver: { resolve: async () => '47.254.130.145' },
        persistRedirect(sn, host, port, opts) {
            this.sent.push({ sn, host, port, opts });
            setTimeout(() => {
                this._clients.clear();
                this._stickBySn.clear();
                if (reconnect) {
                    setTimeout(() => {
                        this.connectCount += 1;
                        const again = {};
                        this._clients.add(again);
                        this._stickBySn.set('XGD6CK737N', again);
                    }, 50);
                }
            }, 30);
            return true;
        },
        dropClients() {
            this._clients.clear();
            this._stickBySn.clear();
        },
        dropClientBySn(sn) {
            const s = this._stickBySn.get(sn);
            if (!s) {
                return 0;
            }
            this._clients.delete(s);
            this._stickBySn.delete(sn);
            return 1;
        },
        hasStickSn(sn) {
            const s = this._stickBySn.get(sn);
            return !!(s && !s.destroyed);
        },
        async stop() {
            this.stopped = true;
        },
    };
    return server;
}

function fakeAdapter(server) {
    const native = {
        growattFeedMode: 'cloud',
        localEnabled: false,
        localSetupPending: false,
        localSetupVerified: false,
        manufacturer: 'growatt',
        cloudStickRedirectActive: true,
        cloudStickRedirectSn: 'XGD6CK737N',
        localStickSn: 'XGD6CK737N',
    };
    return {
        native,
        writes: 0,
        namespace: 'fronius-fake-sm.0',
        config: { ...native },
        localServer: server,
        log: { warn() {}, info() {}, debug() {}, error() {} },
        async setStateAsync() {},
        async getForeignObjectAsync() {
            return { native: { ...native } };
        },
        async setForeignObjectAsync(_id, obj) {
            this.writes += 1;
            Object.assign(native, obj.native);
        },
    };
}

(async () => {
    // Redirect memory alone keeps the proxy alive (cloud data path, flags cleared)
    assert.strictEqual(stickMayPointAtProxy({ cloudStickRedirectActive: true }), true);
    assert.strictEqual(stickMayPointAtProxy({}), false);
    assert.strictEqual(
        shouldRunLocalProxy({ config: { growattFeedMode: 'cloud', cloudStickRedirectActive: true } }),
        true,
    );
    assert.strictEqual(
        shouldRunLocalProxy({ config: { growattFeedMode: 'cloud', manufacturer: 'growatt' } }),
        true,
        'always-on keeps proxy in clean cloud mode',
    );
    assert.strictEqual(
        shouldRunLocalProxy({
            config: { growattFeedMode: 'cloud', manufacturer: 'growatt', localProxyAlwaysOn: false },
        }),
        true,
        'legacy localProxyAlwaysOn=false is ignored — proxy stays on',
    );
    assert.strictEqual(
        shouldRunLocalProxy({ config: { growattFeedMode: 'cloud', manufacturer: 'fronius' } }),
        false,
        'non-Growatt leaves proxy off without redirect flags',
    );

    const reboot = decodeFrame(buildRebootFrame('XGD6CK737N'));
    assert.strictEqual(reboot.crcOk, true);
    assert.strictEqual(reboot.func, 0x18);

    // Admin status messages can arrive before localServer is up
    assert.strictEqual(hasStickSession(null, 'XGD6CK737N'), false);
    assert.strictEqual(hasStickSession(null, ''), false);

    // verifyStickLeftProxy: stick that never comes back → left
    const gone = { _clients: new Set(), connectCount: 3 };
    assert.deepStrictEqual(await verifyStickLeftProxy(gone, { disconnectMs: 50, quietMs: 100, pollMs: 10 }), {
        left: true,
        reason: 'quiet',
    });

    // Stick reconnects after the command → restore must FAIL and keep proxy + flags
    const sticky = fakeServer({ reconnect: true });
    const a1 = fakeAdapter(sticky);
    const r1 = await runRestoreCloud(a1, {});
    assert.strictEqual(r1.ok, false, 'reconnecting stick must not count as restored');
    assert.strictEqual(sticky.sent.length, 1);
    assert.strictEqual(sticky.sent[0].host, '47.254.130.145');
    assert.strictEqual(sticky.sent[0].opts.reboot, true);
    assert.strictEqual(sticky.autoPersistRedirect, false, 'restore must not re-redirect the stick');
    await sleep(50);
    assert.strictEqual(sticky.stopped, false, 'proxy must stay up');
    assert.strictEqual(a1.localServer, sticky);
    assert.strictEqual(a1.native.cloudStickRedirectActive, true);

    // Stick leaves and stays away → success, flags cleared, proxy stays (Growatt always-on)
    const leaving = fakeServer({ reconnect: false });
    const a2 = fakeAdapter(leaving);
    const r2 = await runRestoreCloud(a2, {});
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.verified, true);
    assert.strictEqual(r2.native.cloudStickRedirectActive, false);
    await sleep(80);
    assert.strictEqual(a2.native.cloudStickRedirectActive, false);
    assert.strictEqual(leaving.stopped, false, 'Growatt always-on keeps proxy after restore');
    assert.ok(a2.localServer);

    console.log('stickRedirectLockout.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
