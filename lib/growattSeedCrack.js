'use strict';

/**
 * Offline recovery of a ShineWiFi-X 3.1.1.7 AES session key from a captured
 * data frame by brute-forcing the 32-bit RNG seed.
 *
 * Firmware model (bit-exact, see docs/FW_3117_FRAME_ANALYSIS.md §1/§5):
 *   RandKey_Init re-seeds fresh each key-negotiation cycle:
 *     seed32 = *0x3fff294c           (FUN_402a7610, printf "...seed = %u")
 *     srand(seed32)                  (FUN_402a2e58: state=(seed,0))
 *     for i in 16: b[i] = rand()&0xff (FUN_402a2e68: state=state*M+1,
 *                                      out=(state>>32)&0x7fffffff)
 *     for i in 10: b[i] ^= DataLogSN[i]
 *   key = UpperHex16(SHA256(b || SESSION_SECRET))   (32 ASCII bytes)
 *   iv  = key[16:32]
 *
 * The datalogger serial appears in cleartext at the start of every decrypted
 * UP data frame, giving a near-zero-false-positive oracle (10-byte match).
 *
 * Note: pure-JS brute is single-threaded; for a full 2^32 sweep use the Python
 * multiprocess tool scripts/_crack_seed_mp.py. This module is for small/known
 * seed ranges and for deriving/verifying a key once the seed is known.
 */

const crypto = require('crypto');
const { SESSION_SECRET } = require('./growattAesKdf');

// newlib/MMIX 64-bit LCG multiplier.
const M = 0x5851f42d4c957f2dn;
const MASK64 = (1n << 64n) - 1n;

/**
 * Reproduce RandNum[16] and derive {key, iv} for a given 32-bit seed.
 * @param {number} seed
 * @param {Buffer|string} serial datalogger SN (first 10 bytes XOR'd into rand)
 * @param {Buffer} [secret32]
 * @returns {{ seed:number, rand:Buffer, key:Buffer, iv:Buffer }}
 */
function deriveFromSeed(seed, serial, secret32 = SESSION_SECRET) {
    const sn = Buffer.isBuffer(serial) ? serial : Buffer.from(String(serial), 'ascii');
    let state = BigInt(seed >>> 0) & MASK64;
    const rand = Buffer.allocUnsafe(16);
    for (let i = 0; i < 16; i++) {
        state = (state * M + 1n) & MASK64;
        rand[i] = Number((state >> 32n) & 0xffn);
    }
    for (let i = 0; i < 10 && i < sn.length; i++) {
        rand[i] ^= sn[i];
    }
    const hash = crypto.createHash('sha256').update(rand).update(secret32).digest();
    const key = Buffer.from(hash.subarray(0, 16).toString('hex').toUpperCase(), 'ascii');
    const iv = key.subarray(16, 32);
    return { seed: seed >>> 0, rand, key, iv };
}

/**
 * Extract the AES ciphertext of a proto-6 data frame (cipher starts at offset 8,
 * length = raw[4:6], CRC-outside for live 3.1.1.7).
 * @param {Buffer} raw
 * @returns {Buffer|null}
 */
function frameCipher(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 24) {
        return null;
    }
    const length = raw.readUInt16BE(4);
    if (raw.length < 6 + length || length < 18) {
        return null;
    }
    let ct = raw.subarray(8, 6 + length);
    const n = ct.length - (ct.length % 16);
    return n >= 16 ? ct.subarray(0, n) : null;
}

/**
 * Decrypt the last CBC block only (cheap PKCS7 pre-filter).
 * @param {Buffer} key @param {Buffer} iv @param {Buffer} ct
 * @returns {boolean} true if last-block PKCS7 padding is valid
 */
