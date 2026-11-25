'use strict';

/**
 * Growatt Device Type Code (DTC) → short series label for UI.
 * Source: Growatt VPP Communication Protocol Table 3-1 (V2.01–V2.05)
 * plus common legacy codes (holding register 43).
 * Keep labels short — rated power belongs in the pmax column.
 */
const DTC_SERIES = {
    // Legacy (reg 43)
    210: 'MIC MTL-S',
    2049: 'TL3-S',
    // SPF off-grid
    3400: 'SPF ES Plus',
    20105: 'SPF 5000 ES',
    // SPH / SPA / SPM
    3501: 'SPH TL BL',
    3502: 'SPH TL BL-UP',
    3503: 'SPH TL HU',
    3504: 'SPH TL HUB',
    3601: 'SPH TL3 BH-UP',
    3701: 'SPA TL BL',
    3715: 'SPA TL AU',
    3716: 'SPA TL AUB',
    3725: 'SPA TL3 BH-UP',
    3735: 'SPA TL BL-UP',
    21100: 'SPH/SPM TL-HU',
    21303: 'SPH/SPM TL-HU',
    21304: 'SPM TL-HU',
    21305: 'SPM TL-HU',
    21308: 'SPM TL-HU',
    21309: 'SPM TL-HU',
    // MID / MOD / MAC / MAX
    5000: 'MAX TL3',
    5001: 'MID TL3-X',
    5002: 'MOD TL3-X',
    5003: 'MAC TL3-X',
    5500: 'MAX TL3-X HV',
    5501: 'MAX TL3-X',
    5502: 'MAX TL3-X',
    // MIN / MIC
    5100: 'MIN TL-XH',
    5200: 'MIC/MIN TL-X',
    5201: 'MIN TL-X',
    // MOD / MID hybrid
    5400: 'MOD/MID TL3-XH',
    5401: 'MOD/MID TL3-HU',
    // WIT / WIS
    5600: 'WIT/WIS',
    5601: 'WIT XHU',
    5603: 'WIT HU',
    5604: 'WIS 125K-AM',
    5605: 'WIT XHU',
    5800: 'WIS 210K',
    5801: 'WIS AMA',
};

/**
 * @param {number|string|null|undefined} dtc
 * @returns {string} series label or ''
 */
function seriesFromDtc(dtc) {
    if (dtc == null || dtc === '') {
        return '';
    }
    const n = Number(dtc);
    if (!Number.isFinite(n) || n <= 0) {
        return '';
    }
    return DTC_SERIES[n] || '';
}

/**
 * Configured max power for the devices table.
 * @param {number|string|null|undefined} pmaxW
 * @returns {string} e.g. "1000 W", "15 kW", or "—"
 */
function formatPmaxLabel(pmaxW) {
    const n = Number(pmaxW);
    if (!Number.isFinite(n) || n <= 0) {
        return '—';
    }
    if (n >= 10000) {
        return `${Math.round(n / 1000)} kW`;
    }
    return `${Math.round(n)} W`;
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function parsePmaxW(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return null;
    }
    return n;
}

module.exports = {
    DTC_SERIES,
    seriesFromDtc,
    formatPmaxLabel,
    parsePmaxW,
};
