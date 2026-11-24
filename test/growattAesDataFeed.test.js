'use strict';

// Regression: AES data records (func 0x04) must feed the local sample.
// The unit/func live in the CLEAR 8-byte header (raw[6]/raw[7]); the decrypted
// plaintext IS the payload and starts with the datalogger SN. A prior bug read
// plain[0]/plain[1] as unit/func (the 'X'/'G' of the SN), yielding func=0x47 so
// isRealtimeDataFunc() gated every real 0x04/0x50 record out of the Modbus mirror.
// Captured live from the 3.1.1.7 prod-clone lab stick (SN XGD6CJH2Y0).

const assert = require('assert');
const { frameCipher, recoverSessionKey } = require('../lib/growattSeedCrack');
const { AesSession } = require('../lib/growattAesSession');
const { AutoCalibrator } = require('../lib/growattRecord');
const { handleStickFrame } = require('../lib/growattServerFrame');

const SN = 'XGD6CJH2Y0';

// Real UP wire=0x04 len=266 AES data frame (prod-clone, fake inverter ~1850 W).
const FRAME_0x04 =
    '0002000601020104a9fff1d2c3a202509d827040974460f3e937555cf41bc2039298572f8425fd5' +
    '3828bc695d81b5326f1c2931c5fc5383debb575468633da2a5f173b9dbc17259eb147b31fcb5be01' +
    'd4209df1935a17639cf8b8dbc72c2e77ab4e57a008c70dd087927362afbefe28cdc8e2704544fb13' +
    '2bc9a816012ea43e4260e17435d7a0b060bf1fbac6c63a817229fb93fe492a1616665146b66d050c' +
    'd5314e650a6005acb772d601f3f914e312a4a935170ca5a4da0707b6e75792a9736809a4857c6988' +
    'b75bfddee7bc3b0a1926acc2fb351e3b8ea1ac2d9126946bcefb0fd549fb6b1736316a9db7260d2d' +
    '06ef2a9fc5c8f4831b9c071382d3fe9c491e35449377ddf72503d';

// Same session, wire=0x03 (announce/buffered) — must NOT feed a calibrated sample.
const FRAME_0x03 =
    '0002000601020103ae07af744802f684db760c05fdcb988f6f5affdfd45e2498f9459daa4957de4e' +
    '21f41121c48a13db5cae03b7bdd51ec306b48667642ec7132d3af3731a5b406f5cd317eda2115a15' +
    'f9951a8e776d3378d096150fd3adec872dfd55ac47a130c3d748031cd6f92951f70c22152d170a86' +
    'f2f602976f3a10813e22bb80be51e620ce8fb5538671c55dab1132c7b59c2f100650263581df7251' +
    '2be7b726f89d36032861d35e9ef708b28760f655b2b67e11fccd2e405ce35d29ed9f17ec31e1377f' +
    'bb629ceb52226ad3f410a0fc179941845d955586d6d16f3c12639518cf3f10d3198aa7147fad8d52' +
    'efaf38a6a94d0dd07f7c3983abd5abd93d352076b4343a74427d';

const NATIVE = {
    localPacOffset: 113, localPacKind: 'u16', localPacScale: 0.1,
    localEtotalOffset: 155, localEtotalKind: 'u32', localEtotalScale: 0.1,
    localVacOffset: 117, localFacOffset: 115,
};

function mkAes(frameHex) {
    const raw = Buffer.from(frameHex, 'hex');
    const cipher = frameCipher(raw);
    const hit = recoverSessionKey({ cipher, serial: SN, loSeed: 0, hiSeed: 1 << 20 });
    assert.ok(hit, 'seed recover failed');
    const aes = new AesSession();
    aes.serial = SN;
    aes.installRecoveredKey(hit.key, hit.iv, hit.seed);
    assert.ok(aes.ready, 'aes session not ready');
    return { raw, aes };
}

function mkServer() {
    const cal = new AutoCalibrator({ enabled: false });
    cal.setLayout(AutoCalibrator.layoutFromNative(NATIVE));
    assert.ok(cal.calibrated && cal.layout, 'layout not set');
    const samples = [];
    const frames = [];
    return {
        samples,
        frames,
        debug() {},
        log() {},
        _stickBySn: new Map(),
        _redirectDoneFor: new Set(),
        autoPersistRedirect: false,
        redirectServerIp: null,
        forwardCloud: true,
        replyAckWhenNoForward: false,
        calibrator: cal,
        stickSamples: new Map(),
        getCloudTruth() { return null; },
        onStick() {},
        onFrame(f) { frames.push(f); },
        onCalibrated() {},
        onCalibrateFailed() {},
        onSample(s) { samples.push(s); },
    };
}

// 1) func 0x04 → decoded from the CLEAR header and fed as a realtime sample.
{
    const { raw, aes } = mkAes(FRAME_0x04);
    const server = mkServer();
    const stickSock = { _aesSession: aes, destroyed: false, write() {} };
    const res = handleStickFrame(server, raw, stickSock);
    assert.ok(res && res.aesOk, 'AES frame not accepted');
    assert.strictEqual(server.frames.length, 1);
    assert.strictEqual(server.frames[0].func, 0x04, 'func must come from clear header raw[7]');
    assert.strictEqual(server.frames[0].sn, SN, 'SN must be at start of decrypted payload');
    assert.strictEqual(server.samples.length, 1, 'expected one calibrated sample');
    const s = server.samples[0];
    assert.strictEqual(s.calibrated, true);
    assert.strictEqual(s.sn, SN);
    assert.ok(Math.abs(s.pac_w - 1868.9) < 0.5, `pac_w ${s.pac_w} != ~1868.9`);
    assert.ok(Math.abs(s.e_total_kwh - 10000.1) < 0.5, `eTotal ${s.e_total_kwh} != ~10000.1`);
    assert.ok(Math.abs(s.u1 - 230) < 0.5, `vac ${s.u1} != 230`);
    assert.ok(Math.abs(s.f - 50) < 0.5, `fac ${s.f} != 50`);
}

// 2) func 0x03 → decrypts (registers SN) but must NOT emit a calibrated sample.
{
    const { raw, aes } = mkAes(FRAME_0x03);
    const server = mkServer();
    const stickSock = { _aesSession: aes, destroyed: false, write() {} };
    const res = handleStickFrame(server, raw, stickSock);
    assert.ok(res && res.aesOk, '0x03 AES frame should decrypt');
    assert.strictEqual(server.frames[0].func, 0x03, 'func 0x03 from clear header');
    const calibrated = server.samples.filter((s) => s.calibrated);
    assert.strictEqual(calibrated.length, 0, '0x03 must not feed a calibrated realtime sample');
}

console.log('growattAesDataFeed.test.js OK');
