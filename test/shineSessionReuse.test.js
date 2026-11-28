'use strict';

const assert = require('assert');
const { GrowattShineSession } = require('../lib/growattShineSession');
const { sessionFromAdapter, clearSharedShineSession } = require('../lib/stickOnline');
const {
    persistStickOnlineFlag,
    applyStickStatusToNative,
} = require('../lib/stickOnlineState');
const {
    CACHE_MS,
    clearStatusCaches,
    noteShineAuthFailure,
    seedShineAuthBackoff,
    isShineAuthBackingOff,
    shineLoginBlockedReason,
    clearShineAuthBackoff,
    AUTH_BACKOFF_MAX_MS,
} = require('../lib/localStatusAdmin');

(async () => {
    // login() reuses cookie within TTL — one network login for N ensure calls
    let posts = 0;
    const s = new GrowattShineSession({ user: 'u', password: 'p', log: () => {} });
    s.postForm = async () => {
        posts += 1;
        s.cookie = 'JSESSIONID=abc';
        return { status: 200, data: { result: 1 } };
    };
    await s.login();
    await s.login();
    await s.login();
    assert.strictEqual(posts, 1, 'reuse must skip /login when session fresh');
    s.invalidate();
    await s.login();
    assert.strictEqual(posts, 2, 'invalidate forces re-login');

    // Parallel login coalesces to one in-flight request
    posts = 0;
    const s2 = new GrowattShineSession({ user: 'u', password: 'p', log: () => {} });
    let resolvePost;
    s2.postForm = () =>
        new Promise((resolve) => {
            posts += 1;
            resolvePost = () => {
                s2.cookie = 'JSESSIONID=x';
                resolve({ status: 200, data: { result: 1 } });
            };
        });
    const p1 = s2.login();
    const p2 = s2.login();
    resolvePost();
    await Promise.all([p1, p2]);
    assert.strictEqual(posts, 1, 'parallel login shares one in-flight /login');

    // sessionFromAdapter returns the same instance for identical creds
    const adapter = {
        config: {
            growattUser: 'alice',
            growattPassword: 'secret',
            growattShineUrl: 'https://server.growatt.com',
        },
        log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    clearSharedShineSession(adapter);
    const a = sessionFromAdapter(adapter);
    const b = sessionFromAdapter(adapter);
    assert.ok(!a.error && !b.error);
    assert.strictEqual(a.session, b.session, 'shared Shine session per adapter');
    clearSharedShineSession(adapter);

    // persistStickOnlineFlag never writes native (selection belongs to setup/save)
    const native = { localStickSn: 'OLD', stickCloudOnline: false };
    const writes = [];
    const pa = {
        namespace: 'fronius-fake-sm.0',
        config: { ...native },
        log: { info: () => {}, warn: () => {} },
        getForeignObjectAsync: async () => ({ native: { ...native } }),
        setForeignObjectAsync: async (_id, obj) => {
            writes.push(obj);
            Object.assign(native, obj.native);
        },
        setStateAsync: async () => {},
    };
    await persistStickOnlineFlag(pa, true, {
        localStickSn: 'NEWSTICK01',
        stickStatusText: 'online',
    });
    assert.strictEqual(writes.length, 0, 'status path must not write native');
    assert.strictEqual(pa.config.localStickSn, 'NEWSTICK01');
    assert.strictEqual(native.localStickSn, 'OLD');
    assert.strictEqual(applyStickStatusToNative(native, true, 'x', { localStickSn: 'Z' }), false);

    // Admin cache TTL raised; auth backoff suppresses retries
    assert.ok(CACHE_MS >= 5 * 60 * 1000, 'admin Shine cache must be >= 5 min');
    clearShineAuthBackoff(adapter);
    clearStatusCaches();
    noteShineAuthFailure(adapter, new Error('account locked'));
    assert.strictEqual(isShineAuthBackingOff(adapter), true);
    assert.ok(shineLoginBlockedReason(adapter));
    assert.ok(AUTH_BACKOFF_MAX_MS >= 24 * 60 * 60 * 1000);
    assert.ok(adapter._shineAuthUntil - Date.now() > 23 * 60 * 60 * 1000, 'lock jumps to ~24h backoff');
    clearShineAuthBackoff(adapter);
    seedShineAuthBackoff(adapter, 5000, 'manual');
    assert.strictEqual(isShineAuthBackingOff(adapter), true);
    clearShineAuthBackoff(adapter);
    assert.strictEqual(isShineAuthBackingOff(adapter), false);

    console.log('shineSessionReuse.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
