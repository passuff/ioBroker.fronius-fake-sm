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
const { extractSn, bodyAfterSn, parseDataRecord, AutoCalibrator } = require('../lib/growattRecord');

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

// FrameSplitter reassembles split TCP chunks
const splitter = new FrameSplitter();
assert.deepStrictEqual(splitter.push(ping.subarray(0, 4)), []);
const rest = splitter.push(ping.subarray(4));
assert.strictEqual(rest.length, 1);
assert.deepStrictEqual(rest[0], ping);

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
