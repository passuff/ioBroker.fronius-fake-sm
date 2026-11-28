'use strict';

const { GrowattShineSession, LOGGER_REG, isShineLostFlag } = require('./growattShineSession');

const { MSG, onlineLabel } = require('./stickMessages');
const { persistStickOnlineFlag } = require('./stickOnlineState');
const { maybeFallbackUnpatchedLocal, clientCount } = require('./stickRedirectGuard');

/**
 * @param {any} data
 */
function isCloudLost(data) {
    const msg = data && (data.msg || data.message || data);
    return /datalog_lost|inv_set_datalog_lost/i.test(String(msg || '')) || isShineLostFlag(data && data.lost);
}

/**
 * @param {any} data
 */
function isPermissionDenied(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    const msg = String(data.msg || data.message || data.error || '');
    return /permission_denied|error_permission|no.?permission/i.test(msg);
}

/**
 * @param {any} data
 */
function isCloudOk(data) {
    // HTML / plain text after session expiry must not count as online
    if (!data || typeof data !== 'object') {
        return false;
    }
    if (isPermissionDenied(data)) {
        return false;
    }
    if (data.success === true || data.success === 'true') {
        return !isCloudLost(data);
    }
    // Some Shine endpoints omit success but return msg for register reads
    if (data.success === undefined && (data.msg != null || data.message != null || data.result != null)) {
        return !isCloudLost(data);
    }
    if (data.success === false || data.success === 'false') {
        return false;
    }
    if (isCloudLost(data)) {
        return false;
    }
    return false;
}

/**
 * @param {{id:string,plantName:string}} plant
 */
function plantSelectOption(plant) {
    return {
        value: String(plant.id),
        label: `${plant.plantName} (${plant.id})`,
        noTranslation: true,
    };
}

/**
 * Best-effort FW string from a Shine datalogger row or raw payload.
 * @param {object} [rowOrRaw]
 * @returns {string}
 */
function extractStickFw(rowOrRaw) {
    if (!rowOrRaw || typeof rowOrRaw !== 'object') {
        return '';
    }
    if (rowOrRaw.fw != null && String(rowOrRaw.fw).trim()) {
        return String(rowOrRaw.fw).trim();
    }
    const raw =
        rowOrRaw.raw && typeof rowOrRaw.raw === 'object' ? rowOrRaw.raw : rowOrRaw;
    for (const k of [
        'firmwareVersion',
        'fwVersion',
        'firmware',
        'version',
        'fw',
        'softVersion',
        'softwareVersion',
        'dataloggerVersion',
    ]) {
        const v = raw[k];
        if (v != null && String(v).trim()) {
            return String(v).trim();
        }
    }
    return '';
}

/**
 * @param {{sn:string,lost:boolean,lastUpdateTime?:string,plantName?:string,plantId?:string,fw?:string,raw?:object,redirectState?:string}} stick
 */
function stickSelectOption(stick) {
    const online = !stick.lost;
    const fw = extractStickFw(stick);
    const plant = String(stick.plantName || stick.plantId || '').trim();
    const plantPart = plant ? ` · ${plant}` : '';
    const fwPart = fw ? ` · FW ${fw}` : '';
    const when = stick.lastUpdateTime ? ` · ${stick.lastUpdateTime}` : '';
    let redir = '—';
    if (stick.redirectState === 'verified') {
        redir = 'hier';
    } else if (stick.redirectState === 'pending') {
        redir = 'wartet';
    } else if (stick.redirectState === 'redirected') {
        redir = 'umgeleitet';
    }
    return {
        value: String(stick.sn),
        label: `${stick.sn}${plantPart} — ${online ? 'online' : 'offline'}${fwPart}${when} · Umleitung: ${redir}`,
        noTranslation: true,
    };
}

/**
 * Drop adapter-scoped Shine session (tests / credential change).
 * @param {import('@iobroker/adapter-core').Adapter & object} [adapter]
 */
function clearSharedShineSession(adapter) {
    if (adapter) {
        adapter._shineSession = null;
        adapter._shineSessionKey = '';
    }
}

/**
 * Shared Shine web session per adapter + credential key.
 * Reusing cookies avoids Growatt account lockouts from /login storms.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
function sessionFromAdapter(adapter, message) {
    const msg = message && typeof message === 'object' ? message : {};
    const user = String(msg.growattUser || adapter.config.growattUser || process.env.GROWATT_USER || '').trim();
    const password = String(
        msg.growattPassword || adapter.config.growattPassword || process.env.GROWATT_PASSWORD || '',
    );
    if (!user || !password || password === 'replace-me') {
        return { error: MSG.needPassword };
    }
    const server = String(
        msg.growattShineUrl || (adapter.config && adapter.config.growattShineUrl) || 'https://server.growatt.com',
    ).replace(/\/$/, '');
    const key = `${user}\0${password}\0${server}`;
    if (adapter && adapter._shineSession && adapter._shineSessionKey === key) {
        return { session: adapter._shineSession, user, password };
    }
    const session = new GrowattShineSession({
        user,
        password,
        server,
        log: (m) => adapter.log.info(m),
    });
    if (adapter) {
        adapter._shineSession = session;
        adapter._shineSessionKey = key;
    }
    return { session, user, password };
}

/**
 * Explicit selection only — no silent discovery / info.stickSn fallback.
 * Prefer SN from Admin sendTo payload (unsaved form), then native config.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {import('./growattShineSession').GrowattShineSession} [_session]
 * @param {object} [message]
 */
