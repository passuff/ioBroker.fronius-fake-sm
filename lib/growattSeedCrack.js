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

/** Default brute tiers (small seeds first — lab hit was seed 606430 shortly after boot). */
const DEFAULT_SEED_TIERS = [
    [0, 1 << 22],
    [1 << 22, 1 << 26],
    [1 << 26, 1 << 28],
];

const DEFAULT_SEED_RATE = 100;
const MARGIN_FLOOR = 1000;
const MARGIN_CAP = 8000;

/**
 * Build scan tiers from a previous HIT. Lab seeds rise ~100/s; predicted window
 * is searched first (center-out via optional 3rd element = pred), then defaults.
 *
 * Tier shape: [lo, hi] or [lo, hi, center] for center-out scan.
 *
 * @param {{seed:number, at:number, rate?:number}|null|undefined} hint
 * @param {number} [now]
 * @returns {Array<[number, number]|[number, number, number]>}
 */
function predictSeedTiers(hint, now = Date.now()) {
    const defaults = DEFAULT_SEED_TIERS.map((t) => [t[0], t[1]]);
    if (!hint || hint.seed == null || hint.at == null) {
        return defaults;
    }
    const dtS = Math.max(0, (Number(now) - Number(hint.at)) / 1000);
    const rate = Number(hint.rate) > 0 ? Number(hint.rate) : DEFAULT_SEED_RATE;
    const pred = Math.floor(Number(hint.seed) + rate * dtS);
    let margin = Math.floor(MARGIN_FLOOR + 0.05 * rate * dtS);
    margin = Math.max(MARGIN_FLOOR, Math.min(MARGIN_CAP, margin));
    const lo = Math.max(0, pred - margin);
    const hi = Math.min(0x100000000, pred + margin + 1);
    if (hi <= lo) {
        return defaults;
    }
    return [[lo, hi, pred], ...defaults];
}

/**
 * Resolve tiers from opts (explicit tiers / hiSeed / hint / defaults).
 * @param {object} opts
 * @returns {Array<[number, number]|[number, number, number]>}
 */
function resolveSeedTiers(opts) {
    if (opts && Array.isArray(opts.tiers) && opts.tiers.length) {
        return opts.tiers;
    }
    if (opts && opts.hiSeed != null) {
        return [[Math.max(0, opts.loSeed >>> 0), Number(opts.hiSeed) || 0x100000000]];
    }
    if (opts && opts.hint) {
        return predictSeedTiers(opts.hint, opts.now);
    }
    return DEFAULT_SEED_TIERS.map((t) => [t[0], t[1]]);
}

/**
 * Center-out iteration over [lo, hi) starting at center.
 * @param {number} lo
 * @param {number} hi
 * @param {number} center
 * @returns {Generator<number>}
 */
function* centerOutSeeds(lo, hi, center) {
    if (hi <= lo) {
        return;
    }
    let c = Math.floor(Number(center));
    if (!Number.isFinite(c)) {
        c = lo;
    }
    c = Math.max(lo, Math.min(hi - 1, c >>> 0));
    yield c;
    for (let d = 1; ; d++) {
        const a = c - d;
        const b = c + d;
        let any = false;
        if (a >= lo) {
            yield a >>> 0;
            any = true;
        }
        if (b < hi) {
            yield b >>> 0;
            any = true;
        }
        if (!any) {
            break;
        }
    }
}

/** @type {{ worker: import('worker_threads').Worker|null, jobId: number, busy: boolean }} */
const warmPool = { worker: null, jobId: 0, busy: false };

/**
 * @returns {import('worker_threads').Worker}
 */
function ensureWarmWorker() {
    const { Worker } = require('worker_threads');
    const path = require('path');
    if (warmPool.worker) {
        return warmPool.worker;
    }
    const worker = new Worker(path.join(__dirname, 'seedCrackWorker.js'), {
        workerData: { mode: 'persistent' },
    });
    worker.on('error', () => {
        warmPool.worker = null;
        warmPool.busy = false;
    });
    worker.on('exit', () => {
        if (warmPool.worker === worker) {
            warmPool.worker = null;
            warmPool.busy = false;
        }
    });
    warmPool.worker = worker;
    return worker;
}

/**
 * Drop warm worker so the next job starts a fresh one (after abort/fault).
 */
