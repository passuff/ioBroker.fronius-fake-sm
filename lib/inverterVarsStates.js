'use strict';

const {
    getCatalogEntry,
    familyMatches,
    normalizeFamily,
    mergeInverterVarsConfig,
    pickCloudValue,
    effectiveIntervalS,
    listCatalog,
} = require('./inverterVarsCatalog');

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Array<object>}
 */
function enabledVarRows(adapter) {
    const devices = Array.isArray(adapter._enabledDevices)
        ? adapter._enabledDevices
        : (adapter.config.devices || []).filter((d) => d && d.enabled && d.deviceSn);
    const families = deviceFamiliesUnion(devices);
    return mergeInverterVarsConfig(adapter.config && adapter.config.inverterVars, { families }).filter(
        (r) => r.enabled,
    );
}

/**
 * @param {Array<object>} devices
 * @returns {string[]|null} null = no filter (show all)
 */
function deviceFamiliesUnion(devices) {
    if (!Array.isArray(devices) || !devices.length) {
        return null;
    }
    const set = new Set();
    for (const d of devices) {
        if (d && d.enabled !== false) {
            set.add(deviceFamily(d));
        }
    }
    return set.size ? [...set] : null;
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {string[]}
 */
function deviceSerials(adapter) {
    const devices = Array.isArray(adapter._enabledDevices)
        ? adapter._enabledDevices
        : (adapter.config.devices || []).filter((d) => d && d.enabled && d.deviceSn);
    return [...new Set(devices.map((d) => String(d.deviceSn)).filter(Boolean))];
}

/**
 * @param {object} device
 */
function deviceFamily(device) {
    return normalizeFamily((device && (device.deviceType || device.growattType)) || 'min');
}

/**
 * Ensure channel + states for enabled vars matching device family; prune orphans.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function ensureInverterVarObjects(adapter) {
    const rows = enabledVarRows(adapter);
    const devices = Array.isArray(adapter._enabledDevices)
        ? adapter._enabledDevices
        : (adapter.config.devices || []).filter((d) => d && d.enabled && d.deviceSn);
    if (!devices.length) {
        return;
    }
    await adapter.setObjectNotExistsAsync('inverter', {
        type: 'channel',
        common: { name: 'Inverter variables' },
        native: {},
    });
    for (const device of devices) {
        const sn = String(device.deviceSn);
        const family = deviceFamily(device);
        const base = `inverter.${sn}`;
        /** @type {Set<string>} relative ids under base that must exist */
        const keep = new Set(['values', 'settings']);
        await adapter.setObjectNotExistsAsync(base, {
            type: 'device',
            common: { name: sn },
            native: { deviceSn: sn, deviceType: family },
        });
        await adapter.setObjectNotExistsAsync(`${base}.values`, {
            type: 'channel',
            common: { name: 'Read values' },
            native: {},
        });
        await adapter.setObjectNotExistsAsync(`${base}.settings`, {
            type: 'channel',
            common: { name: 'Writable settings' },
            native: {},
        });
        for (const row of rows) {
            const entry = getCatalogEntry(row.id);
            if (!entry || !familyMatches(family, entry)) {
                continue;
            }
            if (entry.kind === 'read') {
                await ensureReadState(adapter, `${base}.values.${entry.id}`, entry);
                keep.add(`values.${entry.id}`);
            } else {
                await ensureWriteStates(adapter, `${base}.settings.${entry.id}`, entry, sn, family);
                keep.add(`settings.${entry.id}`);
                keep.add(`settings.${entry.id}.value`);
                keep.add(`settings.${entry.id}.msg`);
            }
        }
        await pruneInverterBranch(adapter, base, keep);
    }
}

/**
 * Remove catalog states/channels under base that are not in keep set.
 * Only deletes objects whose native.catalogId is set (adapter-owned).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} base e.g. inverter.SN
 * @param {Set<string>} keep relative paths
 */
