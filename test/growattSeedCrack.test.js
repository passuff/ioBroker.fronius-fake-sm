'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    deriveFromSeed,
    frameCipher,
    recoverSessionKey,
    recoverSessionKeyAsync,
    predictSeedTiers,
    centerOutSeeds,
    DEFAULT_SEED_RATE,
    MARGIN_FLOOR,
    resetWarmWorker,
} = require('../lib/growattSeedCrack');
const { AesSession, redactKey } = require('../lib/growattAesSession');

const SN = 'XGD6CJH2Y0';
const EXPECT_SEED = 606430;
const EXPECT_KEY = '33B4BC873B54F090E331BDCF141A4355';

const d = deriveFromSeed(EXPECT_SEED, SN);
assert.strictEqual(d.key.toString('ascii'), EXPECT_KEY);
assert.strictEqual(d.iv.toString('ascii'), EXPECT_KEY.slice(16));

assert.strictEqual(redactKey('ABCD1234EF'), 'ABCD…');
assert.strictEqual(redactKey('ab'), '****');

// Predicted window from lab reconnect progression (109817 → +545s → ~164015)
{
    const t0 = 1_000_000;
    const tiers = predictSeedTiers({ seed: 109817, at: t0 }, t0 + 545_000);
    assert.ok(tiers.length >= 1);
    const [lo, hi, center] = tiers[0];
    assert.ok(164015 >= lo && 164015 < hi, `predicted window [${lo},${hi}) must contain 164015`);
    assert.ok(center != null, 'predicted tier must carry center for center-out');
    // Tighter margin: floor 1000 + 0.05*100*545 = 3725
    const margin = Math.floor(MARGIN_FLOOR + 0.05 * DEFAULT_SEED_RATE * 545);
    assert.ok(hi - lo <= 2 * margin + 2, `window too wide: ${hi - lo}`);
}

// Adaptive rate: faster rate widens pred
{
    const t0 = 1_000_000;
    const slow = predictSeedTiers({ seed: 100000, at: t0, rate: 50 }, t0 + 100_000);
    const fast = predictSeedTiers({ seed: 100000, at: t0, rate: 200 }, t0 + 100_000);
    assert.ok(fast[0][2] > slow[0][2], 'higher rate → higher pred center');
}

// Center-out visits center first, then neighbors
{
    const seq = [...centerOutSeeds(10, 16, 13)];
    assert.deepStrictEqual(seq.slice(0, 5), [13, 12, 14, 11, 15]);
    assert.strictEqual(seq.length, 6);
}

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

(async () => {
    resetWarmWorker();
    const asyncHit = await recoverSessionKeyAsync({
        cipher,
        serial: SN,
        tiers: [[0, 1 << 21]],
    });
    assert.ok(asyncHit, 'async/worker recover failed');
    assert.strictEqual(asyncHit.seed, EXPECT_SEED);

    // Second call reuses warm worker — still finds seed (and should be fast)
    const t2 = Date.now();
    const asyncHit2 = await recoverSessionKeyAsync({
        cipher,
        serial: SN,
        // Center-out: center near EXPECT_SEED so few probes
        tiers: [[EXPECT_SEED - 100, EXPECT_SEED + 100, EXPECT_SEED]],
    });
    const warmMs = Date.now() - t2;
    assert.ok(asyncHit2 && asyncHit2.seed === EXPECT_SEED);
    assert.ok(warmMs < 500, `warm center-out recover took ${warmMs}ms`);
    assert.ok(asyncHit2.scanned != null && asyncHit2.scanned <= 5, `scanned=${asyncHit2.scanned}`);

    // Event loop stays responsive while a longer worker scan runs
    const tStart = Date.now();
    let timerFiredAt = 0;
    const timerP = new Promise((resolve) => {
        setTimeout(() => {
            timerFiredAt = Date.now();
            resolve();
        }, 10);
    });
    const slowP = recoverSessionKeyAsync({
        cipher,
        serial: SN,
        tiers: [
            [0, 50_000],
            [EXPECT_SEED, EXPECT_SEED + 1],
        ],
    });
    await timerP;
    const delay = timerFiredAt - tStart;
    assert.ok(delay < 100, `setTimeout(10) delayed ${delay}ms — event loop blocked`);
    const slowHit = await slowP;
    assert.ok(slowHit && slowHit.seed === EXPECT_SEED);

    // Center-out finds seed near hi of window with few scans (main thread)
    const centerHit = await recoverSessionKeyAsync({
        cipher,
        serial: SN,
        forceMainThread: true,
        chunk: 64,
        tiers: [[EXPECT_SEED - 5000, EXPECT_SEED + 1, EXPECT_SEED]],
    });
    assert.ok(centerHit && centerHit.seed === EXPECT_SEED);
    assert.ok(centerHit.scanned <= 3, `center-out scanned ${centerHit.scanned}`);

    const aes = new AesSession();
    aes.serial = SN;
    assert.ok(aes.looksLikeAesData(upRaw));
    const r = await aes.scheduleSeedRecover(upRaw, {
        tiers: [[0, 1 << 21]],
    });
    assert.ok(r, 'AesSession recover failed');
    assert.strictEqual(r.seed, EXPECT_SEED);
    const dec = aes.tryDecrypt(upRaw);
    assert.ok(dec && dec.plain.includes(Buffer.from(SN)), 'tryDecrypt after recover');

    // _recoverFailed sticky only for same cipher; new cipher clears
    const aes2 = new AesSession();
    aes2.serial = SN;
    aes2._recoverFailed = true;
    aes2._failedCipher = Buffer.alloc(32, 1);
    const r2 = await aes2.scheduleSeedRecover(upRaw, {
        tiers: [[EXPECT_SEED, EXPECT_SEED + 1]],
    });
    assert.ok(r2 && r2.seed === EXPECT_SEED, 'new cipher must clear sticky miss');

    resetWarmWorker();
    console.log('growattSeedCrack.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
