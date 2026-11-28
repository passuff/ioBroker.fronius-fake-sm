'use strict';

const { MSG, sessionFromAdapter } = require('./stickOnline');
const { refreshStickStatus, publishStickStatus, deriveStickStatus } = require('./stickStatus');
const { clientCount } = require('./stickRedirectGuard');
const { fireAndLog } = require('./asyncSafe');
const { isShineAuthBackingOff } = require('./localStatusAdmin');

const SHINE_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Publish local-proxy-only stick status (no Shine /login).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {boolean} localConnected
 * @param {string} [hint]
 */
async function publishLocalOnlyStatus(adapter, localConnected, hint) {
    const snap = deriveStickStatus({
        listOnline: null,
        localConnected,
        advertisedIp: adapter.config.advertisedModbusIp,
        cfg: adapter.config,
        localStickSn: adapter.config.localStickSn || adapter.config.cloudStickRedirectSn || '',
        localPeerIp: adapter._localPeerIp || '',
    });
    if (hint) {
        snap.text = localConnected ? `online · lokal am Proxy · ${hint}` : hint;
    }
    await publishStickStatus(adapter, snap);
    return snap;
}

/**
 * Background stick status probe (Shine + local proxy). Runs in Cloud and Lokal
 * so the admin UI never shows a stale offline after a reconnect.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [opts]
 * @param {number} [opts.firstDelayMs]
 */
function startStickOnlineMonitor(adapter, opts = {}) {
    if (adapter._stickOnlineTimer) {
        clearTimeout(adapter._stickOnlineTimer);
        adapter._stickOnlineTimer = null;
    }

    const schedule = (delayMs) => {
        if (adapter._stopping) {
            return;
        }
        adapter._stickOnlineTimer = setTimeout(() => {
            fireAndLog(adapter, 'stickOnlineMonitor.tick', () => tick());
        }, delayMs);
    };

    const tick = async () => {
        if (adapter._stopping) {
            return;
        }
        const manufacturer = String(adapter.config.manufacturer || 'growatt');
        if (manufacturer !== 'growatt') {
            return;
        }
        let delayMs = 15 * 60 * 1000;
        try {
            const cred = sessionFromAdapter(adapter);
            const localConnected = clientCount(adapter.localServer) > 0;

            if (cred.error) {
                await publishLocalOnlyStatus(
                    adapter,
                    localConnected,
                    localConnected ? MSG.waitingCreds : MSG.waitingCreds,
                );
                delayMs = 5 * 60 * 1000;
            } else if (
                !String(adapter.config.localStickSn || adapter.config.cloudStickRedirectSn || '').trim()
            ) {
                const snap = await publishLocalOnlyStatus(adapter, localConnected);
                if (!localConnected) {
                    snap.text = MSG.waitingStick;
                    await publishStickStatus(adapter, snap);
                }
                delayMs = 5 * 60 * 1000;
            } else if (isShineAuthBackingOff(adapter)) {
                await publishLocalOnlyStatus(
                    adapter,
                    localConnected,
                    'Shine-Backoff — nur lokaler Proxy-Status',
                );
                const left = Math.max(60 * 1000, Number(adapter._shineAuthUntil || 0) - Date.now());
                delayMs = Math.min(SHINE_COOLDOWN_MS, left);
            } else {
                adapter.log.debug('stick status monitor: probing…');
                const snap = await refreshStickStatus(adapter);
                if (isShineAuthBackingOff(adapter)) {
                    delayMs = Math.min(
                        SHINE_COOLDOWN_MS,
                        Math.max(60 * 1000, Number(adapter._shineAuthUntil || 0) - Date.now()),
                    );
                } else {
                    delayMs = snap.online ? 20 * 60 * 1000 : 10 * 60 * 1000;
                }
            }
        } catch (err) {
            adapter.log.warn(`stick status monitor: ${err && err.message ? err.message : err}`);
            delayMs = 10 * 60 * 1000;
        } finally {
            schedule(delayMs);
        }
    };

    const first = Number(opts.firstDelayMs ?? 8000);
    schedule(first);
    adapter.log.info(`Stick-Status-Monitor aktiv (erste Prüfung in ${Math.round(first / 1000)}s)`);
}

function stopStickOnlineMonitor(adapter) {
    if (adapter._stickOnlineTimer) {
        clearTimeout(adapter._stickOnlineTimer);
        adapter._stickOnlineTimer = null;
    }
}

module.exports = {
    startStickOnlineMonitor,
    stopStickOnlineMonitor,
    publishLocalOnlyStatus,
};
