'use strict';

/**
 * Growatt WiFi-stick frame codec (proto 0x0005/0x0006: XOR "Growatt" + CRC16).
 * Port of scripts/growatt_proto_craft.py.
 */

const XOR_KEY = Buffer.from('Growatt', 'ascii');

/**
 * @param {Buffer} data
 * @returns {number}
 */
function crc16Modbus(data) {
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
 * @param {Buffer} data
 * @returns {Buffer}
 */
function xorGrowatt(data) {
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) {
        out[i] = data[i] ^ XOR_KEY[i % XOR_KEY.length];
    }
    return out;
}

function usesXorCrc(proto) {
    return proto === 0x0005 || proto === 0x0006;
}

/**
 * @param {object} opts
 * @param {number} [opts.proto]
 * @param {number} [opts.unit]
 * @param {number} opts.func
 * @param {Buffer} opts.payloadPlain
 * @param {number} [opts.txn]
 * @returns {Buffer}
 */
function encodeFrame(opts) {
    const proto = Number(opts.proto ?? 0x0006) & 0xffff;
    const unit = Number(opts.unit ?? 1) & 0xff;
    const func = Number(opts.func) & 0xff;
    const txn = Number(opts.txn ?? 1) & 0xffff;
    const payload = Buffer.isBuffer(opts.payloadPlain) ? opts.payloadPlain : Buffer.alloc(0);
    const plainBody = Buffer.concat([Buffer.from([unit, func]), payload]);

    if (usesXorCrc(proto)) {
        // Grott convention: the 8-byte header (txn, proto, length, unit, func)
        // stays CLEAR; only the payload after byte 8 is XOR-scrambled, with the
        // key phase starting at 0 on the first payload byte. (Real ShineWiFi-X
        // 3.1.0.x sticks send exactly this; XOR-ing unit/func too corrupts them.)
        const obfPayload = xorGrowatt(payload);
        const body = Buffer.concat([Buffer.from([unit, func]), obfPayload]);
        const length = body.length + 2; // CRC counted inside length
        const header = Buffer.allocUnsafe(6);
        header.writeUInt16BE(txn, 0);
        header.writeUInt16BE(proto, 2);
        header.writeUInt16BE(length, 4);
        const crc = crc16Modbus(Buffer.concat([header, body]));
        const crcBuf = Buffer.allocUnsafe(2);
        crcBuf.writeUInt16BE(crc, 0);
        return Buffer.concat([header, body, crcBuf]);
    }

    // proto 0x0002: plain body, no CRC; length = body size
    const length = plainBody.length;
    const header = Buffer.allocUnsafe(6);
    header.writeUInt16BE(txn, 0);
    header.writeUInt16BE(proto, 2);
    header.writeUInt16BE(length, 4);
    return Buffer.concat([header, plainBody]);
}

/**
 * @param {Buffer} raw
 * @returns {{ txn:number, proto:number, length:number, unit:number|null, func:number|null, payload:Buffer, crcOk:boolean, crcRx:number|null, crcCalc:number|null }}
 */
function decodeFrame(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 8) {
        throw new Error('frame too short');
    }
    const txn = raw.readUInt16BE(0);
    const proto = raw.readUInt16BE(2);
    const length = raw.readUInt16BE(4);
    if (raw.length < 6 + length) {
        throw new Error('truncated frame');
    }

    if (usesXorCrc(proto)) {
        if (length < 2) {
            throw new Error('invalid length');
        }
        // Grott convention: header (8 bytes incl. unit+func) is CLEAR; only the
        // payload after byte 8 is XOR-scrambled. CRC is counted inside `length`
        // but is advisory — real 3.1.0.x sticks zero-fill the record trailer, so
        // the modbus CRC frequently does NOT match even on intact data.
        const unit = raw.length > 6 ? raw[6] : null;
        const func = raw.length > 7 ? raw[7] : null;
        const payloadStart = 8;
        const payloadEnd = 6 + length - 2;
        const bodyX =
            payloadEnd > payloadStart ? raw.subarray(payloadStart, payloadEnd) : Buffer.alloc(0);
        const crcRx = raw.readUInt16BE(6 + length - 2);
        const crcCalc = crc16Modbus(raw.subarray(0, 6 + length - 2));
        const payload = xorGrowatt(bodyX);
        return {
            txn,
            proto,
            length,
            unit,
            func,
            payload,
            crcOk: crcRx === crcCalc,
            crcRx,
            crcCalc,
        };
    }

    const plain = raw.subarray(6, 6 + length);
    return {
        txn,
        proto,
        length,
        unit: plain.length ? plain[0] : null,
        func: plain.length > 1 ? plain[1] : null,
        payload: plain.length > 2 ? plain.subarray(2) : Buffer.alloc(0),
        crcOk: true,
        crcRx: null,
        crcCalc: null,
    };
}

