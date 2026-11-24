'use strict';

// Regression: two distinct sticks (different peer IPs) must COEXIST instead of
// fighting over a single global session. Only same-IP zombies get replaced.
// This reproduces the live reconnect storm where a lab stick (192.168.1.200) and
// the real prod stick (192.168.1.38) replaced each other ~every 0.8s, which
// prevented either from completing the 0x41 -> seed-recover -> 0x04 handshake.

const assert = require('assert');
const { GrowattServer } = require('../lib/growattServer');

function mockSock(ip) {
    return {
        remoteAddress: ip,
        destroyed: false,
        destroy() {
            this.destroyed = true;
        },
    };
}

(async () => {
    const server = new GrowattServer({
        host: '127.0.0.1',
        port: 0,
        forwardCloud: false,
        autoPersistRedirect: false,
        autoCalibrate: false,
        log: () => {},
        debug: () => {},
        error: () => {},
    });

    const lab = mockSock('192.168.1.200');
    const prod = mockSock('192.168.1.38');
    const labZombie = mockSock('192.168.1.200');
    server._clients.add(lab);
    server._clients.add(prod);
    server._clients.add(labZombie);

    // A fresh connect from the lab IP must drop ONLY the lab sockets, not prod.
    const dropped = server.dropClientsByIp('192.168.1.200');
    assert.strictEqual(dropped, 2, 'both lab-IP sockets dropped');
    assert.strictEqual(lab.destroyed, true, 'lab zombie destroyed');
    assert.strictEqual(labZombie.destroyed, true, 'lab zombie destroyed');
    assert.strictEqual(prod.destroyed, false, 'prod stick (different IP) survives');

    // ::ffff: IPv4-mapped prefix is tolerated on both sides.
    const prod6 = mockSock('::ffff:192.168.1.38');
    server._clients.add(prod6);
    const d2 = server.dropClientsByIp('192.168.1.38');
    assert.strictEqual(d2, 2, 'plain prod + mapped prod both dropped by plain IP');
    assert.strictEqual(prod.destroyed, true);
    assert.strictEqual(prod6.destroyed, true);

    // Empty/unknown IP is a no-op (never nukes everything).
    assert.strictEqual(server.dropClientsByIp(''), 0, 'empty IP drops nothing');
    assert.strictEqual(server.dropClientsByIp(null), 0, 'null IP drops nothing');

    // sumFreshSamples(filterSn): with a designated local stick, a foreign stick's
    // sample (e.g. the real prod stick) must NOT be summed into the local mirror.
    const now = Date.now();
    server.stickSamples.set('XGD6CJH2Y0', { pac_w: 1850, e_total_kwh: 10010, u1: 230, f: 50, at: now });
    server.stickSamples.set('XGD6CK737N', { pac_w: 0, e_total_kwh: 2685, u1: 233, f: 50, at: now });

    const all = server.sumFreshSamples(90000);
    assert.strictEqual(all.pac_w, 1850, 'unfiltered sums both sticks (0 + 1850)');

    const labOnly = server.sumFreshSamples(90000, 'XGD6CJH2Y0');
    assert.strictEqual(labOnly.pac_w, 1850, 'filtered to lab stick');
    assert.strictEqual(labOnly.sn, 'XGD6CJH2Y0', 'filtered sample carries lab SN');

    const prodOnly = server.sumFreshSamples(90000, 'XGD6CK737N');
    assert.strictEqual(prodOnly.pac_w, 0, 'filtered to prod stick only (0 W)');
    assert.strictEqual(prodOnly.sn, 'XGD6CK737N', 'filtered sample carries prod SN');

    // Multi-stick / multi-plant: a SET of selected feed sticks is summed together.
    server.stickSamples.set('XGD9ABCDEF', { pac_w: 500, e_total_kwh: 42, u1: 231, f: 50, at: now });
    const twoPlants = server.sumFreshSamples(90000, ['XGD6CJH2Y0', 'XGD9ABCDEF']);
    assert.strictEqual(twoPlants.pac_w, 2350, 'two selected plants summed (1850 + 500)');
    assert.strictEqual(twoPlants.stickCount, 2, 'two sticks counted');
    const asSet = server.sumFreshSamples(90000, new Set(['XGD9ABCDEF']));
    assert.strictEqual(asSet.pac_w, 500, 'Set filter works too');

    // GrowattServer.isFeedStick: feed set gates which sticks are decoded locally.
    const multi = new GrowattServer({
        host: '127.0.0.1',
        port: 0,
        forwardCloud: false,
        feedStickSns: ['XGD6CJH2Y0', 'XGD9ABCDEF'],
        log: () => {},
        debug: () => {},
        error: () => {},
    });
    assert.strictEqual(multi.isFeedStick('XGD6CJH2Y0'), true, 'selected stick is a feed stick');
    assert.strictEqual(multi.isFeedStick('XGD9ABCDEF'), true, 'second selected stick is a feed stick');
    assert.strictEqual(multi.isFeedStick('XGD6CK737N'), false, 'unselected stick is forward-only');

    const anyServer = new GrowattServer({
        host: '127.0.0.1',
        port: 0,
        forwardCloud: false,
        log: () => {},
        debug: () => {},
        error: () => {},
    });
    assert.strictEqual(anyServer.isFeedStick('WHATEVER'), true, 'empty feed set mirrors any stick (legacy)');

    console.log('sessionMultiStick.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
