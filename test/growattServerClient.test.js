'use strict';

/**
 * Regression: attachStickClient is a plain function — handleStickFrame must get
 * `server`, not `this` (undefined), or the first stick frame crashes the adapter.
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const { attachStickClient } = require('../lib/growattServerClient');
const { encodeFrame } = require('../lib/growattProto');

function makeFakeServer() {
    const debugMsgs = [];
    /** @type {string[]} */
    const sticks = [];
    return {
        connectCount: 0,
        forwardCloud: false,
        replyAckWhenNoForward: false,
        defaultSerial: '',
        _clients: new Set(),
        _pendingToStick: new Map(),
        _stickBySn: new Map(),
        dropClientsByIp: () => 0,
        log: () => {},
        debug: (m) => {
            debugMsgs.push(String(m));
        },
        error: () => {},
        onPeer: () => {},
        onStick: (sn) => {
            sticks.push(String(sn));
        },
        onClientClose: () => {},
        onSample: () => {},
        onFrame: () => {},
        isFeedStick: () => true,
        _emitClientCount: () => {},
        _reportFrameHealth: () => {},
        debugMsgs,
        sticks,
    };
}

function makeFakeSock() {
    const sock = new EventEmitter();
    sock.remoteAddress = '192.168.1.38';
    sock.remotePort = 12345;
    sock.destroyed = false;
    sock.setKeepAlive = () => {};
    sock.setTimeout = () => {};
    sock.destroy = () => {
        sock.destroyed = true;
        sock.emit('close');
    };
    sock.write = () => true;
    return sock;
}

(async () => {
    const server = makeFakeServer();
    const sock = makeFakeSock();

    let clientsWhenPeer = null;
    server.onPeer = () => {
        clientsWhenPeer = server._clients.size;
    };

    assert.doesNotThrow(() => attachStickClient(server, sock));
    assert.strictEqual(server.connectCount, 1);
    assert.strictEqual(server._clients.size, 1);
    assert.strictEqual(
        clientsWhenPeer,
        1,
        'onPeer must run after _clients.add so localConnection sees the socket',
    );

    const frame = encodeFrame({
        proto: 0x0006,
        unit: 1,
        func: 0x16,
        payloadPlain: Buffer.concat([
            Buffer.from('XGD6CK737N\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0'),
            Buffer.from([0, 0]),
        ]),
        txn: 1,
    });

    assert.doesNotThrow(() => sock.emit('data', frame));
    await new Promise((r) => setImmediate(r));

    assert.ok(
        server.sticks.includes('XGD6CK737N') || server.debugMsgs.length > 0,
        'frame path must use server (debug/onStick), not crash on undefined this',
    );

    sock.destroy();
    console.log('growattServerClient.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
