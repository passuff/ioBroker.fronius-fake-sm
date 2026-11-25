'use strict';

const {
    getStickEntry,
    listRedirectedSns,
    configuredLabelFromEntry,
} = require('./stickRedirectRegistry');
const { hasStickSession, clientCount } = require('./stickRedirectGuard');

/**
 * Build a short DE summary for the Local workflow status board.
 * @param {{localSetupPending?:boolean,localSetupVerified?:boolean,localEnabled?:boolean}} cfg
 * @param {boolean} connected
 * @returns {string}
 */
function buildLocalWorkflowStatus(cfg, connected) {
    const pending = !!(cfg && cfg.localSetupPending);
    const verified = !!(cfg && cfg.localSetupVerified);
    const enabled = !!(cfg && cfg.localEnabled);
    let setup;
    if (verified) {
        setup = 'erledigt';
    } else if (pending) {
        setup = 'umgeleitet, warte auf Stick';
    } else {
        setup = 'noch nicht';
    }
    const conn = connected ? 'ja' : 'nein';
    const feed = enabled ? 'an' : 'aus';
    return `Einrichtung: ${setup} · Verbindung: ${conn} · Lokal: ${feed}`;
}

/**
 * Wifi / stick-redirect label for one stick (or legacy global cfg).
 * @param {object|null} cfgOrEntry adapter.config OR a registry entry
 * @param {object} [extra]
 * @returns {string}
 */
function buildStickConfiguredLabel(cfgOrEntry, extra) {
    // Registry entry shape: { state: 'pending'|'verified'|'redirected' }
    if (cfgOrEntry && typeof cfgOrEntry.state === 'string' && !('localSetupVerified' in cfgOrEntry)) {
        return configuredLabelFromEntry(cfgOrEntry, extra);
    }
    const cfg = cfgOrEntry || {};
    const sn = String((extra && extra.sn) || cfg.localStickSn || '').trim();
    if (sn) {
        const entry = getStickEntry(cfg, sn);
        if (entry) {
            return configuredLabelFromEntry(entry, extra);
        }
    }
    if (cfg.localSetupVerified) {
        return 'konfiguriert';
    }
    if (cfg.localSetupPending) {
        return 'umgeleitet – warte auf Stick';
    }
    if (cfg.cloudStickRedirectActive || (extra && extra._liveTarget === 'hier') || cfg._liveTarget === 'hier') {
        return 'umgeleitet auf diesen Host';
    }
    if (extra && extra._liveTarget === 'hier') {
        return 'umgeleitet auf diesen Host';
    }
    return 'nicht konfiguriert';
}

/**
 * Local TCP connection label (Lokal Schritt 4).
 * @param {boolean} connected
 * @returns {string}
 */
function buildLocalConnectedLabel(connected) {
    return connected ? 'hergestellt' : 'nicht hergestellt';
}

/**
 * Per-stick summary for proxy panel, e.g. "AAA: verbunden · BBB: wartet".
 * @param {object} [cfg]
 * @param {object} [server]
 * @returns {string}
 */
function buildRegistrySummary(cfg, server) {
    const sns = listRedirectedSns(cfg);
    if (!sns.length) {
        return 'keine Umleitung';
    }
    return sns
        .map((sn) => {
            const entry = getStickEntry(cfg, sn);
            const connected = hasStickSession(server, sn);
            let st = '—';
            if (connected) {
                st = 'verbunden';
            } else if (entry && entry.state === 'pending') {
                st = 'wartet';
            } else if (entry && entry.state === 'verified') {
                st = 'offline';
            } else if (entry && entry.state === 'redirected') {
                st = 'umgeleitet';
            }
            return `${sn}: ${st}`;
        })
        .join(' · ');
}

/**
 * Whether the local stick proxy currently has a client.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} [sn] when set, only that SN
 * @returns {boolean}
 */
function isLocalStickConnected(adapter, sn) {
    if (sn) {
        return hasStickSession(adapter.localServer, sn);
    }
    if (adapter._localConnected === true) {
        return true;
    }
    if (adapter._localConnected === false) {
        return false;
    }
    return clientCount(adapter.localServer) > 0;
}

