'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

/** Datalogger registers (Grott / PLCHome). */
const LOGGER_REG = {
    INTERVAL: 4,
    SERVERIP: 17,
    SERVERPORT: 18,
};

/** paramType for setDatalogParam. */
const LOGGER_FN = {
    REGISTER: 0,
    SERVERIP: 1,
    SERVERNAME: 2,
    SERVERPORT: 3,
};

/**
 * Shine Web session (server.growatt.com) — can push datalogger register writes
 * to the stick over the existing cloud TCP session (no AP button).
 */
class GrowattShineSession {
    /**
     * @param {object} opts
     * @param {string} opts.user
     * @param {string} opts.password
     * @param {string} [opts.server]
     * @param {(m:string)=>void} [opts.log]
     */
    constructor(opts) {
        this.user = String(opts.user || '');
        this.password = String(opts.password || '');
        this.server = (opts.server || 'https://server.growatt.com').replace(/\/$/, '');
        this.log = opts.log || (() => {});
        this.cookie = '';
        this.connected = false;
    }

    md5(s) {
        return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
    }

    /** Merge Set-Cookie name=value pairs into this.cookie (do not drop JSESSIONID). */
    absorbSetCookie(setCookie) {
        if (!setCookie || !setCookie.length) {
            return;
        }
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
        for (const raw of setCookie) {
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

    headers(login) {
        const h = {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            Connection: 'keep-alive',
        };
        if (!login && this.cookie) {
            h.Cookie = this.cookie;
            // Growatt expects a referer with jsessionid for /ftp.do
            const m = /JSESSIONID=([^;]+)/i.exec(this.cookie);
            if (m) {
                h.Referer = `${this.server}/index;jsessionid=${m[1]}`;
            }
        }
        return h;
    }

    /**
     * @param {string} path
     * @param {Record<string,string|number>} fields
     * @param {boolean} [login]
     */
    postForm(path, fields, login = false) {
        const url = new URL(path, `${this.server}/`);
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) {
            body.set(k, String(v));
        }
        const payload = body.toString();
        return new Promise((resolve, reject) => {
            const lib = url.protocol === 'http:' ? http : https;
            const req = lib.request(
                url,
                {
                    method: 'POST',
                    headers: {
                        ...this.headers(login),
                        'Content-Length': Buffer.byteLength(payload),
                    },
                    timeout: 25000,
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const setCookie = res.headers['set-cookie'];
                        if (setCookie) {
                            this.absorbSetCookie(Array.isArray(setCookie) ? setCookie : [setCookie]);
                        }
                        const text = Buffer.concat(chunks).toString('utf8');
                        try {
                            resolve({ status: res.statusCode, data: JSON.parse(text) });
                        } catch {
                            resolve({ status: res.statusCode, data: text });
                        }
                    });
                },
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Shine session timeout'));
            });
            req.write(payload);
            req.end();
        });
    }

    async login() {
        if (!this.user || !this.password) {
            throw new Error('growattUser/growattPassword missing for remote stick setup');
        }
        const res = await this.postForm(
            '/login',
            {
                account: this.user,
                password: '',
                validateCode: '',
                isReadPact: 0,
                passwordCrc: this.md5(this.password),
            },
            true,
        );
        if (!res.data || Number(res.data.result) !== 1) {
            throw new Error(`Shine login failed: ${JSON.stringify(res.data).slice(0, 200)}`);
        }
        this.connected = true;
        this.log('Shine web login OK');
        return res.data;
    }

    /**
     * @param {string} plantId
     * @param {number} [currPage]
     */
    async getDatalogList(plantId, currPage = 1) {
        const res = await this.postForm('/device/getDatalogList', {
            datalogSn: '',
            plantId: String(plantId),
            currPage,
        });
        return res.data;
    }

    /**
     * Shine web plant title list (same source as portal sidebar).
     * @returns {Promise<Array<{id:string,plantName:string,timezone?:string,raw:any}>>}
     */
    async listPlants() {
        const res = await this.postForm('/index/getPlantListTitle', {});
        const rows = Array.isArray(res.data)
            ? res.data
            : (res.data && res.data.datas) ||
              (res.data && res.data.data) ||
              (res.data && res.data.obj) ||
              [];
        if (!Array.isArray(rows)) {
            return [];
        }
        return rows
            .map((r) => {
                const id = String(r.id || r.plantId || r.plant_id || '');
                const plantName = String(r.plantName || r.name || id);
                if (!id) {
                    return null;
                }
                return { id, plantName, timezone: r.timezone != null ? String(r.timezone) : undefined, raw: r };
            })
            .filter(Boolean);
    }

    /**
     * Normalize datalogger list rows for one plant.
     * @param {string} plantId
     * @param {number} [currPage]
     * @returns {Promise<Array<{sn:string,plantId:string,plantName:string,lost:boolean,lastUpdateTime:string,raw:any}>>}
     */
    async listDataloggers(plantId, currPage = 1) {
        if (!plantId) {
            return [];
        }
        const data = await this.getDatalogList(plantId, currPage);
        const rows =
            (data && data.datas) ||
            (data && data.data && data.data.datas) ||
            (data && data.obj && data.obj.datas) ||
            [];
        if (!Array.isArray(rows)) {
            return [];
        }
        return rows
            .map((r) => {
                const sn = String(r.sn || r.datalogSn || r.dataLogSn || '');
                if (!sn) {
                    return null;
                }
                return {
                    sn,
                    plantId: String(plantId),
                    plantName: String(r.plantName || ''),
                    lost: isShineLostFlag(r.lost),
                    lastUpdateTime: String(r.lastUpdateTime || r.last_update_time || ''),
                    raw: r,
                };
            })
            .filter(Boolean);
    }

    /**
     * Collect datalogger SNs for all known plant IDs.
     * @param {string[]} plantIds
     */
    async listDataloggerSns(plantIds) {
        const sns = [];
        for (const plantId of plantIds) {
            if (!plantId) {
                continue;
            }
            try {
                const rows = await this.listDataloggers(plantId);
                for (const r of rows) {
                    sns.push({ sn: r.sn, plantId: r.plantId, lost: r.lost, lastUpdateTime: r.lastUpdateTime, raw: r.raw });
                }
            } catch (err) {
                this.log(`getDatalogList plant ${plantId}: ${err.message}`);
            }
        }
        return sns;
    }

    /** @param {any} data */
    static isFail(data) {
        if (!data || typeof data !== 'object') {
            return true;
        }
        return data.success === false || data.success === 'false';
    }

    /**
     * Read datalogger register (also probes whether cloud can reach the stick).
     * @param {string} dataLogSn
     * @param {number} addr
     */
    async getRegister(dataLogSn, addr) {
        const res = await this.postForm('/ftp.do', {
            action: 'readDatalogParam',
            dataLogSn,
            paramType: 'set_any_reg',
            addr,
        });
        return res.data;
    }

    /**
     * High-level param write (SecureWatt / PLCHome): paramType 1=IP, 3=port.
     * @param {string} dataLogSn
     * @param {number} paramType
     * @param {string|number} value
     */
    async setParam(dataLogSn, paramType, value) {
        const res = await this.postForm('/ftp.do', {
            action: 'setDatalogParam',
            dataLogSn,
            paramType,
            param_1: value,
            param_2: '',
        });
        if (GrowattShineSession.isFail(res.data)) {
            throw new Error(`setParam ${paramType} failed: ${JSON.stringify(res.data).slice(0, 220)}`);
        }
        return res.data;
    }

    /**
     * @param {string} dataLogSn
     * @param {number} addr
     * @param {string|number} value
     */
    async setRegister(dataLogSn, addr, value) {
        const res = await this.postForm('/ftp.do', {
            action: 'setDatalogParam',
            dataLogSn,
            paramType: LOGGER_FN.REGISTER,
            param_1: addr,
            param_2: value,
        });
        if (GrowattShineSession.isFail(res.data)) {
            throw new Error(`setRegister ${addr} failed: ${JSON.stringify(res.data).slice(0, 220)}`);
        }
        return res.data;
    }

    async restart(dataLogSn) {
        const res = await this.postForm('/ftp.do', {
            action: 'restartDatalog',
            dataLogSn,
        });
        return res.data;
    }

    /**
     * Point stick at an arbitrary Growatt server host/IP and restart.
     * Prefers paramType SERVERIP/SERVERPORT; falls back to registers 17/18.
     * @param {string} dataLogSn
     * @param {string} serverHost IP or hostname (e.g. server.growatt.com)
     * @param {number} [port]
     */
    async redirectServer(dataLogSn, serverHost, port = 5279) {
        const host = String(serverHost || '').trim();
        if (!host) {
            throw new Error('redirectServer: empty host');
        }
        // Probe reachability — inv_set_datalog_lost means cloud has no live session to stick
        try {
            const probe = await this.getRegister(dataLogSn, LOGGER_REG.SERVERIP);
            this.log(`remote probe SERVERIP: ${JSON.stringify(probe).slice(0, 160)}`);
        } catch (err) {
            this.log(`remote probe failed: ${err.message}`);
        }

        let r1;
        let r2;
        let mode = 'param';
        try {
            this.log(`remote setParam SERVERIP ${dataLogSn} → ${host}`);
            r1 = await this.setParam(dataLogSn, LOGGER_FN.SERVERIP, host);
            this.log(`remote setParam SERVERPORT ${dataLogSn} → ${port}`);
            r2 = await this.setParam(dataLogSn, LOGGER_FN.SERVERPORT, port);
        } catch (err) {
            this.log(`setParam failed (${err.message}) — trying register 17/18`);
            mode = 'register';
            r1 = await this.setRegister(dataLogSn, LOGGER_REG.SERVERIP, host);
            r2 = await this.setRegister(dataLogSn, LOGGER_REG.SERVERPORT, port);
        }
        this.log(`remote restart ${dataLogSn}`);
        const r3 = await this.restart(dataLogSn);
        return { mode, serverHost: host, serverIp: r1, serverPort: r2, restart: r3 };
    }

    /**
     * Point stick at local proxy host and restart.
     * @param {string} dataLogSn
     * @param {string} serverIp
     * @param {number} [port]
     */
    async redirectToLocal(dataLogSn, serverIp, port = 5279) {
        return this.redirectServer(dataLogSn, serverIp, port);
    }

    /**
     * Restore stick to stock Growatt cloud endpoint.
     * @param {string} dataLogSn
     * @param {number} [port]
     */
    async redirectToCloud(dataLogSn, port = 5279) {
        return this.redirectServer(dataLogSn, 'server.growatt.com', port);
    }
}

/**
 * Shine/OpenAPI lost flags arrive as bool, 0/1, or "true"/"false".
 * @param {any} lost
 * @returns {boolean} true when device is considered offline/lost
 */
function isShineLostFlag(lost) {
    if (lost === true || lost === 1 || lost === '1') {
        return true;
    }
    if (typeof lost === 'string' && /^true$/i.test(lost.trim())) {
        return true;
    }
    return false;
}

module.exports = {
    GrowattShineSession,
    LOGGER_REG,
    LOGGER_FN,
    isShineLostFlag,
};
