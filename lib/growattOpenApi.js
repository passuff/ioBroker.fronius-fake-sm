'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const {
    isLikelyProductName,
    isJunkLabel,
    labelFromDevicePayload,
    pickDeviceTypeLabel,
    collectLabelCandidates,
    aliasLabel,
} = require('./growattDeviceLabel');
const { seriesFromDtc, formatPmaxLabel, parsePmaxW } = require('./growattDtc');

const ALLOWED_SLUGS = new Set([
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
]);

/** Growatt numeric device type → OpenAPI slug (best-effort). */
const TYPE_CODE_MAP = {
    1: 'inv',
    2: 'storage',
    3: 'max',
    4: 'mix',
    5: 'spa',
    6: 'min',
    7: 'min',
    8: 'sph',
    9: 'spa',
    10: 'wit',
};

class GrowattRateLimitError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'GrowattRateLimitError';
        this.code = 'GROWATT_RATE_LIMIT';
    }
}

function isGrowattRateLimitError(err) {
    if (!err) {
        return false;
    }
    if (err instanceof GrowattRateLimitError || err.code === 'GROWATT_RATE_LIMIT') {
        return true;
    }
    return /HTTP 429|FREQUENTLY_ACCESS|rate.?limit/i.test(String(err.message || err));
}

/**
 * Minimal Growatt OpenAPI client (token header, no password login).
 */
class GrowattOpenApiClient {
    /**
     * @param {object} opts
     */
    constructor(opts) {
        this.token = String(opts.token || '');
        this.deviceSn = String(opts.deviceSn || '');
        this.deviceType = String(opts.deviceType || 'min');
        this.plantId = opts.plantId ? String(opts.plantId) : '';
        this.baseUrl = opts.baseUrl || 'https://openapi.growatt.com/';
        if (!this.baseUrl.endsWith('/')) {
            this.baseUrl += '/';
        }
        this.powerFields = opts.powerFields || [
            'ppv',
            'pac',
            'outPower',
            'powerOfPhotovoltaic',
            'chargePower',
        ];
        this.powerSign = Number(opts.powerSign ?? -1);
        this.powerKwThreshold = Number(opts.powerKwThreshold ?? 0);
        this.log = opts.log || (() => {});
    }

    /**
     * List all plants + devices for the account token.
     * @returns {Promise<Array<object>>}
     */
    async discoverAccountDevices() {
        if (!this.token) {
            throw new Error('GROWATT token missing');
        }
        const plants = await this._listPlants();
        const rows = [];
        let skipDeviceInfo = false;
        for (const plant of plants) {
            const plantId = String(plant.plant_id ?? plant.plantId ?? '');
            const plantName = String(plant.name ?? plant.plantName ?? plantId);
            if (!plantId) {
                continue;
            }
            let devices = [];
            try {
                devices = await this._listDevices(plantId);
            } catch (err) {
                this.log(`device list plant ${plantId} failed: ${err.message}`);
                continue;
            }
            for (const d of devices) {
                const deviceSn = String(d.device_sn || d.deviceSn || d.sn || d.serialNum || '');
                if (!deviceSn) {
                    continue;
                }
                const deviceType = mapDeviceType(d);
                const stickSnHint = String(d.datalogger_sn || d.datalogSn || d.stickSn || '');
                const labelCtx = { deviceSn, stickSn: stickSnHint };
                const model = String(d.model || d.device_model || d.type_text || '');
                let deviceTypeLabel = labelFromDevicePayload(d, labelCtx);
                let dtc = null;
                let deviceAlias = '';
                let pmaxW = null;
                let infoFetched = false;

                if (!skipDeviceInfo) {
                    try {
                        const info = await this._queryDeviceInfo(deviceSn, deviceType);
                        infoFetched = true;
                        const fromInfo = labelFromDevicePayload(info, labelCtx);
                        if (isLikelyProductName(fromInfo, labelCtx)) {
                            deviceTypeLabel = fromInfo;
                        }
                        const dtcRaw = info.dtc != null ? Number(info.dtc) : NaN;
                        if (Number.isFinite(dtcRaw) && dtcRaw > 0) {
                            dtc = dtcRaw;
                        }
                        if (!isLikelyProductName(deviceTypeLabel, labelCtx) && dtc != null) {
                            const series = seriesFromDtc(dtc);
                            if (series) {
                                deviceTypeLabel = series;
                            }
                        }
                        deviceAlias = aliasLabel(info.alias || info.treeName, labelCtx);
                        pmaxW = parsePmaxW(info.pmax);
                        if (pmaxW == null) {
                            try {
                                const tlx = await this._queryTlxDataInfo(deviceSn);
                                pmaxW = parsePmaxW(tlx && tlx.pmax);
                                await sleep(150);
                            } catch (tlxErr) {
                                this.log(`tlx_data_info ${deviceSn}: ${tlxErr.message}`);
                            }
                        }
                        await sleep(200);
                    } catch (err) {
                        this.log(`device info ${deviceSn}: ${err.message}`);
                        if (isGrowattRateLimitError(err)) {
                            skipDeviceInfo = true;
                        }
                    }
                }

                // Prefer marketing product name; else DTC series; never firmware / opaque codes.
                if (!isLikelyProductName(deviceTypeLabel, labelCtx)) {
                    deviceTypeLabel = seriesFromDtc(dtc) || '—';
                }

                rows.push({
                    enabled: false,
                    plantId,
                    plantName,
                    deviceSn,
                    deviceType,
                    model,
                    deviceTypeLabel,
                    dtc: dtc == null ? '' : String(dtc),
                    deviceAlias,
                    pmaxW: pmaxW == null ? '' : pmaxW,
                    pmaxLabel: formatPmaxLabel(pmaxW),
                    _infoFetched: infoFetched,
                });
            }
            await sleep(250);
        }
        return rows;
    }

