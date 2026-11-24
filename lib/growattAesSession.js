'use strict';

/**
 * Per-stick-socket AES session derived from 0x41 UP handshake.
 *
 * On ShineWiFi-X 3.1.1.7 the wire-echoed rand16 is transformed, so the
 * bootstrap derives from observeUp do not decrypt. When the first AES data
 * frame arrives, scheduleSeedRecover() brute-forces the 32-bit RNG seed
 * offline (SN-oracle) and installs the recovered key.
 */

const {
    tryParse041UpFrame,
    tryDecryptFrame,
    encodeAesDownFrame,
} = require('./growattAesKdf');
const { frameCipher, recoverSessionKeyAsync } = require('./growattSeedCrack');
const { extractSn } = require('./growattRecord');

class AesSession {
    constructor() {
        /** @type {string|null} */
        this.serial = null;
        /** @type {{key:Buffer,iv:Buffer}[]} */
        this.candidates = [];
        this.derivedAt = 0;
        this.decryptHits = 0;
        /** @type {{seed:number,key:Buffer,iv:Buffer}|null} */
        this._recovered = null;
        this._recovering = false;
        this._recoverFailed = false;
        /** @type {Buffer|null} */
        this._pendingRecoverRaw = null;
    }

    get ready() {
        return this.candidates.length > 0;
    }

    /**
     * @param {Buffer} rawUp
     * @returns {boolean} true if session keys were derived
     */
    observeUp(rawUp) {
        const info = tryParse041UpFrame(rawUp);
        if (!info) {
            return false;
        }
        this.serial = info.serial;
        // Fresh 0x41 ⇒ new seed epoch; drop seed-recovered key (uart-forced survives).
        this._recovered = null;
        this._recoverFailed = false;
        this._pendingRecoverRaw = null;
        if (this._forced && this._forced.source === 'seed') {
            this._forced = null;
        }
        const derived = [
            { key: info.keyUpper, iv: info.ivUpper },
            { key: info.keyLower, iv: info.ivLower },
            { key: info.keyPreSnXorUpper, iv: info.ivPreSnXorUpper },
            { key: info.keyLegacyUpper, iv: info.ivLegacyUpper },
            { key: info.keyLegacyLower, iv: info.ivLegacyLower },
        ];
        // Forced/recovered key stays first (not bootstrap-derive).
        if (this._forced && this._forced.key && this._forced.iv) {
            this.candidates = [this._forced, ...derived.filter((c) => !c.key.equals(this._forced.key))];
        } else {
            this.candidates = derived;
        }
        this.derivedAt = Date.now();
        return true;
    }

    /**
     * True for proto-6 mid-session AES data frames (CRC-outside, cipher ≥ 16).
     * @param {Buffer} raw
     */
    looksLikeAesData(raw) {
        if (!Buffer.isBuffer(raw) || raw.length < 26) {
            return false;
        }
        if (raw.readUInt16BE(2) !== 0x0006) {
            return false;
        }
        const length = raw.readUInt16BE(4);
        if (length < 18 || (length - 2) % 16 !== 0) {
            return false;
        }
        // 0x41 handshake is never AES-padded this way
        if (raw[7] === 0x41 || raw[6] === 0x41) {
            return false;
        }
        return raw.length >= 6 + length + 2;
    }

