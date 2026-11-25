'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const {
    getCatalogEntry,
    resolveApiType,
    resolveApiAction,
    normalizeFamily,
    listCatalog,
} = require('./inverterVarsCatalog');

/**
 * Queue + send safe inverter settings via Shine classic API or OpenAPI.
 * One write at a time to avoid Growatt rate limits.
 */
class GrowattSettingsQueue {
    /**
     * @param {import('@iobroker/adapter-core').Adapter & object} adapter
     */
    constructor(adapter) {
        this.adapter = adapter;
        /** @type {Array<object>} */
        this._q = [];
        this._busy = false;
    }

    /**
     * @param {object} job
     */
    enqueue(job) {
        this._q.push(job);
        void this._pump();
    }

    async _pump() {
        if (this._busy) {
            return;
        }
        this._busy = true;
        try {
            while (this._q.length) {
                const job = this._q.shift();
                try {
                    await this._run(job);
                } catch (err) {
                    this.adapter.log.warn(`Setting ${job.catalogId}@${job.deviceSn}: ${err.message}`);
                    await this._fail(job, err.message);
                }
                await sleep(1500);
            }
        } finally {
            this._busy = false;
        }
    }

    /**
     * @param {object} job
     */
    async _run(job) {
        const entry = getCatalogEntry(job.catalogId);
        if (!entry || entry.kind !== 'write') {
            throw new Error(`unknown setting ${job.catalogId}`);
        }
        const family = normalizeFamily(job.family || 'min');
        const isString = entry.type === 'string';
        const num = isString ? NaN : Number(job.value);
        if (entry.range && !isString) {
            if (!Number.isFinite(num) || num < entry.range.min || num > entry.range.max) {
                throw new Error(`value ${job.value} out of range ${entry.range.min}…${entry.range.max}`);
            }
        }
        if (isString && (job.value == null || String(job.value).trim() === '')) {
            throw new Error('empty value');
        }
        const writeVal = isString ? String(job.value) : num;
        const apiType = resolveApiType(entry, family);
        const action = resolveApiAction(entry, family);
        if (!apiType) {
            throw new Error('no API type for family');
        }

        // Prefer local Modbus write when stick connected (numeric holding regs only)
        if (!isString && entry.holdingReg != null) {
            const localOk = await tryLocalWrite(this.adapter, {
                deviceSn: job.deviceSn,
                holdingReg: entry.holdingReg,
                value: num,
            });
            if (localOk) {
                await this._setMsg(job, 'ok (local)');
                await this._ackValue(job, writeVal);
                scheduleHoldingReadback(this.adapter, entry.holdingReg, job.deviceSn);
                return;
            }
        }

        const params = await resolveWriteParams(this.adapter, job, entry, writeVal);
        const cfg = this.adapter.config || {};
        const useShine = String(cfg.growattCloudAuth || 'openapi') === 'shine' || !cfg.growattToken;
        let result;
        if (useShine && cfg.growattUser && cfg.growattPassword) {
            result = await shineTcpSet(this.adapter, {
                deviceSn: job.deviceSn,
                action,
                type: apiType,
                param1: params.param1,
                param2: params.param2,
            });
        } else if (cfg.growattToken) {
            result = await openApiTlxSet(this.adapter, {
                deviceSn: job.deviceSn,
                type: apiType,
                param1: params.param1,
                param2: params.param2,
            });
        } else {
            throw new Error('no cloud credentials for setting write');
        }
        await this._setMsg(job, result.msg || 'ok');
        await this._ackValue(job, writeVal);
        if (entry.holdingReg != null) {
            scheduleHoldingReadback(this.adapter, entry.holdingReg, job.deviceSn);
        }
    }

    async _setMsg(job, msg) {
        const id = `inverter.${job.deviceSn}.settings.${job.catalogId}.msg`;
        try {
            await this.adapter.setStateAsync(id, { val: String(msg || ''), ack: true });
        } catch {
            // ignore
        }
    }

    async _ackValue(job, val) {
        const id = `inverter.${job.deviceSn}.settings.${job.catalogId}.value`;
        try {
            await this.adapter.setStateAsync(id, { val, ack: true });
        } catch {
            // ignore
        }
    }

