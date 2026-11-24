'use strict';

const { isGrowattRateLimitError } = require('./growattOpenApi');
const { isShineCloudAuth } = require('./growattShinePoll');
const {
    isAutoOffsetMode,
    applyEnergySamples,
    pipelineETotal,
    persistLastPublished,
    getLastPublished,
} = require('./energyBaselines');
const { refreshFroniusDaylight, isFroniusCacheFresh } = require('./froniusDaylight');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const OPENAPI_POLL_FLOOR_DEFAULT_S = 120;
const OPENAPI_POLL_FLOOR_CAP_S = 300;
const SHINE_POLL_FLOOR_DEFAULT_S = 60;
const SHINE_POLL_MIN_S = 30;

/**
 * Effective cloud poll interval (config vs learned rate-limit floor).
 * OpenAPI queryLastData ~120s; Shine login path tested at 60s (min 30s).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {number}
 */
function effectivePollIntervalS(adapter) {
    if (isShineCloudAuth(adapter)) {
        const cfg = Math.max(SHINE_POLL_MIN_S, Number(adapter.config.pollIntervalS ?? SHINE_POLL_FLOOR_DEFAULT_S));
        const floor = Math.max(
            SHINE_POLL_MIN_S,
            Number(adapter._pollFloorS || SHINE_POLL_FLOOR_DEFAULT_S),
        );
        return Math.max(cfg, floor);
    }
    const cfg = Math.max(90, Number(adapter.config.pollIntervalS ?? OPENAPI_POLL_FLOOR_DEFAULT_S));
    const floor = Math.max(
        OPENAPI_POLL_FLOOR_DEFAULT_S,
        Number(adapter._pollFloorS || OPENAPI_POLL_FLOOR_DEFAULT_S),
    );
    return Math.max(cfg, floor);
}

/**
 * Freshness window — tied to effective OpenAPI poll (local stick frames are slower).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function staleAfterS(adapter) {
    const poll = effectivePollIntervalS(adapter);
    const cloudStale = Math.max(Math.round(poll * 1.5), poll + 30);
    const localMode = String(adapter.config.growattFeedMode || 'cloud') === 'local';
    if (localMode || adapter.config.localEnabled || adapter._lastLocalOkAt) {
        return Math.max(cloudStale, 300);
    }
    return cloudStale;
}

function hardStaleAfterS(adapter) {
    return staleAfterS(adapter) * 2;
}

function isRateLimitCooldown(adapter) {
    return !!(adapter._rateLimitUntil && adapter._rateLimitUntil > Date.now());
}

function pollIntervalMs(adapter) {
    const now = Date.now();
    if (adapter._rateLimitUntil > now) {
        return Math.max(5000, adapter._rateLimitUntil - now);
    }
    const day = effectivePollIntervalS(adapter) * 1000;
    const nightMin = isShineCloudAuth(adapter) ? SHINE_POLL_MIN_S : 120;
    const nightCfg = Math.max(nightMin, Number(adapter.config.nightPollIntervalS ?? 300));
    const night = Math.max(day, nightCfg * 1000);
    const eps = Math.max(15, Number(adapter.config.powerEpsilonW ?? 5));
    const sample = adapter._lastSample;
    const lastP = sample ? Math.abs(Number(sample.power_w) || 0) : 0;
    const fresh = hasFreshSample(adapter);

    // Soft-stale after errors: keep near day cadence if last good power was active
    if (!fresh) {
        if (lastP >= eps && adapter._lastPollOkAt) {
            const softBackoff = Math.min(day * 2, Math.max(day, 180000));
            return softBackoff;
        }
        return night;
    }
    if (!sample) {
        return night;
    }
    return lastP < eps ? night : day;
}

/**
 * Commit a successful (partial) poll sample into adapter state.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {{ powerSum:number, eSum:number, u1:number, f:number, ok:number, errors:string[] }} parts
 * @param {{ keepRateLimit?: boolean }} [opts] keepRateLimit: do not clear cooldown (partial+429 path)
 */
