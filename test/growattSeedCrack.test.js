'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { deriveFromSeed, frameCipher, recoverSessionKey, recoverSessionKeyAsync } = require('../lib/growattSeedCrack');
const { AesSession } = require('../lib/growattAesSession');

const SN = 'XGD6CJH2Y0';
const EXPECT_SEED = 606430;
const EXPECT_KEY = '33B4BC873B54F090E331BDCF141A4355';

const d = deriveFromSeed(EXPECT_SEED, SN);
assert.strictEqual(d.key.toString('ascii'), EXPECT_KEY);
assert.strictEqual(d.iv.toString('ascii'), EXPECT_KEY.slice(16));

const cap = path.join(__dirname, '..', '..', 'fw-analysis', 'captures', 'capture-2026-11-23T19-30-09.log');
assert.ok(fs.existsSync(cap), 'capture missing');
let upRaw = null;
for (const ln of fs.readFileSync(cap, 'utf8').split(/\r?\n/)) {
    const m = ln.match(/hex=([0-9a-fA-F]+)/);
    if (!m || !/ UP /.test(ln) || !/wire=0x0*(3|4)\b/.test(ln)) continue;
    const raw = Buffer.from(m[1], 'hex');
    if (raw.readUInt16BE(4) >= 0x80) {
        upRaw = raw;
        break;
    }
}
assert.ok(upRaw, 'no UP data frame');
const cipher = frameCipher(upRaw);
assert.ok(cipher && cipher.length >= 16);

const hit = recoverSessionKey({ cipher, serial: SN, loSeed: 0, hiSeed: 1 << 21 });
assert.ok(hit, 'sync recover failed');
assert.strictEqual(hit.seed, EXPECT_SEED);
assert.strictEqual(hit.key.toString('ascii'), EXPECT_KEY);
assert.ok(hit.plain.includes(Buffer.from(SN)));

recoverSessionKeyAsync({ cipher, serial: SN, tiers: [[0, 1 << 21]], chunk: 8192 }).then((asyncHit) => {
    assert.ok(asyncHit, 'async recover failed');
    assert.strictEqual(asyncHit.seed, EXPECT_SEED);

    const aes = new AesSession();
    aes.serial = SN;
    assert.ok(aes.looksLikeAesData(upRaw));
    return aes.scheduleSeedRecover(upRaw).then((r) => {
        assert.ok(r, 'AesSession recover failed');
        assert.strictEqual(r.seed, EXPECT_SEED);
        const dec = aes.tryDecrypt(upRaw);
        assert.ok(dec && dec.plain.includes(Buffer.from(SN)), 'tryDecrypt after recover');
        console.log('growattSeedCrack.test.js OK');
    });
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
