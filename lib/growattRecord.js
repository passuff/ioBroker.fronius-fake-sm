'use strict';

/**
 * Parse Growatt stick data records + auto-calibrate field offsets against cloud truth.
 *
 * Payload layout (after unit+func decode) typically:
 *   SN (30 ASCII, NUL-padded) + record body (binary fields, big-endian).
 */

const SN_LEN = 30;

/** Seed layouts (Grott-style hints). AutoCalibrator overrides with learned offsets. */
const SEED_LAYOUTS = {
    // common TLX / MIN-family body offsets (relative to start of payload after SN)
    tlx: { pacOff: 0x2a, pacScale: 0.1, etotalOff: 0x3e, etotalScale: 0.1, vacOff: 0x1e, vacScale: 0.1, facOff: 0x24, facScale: 0.01 },
    min: { pacOff: 0x2a, pacScale: 0.1, etotalOff: 0x3e, etotalScale: 0.1, vacOff: 0x1e, vacScale: 0.1, facOff: 0x24, facScale: 0.01 },
};

/**
 * @param {Buffer} payload
 * @returns {string}
 */
function extractSn(payload) {
    if (!payload || payload.length < 4) {
        return '';
    }
    const n = Math.min(SN_LEN, payload.length);
    let end = 0;
    while (end < n && payload[end] !== 0) {
        end += 1;
    }
    const s = payload.subarray(0, end).toString('ascii');
    return /^[A-Za-z0-9_-]+$/.test(s) ? s : '';
}

/**
 * @param {Buffer} buf
 * @param {number} off
 * @param {'u16'|'u32'|'i16'|'i32'} kind
 */