    /**
     * Kick off non-blocking seed brute when bootstrap candidates fail to decrypt.
     * Resolves with the hit (and installs the key) or null. Idempotent while running.
     *
     * @param {Buffer} raw AES UP data frame
     * @param {object} [opts]
     * @param {(m:string)=>void} [opts.log]
     * @param {(m:string)=>void} [opts.debug]
     * @returns {Promise<{seed:number,key:Buffer,iv:Buffer,plain:Buffer}|null>}
     */
    scheduleSeedRecover(raw, opts = {}) {
        if (this._recovered) {
            return Promise.resolve({
                seed: this._recovered.seed,
                key: this._recovered.key,
                iv: this._recovered.iv,
                plain: null,
            });
        }
        if (this._recovering || this._recoverFailed) {
            return Promise.resolve(null);
        }
        if (!this.serial || !this.looksLikeAesData(raw)) {
            return Promise.resolve(null);
        }
        // Already decrypts with current candidates → nothing to do
        if (this.tryDecrypt(raw)) {
            return Promise.resolve(null);
        }
        const cipher = frameCipher(raw);
        if (!cipher) {
            return Promise.resolve(null);
        }
        this._recovering = true;
        this._pendingRecoverRaw = Buffer.from(raw);
        const log = opts.log || (() => {});
        const debug = opts.debug || (() => {});
        log(`AES seed-recover start SN=${this.serial} cipher=${cipher.length}B`);
        const t0 = Date.now();
        return recoverSessionKeyAsync({
            cipher,
            serial: this.serial,
            onProgress: (done, total) => {
                if (done > 0 && done % (1 << 22) < 16384) {
                    debug(`AES seed-recover ${((100 * done) / total).toFixed(1)}% ${done} scanned`);
                }
            },
            shouldAbort: () => !this.serial,
        })
            .then((hit) => {
                this._recovering = false;
                if (!hit) {
                    this._recoverFailed = true;
                    log(`AES seed-recover miss SN=${this.serial} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
                    return null;
                }
                this.installRecoveredKey(hit.key, hit.iv, hit.seed);
                log(
                    `AES seed-recover HIT SN=${this.serial} seed=${hit.seed} ` +
                        `key=${hit.key.toString('ascii')} iv=${hit.iv.toString('ascii')} ` +
                        `in ${((Date.now() - t0) / 1000).toFixed(1)}s`
                );
                return hit;
            })
            .catch((err) => {
                this._recovering = false;
                this._recoverFailed = true;
                log(`AES seed-recover error SN=${this.serial}: ${err && err.message ? err.message : err}`);
                return null;
            });
    }

    /**
     * Install a seed-recovered session key (survives the next observeUp only if
     * also stashed as _forced — we keep it as _recovered + prepend candidates).
     * @param {Buffer|string} key
     * @param {Buffer|string} [iv]
     * @param {number} [seed]
     */
    installRecoveredKey(key, iv, seed) {
        const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'ascii');
        let ivBuf =
            iv == null || iv === ''
                ? keyBuf.subarray(16, 32)
                : Buffer.isBuffer(iv)
                  ? iv
                  : Buffer.from(String(iv), 'ascii');
        if (keyBuf.length !== 32 || ivBuf.length !== 16) {
            return false;
        }
        this._recovered = { seed: seed >>> 0, key: keyBuf, iv: ivBuf };
        this._forced = { key: keyBuf, iv: ivBuf, source: 'seed' };
        this.candidates = [
            this._forced,
            ...this.candidates.filter((c) => !c.key.equals(keyBuf)),
        ];
        this.derivedAt = Date.now();
        return true;
    }

    /**
     * Lab-only: install AES key/IV observed on UART (RandKey_Init debug print).
     * Prepends to candidates and survives the next observeUp for this socket.
     * @param {Buffer|string} key 32-byte ASCII hex key
     * @param {Buffer|string} [iv] 16-byte ASCII IV (default key[16:32])
     * @param {string} [serial]
     */
    installUartKey(key, iv, serial) {
        const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'ascii');
        let ivBuf =
            iv == null || iv === ''
                ? keyBuf.subarray(16, 32)
                : Buffer.isBuffer(iv)
                  ? iv
                  : Buffer.from(String(iv), 'ascii');
        if (keyBuf.length !== 32 || ivBuf.length !== 16) {
            return false;
        }
        this._forced = { key: keyBuf, iv: ivBuf, source: 'uart' };
        if (serial) {
            this.serial = String(serial);
        }
        this.candidates = [
            this._forced,
            ...this.candidates.filter((c) => !c.key.equals(keyBuf)),
        ];
        this.derivedAt = Date.now();
        return true;
    }

    /**
     * Also accept an ASCII session key from DOWN (Grott reports cloud may send one).
     * @param {Buffer} rawDown
     * @returns {boolean}
     */
    observeDown(rawDown) {
        if (!Buffer.isBuffer(rawDown) || rawDown.length < 40) {
            return false;
        }
        if (rawDown[7] !== 0x41) {
            return false;
        }
        const body = rawDown.subarray(8, rawDown.length - 2);
        // Grott / live: ~25-char ASCII key run in DOWN 0x41 (often hex alphabet)
        let best = null;
        let run = '';
        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            const ok =
                (c >= 0x30 && c <= 0x39) ||
                (c >= 0x41 && c <= 0x5a) ||
                (c >= 0x61 && c <= 0x7a);
            if (ok) {
                run += String.fromCharCode(c);
            } else {
                if (run.length >= 24 && (!best || run.length > best.length)) {
                    best = run;
                }
                run = '';
            }
        }
        if (run.length >= 24 && (!best || run.length > best.length)) {
            best = run;
        }
        if (!best) {
            return false;
        }
        const keyStr = best.length >= 32 ? best.slice(0, 32) : best.padEnd(32, '0');
        const key = Buffer.from(keyStr, 'ascii');
        const iv = key.subarray(16, 32);
        const decoded =
            /^[0-9a-fA-F]+$/.test(best) && best.length >= 32
                ? Buffer.from(best.slice(0, 32), 'hex')
                : null;
        const next = [{ key, iv }];
        if (decoded && decoded.length === 16) {
            // 16-byte binary key → AES-128 candidate (pad to 32 by repeat)
            next.push({ key: Buffer.concat([decoded, decoded]), iv: decoded });
        }
        this.candidates = [...next, ...this.candidates.filter((c) => !c.key.equals(key))];
        return true;
    }

    /**
     * @param {Buffer} raw
     * @returns {{plain:Buffer, sn:string|null, variant:string}|null}
     */
    tryDecrypt(raw) {
        if (!this.ready) {
            return null;
        }
        const hit = tryDecryptFrame(raw, this.candidates);
        if (!hit) {
            return null;
        }
        this.decryptHits += 1;
        const sn = extractSn(hit.plain) || this.serial;
        return { plain: hit.plain, sn, variant: hit.variant };
    }

    /**
     * Preferred session for DOWN encrypt (first candidate / last successful).
     * @returns {{key:Buffer,iv:Buffer}|null}
     */
    primarySession() {
        return this.candidates[0] || null;
    }

    /**
     * Encrypt a plaintext payload into an AES DOWN wire frame (lab inject).
     * @param {object} opts
     * @param {number} opts.func
     * @param {Buffer} opts.payloadPlain
     * @param {number} [opts.unit]
     * @param {number} [opts.txn]
     * @param {number} [opts.proto]
     * @returns {Buffer|null}
     */
    encryptDown(opts) {
        const session = this.primarySession();
        if (!session) {
            return null;
        }
        return encodeAesDownFrame({
            txn: opts.txn,
            proto: opts.proto,
            unit: opts.unit ?? 1,
            func: opts.func,
            payloadPlain: opts.payloadPlain,
            session,
        });
    }
}

module.exports = { AesSession };