    /**
     * Leave value unacked and record error message.
     * @param {object} job
     * @param {string} msg
     */
    async _fail(job, msg) {
        await this._setMsg(job, msg);
        const id = `inverter.${job.deviceSn}.settings.${job.catalogId}.value`;
        try {
            const prev = await this.adapter.getStateAsync(id);
            await this.adapter.setStateAsync(id, {
                val: prev && prev.val !== undefined ? prev.val : job.value,
                ack: false,
            });
        } catch {
            // ignore
        }
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} job
 * @param {object} entry
 * @param {number|string} writeVal
 */
async function resolveWriteParams(adapter, job, entry, writeVal) {
    if (entry.writeBundle !== 'backflow') {
        return { param1: String(writeVal), param2: undefined };
    }
    let enable = writeVal;
    let rate = 100;
    try {
        const en = await adapter.getStateAsync(`inverter.${job.deviceSn}.settings.exportLimitEnable.value`);
        const rt = await adapter.getStateAsync(`inverter.${job.deviceSn}.settings.exportLimitRate.value`);
        if (entry.id === 'exportLimitEnable') {
            enable = writeVal;
            if (rt && rt.val != null) {
                rate = Number(rt.val);
            }
        } else {
            rate = writeVal;
            if (en && en.val != null) {
                enable = Number(en.val);
            }
        }
    } catch {
        // keep defaults
    }
    return { param1: String(enable), param2: String(rate) };
}

async function tryLocalWrite(adapter, opts) {
    const server = adapter.localServer;
    if (!server) {
        return false;
    }
    if (opts.holdingReg == null || Number.isNaN(Number(opts.holdingReg))) {
        return false;
    }
    const { sendWriteHolding } = require('./growattInverterModbus');
    const stickSn = String(adapter.config.localStickSn || opts.deviceSn || '');
    return sendWriteHolding(server, {
        sn: stickSn,
        register: opts.holdingReg,
        value: opts.value,
        deviceSn: opts.deviceSn,
    });
}

/**
 * Queue FC 0x05 readback shortly after a write.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} holdingReg
 * @param {string} deviceSn
 */
function scheduleHoldingReadback(adapter, holdingReg, deviceSn) {
    if (holdingReg == null || !adapter.localServer) {
        return;
    }
    setTimeout(() => {
        try {
            requestHoldingRead(adapter, holdingReg, deviceSn);
        } catch (err) {
            adapter.log && adapter.log.debug && adapter.log.debug(`holding readback: ${err.message}`);
        }
    }, 800);
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} holdingReg
 * @param {string} [deviceSn]
 */
function requestHoldingRead(adapter, holdingReg, deviceSn) {
    const server = adapter.localServer;
    if (!server) {
        return false;
    }
    const { sendReadHolding } = require('./growattInverterModbus');
    const stickSn = String(adapter.config.localStickSn || deviceSn || '');
    return sendReadHolding(server, {
        sn: stickSn,
        register: holdingReg,
        quantity: 1,
        deviceSn: deviceSn || '',
    });
}

/**
 * Poll enabled write settings with holdingReg every ~300s while stick is connected.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function startSettingsHoldingPoll(adapter) {
    stopSettingsHoldingPoll(adapter);
    const tick = () => {
        try {
            if (!adapter.localServer || !adapter.config) {
                return;
            }
            const clients = adapter.localServer._clients;
            if (!clients || !clients.size) {
                return;
            }
            const rows = Array.isArray(adapter.config.inverterVars) ? adapter.config.inverterVars : [];
            const enabled = new Set(rows.filter((r) => r && r.enabled).map((r) => r.id));
            for (const entry of listCatalog()) {
                if (entry.kind !== 'write' || !enabled.has(entry.id) || entry.holdingReg == null) {
                    continue;
                }
                requestHoldingRead(adapter, entry.holdingReg, '');
            }
        } catch (err) {
            adapter.log && adapter.log.debug && adapter.log.debug(`settings holding poll: ${err.message}`);
        }
    };
    adapter._settingsHoldingTimer = setInterval(tick, 300000);
    // first pass after a short delay
    adapter._settingsHoldingFirst = setTimeout(tick, 15000);
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function stopSettingsHoldingPoll(adapter) {
    if (adapter._settingsHoldingTimer) {
        clearInterval(adapter._settingsHoldingTimer);
        adapter._settingsHoldingTimer = null;
    }
    if (adapter._settingsHoldingFirst) {
        clearTimeout(adapter._settingsHoldingFirst);
        adapter._settingsHoldingFirst = null;
    }
}

/**
 * Wire server.onHoldingRead → applyHoldingReadback.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} server
 */
function attachHoldingReadHandler(adapter, server) {
    if (!server) {
        return;
    }
    const { applyHoldingReadback } = require('./inverterVarsStates');
    server.onHoldingRead = (evt) => {
        void applyHoldingReadback(adapter, evt.register, evt.value, evt.sn).catch(() => {});
    };
}

async function shineTcpSet(adapter, opts) {
    const { GrowattShinePollClient } = require('./growattShinePoll');
    const cfg = adapter.config;
    const client =
        adapter._shinePollClient ||
        new GrowattShinePollClient({
            user: cfg.growattUser,
            password: cfg.growattPassword,
            deviceSn: opts.deviceSn,
            plantId: cfg.localPlantId || '',
            server: cfg.growattShineUrl || 'https://server.growatt.com',
            log: (m) => adapter.log.info(m),
        });
    await client._ensureLogin();
    const action = opts.action || 'tlxSet';
    const fields = {
        serialNum: opts.deviceSn,
        type: opts.type,
        param1: opts.param1 != null ? String(opts.param1) : '',
    };
    if (opts.param2 != null) {
        fields.param2 = String(opts.param2);
    }
    const path =
        action === 'tlxSet' || action === 'mixSet' || action === 'maxSet' || action === 'spaSet'
            ? '/newTcpsetAPI.do'
            : '/tcpSet.do';
    const res = await client.postForm(path, fields, { query: { op: action } });
    const body = res.data;
    const ok = body && (body.result === 1 || body.success === true || Number(body.error_code) === 0);
    const msg =
        (body && (body.msg || body.message || body.error_msg)) ||
        (ok ? 'ok' : JSON.stringify(body).slice(0, 120));
    if (!ok) {
        throw new Error(msg || 'tcpSet failed');
    }
    return { msg };
}

async function openApiTlxSet(adapter, opts) {
    const token = adapter.config.growattToken;
    const base = String(adapter.config.growattOpenApiUrl || 'https://openapi.growatt.com/');
    const form = new URLSearchParams({
        tlx_sn: opts.deviceSn,
        type: opts.type,
        param1: opts.param1 != null ? String(opts.param1) : '',
    });
    if (opts.param2 != null) {
        form.set('param2', String(opts.param2));
    }
    const url = new URL('v1/device/tlx/tlx_set', base.endsWith('/') ? base : `${base}/`);
    const body = await httpForm('POST', url, form.toString(), { token });
    if (body && Number(body.error_code) !== 0 && body.result !== 1) {
        const url2 = new URL('v1/tlxSet', base.endsWith('/') ? base : `${base}/`);
        const body2 = await httpForm('POST', url2, form.toString(), { token });
        if (body2 && Number(body2.error_code) !== 0 && body2.result !== 1) {
            throw new Error(body2.error_msg || body.error_msg || 'tlxSet failed');
        }
        return { msg: body2.error_msg || 'ok' };
    }
    return { msg: (body && body.error_msg) || 'ok' };
}

function httpForm(method, url, body, headers) {
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'http:' ? http : https;
        const req = lib.request(
            url,
            {
                method,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'iobroker.fronius-fake-sm/inverter-vars',
                    ...headers,
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 60000,
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new Error(`non-JSON: ${text.slice(0, 160)}`));
                    }
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.write(body);
        req.end();
    });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} id
 * @param {ioBroker.State|null|undefined} state
 */
function handleInverterSettingChange(adapter, id, state) {
    if (!state || state.ack) {
        return;
    }
    const { parseSettingStateId } = require('./inverterVarsStates');
    const parsed = parseSettingStateId(id, adapter.namespace);
    if (!parsed) {
        return;
    }
    const devices = Array.isArray(adapter._enabledDevices) ? adapter._enabledDevices : [];
    const device = devices.find((d) => d && d.deviceSn === parsed.deviceSn) || {
        deviceSn: parsed.deviceSn,
        deviceType: 'min',
    };
    if (!adapter._settingsQueue) {
        adapter._settingsQueue = new GrowattSettingsQueue(adapter);
    }
    adapter._settingsQueue.enqueue({
        deviceSn: parsed.deviceSn,
        family: device.deviceType || 'min',
        catalogId: parsed.catalogId,
        value: state.val,
    });
}

module.exports = {
    GrowattSettingsQueue,
    handleInverterSettingChange,
    shineTcpSet,
    openApiTlxSet,
    requestHoldingRead,
    scheduleHoldingReadback,
    startSettingsHoldingPoll,
    stopSettingsHoldingPoll,
    attachHoldingReadHandler,
};
