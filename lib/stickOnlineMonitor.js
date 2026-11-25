'use strict';

const { MSG, sessionFromAdapter } = require('./stickOnline');
const { refreshStickStatus, publishStickStatus, deriveStickStatus } = require('./stickStatus');
const { clientCount } = require('./stickRedirectGuard');

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

    const tick = async () => {
        if (adapter._stopping) {
            return;
        }
        const manufacturer = String(adapter.config.manufacturer || 'growatt');
        if (manufacturer !== 'growatt') {
            return;
        }
        const cred = sessionFromAdapter(adapter);
        let delayMs = 15 * 60 * 1000;
        const localConnected = clientCount(adapter.localServer) > 0;

        if (cred.error) {
            const snap = deriveStickStatus({
                listOnline: null,
                localConnected,
                advertisedIp: adapter.config.advertisedModbusIp,
                cfg: adapter.config,
            });
            snap.text = localConnected
                ? `online · lokal am Proxy · ${MSG.waitingCreds}`
                : MSG.waitingCreds;
            await publishStickStatus(adapter, snap);
            delayMs = 5 * 60 * 1000;
        } else if (
            !String(adapter.config.localStickSn || adapter.config.cloudStickRedirectSn || '').trim()
        ) {
            const snap = deriveStickStatus({
                listOnline: null,
                localConnected,
                advertisedIp: adapter.config.advertisedModbusIp,
                cfg: adapter.config,
            });
            if (!localConnected) {
                snap.text = MSG.waitingStick;
            }
            await publishStickStatus(adapter, snap);
            delayMs = 5 * 60 * 1000;
        } else {
            try {
                adapter.log.debug('stick status monitor: probing…');
                const snap = await refreshStickStatus(adapter);
                // refreshStickStatus already reconciles all registry SNs via SERVERIP probes
                delayMs = snap.online ? 20 * 60 * 1000 : 10 * 60 * 1000;
            } catch (err) {
                adapter.log.warn(`stick status monitor: ${err.message}`);
                delayMs = 10 * 60 * 1000;
            }
        }
        if (!adapter._stopping) {
            adapter._stickOnlineTimer = setTimeout(() => {
                void tick();
            }, delayMs);
        }
    };

    const first = Number(opts.firstDelayMs ?? 8000);
    adapter._stickOnlineTimer = setTimeout(() => {
        void tick();
    }, first);
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
};
