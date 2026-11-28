'use strict';

const { LOGGER_REG } = require('./growattShineSession');
const {
    MSG,
    sessionFromAdapter,
    resolveStickSn,
    resolvePlantId,
    isCloudOk,
    isPermissionDenied,
    extractStickFw,
} = require('./stickOnline');
const { looksLikeServerHost, isLocalProxyRedirect } = require('./cloudStickRedirect');
const { clientCount, hasStickSession } = require('./stickRedirectGuard');
const { publishLocalWorkflowStatus, buildStickConfiguredLabel } = require('./localWorkflowStatus');
const { getStickEntry } = require('./stickRedirectRegistry');
const { isTestedStickFw } = require('./frameHealth');

/**
 * @typedef {object} StickStatusSnap
 * @property {boolean} shineOnline
 * @property {boolean} localConnected
 * @property {boolean} online
 * @property {string} target  hier|cloud|elsewhere|unknown
 * @property {string} targetLabel
 * @property {string} serverIp
 * @property {string} lastUpdate
 * @property {string} text
 * @property {string} configured
 * @property {string} [fw]
 * @property {string} [sn]
 */

/**
 * Derive one stick status from Shine list + SERVERIP + proxy client.
 * @param {object} opts
 * @returns {StickStatusSnap}
 */
function deriveStickStatus(opts = {}) {
    const cfg = opts.cfg || {};
    const sn = String(opts.localStickSn || cfg.localStickSn || cfg.cloudStickRedirectSn || '').trim();
    const entry = sn ? getStickEntry(cfg, sn) : null;
    const localConnected = !!opts.localConnected;
    const listOnline = opts.listOnline;
    const lastUpdate = String(opts.lastUpdate || '').trim();
    const fw = String(opts.fw || '').trim();
    const advertisedIp = String(opts.advertisedIp || cfg.advertisedModbusIp || '').trim();
    const localPeerIp = String(opts.localPeerIp || '').trim();
    let serverIp = looksLikeServerHost(opts.serverIp) ? String(opts.serverIp).trim() : '';
    const probeLive = opts.probeLive === true && !!serverIp;

    let target = 'unknown';
    if (probeLive) {
        if (advertisedIp && serverIp.toLowerCase() === advertisedIp.toLowerCase()) {
            target = 'hier';
        } else if (!isLocalProxyRedirect(serverIp, advertisedIp)) {
            target = 'cloud';
        } else {
            target = 'elsewhere';
        }
    } else if (localConnected || (entry && (entry.state === 'pending' || entry.state === 'verified' || entry.state === 'redirected'))) {
        target = 'hier';
        if (!serverIp && (entry && entry.serverIp)) {
            serverIp = String(entry.serverIp);
        } else if (!serverIp && advertisedIp) {
            serverIp = advertisedIp;
        }
    }

    let targetLabel = 'unbekannt';
    if (target === 'hier') {
        targetLabel = serverIp ? `hier (${serverIp})` : 'hier (lokaler Proxy)';
    } else if (target === 'cloud') {
        targetLabel = 'Growatt-Cloud';
    } else if (target === 'elsewhere') {
        targetLabel = serverIp ? `anderer Host (${serverIp})` : 'anderer Host';
    }

    const shineOnline = listOnline === true;
    const online = shineOnline || localConnected;
    const parts = [];
    parts.push(online ? 'online' : 'offline');
    if (sn) {
        parts.push(`SN ${sn}`);
    }
    if (localConnected && !shineOnline) {
        parts.push('lokal am Proxy');
    } else if (shineOnline && localConnected) {
        parts.push('Shine + lokal');
    } else if (shineOnline) {
        parts.push('Shine');
    } else if (!localConnected) {
        parts.push('nicht am Proxy');
    }
    if (localConnected && localPeerIp) {
        parts.push(`Peer ${localPeerIp}`);
    }
    if (target === 'hier') {
        parts.push(serverIp ? `zeigt auf ${serverIp}` : 'zeigt auf diesen Host');
        if (cfg.localForwardCloud !== false) {
            parts.push('Cloud-Forward aktiv');
        }
    } else if (target === 'cloud') {
        parts.push('zeigt auf Growatt-Cloud');
    } else if (target === 'elsewhere') {
        parts.push(`zeigt auf ${serverIp || 'anderen Host'}`);
    }
    if (lastUpdate) {
        parts.push(`Update ${lastUpdate}`);
    }
    if (fw) {
        parts.push(`FW ${fw}${isTestedStickFw(fw) ? '' : ' ungetestet'}`);
    }
    const text = parts.join(' · ');
    const configured = buildStickConfiguredLabel(entry || cfg, {
        sn,
        _liveTarget: target,
        _liveServerIp: serverIp,
    });

    return {
        shineOnline,
        localConnected,
        online,
        target,
        targetLabel,
        serverIp,
        lastUpdate,
        fw,
        text,
        configured,
        sn,
    };
}