async function resolveStickSn(adapter, _session, message) {
    const msg = message && typeof message === 'object' ? message : {};
    return String(msg.localStickSn || adapter.config.localStickSn || '').trim();
}

/**
 * Prefer form plantId, then registry entry for selected SN, then native localPlantId.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
function resolvePlantId(adapter, message) {
    const msg = message && typeof message === 'object' ? message : {};
    const fromMsg = String(msg.localPlantId || '').trim();
    if (fromMsg) {
        return fromMsg;
    }
    const sn = String(msg.localStickSn || (adapter.config && adapter.config.localStickSn) || '').trim();
    if (sn) {
        const { getStickEntry } = require('./stickRedirectRegistry');
        const entry = getStickEntry(adapter.config, sn);
        if (entry && entry.plantId) {
            return String(entry.plantId).trim();
        }
        const cache = adapter._localStickPlantBySn;
        if (cache && cache[sn]) {
            return String(cache[sn]).trim();
        }
    }
    return String((adapter.config && adapter.config.localPlantId) || '').trim();
}

/**
 * Admin form may already be on „local“ while native is still cloud until Save.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
function isLocalFeedMode(adapter, message) {
    const msg = message && typeof message === 'object' ? message : {};
    const mode = String(msg.growattFeedMode || adapter.config.growattFeedMode || 'cloud');
    return mode === 'local';
}

/**
 * Setup button / green badge = register remote session (setDatalogParam).
 * Shine list `lost` alone is not enough — App can show online while remote cmds fail.
 * @param {boolean|null} listOnline  null when plant list unavailable
 * @param {boolean} remoteOk
 * @returns {boolean}
 */
function isSetupReady(listOnline, remoteOk) {
    return !!remoteOk;
}

/**
 * @param {string} stickSn
 * @param {boolean|null} listOnline
 * @param {boolean} remoteOk
 * @param {string} currentIp
 * @param {string} [lastUpdate]
 */
function buildOnlineStatusText(stickSn, listOnline, remoteOk, currentIp, lastUpdate) {
    if (remoteOk) {
        if (listOnline === true) {
            let text = MSG.onlineList(stickSn, lastUpdate);
            if (currentIp) {
                text += ` Server-IP: ${currentIp}.`;
            }
            return text;
        }
        return MSG.online(stickSn, currentIp);
    }
    if (listOnline === true) {
        return MSG.remoteNotReady(stickSn, lastUpdate);
    }
    return MSG.offline;
}

/**
 * Probe stick reachability without writing native config (safe for Admin textSendTo).
 * @param {import('./growattShineSession').GrowattShineSession} session
 * @param {string} plantId
 * @param {string} stickSn
 * @returns {Promise<{online:boolean, text:string, listOnline:boolean|null, remoteOk:boolean}>}
 */
async function probeStickStatus(session, plantId, stickSn) {
    const sn = String(stickSn || '').trim();
    if (!sn) {
        return { online: false, text: 'nicht verbunden – kein Stick gewählt', listOnline: null, remoteOk: false };
    }
    let listOnline = null;
    let lastUpdate = '';
    const pid = String(plantId || '').trim();
    if (pid) {
        const sticks = await session.listDataloggers(pid);
        const row = sticks.find((s) => s.sn === sn);
        if (row) {
            listOnline = !row.lost;
            lastUpdate = row.lastUpdateTime || '';
        }
    }
    const probe = await session.getRegister(sn, LOGGER_REG.SERVERIP);
    if (isPermissionDenied(probe)) {
        return {
            online: false,
            text: `nicht verbunden – ${MSG.permissionDenied(sn)}`,
            listOnline,
            remoteOk: false,
            currentIp: '',
        };
    }
    const remoteOk = isCloudOk(probe);
    const currentIp = remoteOk && probe && probe.msg != null ? String(probe.msg).trim() : '';
    const online = isSetupReady(listOnline, remoteOk);
    if (online) {
        const ipHint = currentIp ? ` · Server-IP ${currentIp}` : '';
        return { online: true, text: `verbunden${ipHint}`, listOnline, remoteOk, currentIp };
    }
    if (listOnline === true) {
        return {
            online: false,
            text: `nicht verbunden – Remote-Befehl noch nicht bereit${lastUpdate ? ` · Update ${lastUpdate}` : ''}`,
            listOnline,
            remoteOk,
            currentIp: '',
        };
    }
    return {
        online: false,
        text: 'nicht verbunden – Stick nachts offline oder ohne Cloud-Session',
        listOnline,
        remoteOk,
        currentIp: '',
    };
}