function lastBlockPkcs7Ok(key, iv, ct) {
    const prev = ct.length >= 32 ? ct.subarray(ct.length - 32, ct.length - 16) : iv;
    const last = ct.subarray(ct.length - 16);
    try {
        const d = crypto.createDecipheriv('aes-256-ecb', key, Buffer.alloc(0));
        d.setAutoPadding(false);
        const dec = Buffer.concat([d.update(last), d.final()]);
        const pt = Buffer.allocUnsafe(16);
        for (let i = 0; i < 16; i++) {
            pt[i] = dec[i] ^ prev[i];
        }
        const pad = pt[15];
        if (pad < 1 || pad > 16) {
            return false;
        }
        for (let i = 16 - pad; i < 16; i++) {
            if (pt[i] !== pad) {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Try one seed: PKCS7 last-block filter, then full decrypt + SN oracle.
 * @returns {{ seed:number, key:Buffer, iv:Buffer, plain:Buffer }|null}
 */
function trySeed(seed, sn, secret32, cipher) {
    const { key, iv } = deriveFromSeed(seed, sn, secret32);
    if (!lastBlockPkcs7Ok(key, iv, cipher)) {
        return null;
    }
    try {
        const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
        dec.setAutoPadding(false);
        const plain = Buffer.concat([dec.update(cipher), dec.final()]);
        if (plain.includes(sn)) {
            return { seed: seed >>> 0, key, iv, plain };
        }
    } catch {
        /* keep scanning */
    }
    return null;
}

/**
 * Synchronous brute over [loSeed, hiSeed). Prefer recoverSessionKeyAsync for
 * live proxy use so the event loop stays responsive.
 *
 * @param {object} opts
 * @param {Buffer} opts.cipher
 * @param {Buffer|string} opts.serial
 * @param {number} [opts.loSeed]
 * @param {number} [opts.hiSeed]
 * @param {Buffer} [opts.secret32]
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {{ seed:number, key:Buffer, iv:Buffer, plain:Buffer }|null}
 */
function recoverSessionKey(opts) {
    const cipher = opts && opts.cipher;
    if (!Buffer.isBuffer(cipher) || cipher.length < 16) {
        return null;
    }
    const sn = Buffer.isBuffer(opts.serial) ? opts.serial : Buffer.from(String(opts.serial), 'ascii');
    const secret32 = opts.secret32 || SESSION_SECRET;
    const lo = Math.max(0, opts.loSeed >>> 0);
    const hi = opts.hiSeed != null ? Number(opts.hiSeed) || 0x100000000 : 0x100000000;
    const total = hi - lo;
    const step = 1 << 20;
    for (let seed = lo; seed < hi; seed++) {
        const hit = trySeed(seed, sn, secret32, cipher);
        if (hit) {
            return hit;
        }
        if (opts.onProgress && (seed - lo) % step === 0) {
            opts.onProgress(seed - lo, total);
        }
    }
    return null;
}

/**
 * Non-blocking progressive seed brute for the live proxy.
 * Yields via setImmediate every `chunk` seeds. Scans tiers in order
 * (small seeds first — lab hit was seed 606430 shortly after boot).
 *
 * Default tiers: [0,2^22), [2^22,2^26), [2^26,2^28). Full 2^32 is opt-in
 * via opts.hiSeed / opts.tiers (JS is ~0.2 M/s → hours for the whole space).
 *
 * @param {object} opts
 * @param {Buffer} opts.cipher
 * @param {Buffer|string} opts.serial
 * @param {number} [opts.loSeed]
 * @param {number} [opts.hiSeed]
 * @param {Array<[number,number]>} [opts.tiers]
 * @param {number} [opts.chunk] seeds per event-loop slice (default 16384)
 * @param {Buffer} [opts.secret32]
 * @param {(done:number,total:number,lo:number,hi:number)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldAbort] return true to cancel
 * @returns {Promise<{ seed:number, key:Buffer, iv:Buffer, plain:Buffer }|null>}
 */
function recoverSessionKeyAsync(opts) {
    const cipher = opts && opts.cipher;
    if (!Buffer.isBuffer(cipher) || cipher.length < 16) {
        return Promise.resolve(null);
    }
    const sn = Buffer.isBuffer(opts.serial) ? opts.serial : Buffer.from(String(opts.serial), 'ascii');
    const secret32 = opts.secret32 || SESSION_SECRET;
    const chunk = Math.max(1024, opts.chunk || 16384);
    const tiers =
        opts.tiers ||
        (opts.hiSeed != null
            ? [[Math.max(0, opts.loSeed >>> 0), Number(opts.hiSeed) || 0x100000000]]
            : [
                  [0, 1 << 22],
                  [1 << 22, 1 << 26],
                  [1 << 26, 1 << 28],
              ]);

    const total = tiers.reduce((a, t) => a + (t[1] - t[0]), 0);
    return new Promise((resolve) => {
        let ti = 0;
        let seed = tiers[0][0];
        let scanned = 0;

        const tick = () => {
            if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
                resolve(null);
                return;
            }
            const [lo, hi] = tiers[ti];
            const end = Math.min(seed + chunk, hi);
            const before = seed;
            for (; seed < end; seed++) {
                const hit = trySeed(seed, sn, secret32, cipher);
                if (hit) {
                    resolve(hit);
                    return;
                }
            }
            scanned += seed - before;
            if (opts.onProgress) {
                opts.onProgress(scanned, total, lo, hi);
            }
            if (seed >= hi) {
                ti += 1;
                if (ti >= tiers.length) {
                    resolve(null);
                    return;
                }
                seed = tiers[ti][0];
            }
            setImmediate(tick);
        };
        setImmediate(tick);
    });
}

module.exports = {
    M,
    deriveFromSeed,
    frameCipher,
    lastBlockPkcs7Ok,
    trySeed,
    recoverSessionKey,
    recoverSessionKeyAsync,
};
