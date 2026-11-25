'use strict';

const assert = require('assert');
const { classifyRedirectProbe, verifyRedirectServerIp } = require('../lib/redirectVerify');

assert.deepStrictEqual(classifyRedirectProbe('192.168.1.19', '192.168.1.19'), {
    confirmed: true,
    pending: false,
    host: '192.168.1.19',
});
assert.strictEqual(classifyRedirectProbe('192.168.1.19', '47.254.130.145').confirmed, false);
assert.strictEqual(classifyRedirectProbe('192.168.1.19', '47.254.130.145').pending, false);
assert.strictEqual(classifyRedirectProbe('192.168.1.19', '').pending, true);
assert.strictEqual(classifyRedirectProbe('192.168.1.19', 'server.growatt.com').confirmed, false);

(async () => {
    const session = {
        async getRegister() {
            return { msg: '47.254.130.145' };
        },
    };
    const r = await verifyRedirectServerIp(session, 'GPG0CHF1CT', '192.168.1.19');
    assert.strictEqual(r.confirmed, false);
    assert.strictEqual(r.host, '47.254.130.145');

    const okSession = {
        async getRegister() {
            return { msg: '192.168.1.19' };
        },
    };
    const ok = await verifyRedirectServerIp(okSession, 'GPG0CHF1CT', '192.168.1.19');
    assert.strictEqual(ok.confirmed, true);
    console.log('redirectVerify.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
