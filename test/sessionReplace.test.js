'use strict';

const assert = require('assert');
const net = require('net');
const { GrowattServer } = require('../lib/growattServer');

(async () => {
    const counts = [];
    const server = new GrowattServer({
        host: '127.0.0.1',
        port: 0,
        forwardCloud: false,
        autoPersistRedirect: false,
        autoCalibrate: false,
        onClientCount: (n) => counts.push(n),
        log: () => {},
        debug: () => {},
        error: () => {},
    });
    await server.start();
    const port = server._netServer.address().port;

    const a = net.connect({ host: '127.0.0.1', port });
    await new Promise((r) => a.on('connect', r));
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(server._clients.size, 1);

    const b = net.connect({ host: '127.0.0.1', port });
    await new Promise((r) => b.on('connect', r));
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(server._clients.size, 1, 'second connect replaces first');

    const n = server.dropClients();
    assert.ok(n >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(server._clients.size, 0);

    await server.stop();
    console.log('sessionReplace.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
