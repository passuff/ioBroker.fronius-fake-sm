'use strict';

/** @typedef {'openapi'|'shine'|'local'|'custom'} PollingTemplateId */

const POLLING_FIELDS = ['pollIntervalS', 'nightPollIntervalS', 'smoothIntervalS'];

/** @type {Record<Exclude<PollingTemplateId, 'custom'>, { pollIntervalS: number, nightPollIntervalS: number, smoothIntervalS: number }>} */
const TEMPLATES = {
    openapi: { pollIntervalS: 120, nightPollIntervalS: 300, smoothIntervalS: 5 },
    shine: { pollIntervalS: 60, nightPollIntervalS: 300, smoothIntervalS: 5 },
    local: { pollIntervalS: 300, nightPollIntervalS: 600, smoothIntervalS: 1 },
};

/**
 * @param {unknown} id
 * @returns {PollingTemplateId|null}
 */
function normalizeTemplateId(id) {
    const s = String(id || '').toLowerCase();
    if (s === 'openapi' || s === 'shine' || s === 'local' || s === 'custom') {
        return s;
    }
    return null;
}

/**
 * Default preset from data path / cloud auth.
 * @param {unknown} feedMode
 * @param {unknown} cloudAuth
 * @returns {Exclude<PollingTemplateId, 'custom'>}
 */
function resolvePollingTemplate(feedMode, cloudAuth) {
    if (String(feedMode || 'cloud') === 'local') {
        return 'local';
    }
    if (String(cloudAuth || 'openapi') === 'shine') {
        return 'shine';
    }
    return 'openapi';
}

/**
 * @param {PollingTemplateId|string} templateId
 * @returns {{ pollIntervalS: number, nightPollIntervalS: number, smoothIntervalS: number }|null}
 */
function getPollingTemplate(templateId) {
    const id = normalizeTemplateId(templateId);
    if (!id || id === 'custom') {
        return null;
    }
    return { ...TEMPLATES[id] };
}

/**
 * @param {object} config
 * @param {string} templateId
 * @returns {boolean}
 */
function matchesPollingTemplate(config, templateId) {
    const tpl = getPollingTemplate(templateId);
    if (!tpl || !config) {
        return false;
    }
    return POLLING_FIELDS.every((k) => Number(config[k]) === Number(tpl[k]));
}

/**
 * @param {object} config
 * @returns {PollingTemplateId}
 */
function detectPollingTemplate(config) {
    if (normalizeTemplateId(config && config.pollingTemplate) === 'custom') {
        return 'custom';
    }
    for (const id of /** @type {const} */ (['openapi', 'shine', 'local'])) {
        if (matchesPollingTemplate(config, id)) {
            return id;
        }
    }
    return 'custom';
}

/**
 * Interval for one inverter var row under a stock template.
 * @param {object} entry catalog entry
 * @param {Exclude<PollingTemplateId, 'custom'>} templateId
 * @returns {number}
 */
function intervalSForTemplate(entry, templateId) {
    if (templateId === 'local') {
        return Math.max(1, Number(entry && entry.localIntervalS) || 5);
    }
    if (templateId === 'shine') {
        return Math.max(30, Number(entry && entry.defaultIntervalS) || 120);
    }
    return Math.max(5, Number(entry && entry.defaultIntervalS) || 120);
}

/**
 * Apply template sample rates onto inverterVars rows (immutable).
 * @param {Array<object>|null|undefined} rows
 * @param {string} templateId
 * @returns {Array<object>|undefined}
 */
function applyInverterVarsIntervals(rows, templateId) {
    const id = normalizeTemplateId(templateId);
    if (!id || id === 'custom' || !Array.isArray(rows)) {
        return rows;
    }
    const { getCatalogEntry } = require('./inverterVarsCatalog');
    return rows.map((row) => {
        if (!row || !row.id) {
            return row;
        }
        const entry = getCatalogEntry(row.id);
        if (!entry) {
            return { ...row };
        }
        return { ...row, intervalS: intervalSForTemplate(entry, id) };
    });
}

/**
 * Immutable merge of template intervals (+ inverterVars rates) into config.
 * @param {object} config
 * @param {string} templateId
 * @returns {object}
 */
function applyPollingTemplate(config, templateId) {
    const base = config && typeof config === 'object' ? { ...config } : {};
    const id = normalizeTemplateId(templateId);
    if (!id || id === 'custom') {
        return { ...base, pollingTemplate: 'custom' };
    }
    const tpl = TEMPLATES[id];
    const next = {
        ...base,
        pollingTemplate: id,
        pollIntervalS: tpl.pollIntervalS,
        nightPollIntervalS: tpl.nightPollIntervalS,
        smoothIntervalS: tpl.smoothIntervalS,
    };
    if (Array.isArray(base.inverterVars)) {
        next.inverterVars = applyInverterVarsIntervals(base.inverterVars, id);
    }
    return next;
}

/**
 * Reconcile template id + intervals (adapter ready / migration).
 * Stock presets follow feed mode; dirty numbers become `custom` (never overwritten).
 * @param {object} config
 * @returns {object} new config (may be shallow-equal in values)
 */
function reconcilePollingConfig(config) {
    const out = config && typeof config === 'object' ? { ...config } : {};
    const suggested = resolvePollingTemplate(out.growattFeedMode, out.growattCloudAuth);
    const id = normalizeTemplateId(out.pollingTemplate);

    if (id === 'custom') {
        return out;
    }

    if (!id) {
        const detected = detectPollingTemplate(out);
        if (detected !== 'custom') {
            if (detected !== suggested) {
                return applyPollingTemplate(out, suggested);
            }
            out.pollingTemplate = detected;
            return out;
        }
        return applyPollingTemplate(out, suggested);
    }

    if (matchesPollingTemplate(out, id)) {
        if (id !== suggested) {
            return applyPollingTemplate(out, suggested);
        }
        out.pollingTemplate = id;
        return out;
    }

    // Declared preset but numbers differ → keep numbers, mark custom
    out.pollingTemplate = 'custom';
    return out;
}

/**
 * Patch of keys that differ after reconcile (for persistNative).
 * Includes inverterVars when a stock template apply rewrote sample rates.
 * @param {object} config
 * @returns {object}
 */
function pollingReconcilePatch(config) {
    const next = reconcilePollingConfig(config);
    /** @type {Record<string, unknown>} */
    const patch = {};
    const keys = ['pollingTemplate', ...POLLING_FIELDS];
    for (const k of keys) {
        if (next[k] !== (config && config[k])) {
            if (POLLING_FIELDS.includes(k) && Number(next[k]) === Number(config && config[k])) {
                continue;
            }
            patch[k] = next[k];
        }
    }
    try {
        if (JSON.stringify(next.inverterVars) !== JSON.stringify(config && config.inverterVars)) {
            patch.inverterVars = next.inverterVars;
        }
    } catch {
        if (next.inverterVars !== (config && config.inverterVars)) {
            patch.inverterVars = next.inverterVars;
        }
    }
    return patch;
}

module.exports = {
    POLLING_FIELDS,
    TEMPLATES,
    normalizeTemplateId,
    resolvePollingTemplate,
    getPollingTemplate,
    matchesPollingTemplate,
    detectPollingTemplate,
    intervalSForTemplate,
    applyInverterVarsIntervals,
    applyPollingTemplate,
    reconcilePollingConfig,
    pollingReconcilePatch,
};
