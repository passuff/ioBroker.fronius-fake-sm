'use strict';

const { isGrowattRateLimitError } = require('./growattOpenApi');
const {
    isAutoOffsetMode,
    applyEnergySamples,
    pipelineETotal,
    persistLastPublished,
    getLastPublished,
} = require('./energyBaselines');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Freshness window — local stick frames are often 1–5 min apart.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function staleAfterS(adapter) {
    const poll = Math.max(60, Number(adapter.config.pollIntervalS ?? 60));
    const cloudStale = Math.max(90, Math.round(poll * 1.5));
    const localMode = String(adapter.config.growattFeedMode || 'cloud') === 'local';
    if (localMode || adapter.config.localEnabled || adapter._lastLocalOkAt) {
        return Math.max(cloudStale, 300);
    }
    return cloudStale;
}

function hardStaleAfterS(adapter) {
    return staleAfterS(adapter) * 2;
}

function pollIntervalMs(adapter) {
    const now = Date.now();
    if (adapter._rateLimitUntil > now) {
        return Math.max(5000, adapter._rateLimitUntil - now);
    }
    const day = Math.max(60, Number(adapter.config.pollIntervalS ?? 60)) * 1000;
    const night = Math.max(120, Number(adapter.config.nightPollIntervalS ?? 300)) * 1000;
    const eps = Math.max(15, Number(adapter.config.powerEpsilonW ?? 5));
    const sample = adapter._lastSample;
    const lastP = sample ? Math.abs(Number(sample.power_w) || 0) : 0;
    const fresh = hasFreshSample(adapter);

    // Soft-stale after errors: keep day cadence if last good power was active
    if (!fresh) {
        if (lastP >= eps && adapter._lastPollOkAt) {
            const softBackoff = Math.min(day * 2, 180000);
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
    const hit = devices.find((d) => d && d.deviceSn && sn && d.deviceSn === sn);
    if (hit) {
        hit.enabled = true;
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

    await adapter.setStateAsync('info.connection', { val: true, ack: true });
    await adapter.setStateAsync('info.localConnection', { val: true, ack: true });
    await adapter.setStateAsync('info.lastPoll', { val: adapter._lastPollOkAt, ack: true });
    await adapter.setStateAsync('info.lastLocalFrame', { val: adapter._lastLocalOkAt, ack: true });
    if (sample.sn) {
        await adapter.setStateChangedAsync('info.stickSn', { val: String(sample.sn), ack: true });
    }
    await adapter.setStateChangedAsync('meter.power', { val: Math.round(power_w * 10) / 10, ack: true });
    await adapter.setStateChangedAsync('meter.eTotalCloud', { val: Math.round(rawSum * 1000) / 1000, ack: true });
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

function noteRateLimit(adapter) {
    const next = adapter._rateLimitBackoffS > 0 ? Math.min(300, adapter._rateLimitBackoffS * 2) : 120;
    adapter._rateLimitBackoffS = next;
    adapter._rateLimitUntil = Date.now() + next * 1000;
    return next;
}

function clearRateLimit(adapter) {
    adapter._rateLimitBackoffS = 0;
    adapter._rateLimitUntil = 0;
}

function hasFreshSample(adapter) {
    if (!adapter._lastPollOkAt) {
        return false;
    }
    return Date.now() - adapter._lastPollOkAt <= staleAfterS(adapter) * 1000;
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
    if (!adapter.config.growattToken || !adapter._enabledDevices.length) {
        return;
    }

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
        adapter.log.info(`Growatt rate-limited — cooldown ${cooldownS}s (Modbus keeps last sample)`);
        await adapter.setStateAsync('info.lastError', {
            val: `Growatt cooldown ${cooldownS}s`,
            ack: true,
        });
        if (ok > 0) {
            await commitPollSample(
                adapter,
                { powerSum, eSum: ePipe, eSumRaw: rawSum, u1, f, ok, errors },
                { keepRateLimit: true },
            );
            adapter.log.info(
                `Growatt partial sum power=${powerSum.toFixed(1)} W eRaw=${rawSum.toFixed(2)} ePipe=${ePipe.toFixed(2)} kWh devices=${ok} (then rate-limit)`,
            );
        } else if (!hasFreshSample(adapter)) {
            await adapter.setStateAsync('info.connection', { val: false, ack: true });
        }
        return;
    }

    if (!ok) {
        await adapter.setStateAsync('info.connection', { val: false, ack: true });
        await adapter.setStateAsync('info.lastError', { val: errors.join('; ') || 'all devices failed', ack: true });
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
            void adapter.setStateAsync('info.connection', { val: false, ack: true });
            void adapter.setStateAsync('info.localConnection', { val: false, ack: true });
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
    staleAfterS,
    hardStaleAfterS,
    pollIntervalMs,
    noteRateLimit,
    clearRateLimit,
    commitPollSample,
    hasFreshSample,
    scheduleNextPoll,
    pollOnce,
    startSmoothLoop,
    smoothTick,
    applyLocalSample,
};
