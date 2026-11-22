'use strict';

const { encodeFrame } = require('./growattProto');

/**
 * Build Growatt cloud FC 0x18 datalogger configure (Grott-compatible).
 * Payload: SN(30 for proto 6) + reg(u16 BE) + valueLen(u16 BE) + value ASCII.
 *
 * @param {object} opts
 * @param {string} opts.sn stick / datalogger serial
 * @param {number} opts.reg e.g. 17=server IP, 18=port, 31=datetime
 * @param {string|number} opts.value
 * @param {number} [opts.proto]
 * @param {number} [opts.txn]
 */
function buildConfigureFrame(opts) {
    const sn = String(opts.sn || '');
    const reg = Number(opts.reg);
    const value = String(opts.value);
    const proto = Number(opts.proto ?? 0x0006);
    const txn = Number(opts.txn ?? 1) & 0xffff;

    const snBuf = Buffer.alloc(30, 0);
    Buffer.from(sn, 'ascii').copy(snBuf, 0, 0, Math.min(30, sn.length));

    const valBuf = Buffer.from(value, 'ascii');
    const mid = Buffer.allocUnsafe(4);
    mid.writeUInt16BE(reg & 0xffff, 0);
    mid.writeUInt16BE(valBuf.length, 2);

    return encodeFrame({
        proto,
        unit: 1,
        func: 0x18,
        payloadPlain: Buffer.concat([snBuf, mid, valBuf]),
        txn,
    });
}

/**
 * @param {string} sn
 * @param {string} serverIp
 * @param {number} [port]
 * @param {number} [proto]
 */
function buildRedirectFrames(sn, serverIp, port = 5279, proto = 0x0006) {
    return [
        buildConfigureFrame({ sn, reg: 17, value: serverIp, proto, txn: 1 }),
        buildConfigureFrame({ sn, reg: 18, value: String(port), proto, txn: 2 }),
    ];
}

module.exports = {
    buildConfigureFrame,
    buildRedirectFrames,
};