/**
 * Publish workflow summary + Wifi/local-connection labels.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {{connected?:boolean, sn?:string}} [opts]
 */
async function publishLocalWorkflowStatus(adapter, opts = {}) {
    const sn = String(opts.sn || adapter.config.localStickSn || '').trim();
    const connected =
        opts.connected != null ? !!opts.connected : isLocalStickConnected(adapter, sn || undefined);
    if (opts.connected != null && !sn) {
        adapter._localConnected = connected;
    } else if (!sn) {
        adapter._localConnected = connected;
    }
    const cfg = adapter.config || {};
    const anyClient = clientCount(adapter.localServer) > 0;
    const connectedAny = connected || anyClient;
    const text = buildLocalWorkflowStatus(cfg, connectedAny);
    const entry = sn ? getStickEntry(cfg, sn) : null;
    const configured = buildStickConfiguredLabel(entry || cfg, {
        sn,
        _liveTarget: opts._liveTarget,
    });
    // Prefer explicit opts.connected; with SN use that stick's socket; else any client / flag
    const localConn = buildLocalConnectedLabel(
        opts.connected != null
            ? !!opts.connected
            : sn
              ? isLocalStickConnected(adapter, sn)
              : anyClient || !!adapter._localConnected,
    );
    const summary = buildRegistrySummary(cfg, adapter.localServer);
    try {
        await adapter.setStateAsync('info.localWorkflowStatus', { val: text, ack: true });
        await adapter.setStateAsync('info.wfStickConfigured', { val: configured, ack: true });
        await adapter.setStateAsync('info.wfLocalConnected', { val: localConn, ack: true });
        await adapter.setStateAsync('info.stickRedirectSummary', { val: summary, ack: true });
    } catch (err) {
        if (adapter.log && adapter.log.warn) {
            adapter.log.warn(`publishLocalWorkflowStatus: ${err.message}`);
        }
    }
    return text;
}

/**
 * Structured snapshot for Admin LocalStickPanel (no prose blob).
 * Shine fields may be filled by the handler from cache/login.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {{selectedSn?:string, shine?:{connected:boolean,plantCount:number,error?:string}, frameStatus?:string}} [opts]
 * @returns {object}
 */
function buildLocalWorkflowSnapshot(adapter, opts = {}) {
    const cfg = (adapter && adapter.config) || {};
    const selectedSn = String(opts.selectedSn || cfg.localStickSn || '').trim();
    const server = adapter && adapter.localServer;
    const listening = !!(server && server.listening);
    const frameStatus = String(opts.frameStatus || adapter._localFrameStatus || '—');
    const sticks = listRedirectedSns(cfg).map((sn) => {
        const entry = getStickEntry(cfg, sn) || {};
        const online = hasStickSession(server, sn);
        return {
            sn,
            name: entry.plantName ? String(entry.plantName) : undefined,
            online,
            redirectState: String(entry.state || 'redirected'),
            serverHint: entry.serverIp ? String(entry.serverIp) : undefined,
        };
    });
    const selectedEntry = selectedSn ? getStickEntry(cfg, selectedSn) : null;
    const selectedOnline = selectedSn ? hasStickSession(server, selectedSn) : false;
    return {
        shine: opts.shine || { connected: false, plantCount: 0 },
        proxy: {
            listening,
            forward: cfg.localForwardCloud !== false,
            frameStatus: String(frameStatus || '—'),
            clientCount: clientCount(server),
            port: Number(cfg.localPort ?? 5279),
        },
        sticks,
        selectedSn,
        setup: {
            canPatch: !!selectedSn && !selectedEntry,
            canRestore: !!selectedSn && !!selectedEntry,
            selectedOnline,
            selectedRedirectState: selectedEntry ? String(selectedEntry.state) : null,
        },
    };
}

module.exports = {
    buildLocalWorkflowStatus,
    buildStickConfiguredLabel,
    buildLocalConnectedLabel,
    buildRegistrySummary,
    isLocalStickConnected,
    publishLocalWorkflowStatus,
    buildLocalWorkflowSnapshot,
};
