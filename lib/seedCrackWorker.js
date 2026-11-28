'use strict';

/**
 * worker_threads entry for AES seed brute.
 *
 * Modes:
 * - oneshot (legacy): workerData has cipher/serial/tiers; exits after one job
 * - persistent (default): waits for parentPort messages
 *     job:  { jobId, cipher, serial, secret32, tiers }
 *     abort:{ type:'abort', jobId }
 *   reply: { jobId, type:'progress', done, lo, hi }
 *        | { jobId, hit:{seed,key,iv}|null, scanned, ms, error? }
 */

const { parentPort, workerData } = require('worker_threads');
const { trySeed } = require('./growattSeedCrack');
const { SESSION_SECRET } = require('./growattAesKdf');

/** @type {number|null} */
let abortJobId = null;

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

/**
 * @param {object} job
 * @returns {{ hit: object|null, scanned: number, ms: number, error?: string }}
 */
function runJob(job) {
    const t0 = Date.now();
    const jobId = job && job.jobId != null ? job.jobId : null;
    try {
        const cipher = Buffer.from(job.cipher || []);
        const sn = Buffer.from(String(job.serial || ''), 'ascii');
        const secret32 = Buffer.from(job.secret32 || SESSION_SECRET);
        const tiers = Array.isArray(job.tiers) && job.tiers.length ? job.tiers : [[0, 1 << 22]];

        let scanned = 0;
        const progressEvery = 1 << 20;
        for (const tier of tiers) {
            if (abortJobId != null && abortJobId === jobId) {
                return { hit: null, scanned, ms: Date.now() - t0, aborted: true };
            }
            const lo = Number(tier[0]) >>> 0;
            const hi = Number(tier[1]) || 0;
            const center = tier.length >= 3 && tier[2] != null ? Number(tier[2]) : null;
            const iter =
                center != null && Number.isFinite(center)
                    ? centerOutSeeds(lo, hi, center)
                    : (function* () {
                          for (let seed = lo; seed < hi; seed++) {
                              yield seed;
                          }
                      })();

            for (const seed of iter) {
                if (abortJobId != null && abortJobId === jobId) {
                    return { hit: null, scanned, ms: Date.now() - t0, aborted: true };
                }
                const hit = trySeed(seed, sn, secret32, cipher);
                scanned += 1;
                if (hit) {
                    return {
                        hit: {
                            seed: hit.seed,
                            key: hit.key.toString('ascii'),
                            iv: hit.iv.toString('ascii'),
                        },
                        scanned,
                        ms: Date.now() - t0,
                    };
                }
                if (scanned % progressEvery === 0 && parentPort) {
                    parentPort.postMessage({
                        jobId,
                        type: 'progress',
                        done: scanned,
                        lo,
                        hi,
                    });
                }
            }
        }
        return { hit: null, scanned, ms: Date.now() - t0 };
    } catch (err) {
        return {
            hit: null,
            scanned: 0,
            ms: Date.now() - t0,
            error: String(err && err.message ? err.message : err),
        };
    }
}

function reply(jobId, result) {
    if (!parentPort) {
        return;
    }
    parentPort.postMessage({
        jobId,
        hit: result.hit,
        scanned: result.scanned,
        ms: result.ms,
        aborted: !!result.aborted,
        error: result.error,
    });
}

const mode = workerData && workerData.mode === 'oneshot' ? 'oneshot' : 'persistent';

if (mode === 'oneshot') {
    const result = runJob(workerData || {});
    reply(workerData && workerData.jobId, result);
} else if (parentPort) {
    parentPort.on('message', (msg) => {
        if (!msg) {
            return;
        }
        if (msg.type === 'abort') {
            abortJobId = msg.jobId != null ? msg.jobId : abortJobId;
            return;
        }
        abortJobId = null;
        const result = runJob(msg);
        reply(msg.jobId, result);
    });
}

module.exports = { centerOutSeeds, runJob };
