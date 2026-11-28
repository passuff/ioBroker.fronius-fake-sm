'use strict';

const net = require('net');
const { GrowattServer } = require('./growattServer');
const { advertisedListenIps } = require('./froniusDiscover');
const { staleAfterS, applyLocalSample } = require('./adapterPoll');
const { warnPeerSubnetMismatch } = require('./localNetworkAnalyze');
const { publishLocalWorkflowStatus } = require('./localWorkflowStatus');
const { fetchCalibrateTruthOnce, resolveCloudTruth, persistLearnedLayout } = require('./localCalibration');
const { primaryLayoutFromNative, layoutsBySnFromNative } = require('./localLayouts');
const { rememberStickRedirect, clientCount } = require('./stickRedirectGuard');
const { publishLocalStickPresence } = require('./stickStatus');
const {
    reportFrameHealth,
    publishProxyClientCount,
    publishLocalConnectionFromCount,
} = require('./frameHealthReport');
const { isLocalFeedMode, shouldRunLocalProxy, computeFeedStickSns, isFeedSn } = require('./localProxyMode');
const { fireAndLog } = require('./asyncSafe');

/**
 * Prefer LAN bind when advertisedModbusIp is set; specific localHost wins;
 * bare 0.0.0.0 (native default) yields to advertised IPv4.
 * @param {object} cfg
 * @returns {string}
 */
function resolveLocalProxyHost(cfg) {
    const hostRaw = cfg && cfg.localHost != null ? String(cfg.localHost).trim() : '';
    if (hostRaw && hostRaw !== '0.0.0.0') {
        return hostRaw;
    }
    const adv = cfg && cfg.advertisedModbusIp != null ? String(cfg.advertisedModbusIp).trim() : '';
    if (adv && net.isIPv4(adv)) {
        return adv;
    }
    return hostRaw || '0.0.0.0';
}

