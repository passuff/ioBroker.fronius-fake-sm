'use strict';

const { GrowattServer } = require('./growattServer');
const { AutoCalibrator } = require('./growattRecord');
const { advertisedListenIps } = require('./froniusDiscover');
const { staleAfterS, applyLocalSample } = require('./adapterPoll');
const { warnPeerSubnetMismatch } = require('./localNetworkAnalyze');
const { publishLocalWorkflowStatus } = require('./localWorkflowStatus');
const { fetchCalibrateTruthOnce, resolveCloudTruth, persistLearnedLayout } = require('./localCalibration');
const {
    stickMayPointAtProxy,
    proxyAlwaysOn,
    rememberStickRedirect,
    clientCount,
} = require('./stickRedirectGuard');
const { publishLocalStickPresence } = require('./stickStatus');
const { reportFrameHealth, publishProxyClientCount } = require('./frameHealthReport');

/**
 * Feed-stick SNs = the sticks the user selected to mirror locally. Derived from the
 * enabled plants in devices[] (each carries its stickSn), so multi-stick / multi-plant
 * accounts work: the user simply enables the plants they want fed into the Fronius
 * meter. Falls back to localStickSn when no enabled device carries a stickSn.
 * @param {object} cfg adapter.config
 * @returns {string[]} unique, trimmed feed-stick SNs (empty = feed any stick)
 */
function computeFeedStickSns(cfg) {
    const set = new Set();
    const devices = Array.isArray(cfg && cfg.devices) ? cfg.devices : [];
    for (const d of devices) {
        if (d && d.enabled && d.stickSn) {
            set.add(String(d.stickSn).trim());
        }
    }
    if (set.size === 0 && cfg && cfg.localStickSn) {
        set.add(String(cfg.localStickSn).trim());
    }
    set.delete('');
    return [...set];
}

/**
 * Is this SN one of the selected feed sticks? Empty set = mirror any stick (legacy).
 * @param {string[]} feedSns
 * @param {string} sn
 * @returns {boolean}
 */
function isFeedSn(feedSns, sn) {
    if (!Array.isArray(feedSns) || feedSns.length === 0) {
        return true;
    }
    return feedSns.includes(String(sn || '').trim());
}

/**
 * Publish auto-detected ioBroker LAN IP for stick redirect instructions.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function publishLocalIpHint(adapter) {
    const ips = advertisedListenIps();
    const hint = (adapter.config.advertisedModbusIp && String(adapter.config.advertisedModbusIp)) || ips[0] || '';
    await adapter.setStateAsync('info.localIpHint', { val: hint, ack: true });
    // Keep config field in sync so admin jsonConfig can show it read-only
    if (hint && !adapter.config.advertisedModbusIp) {
        adapter.config.advertisedModbusIp = hint;
    }
    return hint;
}

/**
 * Persist that stick talks to us locally — unlocks + auto-enables local switch.
 * Only writes native when state actually changes (every frame would churn/restart).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function markLocalSetupVerified(adapter) {
    if (!isLocalFeedMode(adapter)) {
        return;
    }
    const alreadyDone =
        !!adapter.config.localSetupVerified &&
        !adapter.config.localSetupPending &&
        !!adapter.config.localEnabled;
    if (alreadyDone) {
        return;
    }
    const firstVerify = !adapter.config.localSetupVerified;
    adapter.config.localSetupVerified = true;
    adapter.config.localSetupPending = false;
    // localEnabled follows verified (no manual switch)
    adapter.config.localEnabled = true;
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (obj && obj.native) {
            obj.native.growattFeedMode = 'local';
            obj.native.localSetupVerified = true;
            obj.native.localSetupPending = false;
            obj.native.localEnabled = true;
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
        }
    } catch (err) {
        adapter.log.warn(`markLocalSetupVerified: ${err.message}`);
    }
    await adapter.setStateAsync('info.localSetupVerified', { val: true, ack: true });
    await adapter.setStateAsync('info.localEnabled', { val: true, ack: true });
    if (firstVerify) {
        await adapter.setStateAsync('info.setupStatus', {
            val: 'Lokale Verbindung hergestellt — Gen24 bekommt lokale Echtzeit-Daten.',
            ack: true,
        });
        adapter.log.info('Local stick connection verified — localEnabled auto-on');
    }
    await publishLocalWorkflowStatus(adapter, { connected: true });
}

function isLocalFeedMode(adapter) {
    return String(adapter.config.growattFeedMode || 'cloud') === 'local';
}

/**
 * Proxy stays up when always-on, while stick may still point at us, or local feed is on.
 * Always-on avoids orphan sticks after reinstall / Cloud mode.
 */