async function commitPollSample(adapter, parts, opts) {
    if (!(opts && opts.keepRateLimit)) {
        clearRateLimit(adapter);
        adapter._lastFailWasRateLimit = false;
    }
    adapter._lastPollOkAt = Date.now();
    adapter._staleWarned = false;
    adapter._hardStaleCleared = false;
    const rawSum = Number(parts.eSumRaw != null ? parts.eSumRaw : parts.eSum) || 0;
    const pipeE = Number(parts.eSum) || 0;
    adapter._lastSample = {
        power_w: parts.powerSum,
        e_total_kwh: pipeE,
        e_total_raw_kwh: rawSum,
        u1: parts.u1,
        f: parts.f,
    };
    await noteNonZeroPower(adapter, parts.powerSum);
    await adapter.setStateAsync('info.connection', { val: true, ack: true });
    await adapter.setStateAsync('info.lastPoll', { val: adapter._lastPollOkAt, ack: true });
    await adapter.setStateAsync('info.lastError', {
        val: parts.errors.length ? parts.errors.join('; ') : '',
        ack: true,
    });
    await adapter.setStateAsync('info.enabledDeviceCount', { val: adapter._enabledDevices.length, ack: true });
    await adapter.setStateChangedAsync('meter.power', {
        val: Math.round(parts.powerSum * 10) / 10,
        ack: true,
    });
    // Raw Growatt lifetime sum (before baselines)
    await adapter.setStateChangedAsync('meter.eTotalCloud', {
        val: Math.round(rawSum * 1000) / 1000,
        ack: true,
    });
}

/**
 * Apply a local stick sample into the same _lastSample path as pollOnce.
 * Only call after auto-calibration succeeded.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {{ pac_w:number, e_total_kwh:number, u1?:number, f?:number, sn?:string, stickCount?:number }} sample
 */
/**
 * Local stick baseline lives on matching devices[] row or dedicated local* native keys.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} sn
 */
function localBaselineDevice(adapter, sn) {
    const devices = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
    // Prefer stickSn match (local sample carries datalogger SN), else deviceSn.
    const hit =
        devices.find((d) => d && d.stickSn && sn && d.stickSn === sn) ||
        devices.find((d) => d && d.deviceSn && sn && d.deviceSn === sn);
    if (hit) {
        // Do NOT mutate hit.enabled — that churns native.devices and restarts the instance.
        return hit;
    }
    return {
        deviceSn: sn || 'local',
        enabled: true,
        get eBaselineLocked() {
            return !!adapter.config.localEBaselineLocked;
        },
        set eBaselineLocked(v) {
            adapter.config.localEBaselineLocked = !!v;
        },
        get eBaselineKwh() {
            return adapter.config.localEBaselineKwh;
        },
        set eBaselineKwh(v) {
            adapter.config.localEBaselineKwh = v;
        },
    };
}

