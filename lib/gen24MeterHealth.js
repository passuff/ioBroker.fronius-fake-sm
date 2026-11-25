'use strict';

const { httpGetJson } = require('./froniusDiscover');
const { pickSecondaryMeter } = require('./froniusMeterTruth');

const POLL_MS = 45_000;
const MISS_THRESHOLD = 3;
const INVISIBLE_ERR_PREFIX = 'Gen24 sieht Fake-SM';

/**
 * One-shot Solar-API probe for Fake-SM Loc visibility (no energy seeding).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<{ visible: boolean, powerW: number|null, location: number, deviceId: string|null, serial: string, error?: string }>}
 */
async function probeGen24MeterVisibility(adapter) {
    const ip = String(adapter.config.froniusIp || '').trim();
    const location = Number(adapter.config.fakeUniqueId ?? 3);
    if (!ip) {
        return {
            visible: false,
            powerW: null,
            location,
            deviceId: null,
            serial: '',
            error: 'froniusIp missing',
        };
    }
    const url = `http://${ip}/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`;
    try {
        const { body } = await httpGetJson(url, 5000);
        const data = (body && body.Body && body.Body.Data) || {};
        const picked = pickSecondaryMeter(data, location);
        if (!picked) {
            return {
                visible: false,
                powerW: null,
                location,
                deviceId: null,
                serial: '',
                error: `no Loc${location} in Solar API`,
            };
        }
        const visible = Number(picked.row.Visible) === 1;
        const powerRaw = Number(picked.row.PowerReal_P_Sum);
        const powerW = Number.isFinite(powerRaw) ? Math.round(powerRaw * 10) / 10 : null;
        const details = picked.row.Details || {};
        return {
            visible,
            powerW,
            location: Number(picked.row.Meter_Location_Current ?? location),
            deviceId: picked.deviceId,
            serial: String(details.Serial || ''),
            error: visible ? undefined : `Loc${location} Visible=0`,
        };
    } catch (err) {
        return {
            visible: false,
            powerW: null,
            location,
            deviceId: null,
            serial: '',
            error: String(err && err.message ? err.message : err),
        };
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} result from probeGen24MeterVisibility
 */
async function applyGen24MeterProbe(adapter, result) {
    const listening = !!(adapter.modbus && adapter.modbus.listening);
    const visible = !!(result && result.visible);
    const prev = adapter._gen24MeterVisible;
    adapter._gen24MeterVisible = visible;

    await adapter.setStateAsync('info.gen24MeterVisible', { val: visible, ack: true });
    if (result && result.powerW != null && Number.isFinite(result.powerW)) {
        await adapter.setStateAsync('info.gen24MeterPower', { val: result.powerW, ack: true });
    }
    if (visible) {
        adapter._gen24MeterMisses = 0;
        await adapter.setStateAsync('info.gen24MeterLastSeen', { val: Date.now(), ack: true });
        if (prev === false) {
            adapter.log.info(
                `Gen24 Fake-SM Loc${result.location} visible again` +
                    (result.serial ? ` SN=${result.serial}` : '') +
                    (result.powerW != null ? ` P=${result.powerW} W` : ''),
            );
        }
        try {
            const st = await adapter.getStateAsync('info.lastError');
            const cur = st && st.val != null ? String(st.val) : '';
            if (cur.startsWith(INVISIBLE_ERR_PREFIX)) {
                await adapter.setStateAsync('info.lastError', { val: '', ack: true });
            }
        } catch {
            // ignore
        }
        return;
    }

    adapter._gen24MeterMisses = (Number(adapter._gen24MeterMisses) || 0) + 1;
    if (prev === true || prev === undefined) {
        adapter.log.warn(
            `Gen24 Fake-SM Loc${result.location} not visible (${result.error || 'unknown'})` +
                (listening ? ' — Modbus still listening' : ''),
        );
    }
    if (listening && adapter._gen24MeterMisses >= MISS_THRESHOLD) {
        const msg =
            `${INVISIBLE_ERR_PREFIX} Loc${result.location} nicht` +
            (result.error ? ` (${result.error})` : '') +
            ' — Ampel kann trotzdem grün sein';
        await adapter.setStateAsync('info.lastError', { val: msg.slice(0, 240), ack: true });
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function refreshGen24MeterVisibility(adapter) {
    if (adapter._stopping || adapter._gen24MeterProbeBusy) {
        return;
    }
    if (!String(adapter.config.froniusIp || '').trim()) {
        return;
    }
    adapter._gen24MeterProbeBusy = true;
    try {
        const result = await probeGen24MeterVisibility(adapter);
        await applyGen24MeterProbe(adapter, result);
    } catch (err) {
        adapter.log.debug(`gen24 meter probe: ${err && err.message ? err.message : err}`);
    } finally {
        adapter._gen24MeterProbeBusy = false;
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {{ firstDelayMs?: number, intervalMs?: number }} [opts]
 */
function startGen24MeterMonitor(adapter, opts = {}) {
    stopGen24MeterMonitor(adapter);
    adapter._gen24MeterMisses = 0;
    const first = Math.max(2000, Number(opts.firstDelayMs ?? 15000));
    const every = Math.max(15000, Number(opts.intervalMs ?? POLL_MS));
    adapter._gen24MeterTimer = setTimeout(function tick() {
        if (adapter._stopping) {
            return;
        }
        void refreshGen24MeterVisibility(adapter).finally(() => {
            if (!adapter._stopping) {
                adapter._gen24MeterTimer = setTimeout(tick, every);
            }
        });
    }, first);
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function stopGen24MeterMonitor(adapter) {
    if (adapter._gen24MeterTimer) {
        clearTimeout(adapter._gen24MeterTimer);
        adapter._gen24MeterTimer = null;
    }
}

module.exports = {
    POLL_MS,
    MISS_THRESHOLD,
    INVISIBLE_ERR_PREFIX,
    probeGen24MeterVisibility,
    applyGen24MeterProbe,
    refreshGen24MeterVisibility,
    startGen24MeterMonitor,
    stopGen24MeterMonitor,
};