/**
 * Online badge / Setup gate = register probe (remoteOk).
 * Shine list informs status text (and dropdown) but must not unlock Setup alone.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
async function checkStickOnline(adapter, message) {
    if (!isLocalFeedMode(adapter, message)) {
        return {
            result: 'Datenweg ist Cloud — Stick-Prüfung übersprungen',
            native: {},
        };
    }
    const { shineLoginBlockedReason, noteShineAuthFailure } = require('./localStatusAdmin');
    const blocked = shineLoginBlockedReason(adapter);
    if (blocked) {
        await persistStickOnlineFlag(adapter, false, { stickStatusText: blocked });
        return {
            error: blocked,
            native: {
                stickCloudOnline: false,
                stickStatusText: blocked,
                stickOnlineLabel: adapter.config.stickOnlineLabel,
            },
        };
    }
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        await persistStickOnlineFlag(adapter, false, { stickStatusText: cred.error });
        return {
            error: cred.error,
            native: {
                stickCloudOnline: false,
                stickStatusText: cred.error,
                stickOnlineLabel: adapter.config.stickOnlineLabel,
            },
        };
    }

    try {
        await adapter.setStateAsync('info.setupStatus', { val: 'Prüfe Stick bei Growatt…', ack: true });
        await cred.session.login();
        const stickSn = await resolveStickSn(adapter, cred.session, message);
        const plantId = resolvePlantId(adapter, message);
        if (!stickSn) {
            await persistStickOnlineFlag(adapter, false, { stickStatusText: MSG.noStickSn });
            return {
                error: MSG.noStickSn,
                native: {
                    stickCloudOnline: false,
                    stickStatusText: MSG.noStickSn,
                    stickOnlineLabel: adapter.config.stickOnlineLabel,
                },
            };
        }
        await adapter.setStateAsync('info.stickSn', { val: stickSn, ack: true });

        const probed = await probeStickStatus(cred.session, plantId, stickSn);
        let online = probed.online;
        let text = probed.text;
        if (!online && clientCount(adapter.localServer) > 0) {
            text = MSG.localProxyOnly;
        }

        let fellBack = false;
        if (online) {
            const fb = await maybeFallbackUnpatchedLocal(adapter, probed.currentIp, stickSn);
            if (fb.fellBack) {
                fellBack = true;
                text = fb.text || text;
            } else if (fb.text && !online) {
                text = fb.text;
            } else if (fb.text && fb.removed) {
                text = fb.text;
            }
        }

        await persistStickOnlineFlag(adapter, online, {
            localStickSn: stickSn,
            localPlantId: plantId || undefined,
            stickStatusText: text,
        });

        const { cloneRegistry } = require('./stickRedirectRegistry');
        const native = {
            stickCloudOnline: online,
            localStickSn: stickSn,
            stickStatusText: text,
            stickOnlineLabel: adapter.config.stickOnlineLabel,
            stickRedirects: cloneRegistry(adapter.config.stickRedirects),
            localSetupPending: !!adapter.config.localSetupPending,
            localSetupVerified: !!adapter.config.localSetupVerified,
            cloudStickRedirectActive: !!adapter.config.cloudStickRedirectActive,
            cloudStickRedirectSn: String(adapter.config.cloudStickRedirectSn || ''),
        };
        if (plantId) {
            native.localPlantId = plantId;
        }
        if (fellBack) {
            native.growattFeedMode = 'cloud';
            native.localSetupPending = false;
            native.localSetupVerified = false;
            native.cloudStickRedirectActive = false;
            native.cloudStickRedirectSn = '';
        }
        return {
            result: fellBack
                ? text
                : online
                  ? `${MSG.labelOnline} — geprüft`
                  : `${MSG.labelOffline} — geprüft`,
            native,
        };
    } catch (err) {
        noteShineAuthFailure(adapter, err);
        const detail = err.message || String(err);
        const text = /login|password|invalid/i.test(detail)
            ? MSG.loginFail(detail)
            : `${MSG.offlineShort} (${detail})`;
        await persistStickOnlineFlag(adapter, false, { stickStatusText: text });
        return {
            error: text,
            native: {
                stickCloudOnline: false,
                stickStatusText: text,
                stickOnlineLabel: adapter.config.stickOnlineLabel,
            },
        };
    }
}

module.exports = {
    MSG,
    LOGGER_REG,
    isCloudOk,
    isCloudLost,
    isPermissionDenied,
    isShineLostFlag,
    isSetupReady,
    buildOnlineStatusText,
    onlineLabel,
    plantSelectOption,
    stickSelectOption,
    extractStickFw,
    sessionFromAdapter,
    clearSharedShineSession,
    resolveStickSn,
    resolvePlantId,
    isLocalFeedMode,
    persistStickOnlineFlag,
    probeStickStatus,
    maybeFallbackUnpatchedLocal,
    checkStickOnline,
};