function resetWarmWorker() {
    const w = warmPool.worker;
    warmPool.worker = null;
    warmPool.busy = false;
    if (w) {
        try {
            w.removeAllListeners();
            w.terminate().catch(() => {});
        } catch {
            // ignore
        }
    }
}

/**
 * Non-blocking seed brute for the live proxy via a reused worker_threads Worker.
 *
 * @param {object} opts
 * @param {Buffer} opts.cipher
 * @param {Buffer|string} opts.serial
 * @param {number} [opts.loSeed]
 * @param {number} [opts.hiSeed]
 * @param {Array} [opts.tiers]
 * @param {{seed:number, at:number, rate?:number}} [opts.hint]
 * @param {number} [opts.now]
 * @param {number} [opts.chunk] main-thread fallback only (default 16384)
 * @param {boolean} [opts.forceMainThread] skip Worker (tests)
 * @param {Buffer} [opts.secret32]
 * @param {(done:number,total:number,lo:number,hi:number)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldAbort] return true to cancel
 * @returns {Promise<{ seed:number, key:Buffer, iv:Buffer, plain:Buffer, scanned?:number, ms?:number }|null>}
 */
function recoverSessionKeyAsync(opts) {
    const cipher = opts && opts.cipher;
    if (!Buffer.isBuffer(cipher) || cipher.length < 16) {
        return Promise.resolve(null);
    }
    const sn = Buffer.isBuffer(opts.serial) ? opts.serial : Buffer.from(String(opts.serial), 'ascii');
    const secret32 = opts.secret32 || SESSION_SECRET;
    const tiers = resolveSeedTiers(opts);

    const mainThreadOpts = {
        cipher,
        serial: sn,
        secret32,
        tiers,
        chunk: opts.chunk,
        shouldAbort: opts.shouldAbort,
        onProgress: opts.onProgress,
    };

    if (!opts.forceMainThread) {
        const status = { fault: false, aborted: false };
        try {
            return recoverSessionKeyWorker({
                cipher,
                serial: sn,
                secret32,
                tiers,
                shouldAbort: opts.shouldAbort,
                onProgress: opts.onProgress,
                status,
            }).then((hit) => {
                if (hit) {
                    return hit;
                }
                if (status.aborted || (typeof opts.shouldAbort === 'function' && opts.shouldAbort())) {
                    return null;
                }
                if (status.fault) {
                    return recoverSessionKeyMainThread(mainThreadOpts);
                }
                return null;
            });
        } catch {
            // fall through to main-thread progressive scan
        }
    }

    return recoverSessionKeyMainThread(mainThreadOpts);
}

/**
 * Progressive setImmediate scan (fallback / tests with forceMainThread).
 * Supports center-out when tier[2] is set.
 * @param {object} opts
 * @returns {Promise<{ seed:number, key:Buffer, iv:Buffer, plain:Buffer, scanned?:number, ms?:number }|null>}
 */
function recoverSessionKeyMainThread(opts) {
    const cipher = opts.cipher;
    const sn = opts.serial;
    const secret32 = opts.secret32 || SESSION_SECRET;
    const tiers = opts.tiers;
    const chunk = Math.max(1024, opts.chunk || 16384);
    const total = tiers.reduce((a, t) => a + (t[1] - t[0]), 0);
    const t0 = Date.now();
    return new Promise((resolve) => {
        let ti = 0;
        let scanned = 0;
        /** @type {Generator<number>|null} */
        let iter = null;
        let iterDone = false;

        const nextIter = () => {
            if (ti >= tiers.length) {
                iter = null;
                iterDone = true;
                return;
            }
            const tier = tiers[ti];
            const lo = Number(tier[0]) >>> 0;
            const hi = Number(tier[1]) || 0;
            const center = tier.length >= 3 && tier[2] != null ? Number(tier[2]) : null;
            if (center != null && Number.isFinite(center)) {
                iter = centerOutSeeds(lo, hi, center);
            } else {
                iter = (function* () {
                    for (let seed = lo; seed < hi; seed++) {
                        yield seed;
                    }
                })();
            }
            iterDone = false;
        };
        nextIter();

        const tick = () => {
            if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
                resolve(null);
                return;
            }
            if (!iter || iterDone) {
                resolve(null);
                return;
            }
            const [lo, hi] = tiers[ti];
            let n = 0;
            while (n < chunk) {
                const step = iter.next();
                if (step.done) {
                    iterDone = true;
                    break;
                }
                const seed = step.value;
                n += 1;
                scanned += 1;
                const hit = trySeed(seed, sn, secret32, cipher);
                if (hit) {
                    hit.scanned = scanned;
                    hit.ms = Date.now() - t0;
                    resolve(hit);
                    return;
                }
            }
            if (opts.onProgress) {
                opts.onProgress(scanned, total, lo, hi);
            }
            if (iterDone) {
                ti += 1;
                if (ti >= tiers.length) {
                    resolve(null);
                    return;
                }
                nextIter();
            }
            setImmediate(tick);
        };
        setImmediate(tick);
    });
}

