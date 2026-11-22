'use strict';

/**
 * Fronius TS 65A-3 proprietary holding-register encoding (pelle8/smartmeter).
 */

/**
 * @param {number} value
 * @returns {[number, number]} low word first (pelle8 get_32bits_from_value)
 */
function get32BitsFromValue(value) {
    let v = Math.trunc(Number(value) || 0);
    if (v >= 0) {
        return [v & 65535, v >> 16];
    }
    v = -v;
    return [65535 - (v & 65535), 65535 - (v >> 16)];
}

/**
 * Build live register blocks from meter values.
 * @param {object} m
 * @returns {{ reg258: number[], reg286: number[], reg1024: number[] }}
 */
function convertValuesToRegisters(m) {
    const eConsumed = Number(m.e_consumed) || 0;
    const eProduced = Number(m.e_produced) || 0;
    const erConsumed = Number(m.er_consumed) || 0;
    const erProduced = Number(m.er_produced) || 0;
    const frequency = Number(m.f) || 50;
    const u1 = Number(m.u1) || 230;
    const u2 = Number(m.u2) || 230;
    const u3 = Number(m.u3) || 230;
    const uMean = (u1 + u2 + u3) / 3;
    const uMeanPhases = uMean * 1.73;

    // pelle8 forces currents absolute before Fronius encode
    let i1 = Math.abs(Number(m.i1) || 0);
    let i2 = Math.abs(Number(m.i2) || 0);
    let i3 = Math.abs(Number(m.i3) || 0);

    const p1 = Number(m.p1) || 0;
    const p2 = Number(m.p2) || 0;
    const p3 = Number(m.p3) || 0;
    const ptot = Number(m.pt) || 0;
    const pr1 = Number(m.pr1) || 0;
    const pr2 = Number(m.pr2) || 0;
    const pr3 = Number(m.pr3) || 0;
    const prtot = Number(m.prt) || 0;
    const pa1 = Number(m.pa1) || 0;
    const pa2 = Number(m.pa2) || 0;
    const pa3 = Number(m.pa3) || 0;
    const patot = Number(m.pat) || 0;
    const pf1 = Number(m.pf1) || 0;
    const pf2 = Number(m.pf2) || 0;
    const pf3 = Number(m.pf3) || 0;
    const pftot = Number(m.pft) || 0;

    const reg1024 = [
        ...get32BitsFromValue(Math.trunc(eConsumed)),
        ...get32BitsFromValue((eConsumed - Math.trunc(eConsumed)) * 1000),
        ...get32BitsFromValue(Math.trunc(erConsumed)),
        ...get32BitsFromValue((erConsumed - Math.trunc(erConsumed)) * 1000),
        ...get32BitsFromValue(Math.trunc(eProduced)),
        ...get32BitsFromValue((eProduced - Math.trunc(eProduced)) * 1000),
        ...get32BitsFromValue(Math.trunc(erProduced)),
        ...get32BitsFromValue((erProduced - Math.trunc(erProduced)) * 1000),
    ];

    const reg258 = [
        ...get32BitsFromValue(uMean * 10),
        ...get32BitsFromValue(uMeanPhases * 10),
        ...get32BitsFromValue(ptot * 10),
        ...get32BitsFromValue(patot * 10),
        ...get32BitsFromValue(prtot * 10),
        ...get32BitsFromValue(Math.round(pftot * 10 * 100)),
        ...get32BitsFromValue(0),
        ...get32BitsFromValue(frequency * 10),
    ];

    const reg286 = [
        ...get32BitsFromValue(u1 * 1.73 * 10),
        ...get32BitsFromValue(u1 * 10),
        ...get32BitsFromValue(i1 * 1000),
        ...get32BitsFromValue(p1 * 10),
        ...get32BitsFromValue(pa1 * 10),
        ...get32BitsFromValue(pr1 * 10),
        ...get32BitsFromValue(Math.round(pf1 * 10 * 100)),
        ...get32BitsFromValue(u2 * 1.73 * 10),
        ...get32BitsFromValue(u2 * 10),
        ...get32BitsFromValue(i2 * 1000),
        ...get32BitsFromValue(p2 * 10),
        ...get32BitsFromValue(pa2 * 10),
        ...get32BitsFromValue(pr2 * 10),
        ...get32BitsFromValue(Math.round(pf2 * 10 * 100)),
        ...get32BitsFromValue(u3 * 1.73 * 10),
        ...get32BitsFromValue(u3 * 10),
        ...get32BitsFromValue(i3 * 1000),
        ...get32BitsFromValue(p3 * 10),
        ...get32BitsFromValue(pa3 * 10),
        ...get32BitsFromValue(pr3 * 10),
        ...get32BitsFromValue(Math.round(pf3 * 10 * 100)),
    ];

    return { reg258, reg286, reg1024 };
}

/**
 * Static identity / model registers for TS65A-3 init (pelle8).
 * @param {number} fakeUniqueId
 * @returns {Map<number, number>} address -> uint16
 */
function buildStaticHoldingMap(fakeUniqueId) {
    const map = new Map();
    const set = (addr, values) => {
        for (let i = 0; i < values.length; i++) {
            map.set(addr + i, values[i] & 0xffff);
        }
    };

    // Pelle8/pymodbus SparseDataBlock keys are 1-based (client addr A → key A+1).
    // jsmodbus uses protocol addresses directly — so pelle8_key - 1.
    set(0, [2336, 0]); // pelle8 key 1
    set(11, [731]); // pelle8 key 12 — Gen24 probes addr 11
    set(770, [1, 3]); // pelle8 key 771
    set(4098, [1]); // pelle8 key 4099
    set(4355, [1]); // pelle8 key 4356
    set(4356, [1, 0]); // pelle8 key 4357
    set(20480, [50, 52, 48, 50, 54, 54, 87, 31974, 1451 + Number(fakeUniqueId) - 1]); // key 20481
    set(20496, [2022]); // key 20497
    set(768, [0, 0]); // same key 768 in pelle8 live-zero block (protocol 768)

    // live blocks zeroed until first update (protocol addresses match setValues)
    for (let a = 258; a < 258 + 17; a++) {
        map.set(a, 0);
    }
    for (let a = 286; a < 286 + 43; a++) {
        map.set(a, 0);
    }
    for (let a = 1024; a < 1024 + 17; a++) {
        map.set(a, 0);
    }

    return map;
}

/**
 * Meter JSON used by register encoder (same keys as pelle8 MQTT payload).
 * @param {object} opts
 */
function buildMeterValues(opts) {
    const pt = Number(opts.powerW) || 0;
    const u1 = Number(opts.u1) || 237;
    const uEff = Math.abs(u1) > 1 ? u1 : 230;
    const i1 = pt / uEff;

    return {
        i1,
        i2: 0,
        i3: 0,
        p1: pt,
        p2: 0,
        p3: 0,
        pt,
        e_consumed: 0,
        e_produced: Number(opts.eProducedKwh) || 0,
        er_consumed: 0,
        er_produced: 0,
        f: Number(opts.f) || 50,
        u1,
        u2: Number(opts.u2) || u1,
        u3: Number(opts.u3) || u1,
        pr1: 0,
        pr2: 0,
        pr3: 0,
        prt: 0,
        pa1: 0,
        pa2: 0,
        pa3: 0,
        pat: 0,
        pf1: 0,
        pf2: 0,
        pf3: 0,
        pft: 0,
    };
}

module.exports = {
    get32BitsFromValue,
    convertValuesToRegisters,
    buildStaticHoldingMap,
    buildMeterValues,
};
