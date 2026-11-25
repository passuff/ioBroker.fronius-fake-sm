'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const {
    crc16Modbus,
    xorGrowatt,
    encodeFrame,
    decodeFrame,
    buildAck,
    FrameSplitter,
} = require('../lib/growattProto');
const {
    extractSn,
    bodyAfterSn,
    parseDataRecord,
    AutoCalibrator,
    isDataFunc,
    isRealtimeDataFunc,
} = require('../lib/growattRecord');

// Realtime-vs-data func gate: 0x03 is a buffered/announce record (zero realtime
// fields on 3.1.0.x) — it stays a "data" func (SN/health/ACK) but must NOT feed
// the Modbus mirror, otherwise it injects 0 W between live 0x04 updates.
assert.strictEqual(isDataFunc(0x03), true, '0x03 is a data func (SN/health)');
assert.strictEqual(isRealtimeDataFunc(0x03), false, '0x03 is NOT realtime (no Modbus feed)');
assert.strictEqual(isRealtimeDataFunc(0x04), true, '0x04 realtime');
assert.strictEqual(isRealtimeDataFunc(0x50), true, '0x50 realtime');

// CRC known vector: empty payload ping-like
const ping = encodeFrame({
    proto: 0x0006,
    unit: 1,
    func: 0x16,
    payloadPlain: Buffer.concat([
        Buffer.from('XGD6CJH2Y0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0'),
        Buffer.from([0, 0]),
    ]),
    txn: 1,
});
assert.ok(ping.length >= 10);
const decoded = decodeFrame(ping);
assert.strictEqual(decoded.proto, 0x0006);
assert.strictEqual(decoded.func, 0x16);
assert.strictEqual(decoded.crcOk, true);
assert.strictEqual(extractSn(decoded.payload), 'XGD6CJH2Y0');

// Roundtrip XOR
const plain = Buffer.from([1, 4, 0x41, 0x42]);
assert.deepStrictEqual(xorGrowatt(xorGrowatt(plain)), plain);

// Regression: REAL ShineWiFi-X 3.1.0.2 data frame (func 0x04) captured live
// from lab stick XGD6CJH2Y0 with the fake inverter at ~1500 W (+wobble).
// Header (8 bytes incl. unit/func) is CLEAR; payload XOR'd from byte 8. The
// modbus CRC does NOT match (stick zero-fills the trailer) — crcOk must be
// false, yet unit/func/SN/pac must decode correctly.
{
    const realHex =
        '001d0006010101041f352b41223e3c752b5f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f77617f55663f22756174746b726e7761340f462c6f5f6174343c726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f485967fc4f8e6f3161744b7f726f77617474475f6f2e61747447726f7761747447726f776174744772407760f2bb47726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f7761747447726f';
    const real = Buffer.from(realHex, 'hex');
    const rf = decodeFrame(real);
    assert.strictEqual(rf.proto, 0x0006, 'real frame proto');
    assert.strictEqual(rf.unit, 0x01, 'real frame unit clear on wire');
    assert.strictEqual(rf.func, 0x04, 'real frame func clear on wire (not XOR-mangled)');
    assert.strictEqual(rf.crcOk, false, 'real 3.1.0.2 frame CRC is advisory (zero-filled trailer)');
    assert.strictEqual(extractSn(rf.payload), 'XGD6CJH2Y0', 'datalogger SN decodes');
    const realBody = bodyAfterSn(rf.payload);
    assert.strictEqual(realBody.readUInt16BE(113), 16184, 'pac raw @ body+113 (0.1 W)');
    assert.ok(Math.abs(realBody.readUInt16BE(113) / 10 - 1618.4) < 0.01, 'pac = 1618.4 W');
}

// FrameSplitter reassembles split TCP chunks
const splitter = new FrameSplitter();
assert.deepStrictEqual(splitter.push(ping.subarray(0, 4)), []);
const rest = splitter.push(ping.subarray(4));
assert.strictEqual(rest.length, 1);
assert.deepStrictEqual(rest[0], ping);

// AES mid-session: CRC outside length (cipher len % 16 == 0)
{
    const { crc16Modbus: crc } = require('../lib/growattProto');
    const cipher = Buffer.alloc(48, 0xab);
    const body = Buffer.concat([Buffer.from([1, 0x19]), cipher]);
    const header = Buffer.alloc(6);
    header.writeUInt16BE(1, 0);
    header.writeUInt16BE(0x0006, 2);
    header.writeUInt16BE(body.length, 4); // CRC *not* in length
    const crcBuf = Buffer.alloc(2);
    crcBuf.writeUInt16BE(crc(Buffer.concat([header, body])), 0);
    const aesFrame = Buffer.concat([header, body, crcBuf]);
    assert.strictEqual(aesFrame.length, 6 + body.length + 2);

    const sp = new FrameSplitter();
    // residue CRC must not desync the next frame
    const out = sp.push(Buffer.concat([aesFrame, ping]));
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out[0], aesFrame);
    assert.deepStrictEqual(out[1], ping);
}

