'use strict';

/**
 * Per-stick redirect registry.
 * native.stickRedirects = { [sn]: { state, plantId?, plantName?, serverIp?, since } }
 * Aggregate legacy flags (localSetupVerified / Pending / cloudStickRedirect*) are derived
 * so older readers keep working.
 */

const VALID_STATES = new Set(['pending', 'verified', 'redirected']);

/**
 * @param {object} [cfg]
 * @returns {Record<string, object>}
 */
function getRegistry(cfg) {
    const raw = cfg && cfg.stickRedirects;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    return raw;
}

/**
 * @param {object} [cfg]
 * @param {string} sn
 * @returns {object|null}
 */
function getStickEntry(cfg, sn) {
    const key = String(sn || '').trim();
    if (!key) {
        return null;
    }
    const entry = getRegistry(cfg)[key];
    return entry && typeof entry === 'object' ? entry : null;
}

/**
 * @param {object} cfg
 * @param {string} sn
 * @param {object} patch
 * @returns {object} the upserted entry
 */
function upsertStick(cfg, sn, patch) {
    if (!cfg || typeof cfg !== 'object') {
        throw new Error('upsertStick: cfg required');
    }
    const key = String(sn || '').trim();
    if (!key) {
        throw new Error('upsertStick: sn required');
    }
    if (!cfg.stickRedirects || typeof cfg.stickRedirects !== 'object' || Array.isArray(cfg.stickRedirects)) {
        cfg.stickRedirects = {};
    }
    const prev = cfg.stickRedirects[key] && typeof cfg.stickRedirects[key] === 'object' ? cfg.stickRedirects[key] : {};
    const next = { ...prev, ...(patch || {}) };
    if (!VALID_STATES.has(next.state)) {
        next.state = prev.state || 'redirected';
    }
    if (!next.since) {
        next.since = Date.now();
    }
    cfg.stickRedirects[key] = next;
    applyAggregateFlags(cfg);
    return next;
}

/**
 * @param {object} cfg
 * @param {string} sn
 * @returns {boolean} true when an entry was removed
 */
function removeStick(cfg, sn) {
    if (!cfg || typeof cfg !== 'object') {
        return false;
    }
    const key = String(sn || '').trim();
    if (!key || !cfg.stickRedirects || typeof cfg.stickRedirects !== 'object') {
        applyAggregateFlags(cfg);
        return false;
    }
    if (!(key in cfg.stickRedirects)) {
        applyAggregateFlags(cfg);
        return false;
    }
    delete cfg.stickRedirects[key];
    applyAggregateFlags(cfg);
    return true;
}

/**
 * @param {object} [cfg]
 * @returns {string[]}
 */
function listRedirectedSns(cfg) {
    return Object.keys(getRegistry(cfg)).filter(Boolean).sort();
}

/**
 * @param {object} [cfg]
 * @param {string} [state]
 * @returns {string[]}
 */
function listSnsByState(cfg, state) {
    const want = String(state || '').trim();
    const out = [];
    for (const [sn, entry] of Object.entries(getRegistry(cfg))) {
        if (entry && entry.state === want) {
            out.push(sn);
        }
    }
    return out.sort();
}

/**
 * Derive legacy instance flags from the registry.
 * @param {object} [cfg]
 * @returns {{localSetupVerified:boolean,localSetupPending:boolean,cloudStickRedirectActive:boolean,cloudStickRedirectSn:string}}
 */
function deriveAggregateFlags(cfg) {
    const reg = getRegistry(cfg);
    const sns = Object.keys(reg).filter(Boolean).sort();
    let verified = false;
    let pending = false;
    for (const sn of sns) {
        const st = reg[sn] && reg[sn].state;
        if (st === 'verified') {
            verified = true;
        } else if (st === 'pending') {
            pending = true;
        }
    }
    return {
        localSetupVerified: verified,
        localSetupPending: pending,
        cloudStickRedirectActive: sns.length > 0,
        cloudStickRedirectSn: sns[0] || '',
    };
}

/**
 * Write aggregate flags onto cfg (in-memory).
 * @param {object} cfg
 */
function applyAggregateFlags(cfg) {
    if (!cfg || typeof cfg !== 'object') {
        return;
    }
    const flags = deriveAggregateFlags(cfg);
    cfg.localSetupVerified = flags.localSetupVerified;
    cfg.localSetupPending = flags.localSetupPending;
    cfg.cloudStickRedirectActive = flags.cloudStickRedirectActive;
    cfg.cloudStickRedirectSn = flags.cloudStickRedirectSn;
}

