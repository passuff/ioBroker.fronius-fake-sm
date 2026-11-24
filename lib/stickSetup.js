'use strict';

const { buildRedirectFrames } = require('./growattCommands');
const {
    probePort,
    scanLocalStickPorts,
    buildLocalFrame,
    tryTouchApStick,
} = require('./stickApScan');
const { analyzeLocalNetwork } = require('./localNetworkAnalyze');
const {
    MSG,
    LOGGER_REG,
    isCloudOk,
    isPermissionDenied,
    isLocalFeedMode,
    sessionFromAdapter,
    resolveStickSn,
    persistStickOnlineFlag,
    checkStickOnline,
} = require('./stickOnline');
const { publishLocalWorkflowStatus } = require('./localWorkflowStatus');

/**
 * True when stick was already redirected / local setup was armed before.
 * Allows offline arming without a live Shine register write.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {boolean}
 */
function isKnownLocalRedirect(adapter) {
    const cfg = (adapter && adapter.config) || {};
    if (cfg.cloudStickRedirectActive === true) {
        return true;
    }
    if (cfg.localSetupPending === true || cfg.localSetupVerified === true) {
        return true;
    }
    const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
    return devices.some((d) => d && (d.stickRedirected === true || d.stickRedirected === 'yes'));
}

/**
 * Arm local proxy + pending when stick is offline but redirect is already known.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} writeIp
 * @returns {Promise<object>}
 */
async function armLocalOfflineKnown(adapter, writeIp) {
    await persistLocalSetupArmed(adapter);
    const hint =
        'Stick offline — Lokal bewaffnet (Proxy läuft, Pending). Redirect wird geprüft, sobald der Stick wieder online ist.';
    adapter.log.info(hint);
    await adapter.setStateAsync('info.setupStatus', { val: hint, ack: true });
    return {
        result: hint,
        ok: true,
        armedOffline: true,
        native: {
            stickCloudOnline: false,
            stickOnlineLabel: adapter.config.stickOnlineLabel,
            stickStatusText: MSG.offline,
            localSetupPending: true,
            growattFeedMode: 'local',
            advertisedModbusIp: writeIp,
        },
    };
}

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
 * Persist localSetupPending / feed mode only when native actually changes.
 * Must NOT be called before redirectToLocal — setForeignObject(system.adapter.*)
 * restarts the instance and aborts setup mid-flight ("DB closed").
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<boolean>} true when a native write was issued
 */
async function persistLocalSetupArmed(adapter) {
    adapter.config.localSetupPending = true;
    adapter.config.growattFeedMode = 'local';
    const { persistNative } = require('./persistNative');
    const result = await persistNative(
        adapter,
        { localSetupPending: true, growattFeedMode: 'local' },
        'persistLocalSetupArmed',
    );
    await publishLocalWorkflowStatus(adapter);
    return result.wrote;
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
 * @param {object} [message]
 */
async function runRemoteRedirect(adapter, serverIp, message) {
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        return { ok: false, skipped: true, error: 'need_shine_password', hint: cred.error };
    }

    await adapter.setStateAsync('info.setupStatus', { val: 'Shine-Login…', ack: true });
    await cred.session.login();

    const stickSn = await resolveStickSn(adapter, cred.session, message);
    if (!stickSn) {
        return { ok: false, error: 'no_stick_sn', hint: MSG.noStickSn };
    }
    await adapter.setStateAsync('info.stickSn', { val: stickSn, ack: true });

    const probe = await cred.session.getRegister(stickSn, LOGGER_REG.SERVERIP);
    if (isPermissionDenied(probe)) {
        const hint = MSG.permissionDenied(stickSn);
        await persistStickOnlineFlag(adapter, false, { stickStatusText: hint });
        return { ok: false, error: 'stick_sn_denied', hint, offline: false };
    }
    if (!isCloudOk(probe)) {
        await persistStickOnlineFlag(adapter, false, { stickStatusText: MSG.offline, localStickSn: stickSn });
        return { ok: false, error: 'stick_offline', hint: MSG.offline, offline: true };
    }
    await persistStickOnlineFlag(adapter, true, {
        localStickSn: stickSn,
        stickStatusText: MSG.online(stickSn, probe && probe.msg),
    });

    const port = Number(adapter.config.localPort ?? 5279);
    await adapter.setStateAsync('info.setupStatus', {
        val: `Setze Server ${serverIp}:${port} auf Stick ${stickSn}…`,
        ack: true,
    });
    const cloud = await cred.session.redirectToLocal(stickSn, serverIp, port);

    const okText = MSG.setupOk(stickSn, serverIp, port);
    await adapter.setStateAsync('info.setupStatus', { val: okText, ack: true });

    return {
        ok: true,
        mode: 'remote',
        stickSn,
        serverIp,
        port,
        cloud,
        result: okText,
    };
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

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message] Admin form payload (may include unsaved localStickSn)
 * @returns {Promise<object>}
 */
