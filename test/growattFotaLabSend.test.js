'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { applyServerCommands } = require('../lib/growattServerCommands');
const { decodeFrame } = require('../lib/growattProto');

function makeFakeServer() {
    function S() {
        this._clients = new Set();
        this._stickBySn = new Map();
        this._redirectDoneFor = new Set();
        this.fotaLabStickSns = ['XGDLABTEST01'];
        this.logs = [];
        this.errors = [];
        this.log = (m) => this.logs.push(m);
        this.error = (m) => this.errors.push(m);
    }
    applyServerCommands(S);
    return new S();
}

class FakeSock extends EventEmitter {
    constructor() {
        super();
        this.destroyed = false;
        this.written = [];
    }
    write(buf) {
        this.written.push(Buffer.from(buf));
        return true;
    }
}

const LAB = 'XGDLABTEST01';
const PROD = 'XGD6CK737N';

{
    const srv = makeFakeServer();
    const sock = new FakeSock();
    srv._clients.add(sock);
    srv._stickBySn.set(LAB, sock);

    const blocked = srv.sendFotaParamSetLab(PROD, {
        host: '10.0.0.1',
        path: '/u.bin',
    });
    assert.strictEqual(blocked.ok, false);
    assert.ok(/blocklist|allowlist|FOTA/i.test(blocked.reason || ''));
    assert.strictEqual(sock.written.length, 0);

    const ok = srv.sendFotaParamSetLab(LAB, {
        host: '10.0.0.1',
        path: '/u.bin',
        port: 80,
    });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.sent, 1);
    assert.strictEqual(sock.written.length, 1);
    const dec = decodeFrame(sock.written[0]);
    assert.strictEqual(dec.func, 0x18);
    assert.ok(dec.payload.toString('ascii').includes('##10.0.0.1/u.bin/#80#'));
}

{
    const srv = makeFakeServer();
    const sock = new FakeSock();
    srv._stickBySn.set(LAB, sock);
    const noConfirm = srv.sendFotaCycleLab(LAB, {
        host: '10.0.0.1',
        path: '/u.bin',
    });
    assert.strictEqual(noConfirm.ok, false);
    assert.ok(/confirmCycleFota/.test(noConfirm.reason || ''));

    const cyc = srv.sendFotaCycleLab(LAB, {
        host: '10.0.0.1',
        path: '/u.bin',
        confirmCycleFota: true,
    });
    assert.strictEqual(cyc.ok, true);
    assert.strictEqual(cyc.sent, 2);
    assert.strictEqual(decodeFrame(sock.written[0]).func, 0x18);
    assert.strictEqual(decodeFrame(sock.written[1]).func, 0x06);
}

console.log('growattFotaLabSend.test.js OK');
