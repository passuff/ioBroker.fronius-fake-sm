'use strict';

const MIN_E_KWH = 1;

function isAutoOffsetMode(adapter) {
    const mode = String(adapter.config.eOffsetMode || 'auto').toLowerCase();
    return mode !== 'manual';
}

/**
 * @param {object} device devices[] row
 * @param {number} eTotalKwh
 * @returns {boolean} true if baseline newly locked
 */
function tryLockDeviceBaseline(device, eTotalKwh) {
    if (!device || !device.enabled || !device.deviceSn) {
        return false;
    }
    if (device.eBaselineLocked && Number.isFinite(Number(device.eBaselineKwh))) {
        return false;
    }
    const e = Math.abs(Number(eTotalKwh) || 0);
    if (e < MIN_E_KWH) {
        return false;
    }
    device.eBaselineKwh = e;
    device.eBaselineLocked = true;
    return true;
}

/**
 * Relative energy for one device (0 if not locked / disabled).
 * @param {object} device
 * @param {number} eTotalKwh
 */
function deviceRelativeKwh(device, eTotalKwh) {
    if (!device || !device.enabled) {
        return 0;
    }
    const e = Math.abs(Number(eTotalKwh) || 0);
    if (!device.eBaselineLocked || !Number.isFinite(Number(device.eBaselineKwh))) {
        return 0;
    }
    return Math.max(e - Number(device.eBaselineKwh), 0);
}

/**
 * @param {Array<{device:object, e_total_kwh:number}>} rows
 */
function sumRelativeKwh(rows) {
    let sum = 0;
    for (const row of rows || []) {
        sum += deviceRelativeKwh(row.device, row.e_total_kwh);
    }
    return sum;
}

/**
 * If baselines missing but lastPublished exists, rebuild so relSum ≈ lastPublished.
 * @param {Array<{device:object, e_total_kwh:number}>} rows
 * @param {number} lastPublished
 */
function rebuildBaselinesToMatchPublished(rows, lastPublished) {
    const target = Math.max(0, Number(lastPublished) || 0);
    const active = (rows || []).filter(
        (r) => r && r.device && r.device.enabled && Math.abs(Number(r.e_total_kwh) || 0) >= MIN_E_KWH,
    );
    if (!active.length) {
        return false;
    }
    const eValues = active.map((r) => Math.abs(Number(r.e_total_kwh) || 0));
    const eSum = eValues.reduce((a, b) => a + b, 0);
    if (eSum <= 0) {
        return false;
    }
    if (active.length === 1) {
        active[0].device.eBaselineKwh = Math.max(eValues[0] - target, 0);
        active[0].device.eBaselineLocked = true;
        return true;
    }
    // Proportional: assign relative shares of target by current eTotal weight
    for (let i = 0; i < active.length; i++) {
        const share = (eValues[i] / eSum) * target;
        active[i].device.eBaselineKwh = Math.max(eValues[i] - share, 0);
        active[i].device.eBaselineLocked = true;
    }
    return true;
}

/**
 * Lock missing baselines to current eTotals (relSum → ~0). Soft restart after total config loss.
 * @param {Array<{device:object, e_total_kwh:number}>} rows
 */
function lockBaselinesAtCurrent(rows) {
    let any = false;
    for (const row of rows || []) {
        if (tryLockDeviceBaseline(row.device, row.e_total_kwh)) {
            any = true;
        }
    }
    return any;
}

/**
 * Clear all baselines (admin reset — may jump).
 * @param {object[]} devices
 */
function resetAllBaselines(devices) {
    let n = 0;
    for (const d of devices || []) {
        if (!d) {
            continue;
        }
        if (d.eBaselineLocked || d.eBaselineKwh != null) {
            n += 1;
        }
        d.eBaselineKwh = null;
        d.eBaselineLocked = false;
    }
    return n;
}

/**
 * Seed smoother from last published Fake-SM energy (continuity to Fronius).
 * @param {import('../lib/smoother').Smoother} smoother
 * @param {number} lastPublished
 */