async function applyLocalSample(adapter, sample) {
    if (!sample) {
        return;
    }
    const powerSign = Number(adapter.config.powerSign ?? -1);
    const power_w = Number(sample.pac_w || 0) * powerSign;
    const eRaw = Number(sample.e_total_kwh || 0);
    const device = localBaselineDevice(adapter, String(sample.sn || adapter.config.localStickSn || ''));
    const { relSum, rawSum } = applyEnergySamples(adapter, [{ device, e_total_kwh: eRaw }]);
    const pipeE = pipelineETotal(adapter, rawSum, relSum);
    adapter._lastSample = {
        power_w,
        e_total_kwh: pipeE,
        e_total_raw_kwh: rawSum,
        u1: Number(sample.u1) || 0,
        f: Number(sample.f) || 0,
    };
    adapter._lastPollOkAt = Date.now();
    adapter._lastLocalOkAt = adapter._lastPollOkAt;
    adapter._staleWarned = false;
    adapter._hardStaleCleared = false;
    await noteNonZeroPower(adapter, power_w);

    await adapter.setStateAsync('info.connection', { val: true, ack: true });
    await adapter.setStateAsync('info.localConnection', { val: true, ack: true });
    await adapter.setStateAsync('info.lastPoll', { val: adapter._lastPollOkAt, ack: true });
    await adapter.setStateAsync('info.lastLocalFrame', { val: adapter._lastLocalOkAt, ack: true });
    if (sample.sn) {
        await adapter.setStateChangedAsync('info.stickSn', { val: String(sample.sn), ack: true });
    }
    await adapter.setStateChangedAsync('meter.power', { val: Math.round(power_w * 10) / 10, ack: true });
    await adapter.setStateChangedAsync('meter.eTotalCloud', { val: Math.round(rawSum * 1000) / 1000, ack: true });
    try {
        const { syncInverterVarsFromSample } = require('./inverterVarsStates');
        const stickSn = String(sample.sn || adapter.config.localStickSn || '');
        const devices = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
        const matched =
            devices.find((d) => d && d.enabled && d.stickSn && stickSn && d.stickSn === stickSn) ||
            devices.find((d) => d && d.enabled && d.deviceSn) ||
            null;
        const invSn = matched ? String(matched.deviceSn) : stickSn;
        const raw = Object.assign({}, sample.fields || {}, {
            pac_w: sample.pac_w,
            e_total_kwh: sample.e_total_kwh,
            e_today_kwh: sample.e_today_kwh,
            ppv_w: sample.ppv_w,
            status: sample.status,
            temp: sample.temp,
            u1: sample.u1,
            f: sample.f,
        });
        await syncInverterVarsFromSample(adapter, {
            deviceSn: invSn,
            deviceType: (matched && matched.deviceType) || 'min',
            raw,
            transport: 'local',
        });
    } catch (syncErr) {
        adapter.log.debug(`local inverter vars sync: ${syncErr.message}`);
    }
    await adapter.setStateChangedAsync('local.pacW', { val: Math.round(Number(sample.pac_w) * 10) / 10, ack: true });
    await adapter.setStateChangedAsync('local.eTotalKwh', {
        val: Math.round(eRaw * 1000) / 1000,
        ack: true,
    });
    if (sample.u1) {
        await adapter.setStateChangedAsync('local.vac1', { val: Math.round(sample.u1 * 10) / 10, ack: true });
    }
    if (sample.f) {
        await adapter.setStateChangedAsync('local.fac', { val: Math.round(sample.f * 100) / 100, ack: true });
    }
}

/**
 * Raise poll floor and schedule cooldown after FREQUENTLY_ACCESS.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {number} cooldown seconds
 */
function noteRateLimit(adapter) {
    const shine = isShineCloudAuth(adapter);
    const baseFloor = shine ? SHINE_POLL_FLOOR_DEFAULT_S : OPENAPI_POLL_FLOOR_DEFAULT_S;
    const minFloor = shine ? SHINE_POLL_MIN_S : OPENAPI_POLL_FLOOR_DEFAULT_S;
    const prevFloor = Math.max(minFloor, Number(adapter._pollFloorS || baseFloor));
    const floor = Math.min(OPENAPI_POLL_FLOOR_CAP_S, prevFloor + 30);
    adapter._pollFloorS = floor;
    const cooldown = Math.max(shine ? 90 : 180, floor);
    adapter._rateLimitBackoffS = cooldown;
    adapter._rateLimitUntil = Date.now() + cooldown * 1000;
    // Survives clearRateLimit so hard-stale after cooldown still stays green.
    adapter._lastFailWasRateLimit = true;
    return cooldown;
}

function clearRateLimit(adapter) {
    // Keep learned _pollFloorS — only clear temporary cooldown.
    adapter._rateLimitBackoffS = 0;
    adapter._rateLimitUntil = 0;
}

/**
 * True when orange amp must not fire solely because of OpenAPI throttle.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function isThrottleAmpSuppress(adapter) {
    if (isRateLimitCooldown(adapter)) {
        return true;
    }
    return !!adapter._lastFailWasRateLimit;
}

function hasFreshSample(adapter) {
    if (!adapter._lastPollOkAt) {
        return false;
    }
    return Date.now() - adapter._lastPollOkAt <= staleAfterS(adapter) * 1000;
}

/**
 * Sum configured Growatt nameplate (pmax) for enabled devices.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {number}
 */