/**
 * True when legacy global flags imply a redirect but registry is empty.
 * @param {object} [cfg]
 * @returns {boolean}
 */
function needsLegacyMigration(cfg) {
    const c = cfg || {};
    const reg = getRegistry(c);
    if (Object.keys(reg).length > 0) {
        return false;
    }
    return !!(c.localSetupVerified || c.localSetupPending || c.cloudStickRedirectActive);
}

/**
 * Seed registry from legacy single-stick flags. Mutates cfg.
 * @param {object} cfg
 * @returns {boolean} true when migration changed cfg
 */
function migrateLegacyFlags(cfg) {
    if (!cfg || typeof cfg !== 'object') {
        return false;
    }
    if (!needsLegacyMigration(cfg)) {
        // Still re-sync aggregates when registry already exists
        if (Object.keys(getRegistry(cfg)).length > 0) {
            const before = JSON.stringify({
                v: !!cfg.localSetupVerified,
                p: !!cfg.localSetupPending,
                a: !!cfg.cloudStickRedirectActive,
                sn: String(cfg.cloudStickRedirectSn || ''),
            });
            applyAggregateFlags(cfg);
            const after = JSON.stringify({
                v: !!cfg.localSetupVerified,
                p: !!cfg.localSetupPending,
                a: !!cfg.cloudStickRedirectActive,
                sn: String(cfg.cloudStickRedirectSn || ''),
            });
            return before !== after;
        }
        return false;
    }
    const sn = String(cfg.localStickSn || cfg.cloudStickRedirectSn || '').trim();
    if (!sn) {
        // Cannot seed registry without SN — keep legacy flags as-is
        return false;
    }
    let state = 'redirected';
    if (cfg.localSetupVerified) {
        state = 'verified';
    } else if (cfg.localSetupPending) {
        state = 'pending';
    }
    if (!cfg.stickRedirects || typeof cfg.stickRedirects !== 'object' || Array.isArray(cfg.stickRedirects)) {
        cfg.stickRedirects = {};
    }
    cfg.stickRedirects[sn] = {
        state,
        plantId: String(cfg.localPlantId || '').trim() || undefined,
        serverIp: String(cfg.advertisedModbusIp || '').trim() || undefined,
        since: Date.now(),
    };
    applyAggregateFlags(cfg);
    return true;
}

/**
 * Persist registry + derived aggregate flags via persistNative.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} reason
 * @returns {Promise<{wrote:boolean, keys:string[]}>}
 */
async function persistRegistry(adapter, reason) {
    const cfg = adapter.config || {};
    applyAggregateFlags(cfg);
    const { persistNative } = require('./persistNative');
    const result = await persistNative(
        adapter,
        {
            stickRedirects: cloneRegistry(cfg.stickRedirects),
            localSetupVerified: !!cfg.localSetupVerified,
            localSetupPending: !!cfg.localSetupPending,
            cloudStickRedirectActive: !!cfg.cloudStickRedirectActive,
            cloudStickRedirectSn: String(cfg.cloudStickRedirectSn || ''),
        },
        reason || 'persistRegistry',
    );
    return result;
}

/**
 * @param {object} [reg]
 * @returns {Record<string, object>}
 */
function cloneRegistry(reg) {
    try {
        return JSON.parse(JSON.stringify(reg && typeof reg === 'object' ? reg : {}));
    } catch {
        return {};
    }
}

/**
 * Label for UI / workflow from a single registry entry (or null).
 * @param {object|null} entry
 * @param {{_liveTarget?:string}} [extra]
 * @returns {string}
 */
function configuredLabelFromEntry(entry, extra) {
    if (entry && entry.state === 'verified') {
        return 'konfiguriert';
    }
    if (entry && entry.state === 'pending') {
        return 'umgeleitet – warte auf Stick';
    }
    if (entry && entry.state === 'redirected') {
        return 'umgeleitet auf diesen Host';
    }
    if (extra && extra._liveTarget === 'hier') {
        return 'umgeleitet auf diesen Host';
    }
    return 'nicht konfiguriert';
}

module.exports = {
    VALID_STATES,
    getRegistry,
    getStickEntry,
    upsertStick,
    removeStick,
    listRedirectedSns,
    listSnsByState,
    deriveAggregateFlags,
    applyAggregateFlags,
    needsLegacyMigration,
    migrateLegacyFlags,
    persistRegistry,
    cloneRegistry,
    configuredLabelFromEntry,
};