function shouldRunLocalProxy(adapter) {
    const cfg = adapter.config || {};
    if (proxyAlwaysOn(cfg) || stickMayPointAtProxy(cfg)) {
        return true;
    }
    if (!isLocalFeedMode(adapter)) {
        return false;
    }
    return !!cfg.localEnabled;
}

async function sanitizeLocalEnabled(adapter) {
    const { MSG } = require('./stickMessages');
    const cfg = adapter.config;
    // Migrate: previously verified/enabled local → feed mode local
    if (!cfg.growattFeedMode && (cfg.localEnabled || cfg.localSetupVerified)) {
        cfg.growattFeedMode = 'local';
    }
    if (!cfg.growattFeedMode) {
        cfg.growattFeedMode = 'cloud';
    }

    let changed = false;
    if (!isLocalFeedMode(adapter)) {
        // Cloud data path: never stop the always-on / redirected proxy; only disable Modbus feed
        if (cfg.localEnabled) {
            if (stickMayPointAtProxy(cfg)) {
                adapter.log.warn('Feed mode Cloud but stick still local — keep proxy until Restore');
            }
            cfg.localEnabled = false;
            changed = true;
        }
        if (stickMayPointAtProxy(cfg)) {
            await adapter.setStateAsync('info.setupStatus', {
                val: MSG.restoreBeforeCloud,
                ack: true,
            });
        }
        if (!adapter.localServer && shouldRunLocalProxy(adapter)) {
            adapter.localServer = await startLocalProxyIfEnabled(adapter);
        }
        // Only stop when neither always-on nor redirect memory keeps it up
        if (adapter.localServer && !shouldRunLocalProxy(adapter)) {
            try {
                await adapter.localServer.stop();
            } catch (err) {
                adapter.log.warn(`stop local proxy (cloud mode): ${err.message}`);
            }
            adapter.localServer = null;
            await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
            adapter._localConnected = false;
        }
        await adapter.setStateAsync('info.localSetupVerified', {
            val: !!cfg.localSetupVerified,
            ack: true,
        });
    } else {
        // Local mode: stick already redirected → treat as pending in memory only.
        // Do NOT write native here (setForeignObject restarts the instance mid-boot).
        if (
            !!cfg.cloudStickRedirectActive &&
            !cfg.localSetupPending &&
            !cfg.localSetupVerified
        ) {
            cfg.localSetupPending = true;
            adapter.log.info(
                'Lokal: Stick already redirected — pending in memory (UI); native write deferred',
            );
        }
        // Local mode: localEnabled always mirrors verified (no manual switch)
        const wantEnabled = !!cfg.localSetupVerified;
        if (!!cfg.localEnabled !== wantEnabled) {
            cfg.localEnabled = wantEnabled;
            changed = true;
        }
        if (!adapter.localServer && shouldRunLocalProxy(adapter)) {
            adapter.localServer = await startLocalProxyIfEnabled(adapter);
        }
    }

    if (changed) {
        try {
            const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
            if (obj && obj.native) {
                obj.native.growattFeedMode = cfg.growattFeedMode;
                obj.native.localEnabled = !!cfg.localEnabled;
                obj.native.localSetupPending = !!cfg.localSetupPending;
                obj.native.localSetupVerified = !!cfg.localSetupVerified;
                await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
            }
        } catch (err) {
            adapter.log.warn(`sanitizeLocalEnabled: ${err.message}`);
        }
    }
    await adapter.setStateAsync('info.localEnabled', { val: !!cfg.localEnabled, ack: true });
    await publishLocalWorkflowStatus(adapter);
}

