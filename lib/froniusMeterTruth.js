'use strict';

const { httpGetJson } = require('./froniusDiscover');

/**
 * Pick Gen24 secondary / Fake-SM meter row from GetMeterRealtimeData Scope=System.
 * Prefer Meter_Location_Current === targetLocation (default 3 = external generator).
 * @param {object} data Body.Data map
 * @param {number} [targetLocation]
 * @returns {{ deviceId: string, row: object }|null}
 */
function pickSecondaryMeter(data, targetLocation = 3) {
    const locWant = Number(targetLocation);
    const entries = Object.entries(data || {}).filter(([, row]) => row && typeof row === 'object');
    if (!entries.length) {
        return null;
    }
    if (Number.isFinite(locWant)) {
        const byLoc = entries.find(([, row]) => Number(row.Meter_Location_Current ?? row.Meter_Location) === locWant);
        if (byLoc) {
            return { deviceId: String(byLoc[0]), row: byLoc[1] };
        }
        const byId = entries.find(([id]) => Number(id) === locWant);
        if (byId) {
            return { deviceId: String(byId[0]), row: byId[1] };
        }
    }
    // Fallback: first non-grid (location !== 0)
    const nonGrid = entries.find(([, row]) => {
        const loc = Number(row.Meter_Location_Current ?? row.Meter_Location);
        return Number.isFinite(loc) && loc !== 0;
    });
    if (nonGrid) {
        return { deviceId: String(nonGrid[0]), row: nonGrid[1] };
    }
    return null;
}

/**
 * Extract produced energy in kWh from a meter realtime row (API values are Wh).
 * @param {object} row
 * @returns {number|null}
 */
function producedKwhFromMeterRow(row) {
    if (!row || typeof row !== 'object') {
        return null;
    }
    const wh = Number(row.EnergyReal_WAC_Sum_Produced);
    if (!Number.isFinite(wh) || wh < 0) {
        return null;
    }
    return Math.round((wh / 1000) * 10000) / 10000;
}

/**
 * Read Fake-SM energy as seen by Gen24 (Solar API truth).
 * @param {string} froniusIp
 * @param {object} [opts]
 * @param {number} [opts.location] Meter_Location_Current (default 3)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ kwh: number, deviceId: string, location: number, wh: number, model: string, serial: string }>}
 */
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} data
 */
function summarizeMeterLocations(data) {
    return Object.entries(data || {})
        .filter(([, row]) => row && typeof row === 'object')
        .map(([id, row]) => {
            const loc = row.Meter_Location_Current ?? row.Meter_Location;
            return `${id}:loc=${loc}`;
        })
        .join(',') || 'none';
}

async function fetchGen24FakeSmEnergyKwh(froniusIp, opts = {}) {
    const ip = String(froniusIp || '').trim();
    if (!ip) {
        throw new Error('froniusIp missing');
    }
    const location = Number(opts.location ?? 3);
    const timeoutMs = Number(opts.timeoutMs ?? 5000);
    const attempts = Math.max(1, Number(opts.attempts ?? 1));
    const retryDelayMs = Math.max(200, Number(opts.retryDelayMs ?? 2000));
    const url = `http://${ip}/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`;

    const minKwh = opts.minKwh != null ? Number(opts.minKwh) : null;
    const requireStable = opts.requireStable === true;
    let lastErr = 'unknown';
    /** @type {number|null} */
    let prevKwh = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const { body } = await httpGetJson(url, timeoutMs);
            const data = (body && body.Body && body.Body.Data) || {};
            const picked = pickSecondaryMeter(data, location);
            if (!picked) {
                lastErr = `no secondary meter at location ${location} (seen ${summarizeMeterLocations(data)})`;
                prevKwh = null;
            } else if (Number(picked.row.Visible) === 0) {
                lastErr = `meter ${picked.deviceId}: Visible=0`;
                prevKwh = null;
            } else {
                const kwh = producedKwhFromMeterRow(picked.row);
                if (kwh == null) {
                    lastErr = `meter ${picked.deviceId}: EnergyReal_WAC_Sum_Produced missing`;
                    prevKwh = null;
                } else if (minKwh != null && Number.isFinite(minKwh) && kwh + 1e-9 < minKwh) {
                    lastErr = `meter ${picked.deviceId}: ${kwh} kWh below min ${minKwh}`;
                    prevKwh = null;
                } else if (requireStable && (prevKwh == null || Math.abs(prevKwh - kwh) > 0.05)) {
                    lastErr = `meter ${picked.deviceId}: waiting stable energy (got ${kwh} kWh)`;
                    prevKwh = kwh;
                } else {
                    const details = picked.row.Details || {};
                    return {
                        kwh,
                        wh: Number(picked.row.EnergyReal_WAC_Sum_Produced),
                        deviceId: picked.deviceId,
                        location: Number(picked.row.Meter_Location_Current ?? location),
                        model: String(details.Model || ''),
                        serial: String(details.Serial || ''),
                    };
                }
            }
        } catch (err) {
            lastErr = String(err && err.message ? err.message : err);
            prevKwh = null;
        }
        if (i + 1 < attempts) {
            await sleep(retryDelayMs);
        }
    }
    throw new Error(lastErr);
}