async function pruneInverterBranch(adapter, base, keep) {
    if (typeof adapter.getObjectListAsync !== 'function' && typeof adapter.getStatesAsync !== 'function') {
        // Minimal mock / limited adapter: delete known catalog ids not kept
        await pruneByCatalogScan(adapter, base, keep);
        return;
    }
    try {
        const prefix = `${adapter.namespace}.${base}.`;
        const list =
            typeof adapter.getObjectListAsync === 'function'
                ? await adapter.getObjectListAsync({ startkey: prefix, endkey: `${prefix}\u9999` })
                : null;
        const rows = (list && list.rows) || [];
        for (const row of rows) {
            const fullId = row && (row.id || (row.value && row.value._id));
            if (!fullId || typeof fullId !== 'string') {
                continue;
            }
            const rel = fullId.startsWith(`${adapter.namespace}.`)
                ? fullId.slice(`${adapter.namespace}.`.length)
                : fullId;
            if (!rel.startsWith(`${base}.`)) {
                continue;
            }
            const sub = rel.slice(base.length + 1);
            if (keep.has(sub)) {
                continue;
            }
            const obj = row.value || (await adapter.getObjectAsync(rel));
            if (!obj || !obj.native || !obj.native.catalogId) {
                continue;
            }
            if (typeof adapter.delObjectAsync === 'function') {
                await adapter.delObjectAsync(rel, { recursive: true });
            }
        }
    } catch (err) {
        adapter.log && adapter.log.debug && adapter.log.debug(`prune inverter: ${err.message}`);
        await pruneByCatalogScan(adapter, base, keep);
    }
}

/**
 * Fallback prune using catalog ids (works in unit tests without objectList).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} base
 * @param {Set<string>} keep
 */
