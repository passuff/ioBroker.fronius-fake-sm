'use strict';

const net = require('net');
const { candidateHosts, advertisedListenIps } = require('./froniusDiscover');
const { buildRedirectFrames } = require('./growattCommands');
const {
    MSG,
    LOGGER_REG,
    isCloudOk,
    sessionFromAdapter,
    resolveStickSn,
    persistStickOnlineFlag,
    checkStickOnline,
} = require('./stickOnline');

/**
 * Probe TCP port quickly.
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function probePort(host, port, timeoutMs = 400) {
    return new Promise((resolve) => {
        const s = net.connect({ host, port }, () => {
            s.destroy();
            resolve(true);
        });
        s.on('error', () => resolve(false));
        s.setTimeout(timeoutMs, () => {
            s.destroy();
            resolve(false);
        });
    });
}

/**
 * @param {object} [opts]
 * @returns {Promise<string[]>}
 */
async function scanLocalStickPorts(opts = {}) {
    const port = Number(opts.port ?? 5280);
    const hosts = candidateHosts(opts.maxHosts || 256);
    const log = opts.log || (() => {});
    log(`scanning ${hosts.length} hosts for :${port}`);
    const open = [];
    const concurrency = 32;
    for (let i = 0; i < hosts.length; i += concurrency) {
        const batch = hosts.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async (h) => ((await probePort(h, port)) ? h : null)));
        for (const h of results) {
            if (h) {
                open.push(h);
            }
        }
    }
    return open;
}

/**
 * @param {number} func
 * @param {Buffer} payload
 */
function buildLocalFrame(func, payload) {
    const body = Buffer.concat([Buffer.from([0x01, func & 0xff]), payload || Buffer.alloc(0)]);
    const header = Buffer.from([0x00, 0x01, 0x00, 0x05, 0x00, 0x00]);
    header.writeUInt16BE(body.length + 2, 4);
    return Buffer.concat([header, body, Buffer.from([0x00, 0x00])]);
}

/**
 * @param {string} host
 * @param {string} serverIp
 * @param {number} [serverPort]
 */
function tryTouchApStick(host, serverIp, serverPort = 5279) {
    return new Promise((resolve) => {
        const s = net.connect({ host, port: 5280 }, () => {
            const ipPayload = Buffer.concat([
                Buffer.from([0x00, 0x11, 0x00, serverIp.length]),
                Buffer.from(serverIp, 'ascii'),
            ]);
            const portStr = String(serverPort);
            const portPayload = Buffer.concat([
                Buffer.from([0x00, 0x12, 0x00, portStr.length]),
                Buffer.from(portStr, 'ascii'),
            ]);
            const multi = Buffer.concat([Buffer.from([0x00, 0x00, 0x02]), ipPayload, portPayload]);
            try {
                s.write(buildLocalFrame(0x18, multi));
            } catch {
                // ignore
            }
            setTimeout(() => {
                s.destroy();
                resolve({ ok: true, host, note: 'ap_touched' });
            }, 500);
        });
        s.on('error', (err) => resolve({ ok: false, host, error: err.message }));
        s.setTimeout(2000, () => {
            s.destroy();
            resolve({ ok: false, host, error: 'timeout' });
        });
    });
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} serverIp
 */
/**
 * Arm proxy before redirect. Returns false if bind failed.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} serverIp
 * @returns {Promise<boolean>}
 */
async function ensureLocalProxyReady(adapter, serverIp) {
    // Listen for stick reconnect after redirect — do NOT enable local switch yet
    adapter.config.localSetupPending = true;
    adapter.config.growattFeedMode = 'local';
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (obj && obj.native) {
            obj.native.localSetupPending = true;
            obj.native.growattFeedMode = 'local';
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
        }
    } catch (err) {
        adapter.log.warn(`could not persist localSetupPending: ${err.message}`);
    }

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
 */
