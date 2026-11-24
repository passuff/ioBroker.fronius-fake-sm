'use strict';

const { decodeFrame, usesXorCrc } = require('./growattProto');
const { isDataFunc, extractSn } = require('./growattRecord');

/** Stick FW versions with known-good classic local decode. */
const TESTED_STICK_FW = ['3.1.0.2', '3.1.0.5'];

const CONTROL_FUNCS = new Set([0x16, 0x18, 0x19, 0x03, 0x05]);

/**
 * @param {string} fw
 * @returns {boolean}
 */
function isTestedStickFw(fw) {
    const v = String(fw || '').trim();
    return !v || TESTED_STICK_FW.includes(v);
}

/**
 * @param {Buffer} raw
 * @returns {{kind:'data'|'control'|'unknown', proto:number|null, wireFunc:number|null, crcOk:boolean, reason:string}}
 */
function classifyFrame(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 8) {
        return { kind: 'unknown', proto: null, wireFunc: null, crcOk: false, reason: 'too_short' };
    }
    const proto = raw.readUInt16BE(2);
    const wireFunc = raw[7];
    let frame = null;
    try {
        frame = decodeFrame(raw);
    } catch (err) {
        return {
            kind: 'unknown',
            proto,
            wireFunc,
            crcOk: false,
            reason: `decode:${err.message}`,
        };
    }
    // 0x41 key negotiation (3.1.1.7) — clear unit/func on wire, classic CRC often fails
    if (wireFunc === 0x41 || (frame && frame.func === 0x41)) {
        return { kind: 'control', proto, wireFunc, crcOk: !!(frame && frame.crcOk), reason: 'handshake_0x41' };
    }
    if (usesXorCrc(proto) && !frame.crcOk) {
        // CRC is advisory for classic ShineWiFi-X 3.1.0.x frames (the stick
        // zero-fills the record trailer). Trust the XOR-decoded payload ONLY
        // when it yields a readable datalogger SN — that distinguishes a genuine
        // classic frame from an AES 3.1.1.7 frame whose wire func byte merely
        // happens to look like a known func. Without an SN it stays "unknown".
        const hasSn = !!extractSn(frame.payload);
        if (hasSn && isDataFunc(frame.func)) {
            return { kind: 'data', proto, wireFunc, crcOk: false, reason: 'data_crcadv' };
        }
        if (hasSn && (CONTROL_FUNCS.has(frame.func) || CONTROL_FUNCS.has(wireFunc))) {
            return { kind: 'control', proto, wireFunc, crcOk: false, reason: 'control_crcadv' };
        }
        return {
            kind: 'unknown',
            proto,
            wireFunc,
            crcOk: false,
            reason: 'bad_crc',
        };
    }
    // Classic data path (XOR protos with known data funcs)
    if (usesXorCrc(proto) && frame.crcOk && isDataFunc(frame.func)) {
        return { kind: 'data', proto, wireFunc, crcOk: true, reason: 'data' };
    }
    // Known control / register / ping with valid CRC (or non-XOR keepalive)
    if (frame.crcOk && (CONTROL_FUNCS.has(frame.func) || CONTROL_FUNCS.has(wireFunc))) {
        return { kind: 'control', proto, wireFunc, crcOk: true, reason: 'control' };
    }
    // Non-classic proto (0x0001 / 0x000a / 0x000e keepalives) without XOR CRC
    if (!usesXorCrc(proto) && raw.length <= 16) {
        return { kind: 'control', proto, wireFunc, crcOk: true, reason: 'keepalive' };
    }
    return {
        kind: 'unknown',
        proto,
        wireFunc,
        crcOk: !!frame.crcOk,
        reason: `func_0x${Number(wireFunc).toString(16)}`,
    };
}

/**
 * Per-stick-socket frame health tracker.
 */
class SessionFrameHealth {
    /**
     * @param {{now?:()=>number, noDataMs?:number}} [opts]
     */
    constructor(opts = {}) {
        this._now = opts.now || (() => Date.now());
        this.noDataMs = Number(opts.noDataMs ?? 12 * 60 * 1000);
        this.firstSeenAt = this._now();
        this.data = 0;
        this.control = 0;
        this.unknown = 0;
        /** @type {string[]} */
        this.samples = [];
        /** @type {Set<string>} */
        this.wireFuncs = new Set();
        /** @type {Set<string>} */
        this.protos = new Set();
        /** @type {string} */
        this.verdict = 'pending';
    }

    /**
     * @param {Buffer} raw
     * @returns {string} current verdict
     */
    observe(raw) {
        const c = classifyFrame(raw);
        if (c.wireFunc != null) {
            this.wireFuncs.add(`0x${Number(c.wireFunc).toString(16)}`);
        }
        if (c.proto != null) {
            this.protos.add(`0x${Number(c.proto).toString(16)}`);
        }
        if (c.kind === 'data') {
            this.data += 1;
        } else if (c.kind === 'control') {
            this.control += 1;
        } else {
            this.unknown += 1;
            if (this.samples.length < 3 && Buffer.isBuffer(raw)) {
                this.samples.push(raw.toString('hex').slice(0, 96));
            }
        }
        return this._updateVerdict();
    }

    /** Call from the 12-minute timer. */
    checkTimeout() {
        return this._updateVerdict();
    }

    _updateVerdict() {
        let next = 'pending';
        if (this.data > 0) {
            next = 'ok';
            // One undecodable frame (e.g. 0x41 handshake) plus any follow-up
            // without classic data is enough — stick rarely repeats unknown frames.
        } else if (this.unknown >= 1 && this.unknown + this.control >= 2) {
            next = 'unknown_fw';
        } else if (this.unknown >= 2) {
            next = 'unknown_fw';
        } else if (this._now() - this.firstSeenAt >= this.noDataMs && this.data === 0) {
            next = 'no_data';
        }
        this.verdict = next;
        return next;
    }

    /**
     * @returns {{verdict:string, data:number, control:number, unknown:number, wireFuncs:string[], samples:string[], text:string}}
     */
    snapshot() {
        const funcs = [...this.wireFuncs].sort().join('/');
        let text = 'ok';
        if (this.verdict === 'unknown_fw') {
            text = `unbekannte Stick-FW (wire ${funcs || '?'}, CRC/Protokoll)`;
        } else if (this.verdict === 'no_data') {
            text = 'keine Daten-Frames';
        } else if (this.verdict === 'pending') {
            text = 'warte auf Frames';
        }
        return {
            verdict: this.verdict,
            data: this.data,
            control: this.control,
            unknown: this.unknown,
            wireFuncs: [...this.wireFuncs],
            samples: [...this.samples],
            text,
        };
    }
}

module.exports = {
    TESTED_STICK_FW,
    isTestedStickFw,
    classifyFrame,
    SessionFrameHealth,
};
