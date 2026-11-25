'use strict';

const assert = require('assert');
const {
    BOOTSTRAP_KEY,
    snPad32,
    unmaskSnField,
    deriveSessionKeyIv,
    parse041UpPayload,
    tryParse041UpFrame,
    aesCbcEncrypt,
    aesCbcDecrypt,
    encodeAesDownFrame,
} = require('../lib/growattAesKdf');
const { AesSession } = require('../lib/growattAesSession');

const UP_HEX =
    '00010006005601411f352b41223f4373632b6d7050617373776f7264262a32303234303733302e21' +
    '46706e66f745f5435bb3d5bd31d4e97ab59b6b9ddb3d1cb3593c8213dd52b7d6048d8d27ff161c4f' +
    '3aeee0d7ee85f9f2831da444';

assert.strictEqual(BOOTSTRAP_KEY.length, 32);

const sn32 = snPad32('XGD6CK737N');
assert.strictEqual(sn32.length, 32);
assert.strictEqual(sn32.toString('ascii').replace(/\0+$/, ''), 'XGD6CK737N');

const masked = Buffer.alloc(32);
for (let i = 0; i < 32; i++) {
    masked[i] = sn32[i] ^ BOOTSTRAP_KEY[i];
}
assert.strictEqual(unmaskSnField(masked).toString('ascii'), 'XGD6CK737N');

const raw = Buffer.from(UP_HEX, 'hex');
const info = tryParse041UpFrame(raw);
assert.ok(info, 'parse 0x41 UP');
assert.strictEqual(info.serial, 'XGD6CK737N');
assert.strictEqual(info.tag4.toString('ascii'), 'Fpnf');
assert.strictEqual(info.rand16.toString('hex'), 'f745f5435bb3d5bd31d4e97ab59b6b9d');
// Firmware-verified KDF secret is 'GROWATT_NYHL&JKYW_TEST_20240729.' (FW_3117
// §5, seed-crack bit-exact). The old 'Growatt@TempPassword&*20240730.!' is only
// the SN-field XOR mask and yielded the superseded 69174481…/35E9701A… vectors.
// NB: deriving from the WIRE rand16 is a diagnostic candidate only — the real
// session key comes from the internal RandNum via seed recovery.
assert.strictEqual(info.keyUpper.toString('ascii'), '07151E72C180E6790AABC083FE624970');
assert.strictEqual(info.ivUpper.toString('ascii'), '0AABC083FE624970');
assert.strictEqual(info.keyLower.toString('ascii'), '07151e72c180e6790aabc083fe624970');
// legacy misparse kept as candidate
assert.strictEqual(info.rand16Legacy.toString('hex'), '46706e66f745f5435bb3d5bd31d4e97a');
assert.strictEqual(info.keyLegacyUpper.toString('ascii'), 'F23F218CD4DC08FD9CDF75842F947AFF');

const body = raw.subarray(8, raw.length - 2);
const again = parse041UpPayload(body);
assert.strictEqual(again.serial, info.serial);

const d = deriveSessionKeyIv(info.rand16);
assert.ok(d.key.equals(info.keyUpper));
assert.ok(d.iv.equals(info.ivUpper));

// AES-DOWN encrypt ↔ decrypt roundtrip (session key from 0x41 UP)
const plain = Buffer.from('XGD6CK737N-payload-test-pad!!', 'ascii');
const enc = aesCbcEncrypt(info.keyUpper, info.ivUpper, plain, true);
assert.ok(enc && enc.length >= 16);
const dec = aesCbcDecrypt(info.keyUpper, info.ivUpper, enc, true);
assert.ok(dec);
assert.strictEqual(dec.toString('ascii'), plain.toString('ascii'));

const down = encodeAesDownFrame({
    txn: 7,
    proto: 0x0006,
    unit: 1,
    func: 0x18,
    payloadPlain: Buffer.from('hello-fota-lab', 'ascii'),
    session: { key: info.keyUpper, iv: info.ivUpper },
});
assert.ok(down);
assert.strictEqual(down.readUInt16BE(2), 0x0006);
assert.strictEqual(down[6], 0x01);
assert.strictEqual(down[7], 0x18);

const sess = new AesSession();
assert.ok(sess.observeUp(raw));
assert.ok(sess.ready);
assert.strictEqual(sess.serial, 'XGD6CK737N');
const encDown = sess.encryptDown({
    func: 0x06,
    payloadPlain: Buffer.from('Datalog_CycleFota_ON\0', 'ascii'),
    txn: 3,
});
assert.ok(encDown && encDown.length > 20);

console.log('growattAesKdf.test.js OK');
