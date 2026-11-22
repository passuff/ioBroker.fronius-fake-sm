'use strict';

const { GrowattOpenApiClient } = require('./growattOpenApi');
const { discoverFroniusOnLan, advertisedListenIps } = require('./froniusDiscover');

/**
 * @param {object} fronius
 * @param {string[]} listenIps
 */
function froniusAutoSettings(fronius, listenIps) {
    let loc = Number(fronius.suggestedLocation);
    if (!Number.isFinite(loc) || loc < 1) {
        loc = 3;
    }
    // Gen24 UI: secondary meters must use 2–14 (1 is reserved for primary RTU meter).
    let unit = Number(fronius.suggestedUnitId);
    if (!Number.isFinite(unit) || unit < 2 || unit > 127) {
        unit = 3;
    }
    let port = Number(fronius.suggestedModbusPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        port = 502;
    }
    return {
        froniusIp: fronius.ip,
        froniusSerial: fronius.serial || '',
        froniusHostname: fronius.hostname || '',
        fakeUniqueId: loc,
        modbusPort: port,
        modbusUnitId: unit,
        modbusHost: '0.0.0.0',
        advertisedModbusIp: listenIps[0] || '',
    };
}

/**
 * Clamp native Fake-SM defaults so legacy/wrong values never stick.
 * @param {object} cfg adapter.config / native
 * @returns {object} patch of corrected keys (empty if ok)
 */
function clampFakeSmDefaults(cfg) {
    const patch = {};
    let unit = Number(cfg.modbusUnitId);
    if (!Number.isFinite(unit) || unit < 2 || unit > 127) {
        patch.modbusUnitId = 3;
    }
    let loc = Number(cfg.fakeUniqueId);
    if (!Number.isFinite(loc) || loc < 1) {
        patch.fakeUniqueId = 3;
    }
    let port = Number(cfg.modbusPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        patch.modbusPort = 502;
    }
    if (!cfg.modbusHost) {
        patch.modbusHost = '0.0.0.0';
    }
    return patch;
}

/**
 * Prefer inverter that already reports meters (Gen24 master).
 * @param {object[]} found
 * @returns {object|null}
 */
function pickMasterFronius(found) {
    if (!Array.isArray(found) || !found.length) {
        return null;
    }
    const withMeters = found
        .filter((d) => d && Number(d.meterCount) > 0)
        .sort((a, b) => Number(b.meterCount) - Number(a.meterCount));
    if (withMeters.length) {
        return withMeters[0];
    }
    if (found.length === 1) {
        return found[0];
    }
    return null;
}

/**
 * @param {object[]} found
 * @param {object|null} master
 */
function applyMasterSelection(found, master) {
    for (const row of found) {
        row.enabled = !!(master && row.ip === master.ip);
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter} adapter
 * @param {ioBroker.Message} obj
 */
async function handleDiscoverGrowatt(adapter, obj) {
    const msg = obj.message || {};
    const manufacturer = msg.manufacturer || adapter.config.manufacturer || 'growatt';
    try {
        if (manufacturer !== 'growatt') {
            throw new Error(`Manufacturer '${manufacturer}' not supported for search yet`);
        }
        // Prefer decrypted adapter config — do not require token in sendTo payload.
        const token = adapter.config.growattToken || msg.growattToken;
        if (!token) {
            throw new Error('API token missing — enter Growatt token first and save');
        }
        const client = new GrowattOpenApiClient({
            token,
            baseUrl: adapter.config.growattOpenApiUrl || 'https://openapi.growatt.com/',
            log: (m) => adapter.log.info(m),
        });
        const found = await client.discoverAccountDevices();
        const prev = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
        const prevEnabled = new Set(prev.filter((d) => d && d.enabled && d.deviceSn).map((d) => d.deviceSn));
        for (const row of found) {
            if (prevEnabled.has(row.deviceSn)) {
                row.enabled = true;
            }
        }
        adapter.log.info(`Discover found ${found.length} Growatt device(s)`);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, { native: { devices: found } }, obj.callback);
        }
    } catch (err) {
        adapter.log.warn(`discoverDevices failed: ${err.message}`);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
        }
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter} adapter
 * @param {ioBroker.Message} obj
 */