/**
 * Persist + apply localEnabled from the admin switch (or first verify).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {boolean} enabled
 */
async function setLocalEnabled(adapter, enabled) {
    const want = !!enabled;
    if (want && !isLocalFeedMode(adapter)) {
        adapter.log.warn('Lokale Verbindung nur im Datenweg „Lokal“');
        await adapter.setStateAsync('info.localEnabled', { val: false, ack: true });
        return false;
    }
    if (want && !adapter.config.localSetupVerified) {
        adapter.log.warn('Lokale Verbindung nur nach bestätigter Einrichtung einschaltbar');
        await adapter.setStateAsync('info.localEnabled', { val: false, ack: true });
        return false;
    }
    adapter.config.localEnabled = want;
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (obj && obj.native) {
            obj.native.localEnabled = want;
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
        }
    } catch (err) {
        adapter.log.warn(`setLocalEnabled: ${err.message}`);
    }
    await adapter.setStateAsync('info.localEnabled', { val: want, ack: true });

    // Keep proxy up after redirect/pending/verified — localEnabled only gates Modbus feed.
    if (!want) {
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        adapter._localConnected = false;
        if (!shouldRunLocalProxy(adapter) && adapter.localServer) {
            try {
                await adapter.localServer.stop();
            } catch (err) {
                adapter.log.warn(`stop local proxy: ${err.message}`);
            }
            adapter.localServer = null;
        }
        await publishLocalWorkflowStatus(adapter);
        return true;
    }

    if (!adapter.localServer) {
        adapter.localServer = await startLocalProxyIfEnabled(adapter);
        if (!adapter.localServer) {
            adapter.config.localEnabled = false;
            await adapter.setStateAsync('info.localEnabled', { val: false, ack: true });
            await adapter.setStateAsync('info.lastError', {
                val: 'Lokaler Proxy konnte nicht starten (Port belegt?)',
                ack: true,
            });
            await publishLocalWorkflowStatus(adapter);
            return false;
        }
    }
    await publishLocalWorkflowStatus(adapter);
    return true;
}

/**
 * Start local Growatt :5279 proxy when enabled or waiting after setup.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {{force?:boolean}} [opts] force: start regardless of flags (restore catch)
 */
