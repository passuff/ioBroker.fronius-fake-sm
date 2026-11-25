'use strict';

const { sessionFromAdapter } = require('./stickOnline');

/** @type {Map<string, {at:number, text:string}>} */
const shineCache = new Map();
/** @type {Map<string, {at:number, text:string}>} */
const stickCache = new Map();
const CACHE_MS = 60 * 1000;

/**
 * @param {Map<string, {at:number, text:string}>} cache
 * @param {string} key
 * @returns {string|null}
 */
function cacheGet(cache, key) {
    const hit = cache.get(key);
    if (!hit) {
        return null;
    }
    if (Date.now() - hit.at > CACHE_MS) {
        cache.delete(key);
        return null;
    }
    return hit.text;
}

/**
 * @param {Map<string, {at:number, text:string}>} cache
 * @param {string} key
 * @param {string} text
 */
function cacheSet(cache, key, text) {
    cache.set(key, { at: Date.now(), text });
}

/**
 * textSendTo: Shine login status (no native write).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleShineStatus(adapter, obj) {
    const message = (obj && obj.message) || {};
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, 'nicht verbunden – Anmeldedaten fehlen', obj.callback);
        }
        return;
    }
    const cacheKey = String(cred.user || '').toLowerCase();
    const cached = cacheGet(shineCache, cacheKey);
    if (cached != null) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, cached, obj.callback);
        }
        return;
    }
    try {
        await cred.session.login();
        const plants = await cred.session.listPlants();
        const text = `verbunden (${plants.length} Anlage${plants.length === 1 ? '' : 'n'})`;
        cacheSet(shineCache, cacheKey, text);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, text, obj.callback);
        }
    } catch (err) {
        const text = `nicht verbunden – ${err.message || String(err)}`;
        cacheSet(shineCache, cacheKey, text);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, text, obj.callback);
        }
    }
}

/**
 * textSendTo: stick status for selected plant/SN (no native write).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleStickStatusText(adapter, obj) {
    const message = (obj && obj.message) || {};
    const stickSn = String(message.localStickSn || adapter.config.localStickSn || '').trim();
    const plantId = String(message.localPlantId || adapter.config.localPlantId || '').trim();
    if (!stickSn) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, 'nicht verbunden – kein Stick gewählt', obj.callback);
        }
        return;
    }
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, 'nicht verbunden – Anmeldedaten fehlen', obj.callback);
        }
        return;
    }
    const cacheKey = `${cred.user}|${plantId}|${stickSn}`.toLowerCase();
    const cached = cacheGet(stickCache, cacheKey);
    if (cached != null) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, cached, obj.callback);
        }
        return;
    }
    try {
        const { refreshStickStatus } = require('./stickStatus');
        const snap = await refreshStickStatus(adapter, message);
        const text = snap.text || 'nicht verbunden';
        cacheSet(stickCache, cacheKey, text);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, text, obj.callback);
        }
    } catch (err) {
        const text = `nicht verbunden – ${err.message || String(err)}`;
        cacheSet(stickCache, cacheKey, text);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, text, obj.callback);
        }
    }
}

/**
 * textSendTo: setup/redirect state for selected SN (registry + proxy, no Shine call).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleStickSetupState(adapter, obj) {
    const message = (obj && obj.message) || {};
    const stickSn = String(message.localStickSn || adapter.config.localStickSn || '').trim();
    if (!stickSn) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, 'kein Stick gewählt', obj.callback);
        }
        return;
    }
    const { getStickEntry, configuredLabelFromEntry } = require('./stickRedirectRegistry');
    const { hasStickSession } = require('./stickRedirectGuard');
    const entry = getStickEntry(adapter.config, stickSn);
    let label = configuredLabelFromEntry(entry);
    if (hasStickSession(adapter.localServer, stickSn)) {
        label = entry && entry.state === 'verified' ? 'konfiguriert (verbunden)' : `${label} (verbunden)`;
    }
    if (obj.callback) {
        adapter.sendTo(obj.from, obj.command, label, obj.callback);
    }
}

/**
 * Clear caches so textSendTo re-fetches after connect/setup.
 */
function clearStatusCaches() {
    shineCache.clear();
    stickCache.clear();
}

/**
 * Seed shine status cache after a successful connect (avoids stale „nicht verbunden“).
 * @param {string} user
 * @param {string} text
 */
function seedShineStatus(user, text) {
    const key = String(user || '').toLowerCase();
    if (!key || !text) {
        return;
    }
    cacheSet(shineCache, key, text);
}

/**
 * Resolve shine portion for snapshot (uses same cache as shineStatus).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} message
 * @returns {Promise<{connected:boolean,plantCount:number,error?:string}>}
 */
async function resolveShineForSnapshot(adapter, message) {
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        return { connected: false, plantCount: 0, error: String(cred.error) };
    }
    const cacheKey = String(cred.user || '').toLowerCase();
    const cached = cacheGet(shineCache, cacheKey);
    if (cached != null) {
        const m = String(cached).match(/verbunden\s*\((\d+)/i);
        if (m) {
            return { connected: true, plantCount: Number(m[1]) || 0 };
        }
        if (/verbunden/i.test(cached) && !/nicht verbunden/i.test(cached)) {
            return { connected: true, plantCount: 0 };
        }
        return { connected: false, plantCount: 0, error: cached };
    }
    try {
        await cred.session.login();
        const plants = await cred.session.listPlants();
        const text = `verbunden (${plants.length} Anlage${plants.length === 1 ? '' : 'n'})`;
        cacheSet(shineCache, cacheKey, text);
        return { connected: true, plantCount: plants.length };
    } catch (err) {
        const text = `nicht verbunden – ${err.message || String(err)}`;
        cacheSet(shineCache, cacheKey, text);
        return { connected: false, plantCount: 0, error: String(err.message || err) };
    }
}

/**
 * sendTo: structured local workflow snapshot for custom Admin panel.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleLocalWorkflowSnapshot(adapter, obj) {
    const message = (obj && obj.message) || {};
    const selectedSn = String(message.localStickSn || adapter.config.localStickSn || '').trim();
    let frameStatus = '—';
    try {
        if (typeof adapter.getStateAsync === 'function') {
            const st = await adapter.getStateAsync('info.localFrameStatus');
            if (st && st.val != null && String(st.val).trim()) {
                frameStatus = String(st.val);
            }
        }
    } catch {
        // ignore
    }
    if (adapter._localFrameStatus) {
        frameStatus = String(adapter._localFrameStatus);
    }
    const shine = await resolveShineForSnapshot(adapter, message);
    // Snapshot is read-only — never reconcile/demote here (native write restarts
    // the instance and aborts an in-flight setupLocalStick).
    const { buildLocalWorkflowSnapshot } = require('./localWorkflowStatus');
    const snap = buildLocalWorkflowSnapshot(adapter, { selectedSn, shine, frameStatus });
    if (obj.callback) {
        adapter.sendTo(obj.from, obj.command, snap, obj.callback);
    }
}

/** @internal test helper */
function _clearStatusCaches() {
    clearStatusCaches();
}

module.exports = {
    handleShineStatus,
    handleStickStatusText,
    handleStickSetupState,
    handleLocalWorkflowSnapshot,
    clearStatusCaches,
    seedShineStatus,
    _clearStatusCaches,
};