/**
 * Publish stick status to states only (no native writes → no adapter restart).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {StickStatusSnap} snap
 */
async function publishStickStatus(adapter, snap) {
    adapter._stickStatusSnap = snap;
    try {
        await adapter.setStateAsync('info.stickOnline', { val: !!snap.online, ack: true });
        await adapter.setStateAsync('info.stickOnlineLabel', {
            val: snap.online ? MSG.labelOnline : MSG.labelOffline,
            ack: true,
        });
        await adapter.setStateAsync('info.stickStatus', { val: snap.text, ack: true });
        await adapter.setStateAsync('info.stickTarget', { val: snap.targetLabel, ack: true });
        await adapter.setStateAsync('info.wfStickConfigured', { val: snap.configured, ack: true });
        if (snap.fw != null) {
            adapter._stickFw = snap.fw;
            await adapter.setStateAsync('info.stickFw', { val: snap.fw, ack: true });
        }
        await publishLocalWorkflowStatus(adapter, {
            connected: snap.localConnected,
            sn: snap.sn,
            _liveTarget: snap.target,
        });
    } catch (err) {
        if (adapter.log && adapter.log.warn) {
            adapter.log.warn(`publishStickStatus: ${err.message}`);
        }
    }
    return snap;
}

/**
 * Immediate local-only publish (proxy connect/disconnect).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {boolean} [connected]
 * @param {string} [stickSn]
 */
async function publishLocalStickPresence(adapter, connected, stickSn) {
    const sn = String(stickSn || adapter.config.localStickSn || adapter.config.cloudStickRedirectSn || '').trim();
    const localConnected =
        connected != null
            ? !!connected
            : sn
              ? hasStickSession(adapter.localServer, sn)
              : clientCount(adapter.localServer) > 0;
    if (!sn) {
        adapter._localConnected = localConnected;
    }
    try {
        await adapter.setStateAsync('info.localConnection', {
            val: clientCount(adapter.localServer) > 0,
            ack: true,
        });
    } catch {
        // ignore
    }
    const prev = adapter._stickStatusSnap || {};
    const snap = deriveStickStatus({
        listOnline: prev.shineOnline != null ? prev.shineOnline : null,
        lastUpdate: prev.lastUpdate || '',
        serverIp: prev.serverIp || '',
        probeLive: !!prev.serverIp,
        localConnected,
        advertisedIp: adapter.config.advertisedModbusIp,
        fw: prev.fw || adapter._stickFw || '',
        localStickSn: sn,
        localPeerIp: adapter._localPeerIp || '',
        cfg: adapter.config,
    });
    return publishStickStatus(adapter, snap);
}

/**
 * Full refresh: Shine list + SERVERIP + proxy client → states.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 * @returns {Promise<StickStatusSnap>}
 */
