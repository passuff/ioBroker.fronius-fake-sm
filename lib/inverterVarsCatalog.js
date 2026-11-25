'use strict';

const { READ_VARS, ALL_PV, ALL_HYBRID, ALL } = require('./inverterVarsReadCatalog');
const { WRITE_SETTINGS } = require('./inverterVarsWriteCatalog');

function normalizeFamily(deviceType) {
    const t = String(deviceType || 'min').toLowerCase().trim();
    if (t === 'tlxh' || t === 'tl-xh') {
        return 'tlx';
    }
    if (t === 'sph-s') {
        return 'sph';
    }
    if (t === 'mid') {
        return 'mod';
    }
    if (t === 'shine') {
        return 'tlx';
    }
    return t;
}

/**
 * @param {string} family
 * @param {object} entry
 */
function familyMatches(family, entry) {
    const f = normalizeFamily(family);
    return Array.isArray(entry.families) && entry.families.includes(f);
}

/**
 * @param {string} [family]
 * @returns {object[]}
 */
function listCatalog(family) {
    const all = [...READ_VARS, ...WRITE_SETTINGS];
    if (!family) {
        return all;
    }
    return all.filter((e) => familyMatches(family, e));
}

/**
 * @param {object} e catalog entry
 * @param {'en'|'de'} [lang]
 */
function kindLabelFor(e, lang = 'en') {
    if (e.kind === 'write') {
        return lang === 'de' ? 'Schreiben' : 'Write';
    }
    return lang === 'de' ? 'Lesen' : 'Read';
}

/**
 * Build default native inverterVars rows (all catalog entries).
 * @param {{families?: string[]|null, lang?: string}} [opts]
 * @returns {Array<object>}
 */
function defaultInverterVarsConfig(opts = {}) {
    return mergeInverterVarsConfig([], opts);
}

/**
 * Merge user config with catalog (preserve enabled/interval; drop unknown ids).
 * When opts.families is a non-empty array, only entries matching any of those families.
 * @param {Array<object>|null|undefined} rows
 * @param {{families?: string[]|null, lang?: string}} [opts]
 * @returns {Array<object>}
 */
function mergeInverterVarsConfig(rows, opts = {}) {
    const byId = new Map();
    if (Array.isArray(rows)) {
        for (const r of rows) {
            if (r && r.id) {
                byId.set(String(r.id), r);
            }
        }
    }
    const lang = opts.lang === 'de' ? 'de' : 'en';
    const familyFilter = Array.isArray(opts.families) && opts.families.length ? opts.families.map(normalizeFamily) : null;
    return listCatalog()
        .filter((e) => {
            if (!familyFilter) {
                return true;
            }
            return familyFilter.some((f) => familyMatches(f, e));
        })
        .map((e) => {
            const prev = byId.get(e.id) || {};
            return {
                id: e.id,
                enabled: prev.enabled != null ? !!prev.enabled : !!e.defaultEnabled,
                intervalS: Math.max(5, Number(prev.intervalS ?? e.defaultIntervalS) || 120),
                kind: e.kind,
                kindLabel: kindLabelFor(e, lang),
                label: typeof e.label === 'object' ? e.label.en || e.id : String(e.label || e.id),
                families: (e.families || []).join(','),
            };
        });
}

/**
 * @param {string} id
 * @returns {object|null}
 */
function getCatalogEntry(id) {
    return listCatalog().find((e) => e.id === id) || null;
}

/**
 * Pick first matching cloud key from raw row.
 * @param {object} raw
 * @param {string[]} keys
 * @returns {number|string|null}
 */
function pickCloudValue(raw, keys) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(keys)) {
        return null;
    }
    for (const k of keys) {
        if (k in raw && raw[k] != null && raw[k] !== '') {
            return raw[k];
        }
    }
    return null;
}

/**
 * Resolve API type string for a write setting + family.
 * @param {object} entry
 * @param {string} family
 */
function resolveApiType(entry, family) {
    const f = normalizeFamily(family);
    const map = entry.apiType || {};
    return map[f] || map.default || null;
}

/**
 * @param {object} entry
 * @param {string} family
 */
function resolveApiAction(entry, family) {
    const f = normalizeFamily(family);
    const map = entry.apiAction || {};
    return map[f] || map.default || 'tlxSet';
}

/**
 * Effective sample interval: max(user, transport floor).
 * Local: catalog localIntervalS is the default ceiling so cloud-oriented intervalS (e.g. 120)
 * does not slow stick writes. Power-group only may go faster down to 1s; energy/status stay at catalog.
 * @param {object} entry catalog entry
 * @param {number} userIntervalS
 * @param {'openapi'|'shine'|'local'} transport
 */
function effectiveIntervalS(entry, userIntervalS, transport) {
    const user = Math.max(5, Number(userIntervalS) || Number(entry.defaultIntervalS) || 120);
    if (transport === 'local') {
        const catalogLocal = Math.max(1, Number(entry.localIntervalS) || 5);
        const raw = Number(userIntervalS);
        const chosen = Number.isFinite(raw) && raw > 0 ? raw : catalogLocal;
        // Cap at catalog local default; only power vars may go below catalog down to 1s.
        const minAllowed = entry && entry.group === 'power' ? 1 : catalogLocal;
        return Math.max(minAllowed, Math.min(chosen, catalogLocal));
    }
    if (transport === 'shine') {
        return Math.max(30, user);
    }
    return Math.max(90, user);
}

module.exports = {
    READ_VARS,
    WRITE_SETTINGS,
    ALL_PV,
    ALL_HYBRID,
    ALL,
    normalizeFamily,
    familyMatches,
    listCatalog,
    defaultInverterVarsConfig,
    mergeInverterVarsConfig,
    kindLabelFor,
    getCatalogEntry,
    pickCloudValue,
    resolveApiType,
    resolveApiAction,
    effectiveIntervalS,
};
