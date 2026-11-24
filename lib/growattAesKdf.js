'use strict';

/**
 * ShineWiFi-X 3.1.1.7 session KDF (IOT_ESP_RandKey_Init / FUN_402bcf3c).
 *
 * Combined = RandNum[16] || SESSION_SECRET[32]
 * Hash = SHA256(Combined)
 * AES_KEY = ASCII hex(Hash[0:16])  (32 chars, uppercase; "%02X" LUT at 0x3ffe8ca9)
 * AES_IV  = AES_KEY[16:32]         (16 ASCII chars; IV ptr = key ptr + 16)
 *
 * IMPORTANT (verified from firmware .data, flash 0xf717e -> RAM 0x3ffe8cae):
 *   - SESSION_SECRET (GucIOTESPECRETKEY) is 'GROWATT_NYHL&JKYW_TEST_20240729.'
 *   - 'Growatt@TempPassword&*20240730.!' is NOT the KDF secret; it is only the
 *     XOR mask applied to the SN field of the 0x41 handshake frame.
 */

const crypto = require('crypto');

// XOR mask for the 0x41 SN field (NOT the KDF secret).
const SN_FIELD_MASK = Buffer.from('Growatt@TempPassword&*20240730.!', 'ascii');
// Real KDF secret (GucIOTESPECRETKEY) read from firmware .data at RAM 0x3ffe8cae.
const SESSION_SECRET = Buffer.from('GROWATT_NYHL&JKYW_TEST_20240729.', 'ascii');
// Backwards-compatible alias: historically mislabelled as the KDF secret, but
// it is in fact the SN-field mask. Kept so unmaskSnField callers keep working.
const BOOTSTRAP_KEY = SN_FIELD_MASK;

/**
 * @param {Buffer|string} serial
 * @returns {Buffer}
 */
function snPad32(serial) {
    const sn = Buffer.isBuffer(serial) ? serial : Buffer.from(String(serial), 'ascii');
    const out = Buffer.alloc(32, 0);
    sn.copy(out, 0, 0, Math.min(sn.length, 32));
    return out;
}

/**
 * @param {Buffer} field32
 * @param {Buffer} [bootstrap]
 * @returns {Buffer} serial bytes (trimmed at first NUL)
 */
function unmaskSnField(field32, bootstrap = SN_FIELD_MASK) {
    const plain = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
        plain[i] = field32[i] ^ bootstrap[i];
    }
    const z = plain.indexOf(0);
    return z < 0 ? plain : plain.subarray(0, z);
}

/**
 * @param {Buffer} rand16
 * @param {Buffer} [secret32]
 * @param {boolean} [uppercase]
 * @returns {{ key: Buffer, iv: Buffer, hash: Buffer }}
 */
function deriveSessionKeyIv(rand16, secret32 = SESSION_SECRET, uppercase = true) {
    if (!Buffer.isBuffer(rand16) || rand16.length !== 16) {
        throw new Error('rand16 must be 16 bytes');
    }
    if (!Buffer.isBuffer(secret32) || secret32.length !== 32) {
        throw new Error('secret32 must be 32 bytes');
    }
    const hash = crypto.createHash('sha256').update(rand16).update(secret32).digest();
    let hx = hash.subarray(0, 16).toString('hex');
    if (uppercase) {
        hx = hx.toUpperCase();
    }
    const key = Buffer.from(hx, 'ascii');
    const iv = key.subarray(16, 32);
    return { key, iv, hash };
}

/**
 * XOR first 10 bytes of rand with serial (inverse of FUN_402d4040 / same op).
 * @param {Buffer} rand16
 * @param {Buffer|string} serial
 * @returns {Buffer}
 */
function applyRandSnXor(rand16, serial) {
    const sn = Buffer.isBuffer(serial) ? serial : Buffer.from(String(serial), 'ascii');
    const out = Buffer.from(rand16);
    for (let i = 0; i < Math.min(10, sn.length, out.length); i++) {
        out[i] ^= sn[i];
    }
    return out;
}

/**
 * Parse 0x41 UP payload (82 bytes after unit/func).
 * Layout: [0:32] SN⊕boot | [32:36] tag \"Fpnf\" | [36:52] RandNum | [52:82] opaque.
 * @param {Buffer} payload82
 */
