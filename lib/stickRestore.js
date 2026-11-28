'use strict';

const {
    MSG,
    sessionFromAdapter,
    isCloudOk,
    isPermissionDenied,
    LOGGER_REG,
} = require('./stickOnline');
const { scanLocalStickPorts, tryTouchApStick } = require('./stickApScan');
const { publishLocalWorkflowStatus } = require('./localWorkflowStatus');
const {
    waitForStickClient,
    verifyStickLeftProxy,
    rememberStickRedirect,
    proxyAlwaysOn,
} = require('./stickRedirectGuard');
const {
    removeStick,
    listRedirectedSns,
    persistRegistry,
    cloneRegistry,
    applyAggregateFlags,
} = require('./stickRedirectRegistry');

const CLOUD_HOST = 'server.growatt.com';
const CLOUD_PORT = 5279;
/** Mutable so tests can shorten the waits. */
const RESTORE_TIMING = {
    waitStickMs: 45000,
    waitShineMs: 60000,
    waitShineNoLocalMs: 15000,
    shinePollMs: 10000,
    disconnectMs: 30000,
    quietMs: 60000,
    clearDelayMs: 1500,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLEARED_NATIVE = {
    growattFeedMode: 'cloud',
    localEnabled: false,
    localSetupPending: false,
    localSetupVerified: false,
    cloudStickRedirectActive: false,
    cloudStickRedirectSn: '',
    stickRedirects: {},
};

/**
 * Clear local-mode + redirect flags. Growatt keeps the proxy (always-on).
 * Only call after the stick verifiably left the proxy — otherwise it gets orphaned.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function clearLocalModeToCloud(adapter) {
    Object.assign(adapter.config, CLEARED_NATIVE);
    const { persistNative } = require('./persistNative');
    await persistNative(adapter, { ...CLEARED_NATIVE }, 'clearLocalModeToCloud');
    adapter._localConnected = false;
    try {
        await adapter.setStateAsync('info.localEnabled', { val: false, ack: true });
        await adapter.setStateAsync('info.localSetupVerified', { val: false, ack: true });
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        await publishLocalWorkflowStatus(adapter, { connected: false });
    } catch {
        // instance may be restarting
    }
    // Always-on keeps :5279 ready for a future redirect / reinstall safety
    if (adapter.localServer && !proxyAlwaysOn(adapter.config)) {
        try {
            await adapter.localServer.stop();
        } catch (err) {
            adapter.log.warn(`stop local proxy on restore: ${err.message}`);
        }
        adapter.localServer = null;
    }
}

/**
 * Remove one SN from the registry. Clear to cloud only when empty.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} sn
 * @param {object} info
 */
async function succeedRemoveStick(adapter, sn, info) {
    await setStatus(adapter, info.result);
    removeStick(adapter.config, sn);
    applyAggregateFlags(adapter.config);
    const remaining = listRedirectedSns(adapter.config);
    setTimeout(() => {
        void (async () => {
            if (remaining.length === 0) {
                await clearLocalModeToCloud(adapter);
            } else {
                await persistRegistry(adapter, 'restoreCloudStickPartial');
                await publishLocalWorkflowStatus(adapter);
            }
        })();
    }, RESTORE_TIMING.clearDelayMs);
    const native =
        remaining.length === 0
            ? { ...CLEARED_NATIVE, stickStatusText: info.result }
            : {
                  stickRedirects: cloneRegistry(adapter.config.stickRedirects),
                  localSetupPending: !!adapter.config.localSetupPending,
                  localSetupVerified: !!adapter.config.localSetupVerified,
                  cloudStickRedirectActive: !!adapter.config.cloudStickRedirectActive,
                  cloudStickRedirectSn: String(adapter.config.cloudStickRedirectSn || ''),
                  stickStatusText: info.result,
              };
    return { ok: true, ...info, native };
}

/**
 * FC 0x18 (+reboot) on the stick session(s) held by our proxy.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} stickSn
 * @param {string} [host]
 */
function tryLocalTcpRestore(adapter, stickSn, host = CLOUD_HOST) {
    const server = adapter.localServer;
    if (!server || typeof server.persistRedirect !== 'function') {
        return { ok: false, error: 'no_local_server' };
    }
    const ok = server.persistRedirect(stickSn, host, CLOUD_PORT, { reboot: true });
    return ok
        ? { ok: true, mode: 'local_tcp', stickSn, serverHost: host, port: CLOUD_PORT }
        : { ok: false, error: 'local_tcp_send_failed' };
}

/**
 * Cloud IPv4 for reg 17. The stick accepted an IPv4 there; a hostname write was not applied.
 * @param {object|null} server
 * @returns {Promise<string>}
 */
async function resolveCloudTarget(server) {
    try {
        if (server && server.resolver && typeof server.resolver.resolve === 'function') {
            const ip = String(await server.resolver.resolve());
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
                return ip;
            }
        }
    } catch {
        // fall back to hostname
    }
    return CLOUD_HOST;
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<object|null>}
 */
async function ensureCatchProxy(adapter) {
    if (!adapter.localServer) {
        const { startLocalProxyIfEnabled } = require('./localProxy');
        adapter.localServer = await startLocalProxyIfEnabled(adapter, { force: true });
    }
    if (adapter.localServer) {
        adapter.localServer.autoPersistRedirect = false;
    }
    return adapter.localServer;
}