async function startLocalProxyIfEnabled(adapter, opts = {}) {
    const cfg = adapter.config;
    if (!opts.force && !shouldRunLocalProxy(adapter)) {
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        await adapter.setStateAsync('info.localCalibrated', { val: false, ack: true });
        return null;
    }

    const layoutsBySn = layoutsBySnFromNative(cfg);
    const learned = primaryLayoutFromNative(cfg);
    // Only trust calibrated flag when a real layout exists
    if (cfg.localCalibrated && !learned && layoutsBySn.size === 0) {
        adapter.log.warn('localCalibrated was set without offsets — resetting until auto-calibrate succeeds');
        cfg.localCalibrated = false;
    }
    adapter._localCalibrated = !!(learned || layoutsBySn.size);
    await adapter.setStateAsync('info.localCalibrated', { val: adapter._localCalibrated, ack: true });

    const autoCalibrate = cfg.localAutoCalibrate !== false;
    if (!adapter._localCalibrated && !autoCalibrate) {
        await adapter.setStateAsync('info.lastError', {
            val: 'local mode: no learned layout and auto-calibrate disabled',
            ack: true,
        });
        adapter.log.error('Local mode enabled but no layout and localAutoCalibrate=false');
    }

    if (!adapter._localCalibrated && autoCalibrate) {
        await fetchCalibrateTruthOnce(adapter);
    }

    const ips = advertisedListenIps();
    const redirectIp = cfg.advertisedModbusIp || ips[0] || '';

    // Feed-stick SET (multi-stick / multi-plant): the sticks we mirror locally into
    // the Fronius meter. The user selects them by enabling the corresponding plants
    // in devices[]. Any other stick that reaches the proxy (e.g. an unregistered lab
    // clone, or another plant the user did NOT select) is forwarded to the cloud
    // only. Falls back to localStickSn when no device carries a stickSn.
    const feedStickSns = computeFeedStickSns(cfg);
    // Lab / debug sticks: AES decode without adding to Fake-SM power sum.
    const decodeAlsoSns = [
        ...new Set(
            []
                .concat(Array.isArray(cfg.decodeAlsoSns) ? cfg.decodeAlsoSns : [])
                .concat(String(process.env.GROWATT_DECODE_SNS || '').split(/[\s,]+/))
                .concat(['XGD6CJH2Y0'])
                .map((s) => String(s || '').trim())
                .filter(Boolean),
        ),
    ];

    const bindHost = resolveLocalProxyHost(cfg);
    const server = new GrowattServer({
        host: bindHost,
        port: Number(cfg.localPort ?? 5279),
        forwardCloud: cfg.localForwardCloud !== false,
        upstreamHost: 'server.growatt.com',
        upstreamPort: Number(cfg.localUpstreamPort ?? 5279),
        upstreamIp: cfg.localUpstreamHost || '',
        defaultSerial: cfg.localStickSn || (feedStickSns.length === 1 ? feedStickSns[0] : ''),
        feedStickSn: cfg.localStickSn || '',
        feedStickSns,
        decodeAlsoSns,
        layout: learned,
        layoutsBySn,
        autoCalibrate,
        autoPersistRedirect: isLocalFeedMode(adapter) && cfg.localAutoPersistRedirect !== false,
        redirectServerIp: redirectIp,
        redirectServerPort: Number(cfg.localPort ?? 5279),
        replyAckWhenNoForward: cfg.localForwardCloud === false,
        getCloudTruth: (sn) => resolveCloudTruth(adapter, sn),
        onStick: (sn) => {
            const stickSn = String(sn || '').trim();
            if (!stickSn) {
                return;
            }
            // Mark this SN verified (local feed) or at least remember redirect (cloud mode).
            fireAndLog(adapter, 'markLocalSetupVerified', () =>
                require('./localProxy').markLocalSetupVerified(adapter, stickSn),
            );
            fireAndLog(adapter, 'rememberStickRedirect', () => rememberStickRedirect(adapter, stickSn));
            if (!isFeedSn(feedStickSns, stickSn)) {
                adapter.log.debug(`non-feed stick SN=${stickSn} on proxy (forward only, no Fake-SM feed)`);
                return;
            }
            fireAndLog(adapter, 'setState stickSn', () =>
                adapter.setStateChangedAsync('info.stickSn', { val: stickSn, ack: true }),
            );
        },
        onPeer: (peerIp) => {
            const ip = String(peerIp || '').replace(/^::ffff:/, '');
            // Keep a feed stick's peer as the "local" peer when a non-feed stick
            // (e.g. lab clone or an unselected plant) also connects to the proxy.
            if (feedStickSns.length && adapter.localServer && adapter.localServer._stickBySn) {
                let feedPeerSeen = false;
                let thisIsFeedPeer = false;
                for (const feedSn of feedStickSns) {
                    const feedSock = adapter.localServer._stickBySn.get(feedSn);
                    if (feedSock && !feedSock.destroyed) {
                        feedPeerSeen = true;
                        const feedIp = String(feedSock.remoteAddress || '').replace(/^::ffff:/, '');
                        if (feedIp && ip && ip === feedIp) {
                            thisIsFeedPeer = true;
                        }
                    }
                }
                if (feedPeerSeen && !thisIsFeedPeer) {
                    adapter.log.debug(`non-feed peer ${ip} ignored for local presence`);
                    return;
                }
            }
            adapter._localPeerIp = ip;
            if (adapter._frameCapture && typeof adapter._frameCapture.resetStream === 'function') {
                adapter._frameCapture.resetStream();
            }
            fireAndLog(adapter, 'publishLocalStickPresence', () => publishLocalStickPresence(adapter, true));
            const warn = warnPeerSubnetMismatch(redirectIp, peerIp);
            if (warn) {
                adapter.log.warn(warn);
                fireAndLog(adapter, 'setupStatus subnet', () =>
                    adapter.setStateAsync('info.setupStatus', { val: warn, ack: true }),
                );
            }
        },
        onClientClose: (serial) => {
            if (adapter._frameCapture && typeof adapter._frameCapture.resetStream === 'function') {
                adapter._frameCapture.resetStream();
            }
            try {
                const { forgetAesSession } = require('./frameCapture');
                forgetAesSession(adapter, serial);
            } catch {
                // ignore
            }
            const n = clientCount(adapter.localServer);
            if (n <= 0) {
                adapter._localPeerIp = '';
            }
            fireAndLog(adapter, 'publishLocalStickPresence close', () =>
                publishLocalStickPresence(adapter, n > 0),
            );
        },
        onClientCount: (n) => {
            adapter._proxyClientCountLive = Number(n) || 0;
            fireAndLog(adapter, 'publishProxyClientCount', () => publishProxyClientCount(adapter, n));
            fireAndLog(adapter, 'publishLocalConnectionFromCount', () =>
                publishLocalConnectionFromCount(adapter, n),
            );
        },
        onFrameHealth: (verdict, snap) => {
            fireAndLog(adapter, 'reportFrameHealth', () => reportFrameHealth(adapter, verdict, snap));
        },
        onRawUp: (chunk) => {
            if (adapter._frameCapture && typeof adapter._frameCapture.onUp === 'function') {
                adapter._frameCapture.onUp(chunk);
            }
        },
        onRawDown: (chunk) => {
            if (adapter._frameCapture && typeof adapter._frameCapture.onDown === 'function') {
                adapter._frameCapture.onDown(chunk);
            }
        },
        onAesSession: ({ serial, key, iv, source }) => {
            try {
                const { rememberAesSession } = require('./frameCapture');
                rememberAesSession(adapter, { serial, key, iv, source: source || 'up' });
            } catch {
                // ignore
            }
            if (adapter._frameCapture && typeof adapter._frameCapture.noteAesSession === 'function') {
                adapter._frameCapture.noteAesSession(serial, key, iv, source || 'up');
            }
        },
        onCalibrated: (layout, stickSn) => {
            adapter._localCalibrated = true;
            fireAndLog(adapter, 'localCalibrated true', () =>
                adapter.setStateAsync('info.localCalibrated', { val: true, ack: true }),
            );
            fireAndLog(adapter, 'clear lastError calibrate', () =>
                adapter.setStateAsync('info.lastError', { val: '', ack: true }),
            );
            fireAndLog(adapter, 'persistLearnedLayout', () => persistLearnedLayout(adapter, layout, stickSn));
            adapter.log.info(
                `Local stick layout auto-calibrated SN=${stickSn || cfg.localStickSn || '-'} — local samples will feed Modbus`,
            );
        },
        onCalibrateFailed: (reason) => {
            adapter._localCalibrated = false;
            fireAndLog(adapter, 'localCalibrated false', () =>
                adapter.setStateAsync('info.localCalibrated', { val: false, ack: true }),
            );
            fireAndLog(adapter, 'calibrate failed lastError', () =>
                adapter.setStateAsync('info.lastError', {
                    val: String(reason || 'local auto-calibrate failed'),
                    ack: true,
                }),
            );
            adapter.log.warn(String(reason || 'local auto-calibrate failed'));
        },
        onSample: (sample) => {
            // Only mirror SELECTED feed sticks (enabled plants) to the Fronius meter.
            // Other sticks (unregistered lab clone, or plants the user did not select)
            // are still forwarded to the cloud, but must not pollute local.* / Modbus.
            if (sample && sample.sn && !isFeedSn(feedStickSns, sample.sn)) {
                return;
            }
            adapter._localConnected = true;
            fireAndLog(adapter, 'localConnection true', () =>
                adapter.setStateAsync('info.localConnection', { val: true, ack: true }),
            );
            fireAndLog(adapter, 'lastLocalFrame', () =>
                adapter.setStateAsync('info.lastLocalFrame', { val: Date.now(), ack: true }),
            );
            fireAndLog(adapter, 'publishLocalWorkflowStatus', () =>
                publishLocalWorkflowStatus(adapter, { connected: true }),
            );
            fireAndLog(adapter, 'markLocalSetupVerified sample', () =>
                require('./localProxy').markLocalSetupVerified(
                    adapter,
                    sample && sample.sn ? String(sample.sn) : '',
                ),
            );
            if (sample.recordType) {
                fireAndLog(adapter, 'local.recordType', () =>
                    adapter.setStateChangedAsync('local.recordType', { val: sample.recordType, ack: true }),
                );
            }
            // Gate: only feed Modbus after real calibration + numeric sample
            if (!sample.calibrated || sample.pac_w == null || !server.calibrated) {
                return;
            }
            if (!adapter.config.localEnabled) {
                return;
            }
            adapter._localCalibrated = true;
            const summed =
                server.sumFreshSamples(staleAfterS(adapter) * 1000, feedStickSns.length ? feedStickSns : undefined) ||
                sample;
            fireAndLog(adapter, 'applyLocalSample', () => applyLocalSample(adapter, summed));
        },
        onFrame: (meta) => {
            adapter.log.debug(
                `local frame func=0x${Number(meta.func).toString(16)} len=${meta.len} sn=${meta.sn || '-'}`,
            );
        },
        log: (m) => adapter.log.info(m),
        debug: (m) => adapter.log.debug(m),
        error: (m) => adapter.log.error(m),
    });
    // Lab-only FOTA allowlist (env or native); never defaults to production SNs.
    server.fotaLabStickSns =
        cfg.fotaLabStickSns || process.env.GROWATT_FOTA_LAB_SNS || cfg.localStickSn || '';

    try {
        const { attachHoldingReadHandler, startSettingsHoldingPoll } = require('./growattCloudSettings');
        attachHoldingReadHandler(adapter, server);
        startSettingsHoldingPoll(adapter);
    } catch {
        // optional inverter-vars path
    }

    try {
        await server.start();
        const listenIps = advertisedListenIps();
        const hint = cfg.advertisedModbusIp || listenIps[0] || '<ioBroker-IP>';
        adapter.log.info(
            `Local Growatt proxy enabled on ${bindHost}:${cfg.localPort ?? 5279} — set stick server to ${hint}:5279`,
        );
        return server;
    } catch (err) {
        adapter._localConnected = false;
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        await publishLocalWorkflowStatus(adapter, { connected: false });
        const hint =
            `Lokaler Proxy :${cfg.localPort ?? 5279} nicht gestartet (${err.message}). ` +
            'Port belegt (z. B. durch Grott)? Adapter läuft weiter (Cloud-Poll).';
        adapter.log.warn(hint);
        await adapter.setStateAsync('info.setupStatus', { val: hint.slice(0, 240), ack: true });
        return null;
    }
}

module.exports = {
    startLocalProxyIfEnabled,
    computeFeedStickSns,
    isFeedSn,
    resolveLocalProxyHost,
};