function parse041UpPayload(payload82) {
    if (!Buffer.isBuffer(payload82) || payload82.length !== 82) {
        throw new Error('expected 82-byte 0x41 payload');
    }
    const field32 = payload82.subarray(0, 32);
    const tag4 = payload82.subarray(32, 36);
    const rand16 = payload82.subarray(36, 52);
    const rand16Legacy = payload82.subarray(32, 48);
    const opaque = payload82.subarray(52, 82);
    const serialBuf = unmaskSnField(field32);
    const randPre = applyRandSnXor(rand16, serialBuf);
    const upper = deriveSessionKeyIv(rand16, SESSION_SECRET, true);
    const lower = deriveSessionKeyIv(rand16, SESSION_SECRET, false);
    const preU = deriveSessionKeyIv(randPre, SESSION_SECRET, true);
    const legU = deriveSessionKeyIv(rand16Legacy, SESSION_SECRET, true);
    const legL = deriveSessionKeyIv(rand16Legacy, SESSION_SECRET, false);
    return {
        serial: serialBuf.toString('ascii'),
        serialBuf,
        tag4,
        rand16,
        rand16Legacy,
        opaque32: payload82.subarray(48, 80),
        opaque,
        tail: payload82.subarray(80, 82),
        keyUpper: upper.key,
        ivUpper: upper.iv,
        keyLower: lower.key,
        ivLower: lower.iv,
        keyPreSnXorUpper: preU.key,
        ivPreSnXorUpper: preU.iv,
        keyLegacyUpper: legU.key,
        ivLegacyUpper: legU.iv,
        keyLegacyLower: legL.key,
        ivLegacyLower: legL.iv,
        hash: upper.hash,
    };
}

/**
 * Detect and parse a raw 0x41 UP frame (proto-6, wire func 0x41, len 0x56).
 * @param {Buffer} raw
 * @returns {ReturnType<typeof parse041UpPayload>|null}
 */
function tryParse041UpFrame(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 92) {
        return null;
    }
    if (raw.readUInt16BE(2) !== 0x0006) {
        return null;
    }
    if (raw.readUInt16BE(4) !== 0x0056) {
        return null;
    }
    // unit/func often clear on wire for 0x41 (not XOR Growatt)
    if (raw[7] !== 0x41 && raw[6] !== 0x41) {
        return null;
    }
    const body = raw.subarray(6, 6 + 0x56 - 2); // 84 bytes: unit+func+82
    if (body.length < 84) {
        return null;
    }
    // Live captures show clear unit/func 01 41 (not XOR Growatt)
    if (body[1] !== 0x41 && raw[7] !== 0x41) {
        return null;
    }
    try {
        return parse041UpPayload(body.subarray(2));
    } catch {
        return null;
    }
}

/**
 * AES-256-CBC decrypt; returns null on failure.
 * @param {Buffer} key
 * @param {Buffer} iv
 * @param {Buffer} cipher
 * @param {boolean} [autoPad]
 * @returns {Buffer|null}
 */
function aesCbcDecrypt(key, iv, cipher, autoPad = true) {
    if (!Buffer.isBuffer(key) || !Buffer.isBuffer(iv) || !Buffer.isBuffer(cipher)) {
        return null;
    }
    if (key.length !== 32 || iv.length !== 16) {
        return null;
    }
    const n = cipher.length - (cipher.length % 16);
    if (n < 16) {
        return null;
    }
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        decipher.setAutoPadding(!!autoPad);
        return Buffer.concat([decipher.update(cipher.subarray(0, n)), decipher.final()]);
    } catch {
        return null;
    }
}

/**
 * AES-256-CBC encrypt (mirror of aesCbcDecrypt). Key/IV are 32/16 ASCII bytes
 * as produced by deriveSessionKeyIv (hex-string-as-key layout).
 * @param {Buffer} key
 * @param {Buffer} iv
 * @param {Buffer} plain
 * @param {boolean} [autoPad]
 * @returns {Buffer|null}
 */
function aesCbcEncrypt(key, iv, plain, autoPad = true) {
    if (!Buffer.isBuffer(key) || !Buffer.isBuffer(iv) || !Buffer.isBuffer(plain)) {
        return null;
    }
    if (key.length !== 32 || iv.length !== 16) {
        return null;
    }
    try {
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        cipher.setAutoPadding(!!autoPad);
        return Buffer.concat([cipher.update(plain), cipher.final()]);
    } catch {
        return null;
    }
}

/**
 * Wrap a plaintext Growatt body (unit+func+payload) as AES DOWN frame.
 * Layout mirrors decrypt path "payload": header tid/proto/len clear,
 * ciphertext starts at offset 8 (after unit/func clear), CRC16 over header+cipher.
 *
 * Note: live 3.1.1.7 may still require session proof; this is the encrypt mirror
 * for lab inject once AesSession.candidates is populated from 0x41.
 *
 * @param {object} opts
 * @param {number} [opts.txn]
 * @param {number} [opts.proto]
 * @param {number} opts.unit
 * @param {number} opts.func
 * @param {Buffer} opts.payloadPlain
 * @param {{key:Buffer,iv:Buffer}} opts.session
 * @returns {Buffer|null}
 */