/**
 * Poll Shine until the cloud can reach the stick (session via our forward).
 * @param {object} session GrowattShineSession
 * @param {string} sn
 * @param {number} timeoutMs
 */
async function waitShineReachable(session, sn, timeoutMs) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        let probe;
        try {
            probe = await session.getRegister(sn, LOGGER_REG.SERVERIP);
        } catch (err) {
            probe = { success: false, msg: err.message };
        }
        if (isPermissionDenied(probe)) {
            return { ok: false, denied: true };
        }
        if (isCloudOk(probe)) {
            return { ok: true };
        }
        if (Date.now() + RESTORE_TIMING.shinePollMs > until) {
            return { ok: false };
        }
        await sleep(RESTORE_TIMING.shinePollMs);
    }
}

async function setStatus(adapter, text) {
    adapter.log.info(text);
    await adapter.setStateAsync('info.setupStatus', { val: text, ack: true });
}

/**
 * Restore failed: keep proxy + remember redirect so the stick stays reachable.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} text
 * @param {boolean} stickSeen
 * @param {string} [sn]
 */
async function failKeepProxy(adapter, text, stickSeen, sn) {
    adapter._restoreInProgress = false;
    await setStatus(adapter, text);
    if (stickSeen) {
        await rememberStickRedirect(adapter, sn);
    }
    return { ok: false, error: text, native: {} };
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
async function runRestoreCloud(adapter, message) {
    const msg = message && typeof message === 'object' ? message : {};
    if (msg.localStickSn) {
        adapter.config.localStickSn = String(msg.localStickSn).trim();
    }
    const sn = String(
        msg.localStickSn || adapter.config.localStickSn || adapter.config.cloudStickRedirectSn || '',
    ).trim();
    if (!sn) {
        return { ok: false, error: MSG.noStickSn, native: {} };
    }

    adapter._restoreInProgress = true;
    try {
        await setStatus(adapter, MSG.restoreWaitStick);
        const server = await ensureCatchProxy(adapter);
        const stickSeen = server
            ? await waitForStickClient(server, RESTORE_TIMING.waitStickMs, 200, sn)
            : false;
        const target = await resolveCloudTarget(server);

        let sentVia = '';
        const { shineLoginBlockedReason, noteShineAuthFailure } = require('./localStatusAdmin');
        const shineBlocked = shineLoginBlockedReason(adapter);
        const cred = shineBlocked ? { error: shineBlocked } : sessionFromAdapter(adapter, message);
        if (!cred.error && sn) {
            try {
                await cred.session.login();
                await setStatus(adapter, MSG.restoreWaitShine(sn));
                const reach = await waitShineReachable(
                    cred.session,
                    sn,
                    stickSeen ? RESTORE_TIMING.waitShineMs : RESTORE_TIMING.waitShineNoLocalMs,
                );
                if (reach.denied) {
                    return failKeepProxy(adapter, MSG.permissionDenied(sn), stickSeen, sn);
                }
                if (reach.ok) {
                    await setStatus(adapter, MSG.restoreSending(sn, target, 'Shine-Remote'));
                    await cred.session.redirectServer(sn, target, CLOUD_PORT);
                    sentVia = 'remote';
                }
            } catch (err) {
                noteShineAuthFailure(adapter, err);
                adapter.log.warn(`restore cloud remote failed: ${err.message}`);
            }
        }
        if (!sentVia && stickSeen && sn) {
            await setStatus(adapter, MSG.restoreSending(sn, target, 'lokal FC 0x18'));
            if (tryLocalTcpRestore(adapter, sn, target).ok) {
                sentVia = 'local_tcp';
            }
        }

        if (sentVia) {
            if (stickSeen) {
                await setStatus(adapter, MSG.restoreVerifying);
                const check = await verifyStickLeftProxy(server, sn, {
                    disconnectMs: RESTORE_TIMING.disconnectMs,
                    quietMs: RESTORE_TIMING.quietMs,
                    pollMs: Math.min(1000, RESTORE_TIMING.quietMs / 10),
                });
                if (!check.left) {
                    return failKeepProxy(adapter, MSG.restoreStillLocal(sn), true, sn);
                }
            }
            return succeedRemoveStick(adapter, sn, {
                mode: sentVia,
                stickSn: sn,
                serverHost: target,
                port: CLOUD_PORT,
                verified: stickSeen,
                result: MSG.restoreOk(sn, target),
            });
        }

        // AP fallback — write cloud host via :5280
        const open = await scanLocalStickPorts({
            log: (m) => adapter.log.info(m),
            maxHosts: 256,
        });
        if (open.length) {
            for (const h of open) {
                await tryTouchApStick(h, target, CLOUD_PORT);
            }
            return succeedRemoveStick(adapter, sn, {
                mode: 'ap_fallback',
                apHosts: open,
                stickSn: sn,
                result: `AP-Stick (${open.join(', ')}) auf ${target}:${CLOUD_PORT} gesetzt. ${MSG.restoreOk(sn || 'Stick', target)}`,
            });
        }

        return failKeepProxy(adapter, cred.error || MSG.restoreNeedOnline, stickSeen, sn);
    } finally {
        adapter._restoreInProgress = false;
    }
}

module.exports = {
    CLOUD_HOST,
    CLOUD_PORT,
    RESTORE_TIMING,
    clearLocalModeToCloud,
    tryLocalTcpRestore,
    resolveCloudTarget,
    runRestoreCloud,
};
