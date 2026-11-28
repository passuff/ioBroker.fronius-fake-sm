'use strict';

const assert = require('assert');
const {
    isLoopbackIp,
    normalizeIp,
    onModbusClientOpen,
    onModbusClientData,
    onModbusClientClose,
    noteModbusClient,
    SHORT_SESSION_MS,
    HEALTHY_POLL_MIN_RX,
} = require('../lib/modbusClientHealth');

assert.strictEqual(normalizeIp('::ffff:192.168.1.80'), '192.168.1.80');
assert.ok(isLoopbackIp('127.0.0.1'));
assert.ok(!isLoopbackIp('192.168.1.80'));
assert.ok(HEALTHY_POLL_MIN_RX >= 3);

const states = {};
const warns = [];
const adapter = {
    config: { froniusIp: '192.168.1.80' },
    log: {
        info() {},
        warn(m) {
            warns.push(m);
        },
        debug() {},
    },
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

// Abort-like short session (no RX) increments streak
adapter._modbusGen24Sockets.get(sock1).openedAt = Date.now() - 1000;
onModbusClientClose(adapter, { socket: sock1, peer: '192.168.1.80:1' });
assert.strictEqual(adapter._modbusShortStreak, 1);
assert.strictEqual(states['info.modbusClientConnected'], false);

// Healthy Gen24 poll: short duration but enough RX — streak resets, no warn
const sock2 = {};
onModbusClientOpen(adapter, {
    remoteAddress: '192.168.1.80',
    peer: '192.168.1.80:3',
    socket: sock2,
});
const buf = Buffer.alloc(12);
buf.writeUInt8(3, 6);
buf.writeUInt8(3, 7);
buf.writeUInt16BE(768, 8);
buf.writeUInt16BE(1, 10);
for (let i = 0; i < HEALTHY_POLL_MIN_RX; i++) {
    onModbusClientData(adapter, { socket: sock2, peer: '192.168.1.80:3', buf });
}
adapter._modbusGen24Sockets.get(sock2).openedAt = Date.now() - 5500;
const warnsBefore = warns.length;
onModbusClientClose(adapter, { socket: sock2, peer: '192.168.1.80:3' });
assert.strictEqual(adapter._modbusShortStreak, 0, 'healthy short poll must clear streak');
assert.strictEqual(warns.length, warnsBefore, 'healthy short poll must not warn');

// Three abort sessions → warn; Loc3 hint when invisible and stick present
adapter._gen24MeterVisible = false;
adapter._proxyClientCountLive = 1;
for (let i = 0; i < 3; i++) {
    const s = {};
    onModbusClientOpen(adapter, {
        remoteAddress: '192.168.1.80',
        peer: `192.168.1.80:${10 + i}`,
        socket: s,
    });
    adapter._modbusGen24Sockets.get(s).openedAt = Date.now() - 800;
    onModbusClientClose(adapter, { socket: s, peer: `192.168.1.80:${10 + i}` });
}
assert.ok(adapter._modbusShortStreak >= 3);
assert.ok(warns.some((w) => String(w).includes('Loc3 not visible')));

// No stick → short-session warn without Loc3 hint
adapter._modbusShortStreak = 0;
adapter._proxyClientCountLive = 0;
adapter._gen24MeterVisible = false;
const warnsBeforeNoStick = warns.length;
for (let i = 0; i < 3; i++) {
    const s = {};
    onModbusClientOpen(adapter, {
        remoteAddress: '192.168.1.80',
        peer: `192.168.1.80:${20 + i}`,
        socket: s,
    });
    adapter._modbusGen24Sockets.get(s).openedAt = Date.now() - 800;
    onModbusClientClose(adapter, { socket: s, peer: `192.168.1.80:${20 + i}` });
}
assert.ok(warns.length > warnsBeforeNoStick);
assert.ok(
    !warns.slice(warnsBeforeNoStick).some((w) => String(w).includes('Loc3 not visible')),
    'no stick → no Loc3 hint on short-session warn',
);

noteModbusClient(adapter, '127.0.0.1');
assert.ok(SHORT_SESSION_MS >= 1000);
console.log('modbusClientHealth.test.js ok');
