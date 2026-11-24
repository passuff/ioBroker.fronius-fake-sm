'use strict';

/**
 * Stick may still have reg 17 = our IP. While true the :5279 proxy must listen
 * (with cloud forward) — otherwise the stick is orphaned and also offline at Shine,
 * which in turn blocks every remote command (lockout).
 * @param {object} cfg adapter.config / native
 * @returns {boolean}
 */
function stickMayPointAtProxy(cfg) {
    const c = cfg || {};
    return !!(c.localSetupPending || c.localSetupVerified || c.cloudStickRedirectActive);
}

/**
 * Keep :5279 listening even in Cloud mode / after reinstall (opt-out via localProxyAlwaysOn=false).
 * Only applies to Growatt; other manufacturers leave the proxy off.
 * @param {object} cfg adapter.config / native
 * @returns {boolean}
 */
function proxyAlwaysOn(cfg) {
    const c = cfg || {};
    if (String(c.manufacturer || 'growatt') !== 'growatt') {
        return false;
    }
    return c.localProxyAlwaysOn !== false;
}

/**
 * A stick connected to our proxy → it is redirected. Persist that once so a later
 * restart keeps the proxy up even when pending/verified were cleared.
 * Only writes native when nothing else keeps the proxy alive (native write = restart).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<boolean>} true when native was written
 */
async function rememberStickRedirect(adapter) {
    const cfg = adapter.config;
    if (stickMayPointAtProxy(cfg) || adapter._restoreInProgress) {
        return false;
    }
    const sn = String(cfg.localStickSn || cfg.cloudStickRedirectSn || '').trim();
    cfg.cloudStickRedirectActive = true;
    cfg.cloudStickRedirectSn = sn;
    const { persistNative } = require('./persistNative');
    const result = await persistNative(
        adapter,
        (native) => {
            if (native.cloudStickRedirectActive === true) {
                return;
            }
            native.cloudStickRedirectActive = true;
            native.cloudStickRedirectSn = sn;
        },
        'rememberStickRedirect',
    );
    if (result.wrote) {
        adapter.log.warn('Stick verbindet sich auf den lokalen Proxy — Umleitung gemerkt, Proxy bleibt aktiv');
    }
    return result.wrote;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{_clients?:Set<any>}} server
 * @returns {number}
 */
function clientCount(server) {
    return server && server._clients ? server._clients.size : 0;
}

/**
 * Wait until any stick holds a TCP session on the proxy.
 * @param {object} server GrowattServer
 * @param {number} timeoutMs
 * @param {number} [pollMs]
 * @returns {Promise<boolean>}
 */
async function waitForStickClient(server, timeoutMs, pollMs = 1000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (clientCount(server) > 0) {
            return true;
        }
        await sleep(pollMs);
    }
    return clientCount(server) > 0;
}

/**
 * After a redirect-to-cloud command: the stick must drop its session and must not
 * come back within quietMs. Sessions still open after disconnectMs are closed so the
 * stick reconnects with its current server setting.
 * @param {object} server GrowattServer (needs connectCount + _clients)
 * @param {object} [opts]
 * @param {number} [opts.disconnectMs]
 * @param {number} [opts.quietMs]
 * @param {number} [opts.pollMs]
 * @returns {Promise<{left:boolean, reason:string}>}
 */
async function verifyStickLeftProxy(server, opts = {}) {
    const disconnectMs = Number(opts.disconnectMs ?? 30000);
    const quietMs = Number(opts.quietMs ?? 60000);
    const pollMs = Number(opts.pollMs ?? 1000);

    const dropUntil = Date.now() + disconnectMs;
    while (clientCount(server) > 0 && Date.now() < dropUntil) {
        await sleep(pollMs);
    }
    if (clientCount(server) > 0 && typeof server.dropClients === 'function') {
        server.dropClients();
    }
    const baseline = Number(server.connectCount || 0);
    const quietUntil = Date.now() + quietMs;
    while (Date.now() < quietUntil) {
        if (Number(server.connectCount || 0) > baseline || clientCount(server) > 0) {
            return { left: false, reason: 'stick_reconnected' };
        }
        await sleep(pollMs);
    }
    return { left: true, reason: 'quiet' };
}

/**
 * Stick is online but SERVERIP is not our local proxy — fall back to cloud poll.
 * The stick verifiably points elsewhere, so the redirect memory is cleared too.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} currentIp
 * @returns {Promise<{fellBack:boolean, text?:string}>}
 */
async function maybeFallbackUnpatchedLocal(adapter, currentIp) {
    if (String(adapter.config.growattFeedMode || 'cloud') !== 'local') {
        return { fellBack: false };
    }
    const { looksLikeServerHost, isLocalProxyRedirect } = require('./cloudStickRedirect');
    const host = String(currentIp || '').trim();
    if (!looksLikeServerHost(host)) {
        return { fellBack: false };
    }
    const adv = String(adapter.config.advertisedModbusIp || '').trim();
    if (adv) {
        if (host.toLowerCase() === adv.toLowerCase()) {
            return { fellBack: false };
        }
    } else if (isLocalProxyRedirect(host, adv)) {
        // No advertised IP yet — any non-cloud host is acceptable.
        return { fellBack: false };
    }
    const text = `Stick online, aber SERVERIP=${host} zeigt nicht auf den lokalen Proxy — Fallback auf Cloud-Poll`;
    adapter.log.warn(text);
    adapter.config.growattFeedMode = 'cloud';
    adapter.config.localSetupPending = false;
    adapter.config.cloudStickRedirectActive = false;
    if (typeof adapter.setStateAsync === 'function') {
        await adapter.setStateAsync('info.connection', { val: false, ack: true });
        await adapter.setStateAsync('info.lastError', { val: text.slice(0, 240), ack: true });
        await adapter.setStateAsync('info.setupStatus', { val: text.slice(0, 240), ack: true });
    }
    const { persistNative } = require('./persistNative');
    await persistNative(
        adapter,
        {
            growattFeedMode: 'cloud',
            localSetupPending: false,
            cloudStickRedirectActive: false,
        },
        'fallbackUnpatchedLocal',
    );
    return { fellBack: true, text };
}

module.exports = {
    maybeFallbackUnpatchedLocal,
    stickMayPointAtProxy,
    proxyAlwaysOn,
    rememberStickRedirect,
    waitForStickClient,
    verifyStickLeftProxy,
    clientCount,
};
