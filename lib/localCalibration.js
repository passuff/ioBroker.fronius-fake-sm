'use strict';

const { persistNative } = require('./persistNative');
const { applyLayoutToNative } = require('./localLayouts');

/**
 * @param {{pac:number,etotal:number}} truth
 */
function normTruth(truth) {
    if (!truth || truth.etotal == null) {
        return null;
    }
    return {
        pac: Math.abs(Number(truth.pac) || 0),
        etotal: Math.abs(Number(truth.etotal) || 0),
    };
}

/**
 * Remember truth under deviceSn and stickSn keys.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} device
 * @param {{pac:number,etotal:number}} truth
 */
function rememberTruthForDevice(adapter, device, truth) {
    const t = normTruth(truth);
    if (!t) {
        return;
    }
    if (!adapter._calibrateTruthByKey) {
        adapter._calibrateTruthByKey = Object.create(null);
    }
    const map = adapter._calibrateTruthByKey;
    if (device && device.deviceSn) {
        map[String(device.deviceSn).trim()] = t;
    }
    if (device && device.stickSn) {
        map[String(device.stickSn).trim()] = t;
    }
    // Legacy single-slot fallback (primary / first device)
    if (!adapter._calibrateTruth) {
        adapter._calibrateTruth = t;
    }
}

/**
 * One-shot OpenAPI samples for local auto-calibrate truth (per enabled device).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<{pac:number,etotal:number}|null>}
 */
async function fetchCalibrateTruthOnce(adapter) {
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
    let first = null;
    for (const device of devices) {
        try {
            const sample = await adapter._clientFor(device).fetch();
            const truth = {
                pac: Math.abs(Number(sample.power_w) || 0),
                etotal: Math.abs(Number(sample.e_total_kwh) || 0),
            };
            rememberTruthForDevice(adapter, device, truth);
            if (!first) {
                first = truth;
                adapter._calibrateTruth = truth;
            }
            adapter.log.info(
                `Local calibrate truth from OpenAPI SN=${device.deviceSn || '-'} stick=${device.stickSn || '-'}: ` +
                    `pac=${truth.pac} e=${truth.etotal}`,
            );
        } catch (err) {
            adapter.log.info(
                `Local calibrate truth one-shot skipped for ${device.deviceSn || '?'}: ${err.message}`,
            );
        }
    }
    return first;
}

/**
 * Resolve cloud ground truth for a stick (or inverter) SN.
 * Prefers per-SN map, then device table mapping, then legacy single truth / last sample.
 *
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} [stickOrDeviceSn]
 * @returns {{pac:number,etotal:number}|null}
 */
function resolveCloudTruth(adapter, stickOrDeviceSn) {
    const key = String(stickOrDeviceSn || '').trim();
    const map = adapter._calibrateTruthByKey || null;

    if (key && map && map[key]) {
        return normTruth(map[key]);
    }

    if (key) {
        const devices = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
        const byStick = devices.find((d) => d && String(d.stickSn || '').trim() === key);
        const byDev = devices.find((d) => d && String(d.deviceSn || '').trim() === key);
        const row = byStick || byDev;
        if (row && map) {
            const viaDev = row.deviceSn && map[String(row.deviceSn).trim()];
            const viaStick = row.stickSn && map[String(row.stickSn).trim()];
            const hit = viaDev || viaStick;
            if (hit) {
                return normTruth(hit);
            }
        }
        // Known stick without its own truth must NOT fall back to another plant's truth.
        if (byStick || byDev) {
            return null;
        }
    }

    const legacy = normTruth(adapter._calibrateTruth);
    if (legacy) {
        return legacy;
    }
    const s = adapter._lastSample;
    if (!s || s.e_total_kwh == null) {
        return null;
    }
    // Last sample only when no SN asked (legacy) or SN unknown to device table.
    if (key) {
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
    rememberTruthForDevice,
    persistLearnedLayout,
};
