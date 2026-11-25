'use strict';

const assert = require('assert');
const {
    isLoopbackIp,
    normalizeIp,
    onModbusClientOpen,
    onModbusClientClose,
    noteModbusClient,
    SHORT_SESSION_MS,
} = require('../lib/modbusClientHealth');

assert.strictEqual(normalizeIp('::ffff:192.168.1.80'), '192.168.1.80');
assert.ok(isLoopbackIp('127.0.0.1'));
assert.ok(!isLoopbackIp('192.168.1.80'));

const states = {};
const adapter = {
    config: { froniusIp: '192.168.1.80' },
    log: { info() {}, warn() {}, debug() {} },
    async setStateAsync(id, obj) {
        states[id] = obj && obj.val;
    },
};

const sock1 = {};
const open = onModbusClientOpen(adapter, {
    remoteAddress: '192.168.1.80',
    peer: '192.168.1.80:1',
    socket: sock1,
});
assert.strictEqual(open.track, true);
assert.strictEqual(adapter._modbusClientFromFronius, true);
assert.strictEqual(states['info.modbusClientConnected'], true);

const quiet = onModbusClientOpen(adapter, {
    remoteAddress: '127.0.0.1',
    peer: '127.0.0.1:2',
    socket: {},
});
assert.strictEqual(quiet.quiet, true);
assert.strictEqual(adapter._modbusGen24Sockets.size, 1);

// Force short session
adapter._modbusGen24Sockets.get(sock1).openedAt = Date.now() - 1000;
onModbusClientClose(adapter, { socket: sock1, peer: '192.168.1.80:1' });
assert.strictEqual(adapter._modbusShortStreak, 1);
assert.strictEqual(states['info.modbusClientConnected'], false);

noteModbusClient(adapter, '127.0.0.1');
assert.ok(SHORT_SESSION_MS >= 1000);
console.log('modbusClientHealth.test.js ok');
