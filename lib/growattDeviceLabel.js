'use strict';

/** Known OpenAPI slug buckets — never use alone as UI product name. */
const API_SLUGS = new Set([
    'min',
    'tlx',
    'max',
    'sph',
    'spa',
    'inv',
    'storage',
    'wit',
    'noah',
    'sph-s',
    'mix',
]);

/**
 * Keys that may hold a marketing product name (not firmware / internal codes).
 * No hardcoding of specific inverter models — only field names Growatt may send.
 */
const LABEL_KEYS = [
    'productName',
    'product_name',
    'productModel',
    'product_model',
    'nominalModel',
    'nominal_model',
    'deviceTypeName',
    'device_type_name',
    'modelName',
    'model_name',
    'type_text',
    'typeText',
    'typeName',
    'type_name',
    'invType',
    'inv_type',
    'model',
    'device_model',
    'deviceModel',
];

const SKIP_KEYS =
    /^(alias|name|deviceName|device_name|datalogger|dataLog|wifi|ssid|ip|mac|fw|firmware|version|machine|machineVersion|machine_version|status|lost|error|token|url|plant|time|update|sn|serial|id|type|deviceType|device_type)$/i;

/**
 * Reject stick/collector aliases, firmware revisions, SN-bearing junk.
 * @param {string} s
 * @param {{deviceSn?:string,stickSn?:string}} [ctx]
 * @returns {boolean}
 */
function isJunkLabel(s, ctx) {
    const t = String(s || '').trim();
    if (!t) {
        return true;
    }
    if (/shinepano|shine\s*pano|datalogger|collector|wifi\s*stick/i.test(t)) {
        return true;
    }
    // Firmware / HW revision style: GH1.0, V1.2.3, 1.0.0
    if (/^(GH|FW|HW|SW|V)?\d+(\.\d+){1,3}[A-Z]?$/i.test(t)) {
        return true;
    }
    // "Alias - SN" / "Something - XGDxxxx"
    if (/\s[-–—]\s*[A-Z0-9]{6,}$/i.test(t)) {
        return true;
    }
    const deviceSn = String((ctx && ctx.deviceSn) || '').trim();
    const stickSn = String((ctx && ctx.stickSn) || '').trim();
    if (deviceSn && t.toLowerCase().includes(deviceSn.toLowerCase())) {
        return true;
    }
    if (stickSn && t.toLowerCase().includes(stickSn.toLowerCase())) {
        return true;
    }
    if (/^XGD[A-Z0-9]+$/i.test(t)) {
        return true;
    }
    if (/^\d+$/.test(t)) {
        return true;
    }
    // Internal opaque model codes: S3EB08D00T00P0
    if (/^[A-Z]\d[A-Z0-9]{6,}$/i.test(t) && !/[-_\s]/.test(t)) {
        return true;
    }
    return false;
}

/**
 * True only for Growatt-style marketing names (works for any WR family in the API).
 * @param {string} s
 * @param {{deviceSn?:string,stickSn?:string}} [ctx]
 * @returns {boolean}
 */
function isLikelyProductName(s, ctx) {
    const t = String(s || '').trim();
    if (!t || t.length < 3) {
        return false;
    }
    if (API_SLUGS.has(t.toLowerCase())) {
        return false;
    }
    if (isJunkLabel(t, ctx)) {
        return false;
    }
    // Product families Growatt uses in OpenAPI / datasheets (generic, not one SN).
    if (/\b(MIC|MIN|MOD|MID|MAX|SPH|SPA|NEO|TL-?X|TLX|MAC|WIT|NOAH)\b/i.test(t)) {
        return true;
    }
    return false;
}

/**
 * @param {object} obj
 * @param {{deviceSn?:string,stickSn?:string}} [ctx]
 * @returns {string[]}
 */
function collectLabelCandidates(obj, ctx) {
    if (!obj || typeof obj !== 'object') {
        return [];
    }
    const out = [];
    const seen = new Set();
    const add = (v) => {
        const s = String(v == null ? '' : v).trim();
        if (!s || seen.has(s) || isJunkLabel(s, ctx)) {
            return;
        }
        seen.add(s);
        out.push(s);
    };
    for (const key of LABEL_KEYS) {
        if (obj[key] != null && obj[key] !== '') {
            add(obj[key]);
        }
    }
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string' && typeof v !== 'number') {
            continue;
        }
        if (SKIP_KEYS.test(k) || /sn|serial|id|time|status|lost|error|token|url|alias|datalog|version|machine/i.test(k)) {
            continue;
        }
        add(v);
    }
    return out;
}

/**
 * Only a clear product name — otherwise empty (UI shows "—").
 * No fallback to firmware / internal codes.
 * @param {string[]} candidates
 * @param {{deviceSn?:string,stickSn?:string}} [ctx]
 * @returns {string}
 */
function pickDeviceTypeLabel(candidates, ctx) {
    const list = (candidates || []).map((c) => String(c || '').trim()).filter(Boolean);
    const product = list.find((c) => isLikelyProductName(c, ctx));
    return product || '';
}

/**
 * @param {object} deviceOrInfo
 * @param {{deviceSn?:string,stickSn?:string}} [ctx]
 * @returns {string}
 */
function labelFromDevicePayload(deviceOrInfo, ctx) {
    const merged = {
        deviceSn: (ctx && ctx.deviceSn) || (deviceOrInfo && (deviceOrInfo.deviceSn || deviceOrInfo.device_sn)) || '',
        stickSn:
            (ctx && ctx.stickSn) ||
            (deviceOrInfo && (deviceOrInfo.stickSn || deviceOrInfo.datalogger_sn || deviceOrInfo.datalogSn)) ||
            '',
    };
    return pickDeviceTypeLabel(collectLabelCandidates(deviceOrInfo, merged), merged);
}

/**
 * Owner-defined Shine alias — empty when equal to SN or junk.
 * @param {unknown} alias
 * @param {{deviceSn?:string,stickSn?:string}} [ctx]
 * @returns {string}
 */
function aliasLabel(alias, ctx) {
    const t = String(alias == null ? '' : alias).trim();
    if (!t) {
        return '';
    }
    const deviceSn = String((ctx && ctx.deviceSn) || '').trim();
    if (deviceSn && t.toLowerCase() === deviceSn.toLowerCase()) {
        return '';
    }
    if (isJunkLabel(t, ctx)) {
        return '';
    }
    return t;
}

module.exports = {
    API_SLUGS,
    LABEL_KEYS,
    isJunkLabel,
    isLikelyProductName,
    collectLabelCandidates,
    pickDeviceTypeLabel,
    labelFromDevicePayload,
    aliasLabel,
};