async function refreshStickStatus(adapter, message) {
    const stickSn = await resolveStickSn(adapter, null, message);
    const localConnected = stickSn
        ? hasStickSession(adapter.localServer, stickSn)
        : clientCount(adapter.localServer) > 0;
    if (!stickSn) {
        adapter._localConnected = localConnected;
    }
    const advertisedIp = String(adapter.config.advertisedModbusIp || '').trim();

    let listOnline = null;
    let lastUpdate = '';
    let serverIp = '';
    let probeLive = false;
    let fw = String(adapter._stickFw || '').trim();

    const { isShineAuthBackingOff, noteShineAuthFailure, clearShineAuthBackoff } = require('./localStatusAdmin');
    const skipShine = isShineAuthBackingOff(adapter);
    const cred = skipShine ? { error: 'backoff' } : sessionFromAdapter(adapter, message);
    if (!cred.error) {
        try {
            await cred.session.login();
            const plantId = resolvePlantId(adapter, message);
            if (stickSn) {
                if (plantId) {
                    const sticks = await cred.session.listDataloggers(plantId);
                    const row = sticks.find((s) => s.sn === stickSn);
                    if (row) {
                        listOnline = !row.lost;
                        lastUpdate = row.lastUpdateTime || '';
                        const extracted = extractStickFw(row.raw);
                        if (extracted) {
                            fw = extracted;
                            adapter.log.debug(
                                `stick FW keys sample: ${Object.keys(row.raw || {}).slice(0, 20).join(',')}`,
                            );
                        }
                    }
                }
                try {
                    const probe = await cred.session.getRegister(stickSn, LOGGER_REG.SERVERIP);
                    if (isPermissionDenied(probe)) {
                        // keep defaults
                    } else if (isCloudOk(probe) && looksLikeServerHost(probe.msg)) {
                        serverIp = String(probe.msg).trim();
                        probeLive = true;
                    }
                } catch {
                    // ignore probe errors
                }
            }
            clearShineAuthBackoff(adapter);
        } catch (err) {
            if (cred.session && typeof cred.session.invalidate === 'function') {
                cred.session.invalidate();
            }
            noteShineAuthFailure(adapter, err);
            adapter.log.warn(`refreshStickStatus Shine: ${err.message}`);
        }
    }

    const deriveArgs = {
        listOnline,
        lastUpdate,
        serverIp,
        probeLive,
        localConnected,
        advertisedIp,
        fw,
        localStickSn: stickSn || adapter.config.localStickSn || adapter.config.cloudStickRedirectSn || '',
        localPeerIp: adapter._localPeerIp || '',
        cfg: adapter.config,
    };
    try {
        const { reconcileRedirectRegistry, defaultProbeServerIp } = require('./stickRedirectReconcile');
        // Primary probe result seeds demotion for this SN; reconcile covers all registry SNs.
        const probeMap =
            probeLive && stickSn && serverIp
                ? { [String(stickSn).trim()]: serverIp }
                : {};
        await reconcileRedirectRegistry(adapter, {
            message,
            probeServerIp: async (sn) => {
                if (Object.prototype.hasOwnProperty.call(probeMap, sn)) {
                    return probeMap[sn];
                }
                return defaultProbeServerIp(adapter, sn, message);
            },
        });
    } catch (err) {
        adapter.log.warn(`refreshStickStatus reconcile: ${err.message}`);
    }
    // Re-derive after reconcile so configured labels match updated registry.
    deriveArgs.cfg = adapter.config;
    const snap = deriveStickStatus(deriveArgs);
    try {
        await adapter.setStateAsync('info.localConnection', {
            val: clientCount(adapter.localServer) > 0,
            ack: true,
        });
    } catch {
        // ignore
    }
    await publishStickStatus(adapter, snap);
    return snap;
}

module.exports = {
    deriveStickStatus,
    publishStickStatus,
    publishLocalStickPresence,
    refreshStickStatus,
    extractStickFw,
};
