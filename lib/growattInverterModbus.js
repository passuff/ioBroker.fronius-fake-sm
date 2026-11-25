'use strict';

const { encodeFrame } = require('./growattProto');

/**
 * Growatt stick ↔ inverter register commands (server→stick).
 * FC 0x05 = read holding registers (Grott), 0x06 = write single holding.
 * Payload: SN(30) + register(u16 BE) + value/qty(u16 BE).
 */

/**
 * @param {string} sn
 * @returns {Buffer}
 */
function snPad(sn) {
    const buf = Buffer.alloc(30, 0);
    Buffer.from(String(sn || ''), 'ascii').copy(buf, 0, 0, Math.min(30, String(sn || '').length));
    return buf;
}

/**
 * Read holding registers via stick (FC 0x05).
 * @param {object} opts
 * @param {string} opts.sn datalogger / stick SN
 * @param {number} opts.register start register
 * @param {number} [opts.quantity=1]
 * @param {number} [opts.proto]
 * @param {number} [opts.txn]
 * @returns {Buffer}
 */
function buildReadHoldingFrame(opts) {
    const reg = Number(opts.register) & 0xffff;
    const qty = Math.max(1, Math.min(125, Number(opts.quantity) || 1)) & 0xffff;
    const mid = Buffer.allocUnsafe(4);
    mid.writeUInt16BE(reg, 0);
    mid.writeUInt16BE(qty, 2);
    return encodeFrame({
        proto: Number(opts.proto ?? 0x0006),
        unit: 1,
        func: 0x05,
        payloadPlain: Buffer.concat([snPad(opts.sn), mid]),
        txn: Number(opts.txn ?? 1) & 0xffff,
    });
}

/**
 * Write single holding register (FC 0x06) — Grott-compatible.
 * @param {object} opts
 * @param {string} opts.sn
 * @param {number} opts.register
 * @param {number} opts.value
 * @param {number} [opts.proto]
 * @param {number} [opts.txn]
 * @returns {Buffer}
 */
function buildWriteSingleHoldingFrame(opts) {
    const reg = Number(opts.register) & 0xffff;
    const val = Number(opts.value) & 0xffff;
    const mid = Buffer.allocUnsafe(4);
    mid.writeUInt16BE(reg, 0);
    mid.writeUInt16BE(val, 2);
    return encodeFrame({
        proto: Number(opts.proto ?? 0x0006),
        unit: 1,
        func: 0x06,
        payloadPlain: Buffer.concat([snPad(opts.sn), mid]),
        txn: Number(opts.txn ?? 1) & 0xffff,
    });
}

/**
 * AES-encrypted DOWN write for FW 3.1.1.7 sessions.
 * @param {object} opts same as buildWriteSingleHoldingFrame + aesSession
 * @returns {Buffer|null}
 */
function buildWriteSingleHoldingFrameAes(opts) {
    const aes = opts.aesSession;
    if (!aes || typeof aes.encryptDown !== 'function') {
        return null;
    }
    const reg = Number(opts.register) & 0xffff;
    const val = Number(opts.value) & 0xffff;
    const mid = Buffer.allocUnsafe(4);
    mid.writeUInt16BE(reg, 0);
    mid.writeUInt16BE(val, 2);
    const payloadPlain = Buffer.concat([snPad(opts.sn), mid]);
    return aes.encryptDown({
        func: 0x06,
        payloadPlain,
        unit: 1,
        txn: Number(opts.txn ?? 1) & 0xffff,
        proto: Number(opts.proto ?? 0x0006),
    });
}

/**
 * AES-encrypted DOWN read.
 * @param {object} opts
 * @returns {Buffer|null}
 */
function buildReadHoldingFrameAes(opts) {
    const aes = opts.aesSession;
    if (!aes || typeof aes.encryptDown !== 'function') {
        return null;
    }
    const reg = Number(opts.register) & 0xffff;
    const qty = Math.max(1, Math.min(125, Number(opts.quantity) || 1)) & 0xffff;
    const mid = Buffer.allocUnsafe(4);
    mid.writeUInt16BE(reg, 0);
    mid.writeUInt16BE(qty, 2);
    return aes.encryptDown({
        func: 0x05,
        payloadPlain: Buffer.concat([snPad(opts.sn), mid]),
        unit: 1,
        txn: Number(opts.txn ?? 1) & 0xffff,
        proto: Number(opts.proto ?? 0x0006),
    });
}

/**
 * Send write to connected stick (AES if session ready).
 * @param {object} server GrowattServer instance
 * @param {object} opts
 * @returns {boolean}
 */
function sendWriteHolding(server, opts) {
    if (!server || typeof server.sendToStickOrAll !== 'function') {
        return false;
    }
    const sn = String(opts.sn || '');
    const sock = server._stickBySn && sn ? server._stickBySn.get(sn) : null;
    const aes = sock && sock._aesSession;
    let frame = null;
    if (aes && aes.ready !== false && aes.primarySession && aes.primarySession()) {
        frame = buildWriteSingleHoldingFrameAes({ ...opts, aesSession: aes });
    }
    if (!frame) {
        frame = buildWriteSingleHoldingFrame(opts);
    }
    return !!server.sendToStickOrAll(frame, sn);
}

/**
 * Send holding register read (FC 0x05) to stick.
 * @param {object} server
 * @param {object} opts
 * @returns {boolean}
 */
function sendReadHolding(server, opts) {
    if (!server || typeof server.sendToStickOrAll !== 'function') {
        return false;
    }
    const sn = String(opts.sn || '');
    const sock = server._stickBySn && sn ? server._stickBySn.get(sn) : null;
    const aes = sock && sock._aesSession;
    let frame = null;
    if (aes && aes.ready !== false && aes.primarySession && aes.primarySession()) {
        frame = buildReadHoldingFrameAes({ ...opts, aesSession: aes });
    }
    if (!frame) {
        frame = buildReadHoldingFrame(opts);
    }
    if (!server._pendingHoldingReads) {
        server._pendingHoldingReads = new Map();
    }
    server._pendingHoldingReads.set(Number(opts.register) & 0xffff, {
        register: Number(opts.register) & 0xffff,
        deviceSn: opts.deviceSn || '',
        at: Date.now(),
    });
    return !!server.sendToStickOrAll(frame, sn);
}

/**
 * Parse Growatt FC 0x05 response payload (after XOR/AES decode).
 * Expected: SN(30) + register(u16) + quantity(u16) + values(u16 * qty).
 * @param {Buffer} payload
 * @returns {{sn:string, register:number, quantity:number, values:number[]}|null}
 */
function parseReadHoldingResponse(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 34) {
        return null;
    }
    let end = 0;
    while (end < 30 && payload[end] !== 0) {
        end += 1;
    }
    const sn = payload.subarray(0, end).toString('ascii');
    if (!/^[A-Za-z0-9_-]+$/.test(sn)) {
        return null;
    }
    const register = payload.readUInt16BE(30);
    const quantity = payload.readUInt16BE(32);
    if (quantity < 1 || quantity > 125) {
        return null;
    }
    if (payload.length < 34 + quantity * 2) {
        return null;
    }
    const values = [];
    for (let i = 0; i < quantity; i++) {
        values.push(payload.readUInt16BE(34 + i * 2));
    }
    return { sn, register, quantity, values };
}

module.exports = {
    buildReadHoldingFrame,
    buildWriteSingleHoldingFrame,
    buildWriteSingleHoldingFrameAes,
    buildReadHoldingFrameAes,
    sendWriteHolding,
    sendReadHolding,
    parseReadHoldingResponse,
};