/**
 * Minimal ACK: echo unit+func with empty/status payload (forward mode preferred).
 * @param {ReturnType<typeof decodeFrame>} frame
 * @param {Buffer} [ackPayload]
 */
function buildAck(frame, ackPayload = Buffer.from([0x00])) {
    return encodeFrame({
        txn: frame.txn,
        proto: frame.proto,
        unit: frame.unit ?? 1,
        func: frame.func ?? 0x04,
        payloadPlain: ackPayload,
    });
}

/**
 * TCP stream → complete frames by Growatt length field.
 *
 * Classic XOR frames: total = 6 + length (CRC inside length, BE).
 * AES mid-session (3.1.1.7): clear unit/func, ciphertext multiple of 16,
 * CRC appended *outside* length → total = 6 + length + 2.
 * Without the AES size, a 2-byte CRC residue desyncs the stream into giant blobs.
 */
class FrameSplitter {
    constructor() {
        this._buf = Buffer.alloc(0);
    }

    /**
     * @param {Buffer} chunk
     * @returns {Buffer[]}
     */
    push(chunk) {
        if (!chunk || !chunk.length) {
            return [];
        }
        this._buf = Buffer.concat([this._buf, chunk]);
        const frames = [];
        while (this._buf.length >= 6) {
            const proto = this._buf.readUInt16BE(2);
            const length = this._buf.readUInt16BE(4);
            if (!usesXorCrc(proto) || length < 2 || length > 4096) {
                this._buf = this._buf.subarray(1);
                continue;
            }

            const classicTotal = 6 + length;
            const aesExternal = length >= 18 && (length - 2) % 16 === 0;
            const aesTotal = classicTotal + 2;

            let total = 0;
            if (aesExternal) {
                if (this._buf.length < aesTotal) {
                    break;
                }
                const crcRx = this._buf.readUInt16BE(classicTotal);
                const crcCalc = crc16Modbus(this._buf.subarray(0, classicTotal));
                if (crcRx === crcCalc) {
                    total = aesTotal;
                } else if (this._buf.length >= classicTotal) {
                    // fall back: maybe classic frame that happens to be 16-aligned
                    const cRx = this._buf.readUInt16BE(classicTotal - 2);
                    const cCalc = crc16Modbus(this._buf.subarray(0, classicTotal - 2));
                    total = cRx === cCalc ? classicTotal : aesTotal;
                } else {
                    break;
                }
            } else {
                if (this._buf.length < classicTotal) {
                    break;
                }
                total = classicTotal;
            }

            frames.push(this._buf.subarray(0, total));
            this._buf = this._buf.subarray(total);
        }
        // hard cap to avoid unbounded growth on garbage
        if (this._buf.length > 256 * 1024) {
            this._buf = Buffer.alloc(0);
        }
        return frames;
    }

    reset() {
        this._buf = Buffer.alloc(0);
    }
}

module.exports = {
    XOR_KEY,
    crc16Modbus,
    xorGrowatt,
    usesXorCrc,
    encodeFrame,
    decodeFrame,
    buildAck,
    FrameSplitter,
};
