'use strict';

const { analyzeLocalNetwork } = require('./localNetworkAnalyze');
const { scanLocalStickPorts, tryTouchApStick } = require('./stickApScan');
const { MSG } = require('./stickMessages');

/**
 * Resolve the LAN IP that will be written to the stick (network analysis).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
async function resolveSetupServerIp(adapter, message) {
    const msg = message && typeof message === 'object' ? message : {};
    const preferred = String(
        msg.advertisedModbusIp || adapter.config.advertisedModbusIp || '',
    ).trim();
    const froniusIp = String(adapter.config.froniusIp || '').trim();
    const port = Number(msg.localPort || adapter.config.localPort || 5279);
    const analysis = await analyzeLocalNetwork({
        froniusIp,
        preferredIp: preferred,
        port,
        proxyAlreadyListening: !!(adapter.localServer && adapter.localServer.listening),
    });
    if (analysis.ip) {
        adapter.config.advertisedModbusIp = analysis.ip;
    }
    return analysis;
}

/**
 * Arm proxy in memory before redirect. Returns false if bind failed.
 * Native config is intentionally not written here (restart would kill setup).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} serverIp
 * @returns {Promise<boolean>}
 */
async function ensureLocalProxyReady(adapter, serverIp) {
    // In-memory only — listen for stick reconnect after redirect; do NOT enable local switch yet
    adapter.config.localSetupPending = true;
    adapter.config.growattFeedMode = 'local';

    if (!adapter.localServer) {
        const { startLocalProxyIfEnabled } = require('./localProxy');
        adapter.localServer = await startLocalProxyIfEnabled(adapter);
    }
    if (!adapter.localServer) {
        await adapter.setStateAsync('info.setupStatus', {
            val: 'Lokaler Proxy startet nicht (Port 5279 belegt?) — Redirect abgebrochen.',
            ack: true,
        });
        return false;
    }
    adapter.localServer.redirectServerIp = serverIp;
    adapter.localServer.redirectServerPort = Number(adapter.config.localPort ?? 5279);
    adapter.localServer.autoPersistRedirect = true;
    await adapter.setStateAsync('info.localIpHint', { val: serverIp, ack: true });
    await adapter.setStateAsync('info.setupStatus', {
        val: 'Warte auf lokale Stick-Verbindung zur Bestätigung…',
        ack: true,
    });
    return true;
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} serverIp
 */
async function runApFallback(adapter, serverIp) {
    await adapter.setStateAsync('info.setupStatus', {
        val: 'Suche Stick im AP-Modus (:5280)…',
        ack: true,
    });

    const open = await scanLocalStickPorts({
        log: (m) => adapter.log.info(m),
        maxHosts: 256,
    });

    if (!open.length) {
        return { ok: false, error: 'no_ap_stick', hint: MSG.apOnlyHint };
    }

    const touches = [];
    for (const h of open) {
        touches.push(await tryTouchApStick(h, serverIp, Number(adapter.config.localPort ?? 5279)));
    }

    const text = MSG.apOk(open, serverIp);
    await adapter.setStateAsync('info.setupStatus', { val: text, ack: true });
    return {
        ok: true,
        mode: 'ap_fallback',
        serverIp,
        apHosts: open,
        touches,
        result: text,
    };
}

module.exports = {
    resolveSetupServerIp,
    ensureLocalProxyReady,
    runApFallback,
};
