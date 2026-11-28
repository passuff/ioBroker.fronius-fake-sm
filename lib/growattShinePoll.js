'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const {
    GrowattRateLimitError,
    GrowattAuthError,
    isGrowattRateLimitError,
    isGrowattAuthError,
} = require('./growattOpenApi');

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * ShinePhone password hash: MD5 hex with even-index '0' → 'c'.
 * @param {string} password
 * @returns {string}
 */
function hashPasswordShinePhone(password) {
    const digest = crypto.createHash('md5').update(String(password), 'utf8').digest('hex');
    const chars = digest.split('');
    for (let i = 0; i < chars.length; i += 2) {
        if (chars[i] === '0') {
            chars[i] = 'c';
        }
    }
    return chars.join('');
}

function toFloat(value, defaultVal = 0) {
    if (value == null || value === '') {
        return defaultVal;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : defaultVal;
}

function normalizePowerW(raw, kwThreshold) {
    const thr = Number(kwThreshold) || 0;
    if (thr > 0 && Math.abs(raw) > 0 && Math.abs(raw) < thr) {
        return raw * 1000;
    }
    return raw;
}

function looksLikeAuthFailure(status, bodyText) {
    if (status === 401) {
        return true;
    }
    return /invalid.*(pass|user|credential)|wrong password|login failed|unauthorized|access denied|account.*locked|\blocked\b/i.test(
        String(bodyText || ''),
    );
}


function looksLikeRateLimit(status, bodyText) {
    if (status === 429) {
        return true;
    }
    // Pure 403 without throttle wording is often WAF/auth — callers decide.
    return /frequently|too frequent|rate.?limit|error_frequently/i.test(String(bodyText || ''));
}

/**
 * Cloud poll via Shine login + newTlxApi.do (same shape as GrowattOpenApiClient.fetch).
 * Reuse one instance across polls — avoid re-login every cycle (lock risk).
 */
class GrowattShinePollClient {
    /**
     * @param {object} opts
     */
    constructor(opts) {
        this.user = String(opts.user || '');
        this.password = String(opts.password || '');
        this.deviceSn = String(opts.deviceSn || '');
        this.plantId = String(opts.plantId || '');
        this.server = String(opts.server || 'https://server.growatt.com').replace(/\/$/, '');
        this.powerFields = opts.powerFields || [
            'ppv',
            'pac',
            'outPower',
            'powerOfPhotovoltaic',
            'chargePower',
        ];
        this.powerSign = Number(opts.powerSign ?? -1);
        this.powerKwThreshold = Number(opts.powerKwThreshold ?? 100);
        this.log = opts.log || (() => {});
        this.cookie = '';
        this._loggedIn = false;
    }

    /**
     * @param {string} [setCookieHeader]
     */
    absorbSetCookie(setCookie) {
        if (!setCookie) {
            return;
        }
        const list = Array.isArray(setCookie) ? setCookie : [setCookie];
        const map = {};
        for (const part of String(this.cookie || '')
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean)) {
            const i = part.indexOf('=');
            if (i > 0) {
                map[part.slice(0, i)] = part.slice(i + 1);
            }
        }
        for (const raw of list) {
            const first = String(raw).split(';')[0].trim();
            const i = first.indexOf('=');
            if (i > 0) {
                map[first.slice(0, i)] = first.slice(i + 1);
            }
        }
        this.cookie = Object.entries(map)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }

    /**
     * @param {string} path
     * @param {Record<string, string|number>} fields
     * @param {{query?: Record<string,string>, login?: boolean}} [opts]
     */
    postForm(path, fields, opts = {}) {
        const url = new URL(path, `${this.server}/`);
        if (opts.query) {
            for (const [k, v] of Object.entries(opts.query)) {
                url.searchParams.set(k, String(v));
            }
        }
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) {
            body.set(k, String(v));
        }
        const payload = body.toString();
        const headers = {
            'User-Agent': BROWSER_UA,
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Origin: this.server,
            Referer: `${this.server}/`,
            'Content-Length': Buffer.byteLength(payload),
        };
        if (!opts.login && this.cookie) {
            headers.Cookie = this.cookie;
        }
        return new Promise((resolve, reject) => {
            const lib = url.protocol === 'http:' ? http : https;
            const req = lib.request(
                url,
                { method: 'POST', headers, timeout: 60000 },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const setCookie = res.headers['set-cookie'];
                        if (setCookie) {
                            this.absorbSetCookie(setCookie);
                        }
                        const text = Buffer.concat(chunks).toString('utf8');
                        if (looksLikeAuthFailure(res.statusCode, text)) {
                            reject(
                                new GrowattAuthError(
                                    `Shine auth HTTP ${res.statusCode}: ${text.slice(0, 120)}`,
                                ),
                            );
                            return;
                        }
                        if (looksLikeRateLimit(res.statusCode, text) || res.statusCode === 403) {
                            // Ambiguous 403: treat as rate-limit only when body says so;
                            // bare 403 during API calls is usually WAF throttle.
                            if (res.statusCode === 403 && !looksLikeRateLimit(403, text)) {
                                reject(
                                    new GrowattAuthError(
                                        `Shine auth/WAF HTTP 403: ${text.slice(0, 120)}`,
                                    ),
                                );
                                return;
                            }
                            reject(
                                new GrowattRateLimitError(
                                    `Shine rate-limit HTTP ${res.statusCode}: ${text.slice(0, 120)}`,
                                ),
                            );
                            return;
                        }
                        let data = text;
                        try {
                            data = JSON.parse(text);
                        } catch {
                            /* keep text */
                        }
                        resolve({
                            status: res.statusCode,
                            data,
                            contentType: String(res.headers['content-type'] || ''),
                            text,
                        });
                    });
                },
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Shine poll timeout'));
            });
            req.write(payload);
            req.end();
        });
    }

    async login() {
        if (!this.user || !this.password) {
            throw new Error('growattUser/growattPassword missing for Shine cloud poll');
        }
        this.cookie = '';
        this._loggedIn = false;
        this.log(`Shine poll login as ${this.user}`);
        const hashed = await this.postForm(
            '/newTwoLoginAPI.do',
            { userName: this.user, password: hashPasswordShinePhone(this.password) },
            { login: true },
        );
        if (hashed.status === 403) {
            this.log('Shine hashed login HTTP 403 — classic /login');
            await this._loginClassic();
            this._loggedIn = true;
            return;
        }
        const back = hashed.data && hashed.data.back;
        if (!back || !back.success) {
            const hint = (back && (back.error || back.msg)) || JSON.stringify(hashed.data).slice(0, 120);
            this.log(`Shine hashed login rejected (${hint}) — classic /login`);
            await this._loginClassic();
        }
        this._loggedIn = true;
        this.log(`Shine poll login OK (plant=${this.plantId} sn=${this.deviceSn})`);
    }

    async _loginClassic() {
        this.cookie = '';
        const res = await this.postForm(
            '/login',
            {
                account: this.user,
                password: this.password,
                validateCode: '',
            },
            { login: true },
        );
        if (looksLikeRateLimit(res.status, res.text)) {
            throw new GrowattRateLimitError('Shine login HTTP rate-limit/WAF');
        }
        if (res.status === 403 || looksLikeAuthFailure(res.status, res.text)) {
            throw new GrowattAuthError(`Shine login HTTP ${res.status || 'auth'} (credentials/WAF)`);
        }
        const body = res.data;
        if (body && typeof body === 'object' && (body.result === 1 || body.success)) {
            return;
        }
        throw new GrowattAuthError(`Classic Shine login rejected: ${JSON.stringify(body).slice(0, 200)}`);
    }

    async _ensureLogin() {
        if (!this._loggedIn) {
            await this.login();
        }
    }

    /**
     * @returns {Promise<{power_w:number,e_total_kwh:number,u1:number,f:number,raw:object,deviceSn:string}>}
     */
    async fetch() {
        if (!this.deviceSn) {
            throw new Error('deviceSn missing');
        }
        if (!this.plantId) {
            throw new Error('plantId missing for Shine cloud poll');
        }
        await this._ensureLogin();
        let status;
        let total;
        try {
            ({ status, total } = await this._fetchTlx());
        } catch (err) {
            if (isGrowattRateLimitError(err) || isGrowattAuthError(err)) {
                throw err;
            }
            this.log(`Shine fetch failed (${err.message}) — re-login once`);
            this._loggedIn = false;
            await this.login();
            ({ status, total } = await this._fetchTlx());
        }
        const power_w = this._pickPowerW(status);
        return {
            power_w,
            e_total_kwh: this._pickETotal(total, status),
            u1: toFloat(status.vAc1 ?? status.vac1, 0),
            f: toFloat(status.fAc ?? status.fac, 0),
            raw: status,
            deviceSn: this.deviceSn,
            deviceType: 'shine',
        };
    }

    async _fetchTlx() {
        const status = await this._newTlx('getSystemStatus_KW');
        const total = await this._newTlx('getEnergyOverview');
        if ((!status || !Object.keys(status).length) && (!total || !Object.keys(total).length)) {
            throw new Error('Empty Shine status/total response');
        }
        return { status: status || {}, total: total || {} };
    }

    /**
     * @param {string} op
     * @returns {Promise<object>}
     */
    async _newTlx(op) {
        const res = await this.postForm(
            '/newTlxApi.do',
            { plantId: this.plantId, id: this.deviceSn },
            { query: { op } },
        );
        const ctype = String(res.contentType || '').toLowerCase();
        if (!ctype.includes('json') && typeof res.data === 'string') {
            if (looksLikeRateLimit(res.status, res.text)) {
                throw new GrowattRateLimitError(`Shine newTlxApi ${op} rate-limited`);
            }
            throw new Error(`newTlxApi ${op} returned non-JSON (${ctype || 'unknown'})`);
        }
        const payload = res.data;
        if (payload && typeof payload === 'object') {
            const msg = String(payload.msg || payload.message || payload.error || '');
            if (payload.success === false || payload.result === -1) {
                this._loggedIn = false;
                if (looksLikeAuthFailure(res.status, msg)) {
                    throw new GrowattAuthError(`Shine newTlxApi ${op}: ${msg.slice(0, 120)}`);
                }
            }
            if (looksLikeAuthFailure(res.status, msg)) {
                throw new GrowattAuthError(`Shine newTlxApi ${op}: ${msg.slice(0, 120)}`);
            }
            if (looksLikeRateLimit(res.status, msg)) {
                throw new GrowattRateLimitError(`Shine newTlxApi ${op}: ${msg.slice(0, 120)}`);
            }
            const obj = payload.obj;
            return obj && typeof obj === 'object' ? obj : {};
        }
        return {};
    }

    _pickPowerW(status) {
        let chosenRaw = 0;
        let found = false;
        for (const field of this.powerFields) {
            if (!(field in status)) {
                continue;
            }
            found = true;
            chosenRaw = toFloat(status[field], 0);
            if (Math.abs(chosenRaw) > 1e-9) {
                break;
            }
        }
        if (!found) {
            // Empty / unrelated payload: fail closed. Only drop session when status is empty.
            if (!status || typeof status !== 'object' || !Object.keys(status).length) {
                this._loggedIn = false;
            }
            throw new Error('Shine status missing power fields (session/payload stale)');
        }
        return normalizePowerW(chosenRaw, this.powerKwThreshold) * this.powerSign;
    }

    _pickETotal(total, status) {
        for (const key of ['eTotal', 'etotal', 'eacTotal', 'ETotal', 'epvTotal', 'outEnergyTotal']) {
            if (total && key in total) {
                return toFloat(total[key], 0);
            }
            if (status && key in status) {
                return toFloat(status[key], 0);
            }
        }
        return 0;
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {boolean}
 */
function isShineCloudAuth(adapter) {
    const cfg = (adapter && adapter.config) || {};
    if (String(cfg.growattFeedMode || 'cloud') === 'local') {
        return false;
    }
    return String(cfg.growattCloudAuth || 'openapi') === 'shine';
}

module.exports = {
    GrowattShinePollClient,
    hashPasswordShinePhone,
    isShineCloudAuth,
    looksLikeRateLimit,
    looksLikeAuthFailure,
    GrowattAuthError,
    isGrowattAuthError,
};