async function handleDiscoverFronius(adapter, obj) {
    const msg = obj.message || {};
    try {
        const extra = [];
        if (msg.froniusIpHint) {
            extra.push(String(msg.froniusIpHint));
        }
        if (adapter.config.froniusIp) {
            extra.push(String(adapter.config.froniusIp));
        }

        const found = await discoverFroniusOnLan({
            log: (m) => adapter.log.info(m),
            extraHosts: extra,
        });

        const listenIps = advertisedListenIps();
        const existingUnit = Number(adapter.config.modbusUnitId);
        const existingPort = Number(adapter.config.modbusPort);
        const existingLoc = Number(adapter.config.fakeUniqueId);
        const nativeUpdate = {
            froniusDevices: found,
            modbusHost: adapter.config.modbusHost || '0.0.0.0',
            modbusPort:
                Number.isFinite(existingPort) && existingPort >= 1 && existingPort <= 65535 ? existingPort : 502,
            modbusUnitId: Number.isFinite(existingUnit) && existingUnit >= 2 && existingUnit <= 127 ? existingUnit : 3,
            fakeUniqueId: Number.isFinite(existingLoc) && existingLoc >= 1 ? existingLoc : 3,
            advertisedModbusIp: adapter.config.advertisedModbusIp || listenIps[0] || '',
        };

        // Preserve previous enable if still present and has meters; else auto-pick master.
        const prev = Array.isArray(adapter.config.froniusDevices) ? adapter.config.froniusDevices : [];
        const prevEnabled = prev.filter((d) => d && d.enabled && d.ip);
        let master = null;
        if (prevEnabled.length === 1) {
            master = found.find((d) => d.ip === prevEnabled[0].ip) || null;
        }
        if (!master) {
            master = pickMasterFronius(found);
        }
        applyMasterSelection(found, master);
        if (master) {
            Object.assign(nativeUpdate, froniusAutoSettings(master, listenIps));
            // Keep user-chosen Modbus unit/port if already set and valid.
            if (Number.isFinite(existingUnit) && existingUnit >= 2 && existingUnit <= 127) {
                nativeUpdate.modbusUnitId = existingUnit;
            }
            if (Number.isFinite(existingPort) && existingPort >= 1 && existingPort <= 65535) {
                nativeUpdate.modbusPort = existingPort;
            }
        }

        adapter.log.info(
            `Fronius scan found ${found.length} inverter(s); master=${master ? master.ip : 'none'}; ` +
                `listen IP=${nativeUpdate.advertisedModbusIp}`,
        );
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, { native: nativeUpdate }, obj.callback);
        }
    } catch (err) {
        adapter.log.warn(`discoverFronius failed: ${err.message}`);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
        }
    }
}

/**
 * Clear per-device energy baselines (may cause a Fronius energy jump).
 * @param {import('@iobroker/adapter-core').Adapter} adapter
 * @param {ioBroker.Message} obj
 */
async function handleResetEnergyBaselines(adapter, obj) {
    try {
        const { resetAllBaselines, persistNativePatch } = require('./energyBaselines');
        const { seedFromGen24Truth } = require('./froniusMeterTruth');
        const devices = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
        const n = resetAllBaselines(devices);
        adapter.config.localEBaselineKwh = null;
        adapter.config.localEBaselineLocked = false;
        await persistNativePatch(adapter, {
            localEBaselineKwh: null,
            localEBaselineLocked: false,
        });
        await adapter.setStateAsync('info.eBaselineSum', { val: 0, ack: true });
        // Re-anchor to Gen24 Fake-SM register (same as adapter restart)
        const gen24 = await seedFromGen24Truth(adapter);
        adapter.log.warn(
            `Energy baselines reset (${n} device rows)` +
                (gen24.ok ? `; Gen24 truth=${gen24.kwh} kWh` : `; Gen24 fallback (${gen24.error || 'n/a'})`) +
                ' — next samples will re-lock',
        );
        if (obj.callback) {
            adapter.sendTo(
                obj.from,
                obj.command,
                {
                    ok: true,
                    reset: n,
                    gen24,
                    native: {
                        devices: adapter.config.devices,
                        lastPublishedEProducedKwh: adapter.config.lastPublishedEProducedKwh,
                    },
                },
                obj.callback,
            );
        }
    } catch (err) {
        adapter.log.warn(`resetEnergyBaselines failed: ${err.message}`);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
        }
    }
}

module.exports = {
    froniusAutoSettings,
    clampFakeSmDefaults,
    pickMasterFronius,
    applyMasterSelection,
    handleDiscoverGrowatt,
    handleDiscoverFronius,
    handleResetEnergyBaselines,
};
