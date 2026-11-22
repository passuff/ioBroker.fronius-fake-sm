'use strict';

const { GrowattShineSession, LOGGER_REG } = require('./growattShineSession');

/** German user-facing texts for Admin sendTo (`error` / `result`). */
const MSG = {
    noIp: 'Keine lokale IP gefunden. Prüfe die Netzwerkverbindung von ioBroker.',
    needPassword:
        'Shine-Web-User/Passwort fehlt. Unter „Lokal“ eintragen und speichern — der Adapter prüft den Stick dann automatisch im Hintergrund.',
    noStickSn:
        'Keine Stick-SN gefunden. Unter „Lokal“ die Datalogger-SN eintragen (z.B. XGD…) und speichern.',
    loginFail: (detail) => `Shine-Login fehlgeschlagen: ${detail}`,
    offline:
        'Growatt erreicht den Stick gerade nicht (oft nachts: Stick/WR ohne Cloud-Session). Umbiegen geht nur, solange der Stick bei Growatt online ist — der Adapter prüft das weiter im Hintergrund. Sobald der Status grün ist: „Stick einrichten“.',
    offlineShort: 'Stick bei Growatt nicht erreichbar — Einrichten wartet.',
    offlineBlocked:
        '„Stick einrichten“ wartet: Growatt hat gerade keine Verbindung zum Stick (häufig nachts). Sobald der Status grün ist, wird der Button aktiv.',
    online: (sn, ip) =>
        `Online: Stick ${sn} erreichbar. Server-IP aktuell: ${ip || 'unbekannt'}.`,
    waitingCreds: 'Warte auf Shine-User + Passwort (Lokal) — Online-Prüfung läuft dann automatisch.',
    checking: 'Prüfe Stick-Online-Status bei Growatt…',
    labelOnline: 'WR verbunden',
    labelOffline: 'WR nicht verbunden',
    labelUnknown: 'WR nicht verbunden',
    labelWaiting: 'WR nicht verbunden',
    setupOk: (sn, ip, port) =>
        `Fertig: Stick ${sn} soll ${ip}:${port} nutzen. Warte auf Verbindung (info.localConnection). Cloud bleibt per Forward.`,
    apOk: (hosts, ip) =>
        `AP-Stick gefunden (${hosts.join(', ')}). Stick sollte sich mit ${ip}:5279 verbinden.`,
    apOnlyHint:
        'Kein Stick im AP-Modus (:5280). Remote ging nicht, weil der Stick offline ist. Bei Sonne erneut versuchen — oder Taste drücken bis LED blau.',
};

/**
 * @param {boolean|null} online
 * @param {string} [_detail] ignored — UI shows one short phrase only
 */
function onlineLabel(online, _detail) {
    if (online === true) {
        return MSG.labelOnline;
    }
    return MSG.labelOffline;
}

/**
 * @param {any} data
 */
function isCloudLost(data) {
    const msg = data && (data.msg || data.message || data);
    return /datalog_lost|lost/i.test(String(msg || ''));
}

/**
 * @param {any} data
 */
