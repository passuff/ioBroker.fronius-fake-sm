'use strict';

const { buildRedirectFrames } = require('./growattCommands');
const {
    probePort,
    scanLocalStickPorts,
    buildLocalFrame,
    tryTouchApStick,
} = require('./stickApScan');
const {
    MSG,
    LOGGER_REG,
    isCloudOk,
    isPermissionDenied,
    isLocalFeedMode,
    sessionFromAdapter,
    resolveStickSn,
    resolvePlantId,
    persistStickOnlineFlag,
    checkStickOnline,
} = require('./stickOnline');
const { publishLocalWorkflowStatus } = require('./localWorkflowStatus');
const {
    getStickEntry,
    getRegistry,
    upsertStick,
    persistRegistry,
    cloneRegistry,
} = require('./stickRedirectRegistry');
const {
    resolveSetupServerIp,
    ensureLocalProxyReady,
    runApFallback,
} = require('./stickSetupNet');

/**
 * True when stick was already redirected / local setup was armed before.
 * With sn: only that stick. Without sn: any registry/legacy flag (compat).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} [sn]
 * @returns {boolean}
 */
function isKnownLocalRedirect(adapter, sn) {
    const cfg = (adapter && adapter.config) || {};
    const key = String(sn || '').trim();
    const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
    if (key) {
        if (getStickEntry(cfg, key)) {
            return true;
        }
        return devices.some(
            (d) =>
                d &&
                String(d.stickSn || '').trim() === key &&
                (d.stickRedirected === true || d.stickRedirected === 'yes'),
        );
    }
    if (Object.keys(getRegistry(cfg)).length > 0) {
        return true;
    }
    if (cfg.cloudStickRedirectActive === true) {
        return true;
    }
    if (cfg.localSetupPending === true || cfg.localSetupVerified === true) {
        return true;
    }
    return devices.some((d) => d && (d.stickRedirected === true || d.stickRedirected === 'yes'));
}

/**
 * Persist pending entry for sn + feed mode. Must NOT run before redirectToLocal.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} sn
 * @param {object} [meta]
 * @returns {Promise<boolean>}
 */
async function persistLocalSetupArmed(adapter, sn, meta) {
    const key = String(sn || adapter.config.localStickSn || '').trim();
    adapter.config.growattFeedMode = 'local';
    if (key) {
        upsertStick(adapter.config, key, {
            state: 'pending',
            plantId: meta && meta.plantId,
            plantName: meta && meta.plantName,
            serverIp: meta && meta.serverIp,
        });
    } else {
        adapter.config.localSetupPending = true;
    }
    const { persistNative } = require('./persistNative');
    const result = await persistNative(
        adapter,
        (native) => {
            native.growattFeedMode = 'local';
            if (key) {
                native.localStickSn = key;
                native.stickRedirects = cloneRegistry(adapter.config.stickRedirects);
                native.localSetupPending = !!adapter.config.localSetupPending;
                native.localSetupVerified = !!adapter.config.localSetupVerified;
                native.cloudStickRedirectActive = !!adapter.config.cloudStickRedirectActive;
                native.cloudStickRedirectSn = String(adapter.config.cloudStickRedirectSn || '');
            } else {
                // Legacy single-flag path (tests / no SN yet)
                native.localSetupPending = true;
            }
        },
        'persistLocalSetupArmed',
    );
    await publishLocalWorkflowStatus(adapter);
    return result.wrote;
}

/**
 * Arm local proxy + pending when stick is offline but redirect is already known.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} writeIp
 * @param {string} [sn]
 * @returns {Promise<object>}
 */
async function armLocalOfflineKnown(adapter, writeIp, sn) {
    const key = String(sn || adapter.config.localStickSn || '').trim();
    await persistLocalSetupArmed(adapter, key, { serverIp: writeIp });
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
            localSetupPending: !!adapter.config.localSetupPending,
            localSetupVerified: !!adapter.config.localSetupVerified,
            cloudStickRedirectActive: !!adapter.config.cloudStickRedirectActive,
            cloudStickRedirectSn: String(adapter.config.cloudStickRedirectSn || ''),
            stickRedirects: cloneRegistry(adapter.config.stickRedirects),
            growattFeedMode: 'local',
            advertisedModbusIp: writeIp,
            localStickSn: key || adapter.config.localStickSn,
        },
    };
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} serverIp
 * @param {object} [message]
 */
