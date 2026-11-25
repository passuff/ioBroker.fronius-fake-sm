'use strict';

const {
    MSG,
    sessionFromAdapter,
    plantSelectOption,
    stickSelectOption,
} = require('./stickOnline');
const { analyzeLocalNetwork, hostIpSelectOptions } = require('./localNetworkAnalyze');
const { clearStatusCaches, seedShineStatus } = require('./localStatusAdmin');
const { getStickEntry } = require('./stickRedirectRegistry');

/** @type {Map<string, {at:number, rows:object[], plantBySn:Record<string,string>}>} */
const stickListCache = new Map();
const STICK_LIST_CACHE_MS = 60 * 1000;

/**
 * @param {object[]} rows
 * @param {object} cfg
 * @returns {object[]}
 */
function optionsFromRows(rows, cfg) {
    return (rows || []).map((row) => {
        const entry = getStickEntry(cfg, row.sn);
        return stickSelectOption({
            ...row,
            redirectState: entry ? entry.state : undefined,
        });
    });
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleConnectShineLocal(adapter, obj) {
    const message = (obj && obj.message) || {};
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, { error: cred.error }, obj.callback);
        }
        return;
    }
    try {
        await cred.session.login();
        const plants = await cred.session.listPlants();
        const native = {};
        if (message.growattUser) {
            native.growattUser = String(message.growattUser).trim();
            adapter.config.growattUser = native.growattUser;
        }
        if (message.growattPassword && message.growattPassword !== 'replace-me') {
            native.growattPassword = String(message.growattPassword);
            adapter.config.growattPassword = native.growattPassword;
        }
        // Do not auto-set localPlantId — sticks are listed across all plants.
        let stickCount = 0;
        for (const p of plants) {
            try {
                const sticks = await cred.session.listDataloggers(p.id);
                stickCount += sticks.length;
            } catch {
                // ignore per-plant errors
            }
        }
        const sticksHint =
            plants.length > 0
                ? ` — ${stickCount} Stick${stickCount === 1 ? '' : 's'} in ${plants.length} Anlage${plants.length === 1 ? '' : 'n'}`
                : '';
        const text = MSG.connectOk(plants.length, sticksHint);
        const shineLabel = `verbunden (${plants.length} Anlage${plants.length === 1 ? '' : 'n'})`;
        clearStatusCaches();
        stickListCache.clear();
        seedShineStatus(cred.user, shineLabel);
        native.shineStatusTick = Date.now();
        adapter.config.shineStatusTick = native.shineStatusTick;
        await adapter.setStateAsync('info.setupStatus', { val: text, ack: true });
        try {
            const { refreshStickStatus } = require('./stickStatus');
            await refreshStickStatus(adapter, message);
        } catch (err) {
            adapter.log.warn(`refreshStickStatus after connect: ${err.message}`);
        }
        if (obj.callback) {
            adapter.sendTo(
                obj.from,
                obj.command,
                {
                    result: text,
                    native: { ...native, stickStatusText: text },
                },
                obj.callback,
            );
        }
    } catch (err) {
        clearStatusCaches();
        stickListCache.clear();
        const text = MSG.loginFail(err.message || String(err));
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, { error: text }, obj.callback);
        }
    }
}

/**
 * selectSendTo handler — returns [{value,label}, ...]
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleListLocalPlants(adapter, obj) {
    const message = (obj && obj.message) || {};
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, [], obj.callback);
        }
        return;
    }
    try {
        await cred.session.login();
        const plants = await cred.session.listPlants();
        const options = plants.map(plantSelectOption);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, options, obj.callback);
        }
    } catch (err) {
        adapter.log.warn(`listLocalPlants: ${err.message}`);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, [], obj.callback);
        }
    }
}

/**
 * Load all sticks across plants (cached 60s per user).
 * @param {object} session
 * @param {string} user
 * @param {object} cfg
 * @returns {Promise<{options:object[], plantBySn:Record<string,string>}>}
 */