function encodeAesDownFrame(opts) {
    const session = opts && opts.session;
    if (!session || !Buffer.isBuffer(session.key) || !Buffer.isBuffer(session.iv)) {
        return null;
    }
    const txn = Number(opts.txn ?? 1) & 0xffff;
    const proto = Number(opts.proto ?? 0x0006) & 0xffff;
    const unit = Number(opts.unit ?? 1) & 0xff;
    const func = Number(opts.func) & 0xff;
    const payload = Buffer.isBuffer(opts.payloadPlain) ? opts.payloadPlain : Buffer.alloc(0);
    // Clear unit/func then encrypt payload only (FW encrypt skips first 8 frame bytes)
    const plainPayload = payload;
    const cipher = aesCbcEncrypt(session.key, session.iv, plainPayload, true);
    if (!cipher) {
        return null;
    }
    // Live 3.1.1.7 UP: length = unit+func+cipher only; CRC BE appended outside length.
    const body = Buffer.concat([Buffer.from([unit, func]), cipher]);
    const length = body.length;
    const header = Buffer.allocUnsafe(6);
    header.writeUInt16BE(txn, 0);
    header.writeUInt16BE(proto, 2);
    header.writeUInt16BE(length, 4);
    const crc = crc16ModbusGrowatt(Buffer.concat([header, body]));
    const crcBuf = Buffer.allocUnsafe(2);
    crcBuf.writeUInt16BE(crc, 0);
    return Buffer.concat([header, body, crcBuf]);
}

/** Local CRC (avoid circular require of growattProto). */
function crc16ModbusGrowatt(data) {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let b = 0; b < 8; b++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
        }
    }
    return crc & 0xffff;
}

/**
 * Try decrypting a proto-6 data frame body with session key/IV.
 * Tries: full body before CRC; body after unit/func; upper/lower hex keys.
 * @param {Buffer} raw
 * @param {{key:Buffer,iv:Buffer}[]} sessions
 * @returns {{plain:Buffer, variant:string}|null}
 */
function tryDecryptFrame(raw, sessions) {
    if (!Buffer.isBuffer(raw) || raw.length < 24 || !Array.isArray(sessions) || !sessions.length) {
        return null;
    }
    const length = raw.readUInt16BE(4);
    if (raw.length < 6 + length || length < 18) {
        return null;
    }
    // CRC-outside (live 3.1.1.7): cipher = raw[8 : 6+length], total = 6+length+2
    // CRC-inside (legacy encode): cipher ends at 6+length-2
    const crcOutside = raw.length >= 6 + length + 2 && (length - 2) % 16 === 0;
    const cipherEnd = crcOutside ? 6 + length : 6 + length - 2;
    const body = raw.subarray(6, cipherEnd);
    // FW encrypt skips first 8 bytes of the frame buffer (tid/proto/len/unit/func),
    // CRC is appended after encrypt — ciphertext is payload only.
    const slices = [
        { name: 'payload', buf: raw.length >= 8 ? raw.subarray(8, cipherEnd) : null },
        { name: 'body', buf: body },
        { name: 'afterUF', buf: body.length > 2 ? body.subarray(2) : body },
        { name: 'afterUF16', buf: body.length > 18 ? body.subarray(2 + 16) : null },
        { name: 'afterUF32', buf: body.length > 34 ? body.subarray(2 + 32) : null },
    ];
    for (const s of sessions) {
        for (const sl of slices) {
            if (!sl.buf || sl.buf.length < 16) {
                continue;
            }
            for (const pad of [true, false]) {
                const plain = aesCbcDecrypt(s.key, s.iv, sl.buf, pad);
                if (!plain) {
                    continue;
                }
                // Heuristic: datalogger SN ASCII or unit/func-like header
                if (plain.includes(Buffer.from('XGD')) || plain.includes(Buffer.from('Growatt'))) {
                    return { plain, variant: `${sl.name}/pad=${pad}` };
                }
                if (plain[0] === 0x01 && [0x03, 0x04, 0x19, 0x50].includes(plain[1])) {
                    return { plain, variant: `${sl.name}/pad=${pad}/uf` };
                }
            }
        }
    }
    return null;
}

module.exports = {
    BOOTSTRAP_KEY,
    SN_FIELD_MASK,
    SESSION_SECRET,
    snPad32,
    unmaskSnField,
    applyRandSnXor,
    deriveSessionKeyIv,
    parse041UpPayload,
    tryParse041UpFrame,
    aesCbcDecrypt,
    aesCbcEncrypt,
    encodeAesDownFrame,
    tryDecryptFrame,
};