async function pruneByCatalogScan(adapter, base, keep) {
    if (typeof adapter.delObjectAsync !== 'function') {
        return;
    }
    for (const entry of listCatalog()) {
        if (entry.kind === 'read') {
            const rel = `values.${entry.id}`;
            if (!keep.has(rel)) {
                await adapter.delObjectAsync(`${base}.${rel}`, { recursive: true }).catch(() => {});
            }
        } else {
            const rel = `settings.${entry.id}`;
            if (!keep.has(rel)) {
                await adapter.delObjectAsync(`${base}.${rel}`, { recursive: true }).catch(() => {});
            }
        }
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} id
 * @param {object} entry
 */
async function ensureReadState(adapter, id, entry) {
    const label = typeof entry.label === 'object' ? entry.label.en || entry.id : entry.id;
    await adapter.setObjectNotExistsAsync(id, {
        type: 'state',
        common: {
            name: label,
            type: entry.type || 'number',
            role: entry.role || 'value',
            read: true,
            write: false,
            unit: entry.unit || '',
            desc: typeof entry.label === 'object' ? entry.label.de || label : label,
        },
        native: { catalogId: entry.id, kind: 'read' },
    });
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} channelId
 * @param {object} entry
 * @param {string} sn
 * @param {string} family
 */
async function ensureWriteStates(adapter, channelId, entry, sn, family) {
    const label = typeof entry.label === 'object' ? entry.label.en || entry.id : entry.id;
    await adapter.setObjectNotExistsAsync(channelId, {
        type: 'channel',
        common: { name: label },
        native: { catalogId: entry.id, kind: 'write', deviceSn: sn, family },
    });
    await adapter.setObjectNotExistsAsync(`${channelId}.value`, {
        type: 'state',
        common: {
            name: `${label} value`,
            type: entry.type || 'number',
            role: entry.role || 'level',
            read: true,
            write: true,
            unit: entry.unit || '',
            min: entry.range ? entry.range.min : undefined,
            max: entry.range ? entry.range.max : undefined,
        },
        native: {
            catalogId: entry.id,
            deviceSn: sn,
            family,
            setting: true,
            holdingReg: entry.holdingReg,
        },
    });
    await adapter.setObjectNotExistsAsync(`${channelId}.msg`, {
        type: 'state',
        common: {
            name: `${label} message`,
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        },
        native: { catalogId: entry.id },
    });
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function lastWriteMap(adapter) {
    if (!adapter._inverterVarLastAt) {
        adapter._inverterVarLastAt = new Map();
    }
    return adapter._inverterVarLastAt;
}

/**
 * @param {string} key
 * @param {number} intervalS
 * @param {Map} map
 */
function due(key, intervalS, map) {
    const now = Date.now();
    const last = map.get(key) || 0;
    if (now - last < intervalS * 1000) {
        return false;
    }
    map.set(key, now);
    return true;
}

/**
 * Sync read vars from a cloud/local sample raw object.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} opts
 */
async function syncInverterVarsFromSample(adapter, opts) {
    const sn = String(opts.deviceSn || '');
    if (!sn || !opts.raw || typeof opts.raw !== 'object') {
        return;
    }
    const family = normalizeFamily(opts.deviceType || 'min');
    const transport = opts.transport || 'openapi';
    const rows = enabledVarRows(adapter);
    const map = lastWriteMap(adapter);

    for (const row of rows) {
        const entry = getCatalogEntry(row.id);
        if (!entry || entry.kind !== 'read' || !familyMatches(family, entry)) {
            continue;
        }
        const intervalS = effectiveIntervalS(entry, row.intervalS, transport);
        const key = `${sn}:${entry.id}:${transport}`;
        if (!due(key, intervalS, map) && !opts.force) {
            continue;
        }
        let val = null;
        if (transport === 'local' && entry.localField && entry.localField in opts.raw) {
            val = opts.raw[entry.localField];
        } else {
            val = pickCloudValue(opts.raw, entry.cloudKeys || []);
            if (val == null && entry.localField && entry.localField in opts.raw) {
                val = opts.raw[entry.localField];
            }
        }
        if (val == null || val === '') {
            continue;
        }
        const num = Number(val);
        const out = Number.isFinite(num) && entry.type !== 'string' ? num : val;
        const stateId = `inverter.${sn}.values.${entry.id}`;
        try {
            if (typeof adapter.setStateChangedAsync === 'function') {
                await adapter.setStateChangedAsync(stateId, { val: out, ack: true });
            } else {
                await adapter.setStateAsync(stateId, { val: out, ack: true });
            }
        } catch (err) {
            adapter.log && adapter.log.debug && adapter.log.debug(`inverter var ${stateId}: ${err.message}`);
        }
    }
}

/**
 * Apply a holding-register readback value to the matching setting state.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} register
 * @param {number} value
 * @param {string} [deviceSnHint]
 */
async function applyHoldingReadback(adapter, register, value, deviceSnHint) {
    const reg = Number(register);
    if (!Number.isFinite(reg)) {
        return false;
    }
    const entry = listCatalog().find((e) => e.kind === 'write' && Number(e.holdingReg) === reg);
    if (!entry) {
        return false;
    }
    const devices = Array.isArray(adapter._enabledDevices)
        ? adapter._enabledDevices
        : (adapter.config.devices || []).filter((d) => d && d.enabled && d.deviceSn);
    const sns = deviceSnHint
        ? [String(deviceSnHint)]
        : devices.map((d) => String(d.deviceSn)).filter(Boolean);
    let ok = false;
    for (const sn of sns) {
        const id = `inverter.${sn}.settings.${entry.id}.value`;
        try {
            await adapter.setStateAsync(id, { val: value, ack: true });
            ok = true;
        } catch {
            // ignore missing
        }
    }
    return ok;
}

/**
 * Parse state id → setting write target.
 * @param {string} id
 * @param {string} namespace
 */
function parseSettingStateId(id, namespace) {
    const prefix = `${namespace}.inverter.`;
    if (!id || !id.startsWith(prefix) || !id.endsWith('.value')) {
        return null;
    }
    const rest = id.slice(prefix.length, -'.value'.length);
    const m = /^([^.]+)\.settings\.([^.]+)$/.exec(rest);
    if (!m) {
        return null;
    }
    return { deviceSn: m[1], catalogId: m[2] };
}

module.exports = {
    enabledVarRows,
    deviceSerials,
    deviceFamily,
    deviceFamiliesUnion,
    ensureInverterVarObjects,
    syncInverterVarsFromSample,
    parseSettingStateId,
    mergeInverterVarsConfig,
    pruneInverterBranch,
    applyHoldingReadback,
};
