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
 * Keep :5279 listening even in Cloud mode / after reinstall.
 * Always on for Growatt (not user-configurable). Other manufacturers leave the proxy off.
 * @param {object} cfg adapter.config / native
 * @returns {boolean}
 */
function proxyAlwaysOn(cfg) {
    const c = cfg || {};
    return String(c.manufacturer || 'growatt') === 'growatt';
}

/**
 * A stick connected to our proxy → it is redirected. Persist that SN in the registry
 * so a later restart keeps the proxy up even when pending/verified were cleared.
 * Only writes native when this SN is not yet registered (native write = restart).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} [stickSn]
 * @returns {Promise<boolean>} true when native was written
 */
async function rememberStickRedirect(adapter, stickSn) {
    const cfg = adapter.config;
    if (adapter._restoreInProgress) {
        return false;
    }
    const { getStickEntry, upsertStick, persistRegistry } = require('./stickRedirectRegistry');
    const sn = String(stickSn || cfg.localStickSn || cfg.cloudStickRedirectSn || '').trim();
    if (!sn) {
        return false;
    }
    if (getStickEntry(cfg, sn)) {
        return false;
    }
    upsertStick(cfg, sn, {
        state: 'redirected',
        serverIp: String(cfg.advertisedModbusIp || '').trim() || undefined,
    });
    // Mid/post-setup native write restarts the adapter and orphans Admin busy UI
    const { shouldDeferNativeVerify } = require('./setupQuiet');
    if (shouldDeferNativeVerify(adapter)) {
        adapter._deferredVerifySn = adapter._deferredVerifySn || sn;
        return false;
    }
    const result = await persistRegistry(adapter, 'rememberStickRedirect');
    if (result.wrote) {
        adapter.log.warn(
            `Stick ${sn} verbindet sich auf den lokalen Proxy — Umleitung gemerkt, Proxy bleibt aktiv`,
        );
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
 * @param {object} server
 * @param {string} [sn]
 * @returns {boolean}
 */
function hasStickSession(server, sn) {
    if (!server) {
        return false;
    }
    const key = String(sn || '').trim();
    if (!key) {
        return clientCount(server) > 0;
    }
    if (typeof server.hasStickSn === 'function') {
        return !!server.hasStickSn(key);
    }
    const sock = server._stickBySn && server._stickBySn.get(key);
    return !!(sock && !sock.destroyed);
}

/**
 * Wait until a stick holds a TCP session on the proxy.
 * With sn: wait for that SN. Without sn: any client (legacy).
 * @param {object} server GrowattServer
 * @param {number} timeoutMs
 * @param {number} [pollMs]
 * @param {string} [sn]
 * @returns {Promise<boolean>}
 */
async function waitForStickClient(server, timeoutMs, pollMs = 1000, sn) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (hasStickSession(server, sn)) {
            return true;
        }
        await sleep(pollMs);
    }
    return hasStickSession(server, sn);
}

/**
 * After a redirect-to-cloud command: the stick must drop its session and must not
 * come back within quietMs. With sn: only that SN is watched (other sticks may stay).
 * @param {object} server GrowattServer
 * @param {string|object} snOrOpts SN string or legacy opts object
 * @param {object} [opts]
 * @returns {Promise<{left:boolean, reason:string}>}
 */