async function loadAllStickOptions(session, user, cfg) {
    const cacheKey = String(user || '').toLowerCase();
    const hit = stickListCache.get(cacheKey);
    if (hit && Date.now() - hit.at < STICK_LIST_CACHE_MS) {
        return {
            options: optionsFromRows(hit.rows, cfg),
            plantBySn: hit.plantBySn,
        };
    }

    const plants = await session.listPlants();
    const rows = [];
    const plantBySn = {};
    for (const p of plants) {
        let sticks = [];
        try {
            sticks = await session.listDataloggers(p.id);
        } catch (err) {
            if (typeof session.log === 'function') {
                session.log(`listDataloggers ${p.id}: ${err.message}`);
            }
            continue;
        }
        for (const s of sticks) {
            const sn = String(s.sn || '').trim();
            if (!sn) {
                continue;
            }
            const plantName = String(p.plantName || s.plantName || p.id);
            plantBySn[sn] = String(p.id);
            rows.push({
                ...s,
                sn,
                plantId: String(p.id),
                plantName,
            });
        }
    }
    stickListCache.set(cacheKey, {
        at: Date.now(),
        rows,
        plantBySn,
    });
    return { options: optionsFromRows(rows, cfg), plantBySn };
}

/**
 * selectSendTo handler — all sticks across all plants.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleListLocalSticks(adapter, obj) {
    const message = (obj && obj.message) || {};
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, [], obj.callback);
        }
        return;
    }
    try {
        await cred.session.login();
        const { options, plantBySn } = await loadAllStickOptions(cred.session, cred.user, adapter.config);
        adapter._localStickPlantBySn = plantBySn;
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, options, obj.callback);
        }
    } catch (err) {
        adapter.log.warn(`listLocalSticks: ${err.message}`);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, [], obj.callback);
        }
    }
}

/**
 * Preflight network analysis for stick redirect IP.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleAnalyzeLocalNetwork(adapter, obj) {
    const message = (obj && obj.message) || {};
    try {
        const analysis = await analyzeLocalNetwork({
            froniusIp: String(adapter.config.froniusIp || message.froniusIp || '').trim(),
            preferredIp: String(message.advertisedModbusIp || adapter.config.advertisedModbusIp || '').trim(),
            port: Number(message.localPort || adapter.config.localPort || 5279),
            proxyAlreadyListening: !!(adapter.localServer && adapter.localServer.listening),
        });
        if (analysis.ip) {
            adapter.config.advertisedModbusIp = analysis.ip;
            await adapter.setStateAsync('info.localIpHint', { val: analysis.ip, ack: true });
            await adapter.setStateAsync('info.advertisedModbusIp', { val: analysis.ip, ack: true });
        }
        const hint = String(analysis.summary || '').slice(0, 240);
        await adapter.setStateAsync('info.setupStatus', { val: hint, ack: true });
        await adapter.setStateAsync('info.localNetworkHint', { val: hint, ack: true });
        if (obj.callback) {
            adapter.sendTo(
                obj.from,
                obj.command,
                {
                    result: analysis.summary,
                    ok: analysis.ok,
                    native: {
                        advertisedModbusIp: analysis.ip || adapter.config.advertisedModbusIp || '',
                    },
                    analysis,
                },
                obj.callback,
            );
        }
    } catch (err) {
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
        }
    }
}

/**
 * selectSendTo — host LAN IPs for stick server redirect.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {ioBroker.Message} obj
 */
async function handleListLocalHostIps(adapter, obj) {
    try {
        const analysis = await analyzeLocalNetwork({
            froniusIp: String(adapter.config.froniusIp || '').trim(),
            preferredIp: String(adapter.config.advertisedModbusIp || '').trim(),
            port: Number(adapter.config.localPort || 5279),
            proxyAlreadyListening: !!(adapter.localServer && adapter.localServer.listening),
        });
        const options = hostIpSelectOptions(analysis);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, options, obj.callback);
        }
    } catch (err) {
        adapter.log.warn(`listLocalHostIps: ${err.message}`);
        if (obj.callback) {
            adapter.sendTo(obj.from, obj.command, [], obj.callback);
        }
    }
}

/** @internal */
function _clearStickListCache() {
    stickListCache.clear();
}

module.exports = {
    handleConnectShineLocal,
    handleListLocalPlants,
    handleListLocalSticks,
    handleAnalyzeLocalNetwork,
    handleListLocalHostIps,
    loadAllStickOptions,
    _clearStickListCache,
};