async function runStickSetup(adapter, message) {
    if (!isLocalFeedMode(adapter, message)) {
        return {
            error: 'Datenweg ist Cloud — für Stick-Einrichtung unter Fremd-WR „Lokal“ wählen und speichern.',
            ok: false,
        };
    }
    const msg = message && typeof message === 'object' ? message : {};
    if (msg.localStickSn) {
        adapter.config.localStickSn = String(msg.localStickSn).trim();
    }
    if (msg.localPlantId) {
        adapter.config.localPlantId = String(msg.localPlantId).trim();
    }
    if (msg.advertisedModbusIp) {
        adapter.config.advertisedModbusIp = String(msg.advertisedModbusIp).trim();
    }

    const analysis = await resolveSetupServerIp(adapter, message);
    const serverIp = analysis.ip || '';
    const preferred = String(
        msg.advertisedModbusIp || adapter.config.advertisedModbusIp || '',
    ).trim();
    const preferredOk = preferred && (analysis.candidates || []).includes(preferred);
    if (analysis.ambiguous && !preferredOk) {
        const err = MSG.ambiguousIps;
        await adapter.setStateAsync('info.setupStatus', { val: err, ack: true });
        await adapter.setStateAsync('info.localNetworkHint', { val: analysis.summary || err, ack: true });
        return { error: err, ok: false, analysis };
    }
    if (!serverIp) {
        return { error: analysis.summary || MSG.noIp, ok: false };
    }
    if (!analysis.portOk) {
        return {
            error: analysis.summary || `Port ${analysis.port} nicht nutzbar.`,
            ok: false,
        };
    }
    const writeIp = preferredOk ? preferred : serverIp;
    adapter.config.advertisedModbusIp = writeIp;
    await adapter.setStateAsync('info.localIpHint', { val: writeIp, ack: true });
    await adapter.setStateAsync('info.advertisedModbusIp', { val: writeIp, ack: true });
    await adapter.setStateAsync('info.localNetworkHint', {
        val: analysis.summary || `Ziel für Stick: ${writeIp}:${analysis.port}`,
        ack: true,
    });
    if (analysis.warnings && analysis.warnings.length) {
        adapter.log.warn(`local network analyze: ${analysis.warnings.join(' | ')}`);
    }

    // Proxy must listen before redirect — otherwise stick points at a dead port
    const proxyOk = await ensureLocalProxyReady(adapter, writeIp);
    if (!proxyOk) {
        return {
            error: 'Lokaler Proxy nicht gestartet — Redirect nicht ausgeführt.',
            ok: false,
            native: { localSetupPending: false },
        };
    }

    try {
        const remote = await runRemoteRedirect(adapter, writeIp, message);
        if (remote.ok) {
            // Persist only AFTER the stick was redirected — a native write restarts us.
            await persistLocalSetupArmed(adapter);
            const result =
                remote.result ||
                `${MSG.setupOk(remote.stickSn, writeIp, remote.port)} Schalter geht an, sobald der Stick hier connected.`;
            return {
                result,
                native: {
                    stickCloudOnline: true,
                    stickOnlineLabel: adapter.config.stickOnlineLabel,
                    localSetupPending: true,
                    growattFeedMode: 'local',
                    advertisedModbusIp: writeIp,
                },
                ok: true,
                ...remote,
            };
        }

        if (remote.offline || remote.error === 'stick_offline') {
            if (isKnownLocalRedirect(adapter)) {
                return armLocalOfflineKnown(adapter, writeIp);
            }
            return {
                error: remote.hint || MSG.offline,
                ok: false,
                native: {
                    stickCloudOnline: false,
                    stickOnlineLabel: adapter.config.stickOnlineLabel,
                },
            };
        }

        if (remote.error === 'stick_sn_denied' || remote.error === 'no_stick_sn') {
            return {
                error: remote.hint || MSG.noStickSn,
                ok: false,
                native: {
                    stickCloudOnline: false,
                    stickOnlineLabel: adapter.config.stickOnlineLabel,
                    stickStatusText: remote.hint || MSG.noStickSn,
                },
            };
        }

        if (remote.skipped) {
            const fallback = await runApFallback(adapter, writeIp);
            if (fallback.ok) {
                await persistLocalSetupArmed(adapter);
                return {
                    result: fallback.result,
                    ok: true,
                    native: { localSetupPending: true, growattFeedMode: 'local', advertisedModbusIp: writeIp },
                    ...fallback,
                };
            }
            return { error: remote.hint || MSG.needPassword, ok: false };
        }

        adapter.log.warn(`remote stick setup failed: ${remote.hint || remote.error}`);
        const fallback = await runApFallback(adapter, writeIp);
        if (fallback.ok) {
            await persistLocalSetupArmed(adapter);
            return {
                result: fallback.result,
                ok: true,
                native: { localSetupPending: true, growattFeedMode: 'local', advertisedModbusIp: writeIp },
                ...fallback,
            };
        }
        return {
            error: remote.hint || fallback.hint || MSG.offline,
            ok: false,
            native: { stickCloudOnline: false, stickOnlineLabel: adapter.config.stickOnlineLabel },
        };
    } catch (err) {
        const errMsg = err.message || String(err);
        adapter.log.warn(`remote stick setup error: ${errMsg}`);
        if (/datalog_lost/i.test(errMsg)) {
            await persistStickOnlineFlag(adapter, false, { stickStatusText: MSG.offline });
            if (isKnownLocalRedirect(adapter)) {
                return armLocalOfflineKnown(adapter, writeIp);
            }
            return {
                error: MSG.offline,
                ok: false,
                native: { stickCloudOnline: false, stickOnlineLabel: adapter.config.stickOnlineLabel },
            };
        }
        const fallback = await runApFallback(adapter, writeIp);
        if (fallback.ok) {
            await persistLocalSetupArmed(adapter);
            return {
                result: fallback.result,
                ok: true,
                native: { localSetupPending: true, growattFeedMode: 'local', advertisedModbusIp: writeIp },
                ...fallback,
            };
        }
        return { error: `${errMsg}`, ok: false };
    }
}

function previewRedirect(sn, ip, port) {
    return buildRedirectFrames(sn, ip, port).map((b) => b.toString('hex'));
}

module.exports = {
    probePort,
    scanLocalStickPorts,
    tryTouchApStick,
    ensureLocalProxyReady,
    persistLocalSetupArmed,
    isKnownLocalRedirect,
    armLocalOfflineKnown,
    resolveSetupServerIp,
    runStickSetup,
    runRemoteRedirect,
    checkStickOnline,
    resolveStickSn,
    previewRedirect,
    buildLocalFrame,
    MSG,
};