/**
 * Warm-worker job runner (reuses one Worker across recovers).
 * @param {object} opts
 * @returns {Promise<{ seed:number, key:Buffer, iv:Buffer, plain:Buffer, scanned?:number, ms?:number }|null>}
 */
function recoverSessionKeyWorker(opts) {
    const cipher = opts.cipher;
    const sn = opts.serial;
    const secret32 = opts.secret32 || SESSION_SECRET;
    const tiers = opts.tiers;
    const total = tiers.reduce((a, t) => a + (t[1] - t[0]), 0);

    return new Promise((resolve) => {
        let settled = false;
        let worker;
        try {
            worker = ensureWarmWorker();
        } catch {
            if (opts.status) {
                opts.status.fault = true;
            }
            resolve(null);
            return;
        }

        warmPool.jobId += 1;
        const jobId = warmPool.jobId;
        warmPool.busy = true;

        const finish = (hit) => {
            if (settled) {
                return;
            }
            settled = true;
            clearInterval(abortPoll);
            try {
                worker.removeListener('message', onMessage);
                worker.removeListener('error', onError);
            } catch {
                // ignore
            }
            warmPool.busy = false;
            resolve(hit);
        };

        const onMessage = (msg) => {
            if (!msg || msg.jobId !== jobId) {
                return;
            }
            if (msg.type === 'progress') {
                if (opts.onProgress) {
                    opts.onProgress(msg.done, total, msg.lo, msg.hi);
                }
                return;
            }
            if (!msg.hit) {
                if (msg.error && opts.status) {
                    opts.status.fault = true;
                    resetWarmWorker();
                }
                finish(null);
                return;
            }
            const key = Buffer.from(msg.hit.key, 'ascii');
            const iv = Buffer.from(msg.hit.iv, 'ascii');
            let plain = Buffer.alloc(0);
            try {
                const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
                dec.setAutoPadding(false);
                plain = Buffer.concat([dec.update(cipher), dec.final()]);
            } catch {
                // keep empty plain
            }
            finish({
                seed: msg.hit.seed >>> 0,
                key,
                iv,
                plain,
                scanned: msg.scanned,
                ms: msg.ms,
            });
        };

        const onError = () => {
            if (opts.status && !opts.status.aborted) {
                opts.status.fault = true;
            }
            resetWarmWorker();
            finish(null);
        };

        const abortPoll = setInterval(() => {
            if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
                if (opts.status) {
                    opts.status.aborted = true;
                }
                clearInterval(abortPoll);
                try {
                    worker.postMessage({ type: 'abort', jobId });
                } catch {
                    // ignore
                }
                // Hard-reset so a stuck job cannot block the pool
                resetWarmWorker();
                finish(null);
            }
        }, 50);

        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.postMessage({
            jobId,
            cipher: Buffer.from(cipher),
            serial: sn.toString('ascii'),
            secret32: Buffer.from(secret32),
            tiers,
        });
    });
}

module.exports = {
    M,
    DEFAULT_SEED_TIERS,
    DEFAULT_SEED_RATE,
    MARGIN_FLOOR,
    MARGIN_CAP,
    deriveFromSeed,
    frameCipher,
    lastBlockPkcs7Ok,
    trySeed,
    predictSeedTiers,
    resolveSeedTiers,
    centerOutSeeds,
    recoverSessionKey,
    recoverSessionKeyAsync,
    resetWarmWorker,
};