// ACK has valid CRC (data + ping)
const ack = buildAck(decoded);
assert.strictEqual(decodeFrame(ack).crcOk, true);
assert.strictEqual(decodeFrame(ack).func, 0x16);

// Without layout: not parsed (no SEED feed)
const snPad = Buffer.alloc(30);
Buffer.from('XGDTEST01').copy(snPad);
const body = Buffer.alloc(80);
body.writeUInt32BE(12340, 0x2a); // 1234.0 W at scale 0.1
body.writeUInt32BE(5000, 0x3e); // 500.0 kWh
const payload = Buffer.concat([snPad, body]);
const unparsed = parseDataRecord({
    payload,
    func: 0x04,
    proto: 0x0006,
    frameLen: 100,
    layout: null,
});
assert.strictEqual(unparsed.parsed, false);
assert.strictEqual(unparsed.pac_w, null);
assert.strictEqual(unparsed.sn, 'XGDTEST01');

// allowSeed only for explicit tests
const seeded = parseDataRecord({
    payload,
    func: 0x04,
    proto: 0x0006,
    frameLen: 100,
    layout: null,
    allowSeed: true,
});
assert.strictEqual(seeded.parsed, true);

// AutoCalibrator locks matching pac offset
const cal = new AutoCalibrator({ neededHits: 2, tolerance: 0.05 });
assert.strictEqual(cal.observe(body, { pac: 1234, etotal: 500 }), null);
const locked = cal.observe(body, { pac: 1234, etotal: 500 });
assert.ok(locked);
assert.strictEqual(cal.calibrated, true);
assert.strictEqual(locked.pacOff, 0x2a);

const parsed = parseDataRecord({
    payload,
    func: 0x04,
    proto: 0x0006,
    frameLen: 100,
    layout: locked,
});
assert.strictEqual(parsed.sn, 'XGDTEST01');
assert.ok(Math.abs(parsed.pac_w - 1234) < 0.01);
assert.ok(bodyAfterSn(payload).length === body.length);

// layoutFromNative requires real offset
assert.strictEqual(AutoCalibrator.layoutFromNative({ localCalibrated: true }), null);
assert.strictEqual(AutoCalibrator.layoutFromNative({ localCalibrated: true, localPacOffset: '' }), null);
assert.ok(AutoCalibrator.layoutFromNative({ localPacOffset: 42, localPacScale: 0.1 }));

// Fail path after enough daytime attempts with candidates but high neededHits
const failCal = new AutoCalibrator({ neededHits: 99, failAfterAttempts: 2, tolerance: 0.05 });
failCal.observe(body, { pac: 1234, etotal: 500 });
failCal.observe(body, { pac: 1234, etotal: 500 });
assert.strictEqual(failCal.failed, true);
assert.ok(failCal.failReason.includes('auto-calibrate failed'));

// Disabled auto-calibrate
const off = new AutoCalibrator({ enabled: false });
assert.strictEqual(off.observe(body, { pac: 1234, etotal: 500 }), null);
assert.strictEqual(off.failed, true);

assert.strictEqual(typeof crc16Modbus(Buffer.from([1, 2, 3])), 'number');

// Python roundtrip against scripts/growatt_proto_craft.py (encode-ping)
const craft = path.resolve(__dirname, '../../scripts/growatt_proto_craft.py');
const py = spawnSync('python', [craft, '--txn', '1', 'encode-ping', '--sn', 'XGD6CJH2Y0'], {
    encoding: 'utf8',
});
if (py.status === 0 && py.stdout.trim()) {
    const hex = py.stdout.trim().split(/\s+/)[0];
    const raw = Buffer.from(hex, 'hex');
    const d = decodeFrame(raw);
    assert.strictEqual(d.crcOk, true);
    assert.strictEqual(d.func, 0x16);
    assert.strictEqual(extractSn(d.payload), 'XGD6CJH2Y0');
    // JS re-encode same content should decode equivalently
    const again = encodeFrame({
        proto: d.proto,
        unit: d.unit,
        func: d.func,
        payloadPlain: d.payload,
        txn: d.txn,
    });
    assert.strictEqual(decodeFrame(again).crcOk, true);
    console.log('growattProto.test.js OK (incl. python roundtrip)');
} else {
    console.log('growattProto.test.js OK (python craft skipped:', (py.stderr || py.error || 'no output').toString().slice(0, 80), ')');
}