async function startLocalProxyIfEnabled(adapter, opts = {}) {
    const cfg = adapter.config;
    if (!opts.force && !shouldRunLocalProxy(adapter)) {
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        await adapter.setStateAsync('info.localCalibrated', { val: false, ack: true });
        return null;
    }

    const learned = AutoCalibrator.layoutFromNative(cfg);
    // Only trust calibrated flag when a real layout exists
    if (cfg.localCalibrated && !learned) {
        adapter.log.warn('localCalibrated was set without offsets — resetting until auto-calibrate succeeds');
        cfg.localCalibrated = false;
    }
    adapter._localCalibrated = !!learned;
    await adapter.setStateAsync('info.localCalibrated', { val: adapter._localCalibrated, ack: true });

    const autoCalibrate = cfg.localAutoCalibrate !== false;
    if (!learned && !autoCalibrate) {
        await adapter.setStateAsync('info.lastError', {
            val: 'local mode: no learned layout and auto-calibrate disabled',
            ack: true,
        });
        adapter.log.error('Local mode enabled but no layout and localAutoCalibrate=false');
    }

    if (!learned && autoCalibrate) {
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

    const server = new GrowattServer({
        host: cfg.localHost || '0.0.0.0',
        port: Number(cfg.localPort ?? 5279),
        forwardCloud: cfg.localForwardCloud !== false,
        upstreamHost: 'server.growatt.com',
        upstreamPort: Number(cfg.localUpstreamPort ?? 5279),
        upstreamIp: cfg.localUpstreamHost || '',
        defaultSerial: cfg.localStickSn || (feedStickSns.length === 1 ? feedStickSns[0] : ''),
        feedStickSn: cfg.localStickSn || '',
        feedStickSns,
        layout: learned,
        autoCalibrate,
        autoPersistRedirect: isLocalFeedMode(adapter) && cfg.localAutoPersistRedirect !== false,
        redirectServerIp: redirectIp,
        redirectServerPort: Number(cfg.localPort ?? 5279),
        replyAckWhenNoForward: cfg.localForwardCloud === false,
        getCloudTruth: () => resolveCloudTruth(adapter),
        onStick: (sn) => {
            if (!isFeedSn(feedStickSns, sn)) {
                adapter.log.debug(`non-feed stick SN=${sn} on proxy (forward only, no Fake-SM feed)`);
                return;
            }
            void adapter.setStateChangedAsync('info.stickSn', { val: String(sn), ack: true });
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
            void rememberStickRedirect(adapter);
            void publishLocalStickPresence(adapter, true);
            const warn = warnPeerSubnetMismatch(redirectIp, peerIp);
            if (warn) {
                adapter.log.warn(warn);
                void adapter.setStateAsync('info.setupStatus', { val: warn, ack: true });
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
            void publishLocalStickPresence(adapter, n > 0);
        },
        onClientCount: (n) => {
            void publishProxyClientCount(adapter, n);
        },
        onFrameHealth: (verdict, snap) => {
            void reportFrameHealth(adapter, verdict, snap);
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
        onCalibrated: (layout) => {
            adapter._localCalibrated = true;
            void adapter.setStateAsync('info.localCalibrated', { val: true, ack: true });
            void adapter.setStateAsync('info.lastError', { val: '', ack: true });
            void persistLearnedLayout(adapter, layout);
            adapter.log.info('Local stick layout auto-calibrated — local samples will feed Modbus');
        },
        onCalibrateFailed: (reason) => {
            adapter._localCalibrated = false;
            void adapter.setStateAsync('info.localCalibrated', { val: false, ack: true });
            void adapter.setStateAsync('info.lastError', { val: String(reason || 'local auto-calibrate failed'), ack: true });
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
            void adapter.setStateAsync('info.localConnection', { val: true, ack: true });
            void adapter.setStateAsync('info.lastLocalFrame', { val: Date.now(), ack: true });
            void publishLocalWorkflowStatus(adapter, { connected: true });
            void markLocalSetupVerified(adapter);
            if (sample.recordType) {
                void adapter.setStateChangedAsync('local.recordType', { val: sample.recordType, ack: true });
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
            applyLocalSample(adapter, summed).catch((err) => adapter.log.warn(`applyLocalSample: ${err.message}`));
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
        adapter.log.info(`Local Growatt proxy enabled — set stick server to ${hint}:5279`);
        return server;
    } catch (err) {
        adapter._localConnected = false;
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        await publishLocalWorkflowStatus(adapter, { connected: false });
        const hint =
            `Lokaler Proxy :${cfg.localPort ?? 5279} nicht gestartet (${err.message}). ` +
            'Port belegt? Opt-out: „Proxy immer bereithalten“ aus. Adapter läuft weiter (Cloud-Poll).';
        adapter.log.warn(hint);
        await adapter.setStateAsync('info.setupStatus', { val: hint.slice(0, 240), ack: true });
        return null;
    }
}

module.exports = {
    publishLocalIpHint,
    publishLocalWorkflowStatus,
    startLocalProxyIfEnabled,
    markLocalSetupVerified,
    persistLearnedLayout,
    sanitizeLocalEnabled,
    setLocalEnabled,
    isLocalFeedMode,
    shouldRunLocalProxy,
    fetchCalibrateTruthOnce,
    resolveCloudTruth,
};