/**
 * Boot helper: pull Gen24 truth into adapter lastPublished + unlock baselines for rebuild.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<{ ok: boolean, kwh?: number, error?: string, source: string }>}
 */
/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [opts]
 * @param {number} [opts.attempts]
 * @param {number} [opts.retryDelayMs]
 */
async function seedFromGen24Truth(adapter, opts = {}) {
    const ip = String(adapter.config.froniusIp || '').trim();
    if (!ip) {
        return { ok: false, source: 'gen24', error: 'froniusIp not configured' };
    }
    const location = Number(adapter.config.fakeUniqueId ?? 3);
    try {
        const fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : fetchGen24FakeSmEnergyKwh;
        // Retries: Gen24 may briefly drop Loc3 while Fake-SM Modbus restarts
        const truth = await fetchFn(ip, {
            location,
            timeoutMs: 6000,
            attempts: Number(opts.attempts ?? 5),
            retryDelayMs: Number(opts.retryDelayMs ?? 2500),
            minKwh: opts.minKwh,
            requireStable: opts.requireStable !== false,
        });
        const { getLastPublished, resetAllBaselines, persistNativePatch, seedSmootherFromPublished } = require('./energyBaselines');

        // Guard: Loc3 often reports 0 Wh right after Modbus reconnect (or after our own zero push).
        // Never adopt 0 as truth unless this is a true fresh start (no prior counter).
        const prev = getLastPublished(adapter);
        let priorMeter = null;
        try {
            const st = await adapter.getStateAsync('meter.eProduced');
            if (st && Number.isFinite(Number(st.val))) {
                priorMeter = Number(st.val);
            }
        } catch {
            // ignore
        }
        const hadPrior = (prev != null && prev > 0.001) || (priorMeter != null && priorMeter > 0.001);
        if (truth.kwh <= 0 && hadPrior) {
            adapter.log.warn(
                `Energy continuity: Gen24 returned ${truth.kwh} kWh but prior Fake-SM was ` +
                    `${prev != null ? prev : priorMeter} kWh — ignoring transient zero`,
            );
            return {
                ok: false,
                source: 'gen24',
                error: `transient zero (keep prior ${prev != null ? prev : priorMeter})`,
            };
        }
        if (truth.kwh <= 0 && !hadPrior) {
            adapter.log.info('Energy continuity: Gen24 truth is 0 kWh (fresh start)');
        }

        const devices = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
        const anyLocked = devices.some(
            (d) => d && d.enabled && d.eBaselineLocked && Number.isFinite(Number(d.eBaselineKwh)),
        );
        const localLocked =
            !!adapter.config.localEBaselineLocked && Number.isFinite(Number(adapter.config.localEBaselineKwh));
        const hasBaselines = anyLocked || localLocked;
        // Keep locked baselines unless lastPublished clearly diverges from Gen24 (±50 Wh).
        let unlocked = false;
        if (hasBaselines && prev != null && Math.abs(prev - truth.kwh) >= 0.05) {
            resetAllBaselines(devices);
            adapter.config.localEBaselineKwh = null;
            adapter.config.localEBaselineLocked = false;
            unlocked = true;
            await adapter.setStateAsync('info.eBaselineSum', { val: 0, ack: true });
        }

        const prevNative = prev;
        adapter._lastPublishedEProducedKwh = truth.kwh;
        adapter.config.lastPublishedEProducedKwh = truth.kwh;
        if (adapter.smoother) {
            seedSmootherFromPublished(adapter.smoother, truth.kwh);
        }
        await adapter.setStateAsync('info.lastPublishedEProduced', { val: truth.kwh, ack: true });
        // setForeignObject(system.adapter.*) restarts the instance — only persist native
        // on unlock / first seed / coarse energy steps. Fine-grained truth stays in states.
        const NATIVE_KWH_STEP = 0.5;
        const needPersist =
            unlocked ||
            prevNative == null ||
            Math.abs(Number(prevNative) - truth.kwh) >= NATIVE_KWH_STEP;
        if (needPersist) {
            const patch = { lastPublishedEProducedKwh: truth.kwh };
            if (unlocked) {
                patch.localEBaselineKwh = null;
                patch.localEBaselineLocked = false;
            }
            await persistNativePatch(adapter, patch);
        }

        adapter.log.info(
            `Energy continuity: Gen24 truth eProduced=${truth.kwh} kWh ` +
                `(Loc ${truth.location} id=${truth.deviceId}` +
                (truth.serial ? ` SN=${truth.serial}` : '') +
                (unlocked
                    ? ') — baselines unlocked for rebuild'
                    : hasBaselines
                      ? ') — baselines kept'
                      : ') — baselines empty, next poll will lock/rebuild') +
                (needPersist ? '' : ' (native unchanged)'),
        );
        return { ok: true, kwh: truth.kwh, source: 'gen24', baselinesUnlocked: unlocked };
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        adapter.log.warn(`Energy continuity: Gen24 truth unavailable (${msg}) — fallback to local lastPublished`);
        return { ok: false, source: 'gen24', error: msg };
    }
}

module.exports = {
    pickSecondaryMeter,
    producedKwhFromMeterRow,
    fetchGen24FakeSmEnergyKwh,
    seedFromGen24Truth,
};