async function verifyStickLeftProxy(server, snOrOpts, opts) {
    let sn = '';
    let options = opts || {};
    if (snOrOpts && typeof snOrOpts === 'object' && !Array.isArray(snOrOpts)) {
        // legacy: verifyStickLeftProxy(server, opts)
        options = snOrOpts;
        sn = String(options.sn || '').trim();
    } else {
        sn = String(snOrOpts || '').trim();
    }
    const disconnectMs = Number(options.disconnectMs ?? 30000);
    const quietMs = Number(options.quietMs ?? 60000);
    const pollMs = Number(options.pollMs ?? 1000);

    const dropUntil = Date.now() + disconnectMs;
    while (hasStickSession(server, sn) && Date.now() < dropUntil) {
        await sleep(pollMs);
    }
    if (hasStickSession(server, sn)) {
        if (sn && typeof server.dropClientBySn === 'function') {
            server.dropClientBySn(sn);
        } else if (!sn && typeof server.dropClients === 'function') {
            server.dropClients();
        }
    }

    if (sn) {
        const quietUntil = Date.now() + quietMs;
        while (Date.now() < quietUntil) {
            if (hasStickSession(server, sn)) {
                return { left: false, reason: 'stick_reconnected' };
            }
            await sleep(pollMs);
        }
        return { left: true, reason: 'quiet' };
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
 * Stick SERVERIP is not our local proxy.
 * - sn not in registry: status text only, no feed-mode change.
 * - sn in registry: remove that entry; switch to cloud only if registry empty.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} currentIp
 * @param {string} [stickSn]
 * @returns {Promise<{fellBack:boolean, text?:string, removed?:boolean}>}
 */
async function maybeFallbackUnpatchedLocal(adapter, currentIp, stickSn) {
    const { looksLikeServerHost, isLocalProxyRedirect } = require('./cloudStickRedirect');
    const {
        getStickEntry,
        removeStick,
        listRedirectedSns,
        persistRegistry,
        cloneRegistry,
    } = require('./stickRedirectRegistry');
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
        return { fellBack: false };
    }

    // Mid-setup native demotion restarts the adapter and aborts redirectToLocal.
    if (adapter && adapter._setupInProgress) {
        return { fellBack: false, removed: false };
    }

    const sn = String(stickSn || adapter.config.localStickSn || '').trim();
    const entry = sn ? getStickEntry(adapter.config, sn) : null;
    const inRegistry = !!entry;
    const feedLocal = String(adapter.config.growattFeedMode || 'cloud') === 'local';

    // Orphan registry rows must be demoted even when feedMode is already cloud.
    // Unknown SNs only emit status text while in local feed (unchanged).
    if (!inRegistry) {
        if (!feedLocal) {
            return { fellBack: false };
        }
        const text = sn
            ? `Stick ${sn} online, SERVERIP=${host} (Growatt-Cloud) — nicht gepatcht`
            : `Stick online, SERVERIP=${host} zeigt nicht auf den lokalen Proxy — nicht gepatcht`;
        if (typeof adapter.setStateAsync === 'function') {
            await adapter.setStateAsync('info.setupStatus', { val: text.slice(0, 240), ack: true });
        }
        return { fellBack: false, text, removed: false };
    }

    // Pending: Shine still reports old cloud SERVERIP until the stick reboots.
    if (entry && entry.state === 'pending') {
        return { fellBack: false, removed: false };
    }

    removeStick(adapter.config, sn);
    const remaining = listRedirectedSns(adapter.config);
    if (remaining.length > 0) {
        const text = `Stick ${sn} SERVERIP=${host} — Eintrag entfernt; ${remaining.length} andere Stick(s) bleiben lokal`;
        adapter.log.warn(text);
        if (typeof adapter.setStateAsync === 'function') {
            await adapter.setStateAsync('info.setupStatus', { val: text.slice(0, 240), ack: true });
        }
        await persistRegistry(adapter, 'fallbackUnpatchedLocalSn');
        return { fellBack: false, text, removed: true };
    }

    const text = `Stick ${sn || ''} online, aber SERVERIP=${host} zeigt nicht auf den lokalen Proxy — Fallback auf Cloud-Poll`;
    adapter.log.warn(text);
    adapter.config.growattFeedMode = 'cloud';
    adapter.config.localSetupPending = false;
    adapter.config.localSetupVerified = false;
    adapter.config.cloudStickRedirectActive = false;
    adapter.config.cloudStickRedirectSn = '';
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
            localSetupVerified: false,
            cloudStickRedirectActive: false,
            cloudStickRedirectSn: '',
            stickRedirects: cloneRegistry(adapter.config.stickRedirects),
        },
        'fallbackUnpatchedLocal',
    );
    return { fellBack: true, text, removed: true };
}

module.exports = {
    maybeFallbackUnpatchedLocal,
    stickMayPointAtProxy,
    proxyAlwaysOn,
    rememberStickRedirect,
    waitForStickClient,
    verifyStickLeftProxy,
    clientCount,
    hasStickSession,
};
