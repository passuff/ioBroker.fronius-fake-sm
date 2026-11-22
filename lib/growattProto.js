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
        const obfuscated = xorGrowatt(plainBody);
        const length = obfuscated.length + 2;
        const header = Buffer.allocUnsafe(6);
        header.writeUInt16BE(txn, 0);
        header.writeUInt16BE(proto, 2);
        header.writeUInt16BE(length, 4);
        const crc = crc16Modbus(Buffer.concat([header, obfuscated]));
        const crcBuf = Buffer.allocUnsafe(2);
        crcBuf.writeUInt16BE(crc, 0);
        return Buffer.concat([header, obfuscated, crcBuf]);
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
        const bodyX = raw.subarray(6, 6 + length - 2);
        const crcRx = raw.readUInt16BE(6 + length - 2);
        const crcCalc = crc16Modbus(raw.subarray(0, 6 + length - 2));
        const plain = xorGrowatt(bodyX);
        return {
            txn,
            proto,
            length,
            unit: plain.length ? plain[0] : null,
            func: plain.length > 1 ? plain[1] : null,
            payload: plain.length > 2 ? plain.subarray(2) : Buffer.alloc(0),
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
            const length = this._buf.readUInt16BE(4);
            if (length > 65535 || length < 0) {
                // resync: drop one byte
                this._buf = this._buf.subarray(1);
                continue;
            }
            const total = 6 + length;
            if (this._buf.length < total) {
                break;
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