function readBe(buf, off, kind) {
    if (off < 0 || !buf) {
        return null;
    }
    try {
        if (kind === 'u16' && off + 2 <= buf.length) {
            return buf.readUInt16BE(off);
        }
        if (kind === 'i16' && off + 2 <= buf.length) {
            return buf.readInt16BE(off);
        }
        if (kind === 'u32' && off + 4 <= buf.length) {
            return buf.readUInt32BE(off);
        }
        if (kind === 'i32' && off + 4 <= buf.length) {
            return buf.readInt32BE(off);
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Body = payload after SN pad (or full payload if SN short).
 * @param {Buffer} payload
 */
function bodyAfterSn(payload) {
    if (!payload) {
        return Buffer.alloc(0);
    }
    if (payload.length >= SN_LEN) {
        return payload.subarray(SN_LEN);
    }
    return payload;
}

/**
 * @param {object} layout
 * @param {Buffer} body
 */
function applyLayout(layout, body) {
    if (!layout || !body) {
        return null;
    }
    const pacRaw = readBe(body, layout.pacOff, layout.pacKind || 'u32');
    const eRaw = readBe(body, layout.etotalOff, layout.etotalKind || 'u32');
    const vacRaw = readBe(body, layout.vacOff, layout.vacKind || 'u16');
    const facRaw = readBe(body, layout.facOff, layout.facKind || 'u16');
    if (pacRaw === null && eRaw === null) {
        return null;
    }
    const out = {
        pac_w: pacRaw === null ? 0 : pacRaw * Number(layout.pacScale ?? 0.1),
        e_total_kwh: eRaw === null ? 0 : eRaw * Number(layout.etotalScale ?? 0.1),
        u1: vacRaw === null ? 0 : vacRaw * Number(layout.vacScale ?? 0.1),
        f: facRaw === null ? 0 : facRaw * Number(layout.facScale ?? 0.01),
    };
    // Optional extended fields (seed or learned offsets)
    const etodayOff =
        layout.etodayOff != null
            ? layout.etodayOff
            : layout.etotalOff != null && layout.etotalOff >= 4
              ? layout.etotalOff - 4
              : null;
    if (etodayOff != null) {
        const et = readBe(body, etodayOff, layout.etodayKind || layout.etotalKind || 'u32');
        if (et != null) {
            out.e_today_kwh = et * Number(layout.etodayScale ?? layout.etotalScale ?? 0.1);
        }
    }
    if (layout.statusOff != null) {
        const st = readBe(body, layout.statusOff, layout.statusKind || 'u16');
        if (st != null) {
            out.status = st;
        }
    }
    if (layout.tempOff != null) {
        const t = readBe(body, layout.tempOff, layout.tempKind || 'u16');
        if (t != null) {
            out.temp = t * Number(layout.tempScale ?? 0.1);
        }
    }
    if (layout.ppvOff != null) {
        const p = readBe(body, layout.ppvOff, layout.ppvKind || 'u32');
        if (p != null) {
            out.ppv_w = p * Number(layout.ppvScale ?? 0.1);
        }
    }
    return out;
}

/**
 * @param {object} opts
 * @param {Buffer} opts.payload
 * @param {number} opts.func
 * @param {number} opts.proto
 * @param {number} opts.frameLen
 * @param {object|null} opts.layout learned layout — required for parsed values
 * @param {boolean} [opts.allowSeed] only for tests; production must not feed Modbus from seed
 */
function parseDataRecord(opts) {
    const payload = opts.payload;
    const sn = extractSn(payload);
    const body = bodyAfterSn(payload);
    const layout = opts.layout || (opts.allowSeed ? SEED_LAYOUTS.tlx : null);
    const vals = layout ? applyLayout(layout, body) : null;
    return {
        sn,
        func: opts.func,
        proto: opts.proto,
        frameLen: opts.frameLen,
        recordType: `0x${Number(opts.func).toString(16)}_${opts.frameLen}`,
        bodyLen: body.length,
        body,
        pac_w: vals ? vals.pac_w : null,
        e_total_kwh: vals ? vals.e_total_kwh : null,
        e_today_kwh: vals && vals.e_today_kwh != null ? vals.e_today_kwh : null,
        ppv_w: vals && vals.ppv_w != null ? vals.ppv_w : null,
        status: vals && vals.status != null ? vals.status : null,
        temp: vals && vals.temp != null ? vals.temp : null,
        u1: vals ? vals.u1 : 0,
        f: vals ? vals.f : 0,
        parsed: !!vals,
        fields: vals || null,
    };
}

/**
 * Try Grott-style seed layouts when no cloud truth is available (local-only).
 * @param {Buffer} body
 * @returns {object|null}
 */
function trySeedLayout(body) {
    if (!body || body.length < 64) {
        return null;
    }
    for (const [name, seed] of Object.entries(SEED_LAYOUTS)) {
        const vals = applyLayout(seed, body);
        if (!vals) {
            continue;
        }
        const pac = Math.abs(Number(vals.pac_w) || 0);
        const e = Math.abs(Number(vals.e_total_kwh) || 0);
        // Plausible production or a non-trivial lifetime counter
        const okDay = pac >= 20 && pac < 200000;
        const okEnergy = e >= 10 && e < 1e7;
        if (okDay || (pac < 20 && okEnergy)) {
            return { ...seed, seedName: name };
        }
    }
    return null;
}

function isDataFunc(func) {
    return func === 0x04 || func === 0x50 || func === 0x03;
}

/**
 * Realtime data records that may feed the Modbus mirror / auto-calibration.
 * 0x04 (data) and 0x50 (newer report) carry live AC fields; 0x03 is a
 * buffered/announce record whose realtime fields are zero-filled on
 * ShineWiFi-X 3.1.0.x — using it would clobber live power with 0 W.
 * @param {number} func
 */
function isRealtimeDataFunc(func) {
    return func === 0x04 || func === 0x50;
}

/**
 * Auto-calibrate pac/etotal offsets against cloud ground truth.
 */
class AutoCalibrator {
    /**
     * @param {object} [opts]
     * @param {number} [opts.neededHits]
     * @param {number} [opts.tolerance]
     * @param {number} [opts.failAfterAttempts] give up after N daytime observes without lock
     * @param {boolean} [opts.enabled] when false, never auto-scan
     * @param {(m:string)=>void} [opts.log]
     */
    constructor(opts = {}) {
        this.neededHits = Number(opts.neededHits ?? 3);
        this.tolerance = Number(opts.tolerance ?? 0.08);
        this.failAfterAttempts = Number(opts.failAfterAttempts ?? 40);
        this.enabled = opts.enabled !== false;
        this.log = opts.log || (() => {});
        /** @type {object|null} */
        this.layout = opts.layout || null;
        this.calibrated = !!opts.layout;
        this.failed = false;
        this.failReason = '';
        this.observeAttempts = 0;
        /** @type {Map<string, number>} */
        this._hits = new Map();
        this._lockedKey = null;
        /** @type {string[]} */
        this._lastCandidateKeys = [];
    }

    /**
     * @param {object|null} layout
     */
    setLayout(layout) {
        this.layout = layout;
        this.calibrated = !!layout;
        if (layout) {
            this.failed = false;
            this.failReason = '';
        }
    }

    /**
     * Top hit keys for diagnostics.
     * @param {number} [n]
     */
    topCandidates(n = 5) {
        return [...this._hits.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([k, c]) => `${k}×${c}`);
    }

    /**
     * @param {Buffer} body
     * @param {{pac:number, etotal:number}} truth absolute watts / kWh from cloud
     * @returns {object|null} locked layout or null
     */
    observe(body, truth) {
        if (this.calibrated && this.layout) {
            return this.layout;
        }
        if (!this.enabled) {
            if (!this.failed) {
                this.failed = true;
                this.failReason = 'auto-calibrate disabled and no learned layout';
            }
            return null;
        }
        if (this.failed || !body || !body.length || !truth) {
            return null;
        }
        const pacAbs = Math.abs(Number(truth.pac) || 0);
        const eAbs = Math.abs(Number(truth.etotal) || 0);
        // Night / idle — do not burn fail budget
        if (pacAbs < 20) {
            return null;
        }

        const candidates = this._scan(body, pacAbs, eAbs);
        this._lastCandidateKeys = candidates.map((c) => c.key);
        if (!candidates.length) {
            return null;
        }
        this.observeAttempts += 1;
        for (const c of candidates) {
            const key = c.key;
            const n = (this._hits.get(key) || 0) + 1;
            this._hits.set(key, n);
            if (n >= this.neededHits) {
                this.layout = c.layout;
                this.calibrated = true;
                this._lockedKey = key;
                this.log(`local auto-calibrated layout ${key}`);
                return this.layout;
            }
        }

        if (this.observeAttempts >= this.failAfterAttempts) {
            this.failed = true;
            const top = this.topCandidates(5).join(', ') || this._lastCandidateKeys.slice(0, 5).join(', ') || 'none';
            this.failReason = `auto-calibrate failed after ${this.observeAttempts} daytime samples; candidates: ${top}`;
            this.log(this.failReason);
        }
        return null;
    }

    /**
     * @param {Buffer} body
     * @param {number} pacAbs
     * @param {number} eAbs
     */
    _scan(body, pacAbs, eAbs) {
        const scales = [0.1, 1, 0.01];
        const kinds = /** @type {const} */ (['u32', 'i32', 'u16', 'i16']);
        /** @type {Array<{key:string, score:number, layout:object}>} */
        const out = [];

        for (const kind of kinds) {
            const step = kind.endsWith('16') ? 2 : 4;
            for (let off = 0; off + step <= body.length; off += 2) {
                const raw = readBe(body, off, kind);
                if (raw === null || raw === 0) {
                    continue;
                }
                for (const scale of scales) {
                    const val = Math.abs(raw * scale);
                    if (pacAbs >= 20 && withinTol(val, pacAbs, this.tolerance)) {
                        // Require energy match — locking with etotalOff:0 poisons e_total
                        const eMatch = this._findE(body, eAbs, off);
                        if (!eMatch && eAbs >= 1) {
                            continue;
                        }
                        if (!eMatch) {
                            continue;
                        }
                        out.push({
                            key: `pac@${off}:${kind}*${scale}+e@${eMatch.off}`,
                            score: 1,
                            layout: {
                                pacOff: off,
                                pacKind: kind,
                                pacScale: scale,
                                etotalOff: eMatch.off,
                                etotalKind: eMatch.kind,
                                etotalScale: eMatch.scale,
                                vacOff: 0x1e,
                                vacKind: 'u16',
                                vacScale: 0.1,
                                facOff: 0x24,
                                facKind: 'u16',
                                facScale: 0.01,
                            },
                        });
                    }
                }
            }
        }
        // keep top few to avoid hit-map explosion
        out.sort((a, b) => a.key.localeCompare(b.key));
        return out.slice(0, 8);
    }

    _findE(body, eAbs, skipOff) {
        if (eAbs < 1) {
            return null;
        }
        const scales = [0.1, 1, 0.01];
        const kinds = /** @type {const} */ (['u32', 'u16']);
        for (const kind of kinds) {
            const step = kind === 'u16' ? 2 : 4;
            for (let off = 0; off + step <= body.length; off += 2) {
                if (Math.abs(off - skipOff) < 4) {
                    continue;
                }
                const raw = readBe(body, off, kind);
                if (raw === null || raw === 0) {
                    continue;
                }
                for (const scale of scales) {
                    const val = Math.abs(raw * scale);
                    if (withinTol(val, eAbs, this.tolerance)) {
                        return { off, kind, scale };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Serialize learned layout for native config persistence.
     */
    toNative() {
        if (!this.layout) {
            return {};
        }
        const L = this.layout;
        return {
            localPacOffset: L.pacOff,
            localPacKind: L.pacKind || 'u32',
            localPacScale: L.pacScale,
            localEtotalOffset: L.etotalOff,
            localEtotalKind: L.etotalKind || 'u32',
            localEtotalScale: L.etotalScale,
            localVacOffset: L.vacOff,
            localFacOffset: L.facOff,
            localCalibrated: true,
        };
    }

    /**
     * @param {object} native
     */
    static layoutFromNative(native) {
        if (!native || native.localPacOffset === undefined || native.localPacOffset === null || native.localPacOffset === '') {
            return null;
        }
        return {
            pacOff: Number(native.localPacOffset),
            pacKind: native.localPacKind || 'u32',
            pacScale: Number(native.localPacScale ?? 0.1),
            etotalOff: Number(native.localEtotalOffset ?? 0),
            etotalKind: native.localEtotalKind || 'u32',
            etotalScale: Number(native.localEtotalScale ?? 0.1),
            vacOff: Number(native.localVacOffset ?? 0x1e),
            vacKind: 'u16',
            vacScale: 0.1,
            facOff: Number(native.localFacOffset ?? 0x24),
            facKind: 'u16',
            facScale: 0.01,
        };
    }
}

function withinTol(a, b, tol) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
        return false;
    }
    return Math.abs(a - b) / Math.abs(b) <= tol;
}

module.exports = {
    SN_LEN,
    SEED_LAYOUTS,
    extractSn,
    bodyAfterSn,
    parseDataRecord,
    trySeedLayout,
    isDataFunc,
    isRealtimeDataFunc,
    applyLayout,
    AutoCalibrator,
    readBe,
};