async function runRemoteRedirect(adapter, serverIp) {
    const cred = sessionFromAdapter(adapter);
    if (cred.error) {
        return { ok: false, skipped: true, error: 'need_shine_password', hint: cred.error };
    }

    await adapter.setStateAsync('info.setupStatus', { val: 'Shine-Login…', ack: true });
    await cred.session.login();

    const stickSn = await resolveStickSn(adapter, cred.session);
    if (!stickSn) {
        return { ok: false, error: 'no_stick_sn', hint: MSG.noStickSn };
    }
    await adapter.setStateAsync('info.stickSn', { val: stickSn, ack: true });
    if (!adapter.config.localStickSn) {
        try {
            const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
            if (obj && obj.native) {
                obj.native.localStickSn = stickSn;
                await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
                adapter.config.localStickSn = stickSn;
            }
        } catch (err) {
            adapter.log.warn(`could not persist localStickSn: ${err.message}`);
        }
    }

    const probe = await cred.session.getRegister(stickSn, LOGGER_REG.SERVERIP);
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
 * @returns {Promise<object>}
 */
async function runStickSetup(adapter) {
    if (String(adapter.config.growattFeedMode || 'cloud') !== 'local') {
        return {
            error: 'Datenweg ist Cloud — für Stick-Einrichtung unter Fremd-WR „Lokal“ wählen und speichern.',
            ok: false,
        };
    }
    const ips = advertisedListenIps();
    const serverIp = adapter.config.advertisedModbusIp || ips[0] || '';
    if (!serverIp) {
        return { error: MSG.noIp, ok: false };
    }

    // Proxy must listen before redirect — otherwise stick points at a dead port
    const proxyOk = await ensureLocalProxyReady(adapter, serverIp);
    if (!proxyOk) {
        return {
            error: 'Lokaler Proxy nicht gestartet — Redirect nicht ausgeführt.',
            ok: false,
            native: { localSetupPending: false },
        };
    }

    try {
        const remote = await runRemoteRedirect(adapter, serverIp);
        if (remote.ok) {
            const result =
                remote.result ||
                `${MSG.setupOk(remote.stickSn, serverIp, remote.port)} Schalter geht an, sobald der Stick hier connected.`;
            return {
                result,
                native: {
                    stickCloudOnline: true,
                    stickOnlineLabel: adapter.config.stickOnlineLabel,
                    localSetupPending: true,
                    growattFeedMode: 'local',
                },
                ok: true,
                ...remote,
            };
        }

        if (remote.offline || remote.error === 'stick_offline') {
            return {
                error: remote.hint || MSG.offline,
                ok: false,
                native: {
                    stickCloudOnline: false,
                    stickOnlineLabel: adapter.config.stickOnlineLabel,
                },
            };
        }

        if (remote.skipped) {
            const fallback = await runApFallback(adapter, serverIp);
            if (fallback.ok) {
                return {
                    result: fallback.result,
                    ok: true,
                    native: { localSetupPending: true, growattFeedMode: 'local' },
                    ...fallback,
                };
            }
            return { error: remote.hint || MSG.needPassword, ok: false };
        }

        adapter.log.warn(`remote stick setup failed: ${remote.hint || remote.error}`);
        const fallback = await runApFallback(adapter, serverIp);
        if (fallback.ok) {
            return {
                result: fallback.result,
                ok: true,
                native: { localSetupPending: true, growattFeedMode: 'local' },
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
            return {
                error: MSG.offline,
                ok: false,
                native: { stickCloudOnline: false, stickOnlineLabel: adapter.config.stickOnlineLabel },
            };
        }
        const fallback = await runApFallback(adapter, serverIp);
        if (fallback.ok) {
            return {
                result: fallback.result,
                ok: true,
                native: { localSetupPending: true, growattFeedMode: 'local' },
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
    runStickSetup,
    runRemoteRedirect,
    checkStickOnline,
    resolveStickSn,
    previewRedirect,
    buildLocalFrame,
    MSG,
};