function growattRatedW(adapter) {
    const list =
        (Array.isArray(adapter._enabledDevices) && adapter._enabledDevices.length
            ? adapter._enabledDevices
            : Array.isArray(adapter.config.devices)
              ? adapter.config.devices.filter((d) => d && d.enabled)
              : []) || [];
    let sum = 0;
    for (const d of list) {
        const p = Number(d && d.pmaxW);
        if (Number.isFinite(p) && p > 0) {
            sum += p;
        }
    }
    if (sum > 0) {
        return sum;
    }
    const cfg = Number(adapter.config.growattRatedW);
    return Number.isFinite(cfg) && cfg > 0 ? cfg : 0;
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {Date} [now]
 * @returns {boolean}
 */
function isInDayWindow(adapter, now = new Date()) {
    const start = Number(adapter.config.dayWindowStartHour ?? 6);
    const end = Number(adapter.config.dayWindowEndHour ?? 22);
    const h = now.getHours() + now.getMinutes() / 60;
    if (start === end) {
        return true;
    }
    if (start < end) {
        return h >= start && h < end;
    }
    return h >= start || h < end;
}

/**
 * Track last time Growatt delivered meaningful power (survives via state).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} powerW
 */
async function noteNonZeroPower(adapter, powerW) {
    const eps = Math.max(15, Number(adapter.config.powerEpsilonW ?? 5));
    if (!(Math.abs(Number(powerW) || 0) >= eps)) {
        return;
    }
    adapter._lastNonZeroAt = Date.now();
    if (typeof adapter.setStateChangedAsync === 'function') {
        await adapter.setStateChangedAsync('info.lastNonZeroPower', {
            val: adapter._lastNonZeroAt,
            ack: true,
        });
    }
}

/**
 * Load lastNonZero timestamp from state after restart.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function loadLastNonZeroPower(adapter) {
    if (adapter._lastNonZeroAt) {
        return;
    }
    try {
        const st = await adapter.getStateAsync('info.lastNonZeroPower');
        const v = st && Number(st.val);
        if (Number.isFinite(v) && v > 0) {
            adapter._lastNonZeroAt = v;
        }
    } catch {
        // optional state
    }
}

/**
 * Growatt near-zero / offline is expected when site irradiance (via Fronius util) is low,
 * or (fallback) outside day window / recently idle. Otherwise treat as defect → not idle.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function isExpectedSourceIdle(adapter) {
    if (!adapter._lastPollOkAt) {
        return false;
    }
    const eps = Math.max(15, Number(adapter.config.powerEpsilonW ?? 5));
    const sample = adapter._lastSample;
    const lastP = sample ? Math.abs(Number(sample.power_w) || 0) : 0;
    if (lastP >= eps) {
        return false;
    }

    const gRated = growattRatedW(adapter);
    const fr = adapter._froniusDaylight;
    if (isFroniusCacheFresh(fr) && gRated > 0) {
        const util = Math.min(1, Math.max(0, Number(fr.pvW) / Number(fr.ratedW)));
        const expectedG = util * gRated;
        const thrRatio = Number(adapter.config.daylightUtilThreshold ?? 0.05);
        const thr = Math.max(eps, gRated * (Number.isFinite(thrRatio) ? thrRatio : 0.05));
        fr.util = util;
        fr.expectedGrowattW = expectedG;
        if (typeof adapter.setStateChangedAsync === 'function') {
            void adapter.setStateChangedAsync('info.expectedGrowattW', {
                val: Math.round(expectedG * 10) / 10,
                ack: true,
            });
            void adapter.setStateChangedAsync('info.froniusUtil', {
                val: Math.round(util * 1000) / 1000,
                ack: true,
            });
        }
        // High relative irradiance → Growatt should produce → not expected idle.
        return expectedG < thr;
    }

    // Fallback without Fronius: day window + age since last non-zero.
    if (!isInDayWindow(adapter)) {
        return true;
    }
    const maxH = Number(adapter.config.expectedIdleMaxHours ?? 14);
    const ref = adapter._lastNonZeroAt || adapter._lastPollOkAt;
    const hours = (Date.now() - ref) / 3_600_000;
    return hours < (Number.isFinite(maxH) ? maxH : 14);
}

/**
 * Human hint when Fronius proves unexpected Growatt silence.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {string}
 */
function unexpectedSourceHint(adapter) {
    const fr = adapter._froniusDaylight;
    if (isFroniusCacheFresh(fr) && fr.ratedW > 0) {
        const pct = Math.round((Number(fr.util) || 0) * 100);
        return `Fronius liefert (~${pct} % Nenn), Growatt offline — Stick/WR prüfen`;
    }
    return 'Quelle länger offline bei Tag — Stick/WR prüfen';
}

/**
 * Clear info.connection only for unexpected (daytime) source loss.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} [idleHint]
 */
async function clearConnectionUnlessIdle(adapter, idleHint) {
    await refreshFroniusDaylight(adapter);
    if (isExpectedSourceIdle(adapter)) {
        await adapter.setStateAsync('info.lastError', {
            val: idleHint || 'Quelle offline (erwartet nachts/Idle) — Fake-SM bereit',
            ack: true,
        });
        return;
    }
    await adapter.setStateAsync('info.connection', { val: false, ack: true });
    await adapter.setStateAsync('info.lastError', {
        val: unexpectedSourceHint(adapter),
        ack: true,
    });
}

/**
 * True when local stick samples are fresh enough to feed Modbus — OpenAPI poll must skip.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function isLocalFeedActive(adapter) {
    if (String(adapter.config.growattFeedMode || 'cloud') !== 'local') {
        return false;
    }
    if (!adapter.config.localSetupVerified) {
        return false;
    }
    if (!adapter._lastLocalOkAt) {
        return false;
    }
    return Date.now() - adapter._lastLocalOkAt <= staleAfterS(adapter) * 1000;
}

function scheduleNextPoll(adapter) {
    if (adapter._stopping) {
        return;
    }
    if (adapter._pollTimer) {
        clearTimeout(adapter._pollTimer);
    }
    adapter._pollTimer = setTimeout(() => {
        pollOnce(adapter)
            .catch((err) => adapter.log.error(`Poll error: ${err.message}`))
            .finally(() => scheduleNextPoll(adapter));
    }, pollIntervalMs(adapter));
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function pollOnce(adapter) {
    adapter._enabledDevices = adapter._getEnabledDevices();
    if (!adapter._enabledDevices.length) {
        return;
    }
    if (isShineCloudAuth(adapter)) {
        if (!adapter.config.growattUser || !adapter.config.growattPassword) {
            return;
        }
    } else if (!adapter.config.growattToken) {
        return;
    }
    if (isLocalFeedActive(adapter)) {
        adapter.log.debug('Skipping Growatt poll — local stick feed active');
        return;
    }
    // Keep Gen24 PV cache warm for idle vs defect decisions.
    void refreshFroniusDaylight(adapter);

    let powerSum = 0;
    let u1 = 0;
    let f = 0;
    let ok = 0;
    const errors = [];
    /** @type {Array<{device:object, e_total_kwh:number}>} */
    const energyRows = [];

    if (adapter._rateLimitUntil > Date.now()) {
        const waitS = Math.ceil((adapter._rateLimitUntil - Date.now()) / 1000);
        adapter.log.debug(`Skipping Growatt poll — rate-limit cooldown ${waitS}s left`);
        return;
    }

    let hitRateLimit = false;
    for (const device of adapter._enabledDevices) {
        try {
            const sample = await adapter._clientFor(device).fetch();
            powerSum += sample.power_w;
            energyRows.push({ device, e_total_kwh: sample.e_total_kwh });
            if (!u1 && sample.u1) {
                u1 = sample.u1;
            }
            if (!f && sample.f) {
                f = sample.f;
            }
            ok += 1;
            adapter.log.debug(
                `device ${device.deviceSn} P=${sample.power_w.toFixed(1)} W E=${sample.e_total_kwh.toFixed(2)}`,
            );
            try {
                const { syncInverterVarsFromSample } = require('./inverterVarsStates');
                const { isShineCloudAuth } = require('./growattShinePoll');
                const raw = Object.assign({}, sample.raw || {}, {
                    pac: Math.abs(sample.power_w),
                    eTotal: sample.e_total_kwh,
                    vAc1: sample.u1,
                    fAc: sample.f,
                });
                await syncInverterVarsFromSample(adapter, {
                    deviceSn: device.deviceSn,
                    deviceType: device.deviceType || sample.deviceType || 'min',
                    raw,
                    transport: isShineCloudAuth(adapter) ? 'shine' : 'openapi',
                });
            } catch (syncErr) {
                adapter.log.debug(`inverter vars sync: ${syncErr.message}`);
            }
        } catch (err) {
            errors.push(`${device.deviceSn}: ${err.message}`);
            if (isGrowattRateLimitError(err)) {
                hitRateLimit = true;
                break;
            }
            adapter.log.warn(`Poll ${device.deviceSn} failed: ${err.message}`);
        }
        await sleep(500);
    }

    const { relSum, rawSum } = applyEnergySamples(adapter, energyRows);
    const ePipe = pipelineETotal(adapter, rawSum, relSum);

    if (hitRateLimit) {
        const cooldownS = noteRateLimit(adapter);
        const floor = Number(adapter._pollFloorS || OPENAPI_POLL_FLOOR_DEFAULT_S);
        adapter.log.info(
            `Growatt rate-limited — cooldown ${cooldownS}s floor=${floor}s (Modbus keeps last sample, amp stays green)`,
        );
        // Throttle is not a defect — keep connection green.
        if (typeof adapter.setStateAsync === 'function') {
            await adapter.setStateAsync('info.connection', { val: true, ack: true });
            await adapter.setStateAsync('info.lastError', {
                val: `OpenAPI-Cooldown ${cooldownS}s (Floor ${floor}s)`,
                ack: true,
            });
        }
        if (ok > 0) {
            await commitPollSample(
                adapter,
                { powerSum, eSum: ePipe, eSumRaw: rawSum, u1, f, ok, errors },
                { keepRateLimit: true },
            );
            adapter.log.info(
                `Growatt partial sum power=${powerSum.toFixed(1)} W eRaw=${rawSum.toFixed(2)} ePipe=${ePipe.toFixed(2)} kWh devices=${ok} (then rate-limit)`,
            );
        }
        return;
    }

    if (!ok) {
        await clearConnectionUnlessIdle(
            adapter,
            errors.join('; ') || 'Quelle offline (erwartet nachts/Idle)',
        );
        return;
    }

    await commitPollSample(adapter, { powerSum, eSum: ePipe, eSumRaw: rawSum, u1, f, ok, errors });
    adapter.log.info(
        `Growatt sum power=${powerSum.toFixed(1)} W eRaw=${rawSum.toFixed(2)} ePipe=${ePipe.toFixed(2)} kWh ` +
            `mode=${isAutoOffsetMode(adapter) ? 'auto' : 'manual'} devices=${ok}/${adapter._enabledDevices.length}`,
    );
}