    /**
     * @returns {Promise<{ power_w: number, e_total_kwh: number, u1: number, f: number, raw: object, deviceType: string, deviceSn: string }>}
     */
    async fetch() {
        if (!this.token) {
            throw new Error('GROWATT token missing');
        }
        if (!this.deviceSn) {
            throw new Error('deviceSn missing');
        }

        let type = this.deviceType || 'min';
        let body = await this._queryLastData(type);
        throwIfThrottled(body, type);

        if (!this._hasDeviceData(body, type)) {
            // Do NOT walk every slug on throttle/empty — that multiplies 429s.
            // At most one alternate type; stop immediately on rate-limit.
            for (const alt of fallbackTypes(type).slice(0, 1)) {
                await sleep(400);
                body = await this._queryLastData(alt);
                throwIfThrottled(body, alt);
                if (this._hasDeviceData(body, alt)) {
                    type = alt;
                    this.deviceType = alt;
                    break;
                }
            }
        }

        const row = this._extractRow(body, type);
        if (!row) {
            const msg = body && (body.message || body.msg || body.error || body.error_msg);
            throw new Error(`No last-data for type=${type} sn=${this.deviceSn}: ${msg || JSON.stringify(body).slice(0, 200)}`);
        }

        return {
            power_w: this._pickPowerW(row),
            e_total_kwh: this._pickETotal(row),
            u1: toFloat(row.vAc1 ?? row.vac1 ?? row.vacr ?? 0),
            f: toFloat(row.fAc ?? row.fac ?? row.frequency ?? 0),
            raw: row,
            deviceType: type,
            deviceSn: this.deviceSn,
        };
    }

    async _listPlants() {
        const url = new URL('v1/plant/list', this.baseUrl);
        url.searchParams.set('page', '1');
        url.searchParams.set('perpage', '100');
        const body = await this._request('GET', url, null, { token: this.token });
        assertApiOk(body);
        const plants = (body.data && (body.data.plants || body.data)) || body.plants || [];
        return Array.isArray(plants) ? plants : [];
    }

    async _listDevices(plantId) {
        const url = new URL('v1/device/list', this.baseUrl);
        url.searchParams.set('plant_id', String(plantId));
        url.searchParams.set('page', '1');
        url.searchParams.set('perpage', '100');
        const body = await this._request('GET', url, null, { token: this.token });
        assertApiOk(body);
        const devices = (body.data && (body.data.devices || body.data)) || body.devices || [];
        return Array.isArray(devices) ? devices : [];
    }

    async _queryLastData(deviceType) {
        const url = new URL('v4/new-api/queryLastData', this.baseUrl);
        const form = new URLSearchParams({
            deviceType: String(deviceType),
            deviceSn: this.deviceSn,
        });
        return this._request('POST', url, form.toString(), {
            'Content-Type': 'application/x-www-form-urlencoded',
            token: this.token,
        });
    }

    /**
     * Static device info (model / firmware). Best-effort for UI product label.
     * @param {string} deviceSn
     * @param {string} deviceType
     * @returns {Promise<object>}
     */
    async _queryDeviceInfo(deviceSn, deviceType) {
        const url = new URL('v4/new-api/queryDeviceInfo', this.baseUrl);
        const form = new URLSearchParams({
            deviceType: String(deviceType || 'min'),
            deviceSn: String(deviceSn || ''),
        });
        const body = await this._request('POST', url, form.toString(), {
            'Content-Type': 'application/x-www-form-urlencoded',
            token: this.token,
        });
        throwIfThrottled(body, deviceType);
        if (body && body.data && typeof body.data === 'object') {
            const data = body.data;
            if (data[deviceType] && typeof data[deviceType] === 'object') {
                const bucket = data[deviceType];
                return Array.isArray(bucket) ? bucket[0] || {} : bucket;
            }
            return data;
        }
        return body && typeof body === 'object' ? body : {};
    }

    /**
     * Fallback for pmax when queryDeviceInfo omits it (MIN/TLX family).
     * @param {string} deviceSn
     * @returns {Promise<object>}
     */
    async _queryTlxDataInfo(deviceSn) {
        const url = new URL('v1/device/tlx/tlx_data_info', this.baseUrl);
        url.searchParams.set('device_sn', String(deviceSn || ''));
        const body = await this._request('GET', url, null, { token: this.token });
        throwIfThrottled(body);
        if (body && body.error_code !== undefined && Number(body.error_code) !== 0) {
            throw new Error(body.error_msg || `tlx_data_info error_code=${body.error_code}`);
        }
        return (body && body.data && typeof body.data === 'object' ? body.data : {}) || {};
    }

