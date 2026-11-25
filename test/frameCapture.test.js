'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    FrameCapture,
    rememberAesSession,
    forgetAesSession,
    parseStopWhen,
    startFrameCapture,
} = require('../lib/frameCapture');
const { crc16Modbus } = require('../lib/growattProto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));

function aesSizedFrame(func, cipherLen) {
    const cipher = Buffer.alloc(cipherLen, 0xab);
    const body = Buffer.concat([Buffer.from([1, func]), cipher]);
    const header = Buffer.alloc(6);
    header.writeUInt16BE(1, 0);
    header.writeUInt16BE(0x0006, 2);
    header.writeUInt16BE(body.length, 4);
    const crcBuf = Buffer.alloc(2);
    crcBuf.writeUInt16BE(crc16Modbus(Buffer.concat([header, body])), 0);
    return Buffer.concat([header, body, crcBuf]);
}

// parseStopWhen
assert.deepStrictEqual(parseStopWhen({ stopWhen: { wire: 4, minLen: 100 } }), {
    wire: 4,
    wires: [4],
    minLen: 100,
});
assert.deepStrictEqual(parseStopWhen({ stopWhen: { wires: [3, 4], minLen: 100 } }).wires, [3, 4]);
assert.strictEqual(parseStopWhen({ stopWhen: false }), null);

// remember / forget
const adapter = { _lastAesSessions: undefined, config: { localStickSn: 'XGD6CJH2Y0' } };
rememberAesSession(adapter, {
    serial: 'XGD6CJH2Y0',
    key: 'AABBCCDDEEFF00112233445566778899',
    iv: '2233445566778899',
    source: 'up',
});
rememberAesSession(adapter, {
    serial: 'XGD6CJH2Y0',
    key: 'nu45B11629C09814270247EB3F2U0000',
    iv: '270247EB3F2U0000',
    source: 'down',
});
assert.strictEqual(adapter._lastAesSessions.get('XGD6CJH2Y0').entries.length, 2);
forgetAesSession(adapter, 'XGD6CJH2Y0');
assert.strictEqual(adapter._lastAesSessions.has('XGD6CJH2Y0'), false);

// replay keys into capture
rememberAesSession(adapter, {
    serial: 'XGD6CJH2Y0',
    key: 'AABBCCDDEEFF00112233445566778899',
    iv: '2233445566778899',
    source: 'up',
});
const cap = new FrameCapture({ dir: tmp, durationMs: 5000, log: () => {} });
cap.start();
const n = cap.replayAesSessions(adapter._lastAesSessions, 'XGD6CJH2Y0');
assert.strictEqual(n, 1);
assert.ok(cap._keySources.has('up'));
const body = fs.readFileSync(cap.filePath, 'utf8');
assert.ok(body.includes('replay=1'));
assert.ok(body.includes('source=up'));
cap.stop('manual');

// stopWhen matches UP 0x04 after keys present
const cap2 = new FrameCapture({
    dir: tmp,
    durationMs: 10000,
    stopWhen: { wire: 4, minLen: 100 },
    log: () => {},
});
cap2.start();
cap2.noteAesSession('XGD6CJH2Y0', 'AABBCCDDEEFF00112233445566778899', '2233445566778899', 'up');
const frame = aesSizedFrame(0x04, 256); // total 6+258+2 = 266
assert.ok(frame.length >= 100);
cap2.onUp(frame);
assert.strictEqual(cap2.active, false);
const stopLine = fs.readFileSync(cap2.filePath, 'utf8');
assert.ok(stopLine.includes('reason=matched'));

// startFrameCapture wires replay + stopWhen
const fakeAdapter = {
    _lastAesSessions: adapter._lastAesSessions,
    _frameCapture: null,
    config: { localStickSn: 'XGD6CJH2Y0' },
    namespace: 'fronius-fake-sm.0',
    adapterDir: path.join(tmp, 'node_modules', 'iobroker.fronius-fake-sm'),
    log: { info: () => {}, warn: () => {} },
    async setStateAsync() {
        return null;
    },
    getDataFolder() {
        return tmp;
    },
};
rememberAesSession(fakeAdapter, {
    serial: 'XGD6CJH2Y0',
    key: 'CA1F9051A69D34AF2C275B168EC6745B',
    iv: '2C275B168EC6745B',
    source: 'up',
});
(async () => {
    const res = await startFrameCapture(fakeAdapter, {
        minutes: 1,
        stopWhen: { wire: 4, minLen: 100 },
    });
    assert.ok(res.ok);
    assert.ok(res.replayedKeys >= 1);
    assert.deepStrictEqual(res.stopWhen, { wire: 4, wires: [4], minLen: 100 });
    fakeAdapter._frameCapture.stop('test');
    console.log('frameCapture.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