function seedSmootherFromPublished(smoother, lastPublished) {
    if (!smoother) {
        return false;
    }
    const v = Number(lastPublished);
    if (!Number.isFinite(v) || v < 0) {
        return false;
    }
    smoother.state.eProducedKwh = v;
    smoother.state.seeded = true;
    return true;
}

/**
 * Resolve lastPublished from config or runtime cache.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function getLastPublished(adapter) {
    const fromMem = adapter._lastPublishedEProducedKwh;
    if (fromMem != null && fromMem !== '' && Number.isFinite(Number(fromMem)) && Number(fromMem) >= 0) {
        return Number(fromMem);
    }
    // Number(null) === 0 — treat null/undefined/'' as missing
    const raw = adapter.config.lastPublishedEProducedKwh;
    if (raw == null || raw === '') {
        return null;
    }
    const fromCfg = Number(raw);
    if (Number.isFinite(fromCfg) && fromCfg >= 0) {
        return fromCfg;
    }
    return null;
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} eProduced
 */
async function persistLastPublished(adapter, eProduced) {
    const v = Math.round(Number(eProduced) * 10000) / 10000;
    if (!Number.isFinite(v) || v < 0) {
        return;
    }
    const prev = getLastPublished(adapter);
    if (prev != null && Math.abs(prev - v) < 1e-4) {
        return;
    }
    adapter._lastPublishedEProducedKwh = v;
    adapter.config.lastPublishedEProducedKwh = v;
    await adapter.setStateChangedAsync('info.lastPublishedEProduced', { val: v, ack: true });

    if (adapter._persistPublishedTimer) {
        clearTimeout(adapter._persistPublishedTimer);
    }
    adapter._persistPublishedTimer = setTimeout(() => {
        void persistNativePatch(adapter, { lastPublishedEProducedKwh: v });
    }, 2000);
}

/**
 * Persist device baselines + optional extra native keys (debounced).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [extra]
 */
async function persistNativePatch(adapter, extra) {
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (!obj || !obj.native) {
            return;
        }
        if (Array.isArray(adapter.config.devices)) {
            obj.native.devices = adapter.config.devices;
        }
        if (extra) {
            Object.assign(obj.native, extra);
            Object.assign(adapter.config, extra);
        }
        if (adapter.config.eOffsetMode) {
            obj.native.eOffsetMode = adapter.config.eOffsetMode;
        }
        if (adapter.config.lastPublishedEProducedKwh != null) {
            obj.native.lastPublishedEProducedKwh = adapter.config.lastPublishedEProducedKwh;
        }
        if (adapter.config.localEBaselineKwh != null) {
            obj.native.localEBaselineKwh = adapter.config.localEBaselineKwh;
        }
        if (adapter.config.localEBaselineLocked != null) {
            obj.native.localEBaselineLocked = adapter.config.localEBaselineLocked;
        }
        await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
    } catch (err) {
        adapter.log.warn(`persist energy baselines: ${err.message}`);
    }
}

/**
 * After poll/local samples: lock baselines, maybe rebuild, return pipeline eTotal.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {Array<{device:object, e_total_kwh:number}>} rows
 * @returns {{ relSum:number, rawSum:number, lockedNew:boolean, rebuilt:boolean }}
 */