function startSmoothLoop(adapter) {
    const tickS = Math.max(1, Number(adapter.config.smoothIntervalS ?? 5));
    const tick = () => {
        if (adapter._stopping) {
            return;
        }
        try {
            smoothTick(adapter, tickS);
        } catch (err) {
            adapter.log.error(`Smooth tick error: ${err.message}`);
        }
        adapter._smoothTimer = setTimeout(tick, tickS * 1000);
    };
    adapter._smoothTimer = setTimeout(tick, 200);
}

function smoothTick(adapter, dtHintS) {
    if (!adapter.smoother || !adapter.modbus) {
        return;
    }
    const sample = adapter._lastSample || { power_w: 0, e_total_kwh: null, u1: 0, f: 0 };
    const staleAfterMs = staleAfterS(adapter) * 1000;
    const hardAfterMs = hardStaleAfterS(adapter) * 1000;
    const age = adapter._lastPollOkAt > 0 ? Date.now() - adapter._lastPollOkAt : 0;
    const freezeEnergy = adapter._lastPollOkAt > 0 && age > staleAfterMs;
    const hardStale = adapter._lastPollOkAt > 0 && age > hardAfterMs;

    if (freezeEnergy && !adapter._staleWarned) {
        adapter._staleWarned = true;
        adapter.log.info('Growatt sample stale — energy integration paused');
    }
    if (!freezeEnergy) {
        adapter._staleWarned = false;
        adapter._hardStaleCleared = false;
    }

    let powerIn = sample.power_w;
    if (hardStale) {
        powerIn = 0;
        if (!adapter._hardStaleCleared) {
            adapter._hardStaleCleared = true;
            void (async () => {
                // Pure OpenAPI throttle must not turn the instance orange
                // (active cooldown OR last failure was rate-limit).
                if (isThrottleAmpSuppress(adapter)) {
                    await adapter.setStateAsync('info.connection', { val: true, ack: true });
                    await adapter.setStateAsync('info.lastError', {
                        val: 'OpenAPI-Cooldown — Fake-SM hält letztes Sample',
                        ack: true,
                    });
                    return;
                }
                await refreshFroniusDaylight(adapter);
                if (!isExpectedSourceIdle(adapter)) {
                    await adapter.setStateAsync('info.connection', { val: false, ack: true });
                    await adapter.setStateAsync('info.lastError', {
                        val: unexpectedSourceHint(adapter),
                        ack: true,
                    });
                } else {
                    await adapter.setStateAsync('info.lastError', {
                        val: 'Quelle hard-stale (erwartet nachts/Idle) — Fake-SM 0 W',
                        ack: true,
                    });
                }
                // Do NOT clear localConnection here: cloud sample age ≠ TCP stick on :5279.
                // A lab stick with Fake-WR can be connected while Shine/OpenAPI is hard-stale at night.
                try {
                    const { clientCount } = require('./stickRedirectGuard');
                    const n = clientCount(adapter.localServer);
                    if (n > 0) {
                        await adapter.setStateAsync('info.localConnection', { val: true, ack: true });
                    }
                } catch {
                    // ignore
                }
            })();
            adapter.log.info('Growatt sample hard-stale — power forced to 0 W');
        }
    }

    const result = adapter.smoother.update(powerIn, sample.e_total_kwh, undefined, dtHintS, {
        freezeEnergy: freezeEnergy || hardStale,
        forcePowerZero: hardStale,
    });
    const u1 = sample.u1 || Number(adapter.config.u1) || 237;
    const meter = adapter.modbus.updateFromMeter({
        powerW: result.powerW,
        eProducedKwh: result.eProducedKwh,
        u1,
        u2: Number(adapter.config.u2) || 237,
        u3: Number(adapter.config.u3) || 239,
        f: sample.f || Number(adapter.config.frequency) || 50,
    });
    if (result.changed || hardStale) {
        void adapter.setStateChangedAsync('meter.powerSmooth', {
            val: Math.round(result.powerW * 10) / 10,
            ack: true,
        });
        void adapter.setStateChangedAsync('meter.eProduced', {
            val: Math.round(result.eProducedKwh * 10000) / 10000,
            ack: true,
        });
        void adapter.setStateChangedAsync('meter.current1', {
            val: Math.round(meter.i1 * 1000) / 1000,
            ack: true,
        });
        void persistLastPublished(adapter, result.eProducedKwh);
    } else if (getLastPublished(adapter) == null && result.eProducedKwh > 0) {
        void persistLastPublished(adapter, result.eProducedKwh);
    }
}

module.exports = {
    OPENAPI_POLL_FLOOR_DEFAULT_S,
    OPENAPI_POLL_FLOOR_CAP_S,
    SHINE_POLL_FLOOR_DEFAULT_S,
    SHINE_POLL_MIN_S,
    effectivePollIntervalS,
    staleAfterS,
    hardStaleAfterS,
    isRateLimitCooldown,
    isThrottleAmpSuppress,
    pollIntervalMs,
    noteRateLimit,
    clearRateLimit,
    commitPollSample,
    hasFreshSample,
    growattRatedW,
    isInDayWindow,
    noteNonZeroPower,
    loadLastNonZeroPower,
    isExpectedSourceIdle,
    unexpectedSourceHint,
    clearConnectionUnlessIdle,
    isLocalFeedActive,
    scheduleNextPoll,
    pollOnce,
    startSmoothLoop,
    smoothTick,
    applyLocalSample,
};
