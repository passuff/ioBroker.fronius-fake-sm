'use strict';

const { advertisedListenIps } = require('./froniusDiscover');
const { froniusAutoSettings, clampFakeSmDefaults } = require('./adminMessages');

/** One-time: old single-SN config → devices[] */
function migrateLegacyDeviceConfig(adapter) {
    const cfg = adapter.config;
    const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
    if (devices.length || !cfg.growattDeviceSn) {
        return;
    }
    cfg.devices = [
        {
            enabled: true,
            plantId: String(cfg.growattPlantId || ''),
            plantName: '',
            deviceSn: String(cfg.growattDeviceSn),
            deviceType: String(cfg.growattDeviceType || 'min'),
            model: '',
        },
    ];
    adapter.log.info(`Migrated legacy device ${cfg.growattDeviceSn} into devices[]`);
}

/** Sync Fake-SM defaults from the enabled Fronius row (single selection). */
function applySelectedFroniusFromTable(adapter) {
    const rows = Array.isArray(adapter.config.froniusDevices) ? adapter.config.froniusDevices : [];
    const enabled = rows.filter((d) => d && d.enabled && d.ip);
    if (!enabled.length) {
        return;
    }
    if (enabled.length > 1) {
        adapter.log.warn(`Multiple Fronius selected (${enabled.length}) — using first ${enabled[0].ip}`);
    }
    const listenIps = advertisedListenIps();
    const suggested = froniusAutoSettings(enabled[0], listenIps);
    const cfg = adapter.config;
    if (!cfg.froniusIp) {
        cfg.froniusIp = suggested.froniusIp;
    }
    if (!cfg.froniusSerial) {
        cfg.froniusSerial = suggested.froniusSerial;
    }
    if (!cfg.froniusHostname) {
        cfg.froniusHostname = suggested.froniusHostname;
    }
    const unit = Number(cfg.modbusUnitId);
    if (!Number.isFinite(unit) || unit < 2 || unit > 127) {
        cfg.modbusUnitId = suggested.modbusUnitId;
    }
    const port = Number(cfg.modbusPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        cfg.modbusPort = suggested.modbusPort;
    }
    const loc = Number(cfg.fakeUniqueId);
    if (!Number.isFinite(loc) || loc < 1) {
        cfg.fakeUniqueId = suggested.fakeUniqueId;
    }
    if (!cfg.advertisedModbusIp && suggested.advertisedModbusIp) {
        cfg.advertisedModbusIp = suggested.advertisedModbusIp;
    }
    if (!cfg.modbusHost) {
        cfg.modbusHost = suggested.modbusHost || '0.0.0.0';
    }
}

/**
 * After enabling encryptedNative, a still-plaintext DB token can be
 * "decrypted" into header-unsafe garbage. Re-encrypt plaintext from DB.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function ensureGrowattTokenUsable(adapter) {
    const token = adapter.config.growattToken;
    if (!token) {
        return;
    }
    const headerSafe = /^[\t\x20-\x7e]*$/.test(String(token));
    if (headerSafe) {
        return;
    }
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        const raw = obj && obj.native && obj.native.growattToken;
        if (raw && /^[\t\x20-\x7e]+$/.test(String(raw)) && !String(raw).startsWith('$/')) {
            adapter.config.growattToken = String(raw);
            obj.native.growattToken = adapter.encrypt(String(raw));
            const enc = ['growattToken', 'growattUser', 'growattPassword'];
            obj.encryptedNative = Array.from(new Set([...(obj.encryptedNative || []), ...enc]));
            obj.protectedNative = Array.from(new Set([...(obj.protectedNative || []), ...enc]));
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
            adapter.log.warn('Migrated growattToken into encryptedNative storage');
            return;
        }
    } catch (err) {
        adapter.log.warn(`growattToken migration failed: ${err.message}`);
    }
    adapter.log.error(
        'growattToken is not usable as HTTP header after encryption — re-enter the API token in admin and save',
    );
    adapter.config.growattToken = '';
}

/** Persist clamped Modbus/Location defaults (never keep unit 1 / empty port). */
async function ensureFakeSmDefaults(adapter) {
    const patch = clampFakeSmDefaults(adapter.config);
    if (!Object.keys(patch).length) {
        return;
    }
    Object.assign(adapter.config, patch);
    adapter.log.warn(
        `Corrected Fake-SM defaults: ${Object.entries(patch)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`,
    );
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (obj && obj.native) {
            Object.assign(obj.native, patch);
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
        }
    } catch (err) {
        adapter.log.warn(`Could not persist Fake-SM defaults: ${err.message}`);
    }
}

module.exports = {
    migrateLegacyDeviceConfig,
    applySelectedFroniusFromTable,
    ensureGrowattTokenUsable,
    ensureFakeSmDefaults,
};