function applyEnergySamples(adapter, rows) {
    const rawSum = (rows || []).reduce((s, r) => s + Math.abs(Number(r.e_total_kwh) || 0), 0);
    let lockedNew = false;
    let rebuilt = false;

    if (isAutoOffsetMode(adapter)) {
        const lastPub = getLastPublished(adapter);
        const anyLocked = (rows || []).some(
            (r) => r.device && r.device.enabled && r.device.eBaselineLocked && Number.isFinite(Number(r.device.eBaselineKwh)),
        );
        if (!anyLocked && lastPub != null && lastPub > 0) {
            // Prefer continuity: rebuild so relSum ≈ lastPublished (do not soft-lock first)
            rebuilt = rebuildBaselinesToMatchPublished(rows, lastPub);
            if (rebuilt) {
                lockedNew = true;
                adapter.log.warn(
                    `Energy baselines missing — rebuilt to match lastPublished=${lastPub} kWh (Fronius continuity)`,
                );
            }
        } else if (!anyLocked) {
            // Migrate legacy global offset → baselines (keeps Fake-SM / Fronius continuity)
            const legacyOffset = Number(adapter.config.eTotalOffsetKwh);
            if (Number.isFinite(legacyOffset) && legacyOffset > 0 && rawSum > legacyOffset) {
                const target = Math.round((rawSum - legacyOffset) * 1000) / 1000;
                rebuilt = rebuildBaselinesToMatchPublished(rows, target);
                if (rebuilt) {
                    lockedNew = true;
                    adapter._lastPublishedEProducedKwh = target;
                    adapter.config.lastPublishedEProducedKwh = target;
                    adapter.log.warn(
                        `Energy baselines: migrated legacy eTotalOffset=${legacyOffset} → rel≈${target} kWh`,
                    );
                    void adapter.setStateChangedAsync('info.lastPublishedEProduced', { val: target, ack: true });
                }
            }
            if (!rebuilt) {
                rebuilt = lockBaselinesAtCurrent(rows);
                if (rebuilt) {
                    lockedNew = true;
                    adapter.log.warn(
                        'Energy baselines + lastPublished missing — locked at current eTotals (soft zero start)',
                    );
                }
            }
        } else {
            // Already have baselines: lock newly enabled devices at current e (relative starts at 0)
            for (const row of rows || []) {
                if (tryLockDeviceBaseline(row.device, row.e_total_kwh)) {
                    lockedNew = true;
                }
            }
            // Fail-safe: baselines present but lastPublished missing → adopt relSum once
            if (lastPub == null) {
                const provisional = sumRelativeKwh(rows);
                if (provisional > 0) {
                    const v = Math.round(provisional * 10000) / 10000;
                    adapter._lastPublishedEProducedKwh = v;
                    adapter.config.lastPublishedEProducedKwh = v;
                    if (adapter.smoother && seedSmootherFromPublished(adapter.smoother, v)) {
                        adapter.log.warn(
                            `Energy continuity: lastPublished missing — seeded ${v} kWh from relSum (baselines present)`,
                        );
                    }
                    void adapter.setStateChangedAsync('info.lastPublishedEProduced', { val: v, ack: true });
                    if (adapter._persistPublishedTimer) {
                        clearTimeout(adapter._persistPublishedTimer);
                    }
                    adapter._persistPublishedTimer = setTimeout(() => {
                        void persistNativePatch(adapter, { lastPublishedEProducedKwh: v });
                    }, 1500);
                }
            }
        }
    }

    const relSum = isAutoOffsetMode(adapter) ? sumRelativeKwh(rows) : rawSum;
    if (lockedNew) {
        if (adapter._persistBaselineTimer) {
            clearTimeout(adapter._persistBaselineTimer);
        }
        adapter._persistBaselineTimer = setTimeout(() => {
            void persistNativePatch(adapter, {});
        }, 1500);
        const baselineSum = (adapter.config.devices || [])
            .filter((d) => d && d.enabled && d.eBaselineLocked)
            .reduce((s, d) => s + Number(d.eBaselineKwh || 0), 0);
        const localBase =
            adapter.config.localEBaselineLocked && Number.isFinite(Number(adapter.config.localEBaselineKwh))
                ? Number(adapter.config.localEBaselineKwh)
                : 0;
        void adapter.setStateChangedAsync('info.eBaselineSum', {
            val: Math.round((baselineSum + localBase) * 1000) / 1000,
            ack: true,
        });
    }

    return { relSum, rawSum, lockedNew, rebuilt };
}

/**
 * Pipeline eTotal for smoother (auto = relative sum, manual = raw).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} rawSum
 * @param {number} relSum
 */
function pipelineETotal(adapter, rawSum, relSum) {
    return isAutoOffsetMode(adapter) ? relSum : rawSum;
}

module.exports = {
    MIN_E_KWH,
    isAutoOffsetMode,
    tryLockDeviceBaseline,
    deviceRelativeKwh,
    sumRelativeKwh,
    rebuildBaselinesToMatchPublished,
    lockBaselinesAtCurrent,
    resetAllBaselines,
    seedSmootherFromPublished,
    getLastPublished,
    persistLastPublished,
    persistNativePatch,
    applyEnergySamples,
    pipelineETotal,
};