function isCloudOk(data) {
    // HTML / plain text after session expiry must not count as online
    if (!data || typeof data !== 'object') {
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
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function sessionFromAdapter(adapter) {
    const user = String(adapter.config.growattUser || process.env.GROWATT_USER || '').trim();
    const password = String(adapter.config.growattPassword || process.env.GROWATT_PASSWORD || '');
    if (!user || !password || password === 'replace-me') {
        return { error: MSG.needPassword };
    }
    return {
        session: new GrowattShineSession({
            user,
            password,
            server: adapter.config.growattShineUrl || 'https://server.growatt.com',
            log: (m) => adapter.log.info(m),
        }),
    };
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {import('./growattShineSession').GrowattShineSession} [session]
 */
async function resolveStickSn(adapter, session) {
    const fromCfg = String(adapter.config.localStickSn || '').trim();
    if (fromCfg) {
        return fromCfg;
    }
    try {
        const st = await adapter.getStateAsync('info.stickSn');
        if (st && st.val) {
            return String(st.val).trim();
        }
    } catch {
        // ignore
    }
    if (!session) {
        return '';
    }
    const plantIds = [];
    const devices = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
    for (const d of devices) {
        if (d && d.plantId && !plantIds.includes(String(d.plantId))) {
            plantIds.push(String(d.plantId));
        }
    }
    if (adapter.config.growattPlantId) {
        const p = String(adapter.config.growattPlantId);
        if (!plantIds.includes(p)) {
            plantIds.push(p);
        }
    }
    const found = await session.listDataloggerSns(plantIds);
    if (found.length === 1) {
        return found[0].sn;
    }
    if (found.length > 1) {
        adapter.log.info(`multiple dataloggers: ${found.map((f) => f.sn).join(', ')} — set localStickSn`);
        return found[0].sn;
    }
    return '';
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {boolean} online
 * @param {object} [extra]
 */
async function persistStickOnlineFlag(adapter, online, extra = {}) {
    adapter.config.stickCloudOnline = !!online;
    const label = onlineLabel(!!online);
    adapter.config.stickOnlineLabel = label;
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (obj && obj.native) {
            obj.native.stickCloudOnline = online;
            obj.native.stickOnlineLabel = label;
            if (extra.localStickSn) {
                obj.native.localStickSn = extra.localStickSn;
                adapter.config.localStickSn = extra.localStickSn;
            }
            if (extra.stickStatusText != null) {
                obj.native.stickStatusText = extra.stickStatusText;
            }
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
        }
    } catch (err) {
        adapter.log.warn(`persist stickCloudOnline: ${err.message}`);
    }
    await adapter.setStateAsync('info.stickOnline', { val: !!online, ack: true });
    await adapter.setStateAsync('info.stickOnlineLabel', { val: label, ack: true });
    if (extra.stickStatusText != null) {
        await adapter.setStateAsync('info.setupStatus', {
            val: String(extra.stickStatusText).slice(0, 240),
            ack: true,
        });
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function checkStickOnline(adapter) {
    if (String(adapter.config.growattFeedMode || 'cloud') !== 'local') {
        return {
            result: 'Datenweg ist Cloud — Stick-Prüfung übersprungen',
            native: {},
        };
    }
    const cred = sessionFromAdapter(adapter);
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
        const stickSn = await resolveStickSn(adapter, cred.session);
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

        const probe = await cred.session.getRegister(stickSn, LOGGER_REG.SERVERIP);
        const online = isCloudOk(probe);
        const currentIp = online && probe && probe.msg != null ? String(probe.msg) : '';
        const text = online ? MSG.online(stickSn, currentIp) : MSG.offline;

        await persistStickOnlineFlag(adapter, online, {
            localStickSn: stickSn,
            stickStatusText: text,
        });

        const native = {
            stickCloudOnline: online,
            localStickSn: stickSn,
            stickStatusText: text,
            stickOnlineLabel: adapter.config.stickOnlineLabel,
        };
        // Always `result` (not `error`) after a successful probe — offline is a
        // valid outcome; returning error made the button look broken in Admin.
        return {
            result: online ? `${MSG.labelOnline} — geprüft` : `${MSG.labelOffline} — geprüft`,
            native,
        };
    } catch (err) {
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

/**
 * Background stick-online probe (Shine login). Interval short when offline so
 * daylight recovery is noticed; longer when already online.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [opts]
 * @param {number} [opts.firstDelayMs]
 */
function startStickOnlineMonitor(adapter, opts = {}) {
    if (adapter._stickOnlineTimer) {
        clearTimeout(adapter._stickOnlineTimer);
        adapter._stickOnlineTimer = null;
    }

    if (String(adapter.config.growattFeedMode || 'cloud') !== 'local') {
        adapter.log.debug('stick online monitor skipped (feed mode is not local)');
        return;
    }

    const tick = async () => {
        if (adapter._stopping) {
            return;
        }
        if (String(adapter.config.growattFeedMode || 'cloud') !== 'local') {
            return;
        }
        const cred = sessionFromAdapter(adapter);
        let delayMs = 15 * 60 * 1000;
        if (cred.error) {
            await persistStickOnlineFlag(adapter, false, { stickStatusText: MSG.waitingCreds });
            delayMs = 5 * 60 * 1000;
        } else {
            try {
                adapter.log.debug('stick online monitor: probing…');
                await checkStickOnline(adapter);
            } catch (err) {
                adapter.log.warn(`stick online monitor: ${err.message}`);
                await persistStickOnlineFlag(adapter, false, {
                    stickStatusText: `${MSG.offlineShort} (${err.message})`,
                });
            }
            delayMs = adapter.config.stickCloudOnline ? 20 * 60 * 1000 : 10 * 60 * 1000;
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
    adapter.log.info(`Stick-Online-Monitor aktiv (erste Prüfung in ${Math.round(first / 1000)}s)`);
}

function stopStickOnlineMonitor(adapter) {
    if (adapter._stickOnlineTimer) {
        clearTimeout(adapter._stickOnlineTimer);
        adapter._stickOnlineTimer = null;
    }
}

module.exports = {
    MSG,
    LOGGER_REG,
    isCloudOk,
    isCloudLost,
    onlineLabel,
    sessionFromAdapter,
    resolveStickSn,
    persistStickOnlineFlag,
    checkStickOnline,
    startStickOnlineMonitor,
    stopStickOnlineMonitor,
};
