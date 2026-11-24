'use strict';

const { AutoCalibrator } = require('./growattRecord');

/**
 * Known good layout for the production FRJ7CJD0S7 / stick XGD6CK737N
 * (586-byte 0x04/0x50 body). Lab fake-inverter records differ (pac@113/u16).
 */
const KNOWN_LAYOUTS = {
    XGD6CK737N: {
        pacOff: 87,
        pacKind: 'u32',
        pacScale: 0.1,
        etotalOff: 155,
        etotalKind: 'u32',
        etotalScale: 0.1,
        vacOff: 117,
        vacKind: 'u16',
        vacScale: 0.1,
        facOff: 91,
        facKind: 'u16',
        facScale: 0.01,
    },
};

/**
 * Normalize a layout object to the shape applyLayout expects.
 * @param {object|null|undefined} L
 * @returns {object|null}
 */
function normalizeLayout(L) {
    if (!L || L.pacOff === undefined || L.pacOff === null || L.pacOff === '') {
        return null;
    }
    return {
        pacOff: Number(L.pacOff),
        pacKind: L.pacKind || 'u32',
        pacScale: Number(L.pacScale ?? 0.1),
        etotalOff: Number(L.etotalOff ?? L.localEtotalOffset ?? 0),
        etotalKind: L.etotalKind || L.localEtotalKind || 'u32',
        etotalScale: Number(L.etotalScale ?? L.localEtotalScale ?? 0.1),
        vacOff: Number(L.vacOff ?? L.localVacOffset ?? 0x1e),
        vacKind: L.vacKind || 'u16',
        vacScale: Number(L.vacScale ?? 0.1),
        facOff: Number(L.facOff ?? L.localFacOffset ?? 0x24),
        facKind: L.facKind || 'u16',
        facScale: Number(L.facScale ?? 0.01),
    };
}

/**
 * Serialize layout for native / devices[].localLayout storage.
 * @param {object} L
 */
function layoutToStored(L) {
    const n = normalizeLayout(L);
    if (!n) {
        return null;
    }
    return {
        pacOff: n.pacOff,
        pacKind: n.pacKind,
        pacScale: n.pacScale,
        etotalOff: n.etotalOff,
        etotalKind: n.etotalKind,
        etotalScale: n.etotalScale,
        vacOff: n.vacOff,
        facOff: n.facOff,
    };
}

/**
 * Flat native keys (legacy single layout) → layout object.
 * @param {object} native
 */
function flatLayoutFromNative(native) {
    return normalizeLayout(AutoCalibrator.layoutFromNative(native));
}

/**
 * Build stickSn → layout map from native + devices[] + known pins + flat migration.
 * @param {object} native adapter.config / native
 * @returns {Map<string, object>}
 */
function layoutsBySnFromNative(native) {
    /** @type {Map<string, object>} */
    const map = new Map();
    const cfg = native || {};

    // Priority (low → high): known pins < flat migration < localLayouts < devices[].localLayout
    // Known pins protect production SNs from a stale lab-learned flat layout.
    for (const [sn, L] of Object.entries(KNOWN_LAYOUTS)) {
        const n = normalizeLayout(L);
        if (n) {
            map.set(sn, n);
        }
    }

    const flat = flatLayoutFromNative(cfg);
    const primary = String(cfg.localStickSn || cfg.cloudStickRedirectSn || '').trim();
    if (flat && primary && !KNOWN_LAYOUTS[primary]) {
        // Flat fills unknown primary sticks only (never overrides a known production pin).
        map.set(primary, flat);
    } else if (flat && primary && !map.has(primary)) {
        map.set(primary, flat);
    }

    const stored = cfg.localLayouts;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [sn, L] of Object.entries(stored)) {
            const n = normalizeLayout(L);
            if (sn && n) {
                map.set(String(sn).trim(), n);
            }
        }
    }

    const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
    for (const d of devices) {
        if (!d || !d.stickSn) {
            continue;
        }
        const sn = String(d.stickSn).trim();
        const n = normalizeLayout(d.localLayout);
        if (sn && n) {
            map.set(sn, n);
        }
    }

    return map;
}

/**
 * Primary layout for single-calibrator boot (feed stick / localStickSn).
 * @param {object} native
 * @returns {object|null}
 */
function primaryLayoutFromNative(native) {
    const map = layoutsBySnFromNative(native);
    const primary = String((native && (native.localStickSn || native.cloudStickRedirectSn)) || '').trim();
    if (primary && map.has(primary)) {
        return map.get(primary) || null;
    }
    if (map.size === 1) {
        return map.values().next().value || null;
    }
    return flatLayoutFromNative(native);
}

/**
 * Persist a learned/pinned layout under stickSn (+ flat keys for primary/compat).
 * @param {Record<string, any>} native mutated
 * @param {object} layout
 * @param {string} stickSn
 * @param {object} [opts]
 * @param {string} [opts.primarySn] when stickSn===primarySn also write flat keys
 */
function applyLayoutToNative(native, layout, stickSn, opts = {}) {
    const stored = layoutToStored(layout);
    if (!stored) {
        return;
    }
    const sn = String(stickSn || '').trim();
    if (!native.localLayouts || typeof native.localLayouts !== 'object') {
        native.localLayouts = {};
    }
    if (sn) {
        native.localLayouts[sn] = stored;
        const devices = Array.isArray(native.devices) ? native.devices : [];
        for (const d of devices) {
            if (d && String(d.stickSn || '').trim() === sn) {
                d.localLayout = stored;
            }
        }
    }
    const primary = String(opts.primarySn || native.localStickSn || '').trim();
    if (!sn || !primary || sn === primary) {
        native.localPacOffset = stored.pacOff;
        native.localPacKind = stored.pacKind;
        native.localPacScale = stored.pacScale;
        native.localEtotalOffset = stored.etotalOff;
        native.localEtotalKind = stored.etotalKind;
        native.localEtotalScale = stored.etotalScale;
        native.localVacOffset = stored.vacOff;
        native.localFacOffset = stored.facOff;
        native.localCalibrated = true;
    }
}

module.exports = {
    KNOWN_LAYOUTS,
    normalizeLayout,
    layoutToStored,
    flatLayoutFromNative,
    layoutsBySnFromNative,
    primaryLayoutFromNative,
    applyLayoutToNative,
};
