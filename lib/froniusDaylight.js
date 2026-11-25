'use strict';

const http = require('http');
const { URL } = require('url');

const CACHE_FRESH_MS = 90_000;
const CACHE_STALE_OK_MS = 180_000;

/**
 * @param {string|URL} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{status:number, body:any}>}
 */
function httpGetJson(url, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const req = http.request(
            u,
            {
                method: 'GET',
                timeout: timeoutMs,
                headers: { Accept: 'application/json', Connection: 'close' },
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve({ status: res.statusCode || 0, body: JSON.parse(text) });
                    } catch {
                        reject(new Error('non-JSON'));
                    }
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.end();
    });
}

/**
 * @param {unknown} n
 * @returns {number}
 */
function toNum(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
}

/**
 * @param {object} body
 * @returns {number}
 */
function extractPvW(body) {
    const data = body && body.Body && body.Body.Data;
    if (!data || typeof data !== 'object') {
        return 0;
    }
    const site = data.Site;
    if (site && typeof site === 'object' && (site.P_PV != null || site.P_PV === 0)) {
        return Math.max(0, toNum(site.P_PV));
    }
    const inv = data.Inverters;
    if (inv && typeof inv === 'object') {
        let sum = 0;
        let any = false;
        for (const row of Object.values(inv)) {
            if (!row || typeof row !== 'object') {
                continue;
            }
            if (row.P != null || row.PAC != null) {
                sum += Math.max(0, toNum(row.P != null ? row.P : row.PAC));
                any = true;
            }
        }
        if (any) {
            return sum;
        }
    }
    return 0;
}

/**
 * Best-effort rated power (W) from inverter info payloads.
 * @param {object} body
 * @returns {number}
 */
function extractRatedW(body) {
    const data = body && body.Body && body.Body.Data;
    if (!data || typeof data !== 'object') {
        return 0;
    }
    let sum = 0;
    let any = false;
    for (const row of Object.values(data)) {
        if (!row || typeof row !== 'object') {
            continue;
        }
        for (const key of ['PVPower', 'P_max', 'PMAX', 'NominalPower', 'Capacity']) {
            const n = toNum(row[key]);
            if (n <= 0) {
                continue;
            }
            // Values below 500 are treated as kW.
            sum += n < 500 ? n * 1000 : n;
            any = true;
            break;
        }
    }
    return any ? sum : 0;
}

/**
 * @param {string} ip
 * @param {{ratedW?:number}} [opts]
 * @returns {Promise<{pvW:number, ratedW:number, at:number}>}
 */
async function probeFroniusPv(ip, opts = {}) {
    const host = String(ip || '').trim();
    if (!host) {
        throw new Error('froniusIp missing');
    }
    const base = `http://${host}`;
    const flow = await httpGetJson(`${base}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`);
    const pvW = extractPvW(flow.body);
    let ratedW = toNum(opts.ratedW);
    if (!(ratedW > 0)) {
        try {
            const info = await httpGetJson(`${base}/solar_api/v1/GetInverterInfo.cgi`);
            ratedW = extractRatedW(info.body);
        } catch {
            ratedW = 0;
        }
    }
    return { pvW, ratedW, at: Date.now() };
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<object|null>}
 */
async function refreshFroniusDaylight(adapter) {
    const ip = String((adapter.config && adapter.config.froniusIp) || '').trim();
    if (!ip) {
        return null;
    }
    const now = Date.now();
    const cached = adapter._froniusDaylight;
    if (cached && cached.at && now - cached.at < CACHE_FRESH_MS) {
        return cached;
    }
    try {
        const ratedCfg = toNum(adapter.config && adapter.config.froniusRatedW);
        const probe = await probeFroniusPv(ip, { ratedW: ratedCfg > 0 ? ratedCfg : undefined });
        const ratedW = probe.ratedW > 0 ? probe.ratedW : ratedCfg > 0 ? ratedCfg : 0;
        const util = ratedW > 0 ? Math.min(1, Math.max(0, probe.pvW / ratedW)) : 0;
        adapter._froniusDaylight = {
            pvW: probe.pvW,
            ratedW,
            at: probe.at,
            util,
            expectedGrowattW: 0,
        };
        if (typeof adapter.setStateChangedAsync === 'function') {
            await adapter.setStateChangedAsync('info.froniusPvW', {
                val: Math.round(probe.pvW * 10) / 10,
                ack: true,
            });
            await adapter.setStateChangedAsync('info.froniusUtil', {
                val: Math.round(util * 1000) / 1000,
                ack: true,
            });
        }
        return adapter._froniusDaylight;
    } catch (err) {
        if (adapter.log && adapter.log.debug) {
            adapter.log.debug(`Fronius daylight probe: ${err.message}`);
        }
        if (cached && cached.at && now - cached.at < CACHE_STALE_OK_MS) {
            return cached;
        }
        return null;
    }
}

/**
 * @param {object|null|undefined} fr
 * @returns {boolean}
 */
function isFroniusCacheFresh(fr) {
    return !!(fr && fr.at && Date.now() - fr.at < CACHE_STALE_OK_MS && Number(fr.ratedW) > 0);
}

module.exports = {
    CACHE_FRESH_MS,
    CACHE_STALE_OK_MS,
    httpGetJson,
    extractPvW,
    extractRatedW,
    probeFroniusPv,
    refreshFroniusDaylight,
    isFroniusCacheFresh,
};
