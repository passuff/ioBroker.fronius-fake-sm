'use strict';

const { persistNative } = require('./persistNative');
const { applyLayoutToNative } = require('./localLayouts');

/**
 * One-shot OpenAPI sample for local auto-calibrate truth (no Dauer-Cloud-Poll).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<{pac:number,etotal:number}|null>}
 */
async function fetchCalibrateTruthOnce(adapter) {
    if (adapter._calibrateTruth && adapter._calibrateTruth.etotal != null) {
        return adapter._calibrateTruth;
    }
    if (adapter._calibrateTruthTried) {
        return adapter._calibrateTruth || null;
    }
    adapter._calibrateTruthTried = true;
    const token = String(adapter.config.growattToken || '').trim();
    if (!token) {
        return null;
    }
    if (typeof adapter._clientFor !== 'function' || typeof adapter._getEnabledDevices !== 'function') {
        return null;
    }
    const devices = adapter._getEnabledDevices();
    if (!devices.length) {
        return null;
    }
    try {
        const sample = await adapter._clientFor(devices[0]).fetch();
        const truth = {
            pac: Math.abs(Number(sample.power_w) || 0),
            etotal: Math.abs(Number(sample.e_total_kwh) || 0),
        };
        adapter._calibrateTruth = truth;
        adapter.log.info(
            `Local calibrate truth from OpenAPI (one-shot): pac=${truth.pac} e=${truth.etotal}`,
        );
        return truth;
    } catch (err) {
        adapter.log.info(`Local calibrate truth one-shot skipped: ${err.message}`);
    }
    return null;
}

/**
 * Prefer one-shot token truth, else last poll/local sample.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {{pac:number,etotal:number}|null}
 */
function resolveCloudTruth(adapter) {
    const t = adapter._calibrateTruth;
    if (t && t.etotal != null) {
        return {
            pac: Math.abs(Number(t.pac) || 0),
            etotal: Math.abs(Number(t.etotal) || 0),
        };
    }
    const s = adapter._lastSample;
    if (!s || s.e_total_kwh == null) {
        return null;
    }
    return {
        pac: Math.abs(Number(s.power_w) || 0),
        etotal: Math.abs(Number(s.e_total_kwh) || 0),
    };
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} layout
 * @param {string} [stickSn]
 */
async function persistLearnedLayout(adapter, layout, stickSn) {
    if (adapter._persistLayoutTimer) {
        clearTimeout(adapter._persistLayoutTimer);
    }
    adapter._persistLayoutTimer = setTimeout(() => {
        void persistLearnedLayoutNow(adapter, layout, stickSn);
    }, 1500);
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} layout
 * @param {string} [stickSn]
 */
async function persistLearnedLayoutNow(adapter, layout, stickSn) {
    const sn = String(stickSn || adapter.config.localStickSn || '').trim();
    const primary = String(adapter.config.localStickSn || '').trim();
    applyLayoutToNative(adapter.config, layout, sn, { primarySn: primary });
    const result = await persistNative(
        adapter,
        (native) => {
            applyLayoutToNative(native, layout, sn, { primarySn: primary });
        },
        `learnedLayout:${sn || 'primary'}`,
    );
    if (result.wrote) {
        adapter.log.info(`Persisted local layout offsets SN=${sn || 'primary'}`);
    }
}

module.exports = {
    fetchCalibrateTruthOnce,
    resolveCloudTruth,
    persistLearnedLayout,
};