    _hasDeviceData(body, deviceType) {
        if (!body) {
            return false;
        }
        if (body.code !== undefined && Number(body.code) !== 0 && body.result !== 1) {
            return false;
        }
        if (body.error_code !== undefined && Number(body.error_code) !== 0) {
            return false;
        }
        return !!this._extractRow(body, deviceType);
    }

    _extractRow(body, deviceType) {
        const data = body && body.data;
        if (!data || typeof data !== 'object') {
            return null;
        }
        const arr = data[deviceType];
        if (Array.isArray(arr) && arr.length) {
            return arr[0];
        }
        if (Array.isArray(data) && data.length) {
            return data[0];
        }
        return null;
    }

    _pickPowerW(row) {
        let chosen = 0;
        for (const field of this.powerFields) {
            if (!(field in row)) {
                continue;
            }
            chosen = toFloat(row[field], 0);
            if (Math.abs(chosen) > 1e-9) {
                break;
            }
        }
        let watts = chosen;
        if (this.powerKwThreshold > 0 && Math.abs(watts) > 0 && Math.abs(watts) < this.powerKwThreshold) {
            watts *= 1000;
        }
        return watts * this.powerSign;
    }

    _pickETotal(row) {
        for (const key of ['eTotal', 'etotal', 'eacTotal', 'ETotal', 'epvTotal', 'outEnergyTotal', 'eacYear']) {
            if (key in row) {
                return toFloat(row[key], 0);
            }
        }
        return 0;
    }

    _request(method, url, body, headers) {
        return new Promise((resolve, reject) => {
            const lib = url.protocol === 'http:' ? http : https;
            const req = lib.request(
                url,
                {
                    method,
                    headers: {
                        Accept: 'application/json',
                        'User-Agent': 'iobroker.fronius-fake-sm/0.2',
                        ...headers,
                        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                    },
                    timeout: 60000,
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode === 401 || res.statusCode === 403) {
                            reject(new Error(`Growatt OpenAPI HTTP ${res.statusCode} (token disabled/invalid or WAF)`));
                            return;
                        }
                        if (res.statusCode === 429) {
                            reject(new GrowattRateLimitError(`Growatt OpenAPI HTTP 429: ${text.slice(0, 120)}`));
                            return;
                        }
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`Growatt OpenAPI HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(text));
                        } catch {
                            reject(new Error(`Growatt OpenAPI non-JSON: ${text.slice(0, 200)}`));
                        }
                    });
                },
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Growatt OpenAPI timeout'));
            });
            if (body) {
                req.write(body);
            }
            req.end();
        });
    }
}

function mapDeviceType(d) {
    const raw = d.deviceType || d.device_type || d.growattType || d.type;
    if (raw === null || raw === undefined || raw === '') {
        return 'min';
    }
    const asStr = String(raw).toLowerCase();
    if (ALLOWED_SLUGS.has(asStr)) {
        return asStr;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && TYPE_CODE_MAP[n]) {
        return TYPE_CODE_MAP[n];
    }
    return 'min';
}

function fallbackTypes(primary) {
    const order = ['min', 'tlx', 'inv', 'max', 'sph', 'spa', 'storage', 'wit', 'noah'];
    return order.filter((t) => t !== primary);
}

function assertApiOk(body) {
    if (!body) {
        throw new Error('Empty Growatt response');
    }
    throwIfThrottled(body);
    if (body.error_code !== undefined && Number(body.error_code) !== 0) {
        throw new Error(body.error_msg || `Growatt error_code=${body.error_code}`);
    }
    if (body.code !== undefined && Number(body.code) !== 0 && body.result !== 1) {
        throw new Error(body.message || body.msg || `Growatt code=${body.code}`);
    }
}

/**
 * @param {object|null} body
 * @param {string} [typeHint]
 */
function throwIfThrottled(body, typeHint) {
    if (!body || typeof body !== 'object') {
        return;
    }
    const msg = String(body.message || body.msg || body.error || body.error_msg || '');
    if (/FREQUENTLY_ACCESS|TOO_MANY|RATE.?LIMIT|429/i.test(msg)) {
        throw new GrowattRateLimitError(
            `Growatt rate-limited${typeHint ? ` (type=${typeHint})` : ''}: ${msg.slice(0, 120)}`,
        );
    }
}

function toFloat(value, defaultValue = 0) {
    if (value === null || value === undefined || value === '') {
        return defaultValue;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : defaultValue;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
    GrowattOpenApiClient,
    GrowattRateLimitError,
    isGrowattRateLimitError,
    mapDeviceType,
    isLikelyProductName,
    labelFromDevicePayload,
    pickDeviceTypeLabel,
    collectLabelCandidates,
    aliasLabel,
    seriesFromDtc,
    formatPmaxLabel,
};