async function runRemoteRedirect(adapter, serverIp, message) {
    const { shineLoginBlockedReason, noteShineAuthFailure } = require('./localStatusAdmin');
    const blocked = shineLoginBlockedReason(adapter);
    if (blocked) {
        return { ok: false, skipped: true, error: 'shine_backoff', hint: blocked };
    }
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        return { ok: false, skipped: true, error: 'need_shine_password', hint: cred.error };
    }

    await adapter.setStateAsync('info.setupStatus', { val: 'Shine-Login…', ack: true });
    try {
        await cred.session.login();
    } catch (err) {
        noteShineAuthFailure(adapter, err);
        throw err;
    }

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
        return { ok: false, error: 'stick_offline', hint: MSG.offline, offline: true, stickSn };
    }
    await persistStickOnlineFlag(adapter, true, {
        localStickSn: stickSn,
        stickStatusText: MSG.online(stickSn, probe && probe.msg),
    });

    const port = Number(adapter.config.localPort ?? 5279);
    await adapter.setStateAsync('info.setupStatus', {
        val: `SERVERIP setzen: ${serverIp}:${port} auf Stick ${stickSn}…`,
        ack: true,
    });
    const cloud = await cred.session.redirectToLocal(stickSn, serverIp, port);

    await adapter.setStateAsync('info.setupStatus', {
        val: `Stick-Neustart ausgelöst (${stickSn}) — warte auf lokale Verbindung (oft 1–4 Min)…`,
        ack: true,
    });

    const { verifyRedirectServerIp } = require('./redirectVerify');
    const { beginPostSetupQuiet } = require('./setupQuiet');
    beginPostSetupQuiet(adapter);
    const verify = await verifyRedirectServerIp(cred.session, stickSn, serverIp, LOGGER_REG.SERVERIP);
    let okText = MSG.setupOk(stickSn, serverIp, port);
    let redirectConfirmed = !!verify.confirmed;
    if (verify.confirmed) {
        okText = `${okText} Shine bestätigt SERVERIP=${verify.host}.`;
    } else if (verify.host) {
        okText =
            `Umleitung gesendet (${stickSn} → ${serverIp}:${port}). ` +
            `Shine zeigt noch SERVERIP=${verify.host} — Stick startet neu; Status wird lokal „wartet“.`;
        adapter.log.info(
            `redirect not yet confirmed SN=${stickSn} expected=${serverIp} shine=${verify.host}`,
        );
    } else {
        okText =
            `Umleitung gesendet (${stickSn} → ${serverIp}:${port}). ` +
            `Shine-SERVERIP noch nicht lesbar — warte auf Stick-Reboot (1–4 Min).`;
    }
    await adapter.setStateAsync('info.setupStatus', { val: okText.slice(0, 240), ack: true });

    return {
        ok: true,
        mode: 'remote',
        stickSn,
        serverIp,
        port,
        cloud,
        redirectConfirmed,
        shineServerIp: verify.host || '',
        result: okText,
    };
}

/**
 * Build native patch after a successful arm for admin useNative.
 * @param {object} adapter
 * @param {string} writeIp
 * @param {string} [stickSn]
 */
function armedNativePatch(adapter, writeIp, stickSn) {
    return {
        stickCloudOnline: true,
        stickOnlineLabel: adapter.config.stickOnlineLabel,
        localSetupPending: !!adapter.config.localSetupPending,
        localSetupVerified: !!adapter.config.localSetupVerified,
        cloudStickRedirectActive: !!adapter.config.cloudStickRedirectActive,
        cloudStickRedirectSn: String(adapter.config.cloudStickRedirectSn || ''),
        stickRedirects: cloneRegistry(adapter.config.stickRedirects),
        growattFeedMode: 'local',
        advertisedModbusIp: writeIp,
        localStickSn: stickSn || adapter.config.localStickSn || '',
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
        const okPort = analysis.warnings.every((w) => /bereits belegt|OK für Setup/i.test(String(w)));
        const line = `local network analyze: ${analysis.warnings.join(' | ')}`;
        // Port-already-in-use is expected when proxy is up — info keeps instance green
        if (okPort) {
            adapter.log.info(line);
        } else {
            adapter.log.warn(line);
        }
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

    const plantId = resolvePlantId(adapter, message);
    const metaBase = { plantId: plantId || undefined, serverIp: writeIp };

    try {
        const remote = await runRemoteRedirect(adapter, writeIp, message);
        if (remote.ok) {
            await persistLocalSetupArmed(adapter, remote.stickSn, metaBase);
            const result =
                remote.result ||
                `${MSG.setupOk(remote.stickSn, writeIp, remote.port)} Schalter geht an, sobald der Stick hier connected.`;
            return {
                result,
                native: armedNativePatch(adapter, writeIp, remote.stickSn),
                ok: true,
                ...remote,
            };
        }

        if (remote.offline || remote.error === 'stick_offline') {
            const sn = remote.stickSn || String(adapter.config.localStickSn || '').trim();
            if (isKnownLocalRedirect(adapter, sn)) {
                return armLocalOfflineKnown(adapter, writeIp, sn);
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
                const sn = String(adapter.config.localStickSn || '').trim();
                await persistLocalSetupArmed(adapter, sn, metaBase);
                return {
                    result: fallback.result,
                    ok: true,
                    native: armedNativePatch(adapter, writeIp, sn),
                    ...fallback,
                };
            }
            return { error: remote.hint || MSG.needPassword, ok: false };
        }

        adapter.log.warn(`remote stick setup failed: ${remote.hint || remote.error}`);
        const fallback = await runApFallback(adapter, writeIp);
        if (fallback.ok) {
            const sn = String(adapter.config.localStickSn || '').trim();
            await persistLocalSetupArmed(adapter, sn, metaBase);
            return {
                result: fallback.result,
                ok: true,
                native: armedNativePatch(adapter, writeIp, sn),
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
            const sn = String(adapter.config.localStickSn || '').trim();
            if (isKnownLocalRedirect(adapter, sn)) {
                return armLocalOfflineKnown(adapter, writeIp, sn);
            }
            return {
                error: MSG.offline,
                ok: false,
                native: { stickCloudOnline: false, stickOnlineLabel: adapter.config.stickOnlineLabel },
            };
        }
        const fallback = await runApFallback(adapter, writeIp);
        if (fallback.ok) {
            const sn = String(adapter.config.localStickSn || '').trim();
            await persistLocalSetupArmed(adapter, sn, metaBase);
            return {
                result: fallback.result,
                ok: true,
                native: armedNativePatch(adapter, writeIp, sn),
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
    runApFallback,
    checkStickOnline,
    resolveStickSn,
    previewRedirect,
    buildLocalFrame,
    MSG,
};
