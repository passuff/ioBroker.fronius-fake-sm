'use strict';

const { getLastPublished, seedSmootherFromPublished } = require('./energyBaselines');
const { seedFromGen24Truth } = require('./froniusMeterTruth');

/**
 * Seed smoother from lastPublished / meter.eProduced (no Gen24).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} [reason]
 */
async function seedEnergyFallback(adapter, reason = 'fallback') {
    const cfg = adapter.config;
    if (getLastPublished(adapter) == null) {
        try {
            const st = await adapter.getStateAsync('meter.eProduced');
            if (st && Number.isFinite(Number(st.val)) && Number(st.val) >= 0) {
                cfg.lastPublishedEProducedKwh = Number(st.val);
                adapter._lastPublishedEProducedKwh = Number(st.val);
            }
        } catch {
            // ignore
        }
    }
    const lastPub = getLastPublished(adapter);
    if (lastPub == null || lastPub < 0 || !adapter.smoother) {
        adapter.log.info(`Energy continuity: no local seed yet (${reason})`);
        return false;
    }
    if (!seedSmootherFromPublished(adapter.smoother, lastPub)) {
        return false;
    }
    adapter._lastPublishedEProducedKwh = lastPub;
    await adapter.setStateAsync('info.lastPublishedEProduced', { val: lastPub, ack: true });
    if (!String(reason).startsWith('provisional')) {
        adapter.log.info(
            `Energy continuity: seeded Fake-SM eProduced=${lastPub} kWh from lastPublished (${reason})`,
        );
    } else {
        adapter.log.debug(`Energy continuity: provisional seed eProduced=${lastPub} kWh`);
    }
    return true;
}

/**
 * Publish current smoother / lastPublished energy into Modbus holding registers.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function pushEnergyToModbus(adapter) {
    if (!adapter.modbus) {
        return;
    }
    const kwh =
        (adapter.smoother && Number(adapter.smoother.state.eProducedKwh)) || getLastPublished(adapter) || 0;
    if (!Number.isFinite(kwh) || kwh < 0) {
        return;
    }
    adapter.modbus.updateFromMeter({
        powerW: 0,
        eProducedKwh: kwh,
        u1: Number(adapter.config.u1) || 237,
        u2: Number(adapter.config.u2) || 237,
        u3: Number(adapter.config.u3) || 239,
        f: Number(adapter.config.frequency) || 50,
    });
}

/**
 * Wait until Gen24 opens a Modbus TCP session (Loc3 often missing until then).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} [timeoutMs]
 */
function waitForGen24ModbusClient(adapter, timeoutMs = 90000) {
    if (adapter._modbusClientFromFronius) {
        return Promise.resolve(true);
    }
    const froniusIp = String(adapter.config.froniusIp || '').trim();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (adapter._pendingModbusClientWait === waitResolve) {
                adapter._pendingModbusClientWait = null;
            }
            resolve(false);
        }, timeoutMs);
        const waitResolve = (ok) => {
            clearTimeout(timer);
            resolve(!!ok);
        };
        adapter._pendingModbusClientWait = waitResolve;
        // Already connected between listen and this wait?
        if (adapter._modbusClientFromFronius) {
            waitResolve(true);
            return;
        }
        if (froniusIp) {
            adapter.log.info(
                `Energy continuity: waiting up to ${Math.round(timeoutMs / 1000)}s for Gen24 Modbus client ${froniusIp}…`,
            );
        }
    });
}

/**
 * Called from Modbus server on each TCP connection.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} remoteAddress
 */
function noteModbusClient(adapter, remoteAddress) {
    const ip = String(remoteAddress || '').replace(/^::ffff:/, '');
    const want = String(adapter.config.froniusIp || '').trim();
    if (want && ip && ip !== want) {
        return;
    }
    adapter._modbusClientFromFronius = true;
    if (typeof adapter._pendingModbusClientWait === 'function') {
        const done = adapter._pendingModbusClientWait;
        adapter._pendingModbusClientWait = null;
        done(true);
    }
}

/**
 * After Modbus is listening: wait for Gen24 client, then Solar-API truth.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function finalizeEnergySeedAfterModbus(adapter) {
    const sawClient = await waitForGen24ModbusClient(adapter, 90000);
    if (!sawClient) {
        adapter.log.warn('Energy continuity: no Gen24 Modbus client within timeout — trying Solar API anyway');
    } else {
        // Give Gen24 a moment to publish Loc3 into GetMeterRealtimeData
        await new Promise((r) => setTimeout(r, 2000));
    }
    // Prefer any known prior counter so Gen24 reconnect-zeros are rejected
    let floor = getLastPublished(adapter);
    if (floor == null || floor <= 0) {
        try {
            const st = await adapter.getStateAsync('meter.eProduced');
            if (st && Number.isFinite(Number(st.val)) && Number(st.val) > 0) {
                floor = Number(st.val);
            }
        } catch {
            // ignore
        }
    }
    const gen24 = await seedFromGen24Truth(adapter, {
        attempts: 12,
        retryDelayMs: 3000,
        // Reject reconnect zeros / large drops when we already know a Fake-SM counter
        minKwh: floor != null && floor > 0.001 ? Math.max(0.001, Math.min(floor * 0.5, floor - 0.05)) : 0.001,
        requireStable: true,
    });
    if (!gen24.ok) {
        await seedEnergyFallback(adapter, `Gen24 fallback (${gen24.error || 'n/a'})`);
    }
    pushEnergyToModbus(adapter);
    return gen24;
}

module.exports = {
    seedEnergyFallback,
    pushEnergyToModbus,
    waitForGen24ModbusClient,
    noteModbusClient,
    finalizeEnergySeedAfterModbus,
};
