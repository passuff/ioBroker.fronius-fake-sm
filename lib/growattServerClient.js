'use strict';

const net = require('net');
const { FrameSplitter } = require('./growattProto');
const { AesSession } = require('./growattAesSession');
const { handleStickFrame } = require('./growattServerFrame');

/**
 * Attach one stick TCP client to a GrowattServer (session / AES / upstream).
 * @param {import('./growattServer').GrowattServer} server
 * @param {import('net').Socket} stickSock
 */
function attachStickClient(server, stickSock) {
    const ip = String(stickSock.remoteAddress || '').replace(/^::ffff:/, '');
    const peer = `${stickSock.remoteAddress}:${stickSock.remotePort}`;
    const peerIp = ip;
    // Replace only stale sessions from the SAME peer IP (zombies left after a
    // WiFi/power-drop reconnect of this datalogger). Distinct sticks on
    // different IPs coexist so a real prod stick and a lab stick don't fight
    // over a single global session (per-SN cleanup happens once the SN is known).
    const replaced = typeof server.dropClientsByIp === 'function' ? server.dropClientsByIp(ip) : 0;
    if (replaced > 0) {
        server.log(`replaced ${replaced} previous stick session(s) from ${ip}`);
    }
    server.connectCount += 1;
    server.log(`stick connected ${peer}`);
    try {
        stickSock.setKeepAlive(true, 30000);
        stickSock.setTimeout(180000);
    } catch {
        // ignore
    }
    // Register client BEFORE onPeer so publishLocalStickPresence sees clientCount > 0.
    server._clients.add(stickSock);
    server._emitClientCount();
    try {
        server.onPeer(String(stickSock.remoteAddress || '').replace(/^::ffff:/, ''));
    } catch {
        // ignore
    }
    const { SessionFrameHealth } = require('./frameHealth');
    const health = new SessionFrameHealth();
    const aesSession = new AesSession();
    stickSock._aesSession = aesSession;
            let healthTimer = setTimeout(() => {
        healthTimer = null;
        server._reportFrameHealth(health.checkTimeout(), health, {
            stickSn: aesSession.serial || '',
            peerIp,
        });
    }, 12 * 60 * 1000);
    const splitter = new FrameSplitter();
    const downSplitter = new FrameSplitter();
    /** @type {net.Socket|null} */
    let upstream = null;
    let upstreamReady = false;
    let closed = false;
    const PENDING_CAP_BYTES = 64 * 1024;
    let pendingBytes = 0;
    /** @type {Buffer[]} */
    const pending = [];
    /** @type {ReturnType<typeof setTimeout>|null} */
    let upstreamRetryTimer = null;
    let upstreamAttempt = 0;

    const redactKey = (hex) => {
        const s = String(hex || '');
        if (s.length <= 4) {
            return '****';
        }
        return `${s.slice(0, 4)}…`;
    };

    const pushPending = (chunk) => {
        const buf = Buffer.from(chunk);
        if (pendingBytes + buf.length > PENDING_CAP_BYTES) {
            server.error(
                `upstream pending overflow (${pendingBytes}+${buf.length} > ${PENDING_CAP_BYTES}) — dropping stick ${peer}`,
            );
            try {
                stickSock.destroy();
            } catch {
                // ignore
            }
            return false;
        }
        pending.push(buf);
        pendingBytes += buf.length;
        return true;
    };

    const cleanup = () => {
        closed = true;
        if (healthTimer) {
            clearTimeout(healthTimer);
            healthTimer = null;
        }
        if (upstreamRetryTimer) {
            clearTimeout(upstreamRetryTimer);
            upstreamRetryTimer = null;
        }
        server._clients.delete(stickSock);
        server._pendingToStick.delete(stickSock);
        for (const [snKey, sock] of server._stickBySn) {
            if (sock === stickSock) {
                server._stickBySn.delete(snKey);
            }
        }
        if (upstream) {
            try {
                upstream.destroy();
            } catch {
                // ignore
            }
            upstream = null;
        }
        pending.length = 0;
        pendingBytes = 0;
        server._emitClientCount();
    };

    stickSock.on('timeout', () => {
        server.log(`stick idle timeout ${peer}`);
        try {
            stickSock.destroy();
        } catch {
            // ignore
        }
    });
    stickSock.on('close', () => {
        server.log(`stick closed ${peer}`);
        const closedSn = aesSession && aesSession.serial ? String(aesSession.serial) : undefined;
        cleanup();
        try {
            server.onClientClose(closedSn);
        } catch {
            // ignore
        }
    });
    stickSock.on('error', (err) => {
        server.debug(`stick error ${peer}: ${err.message}`);
        cleanup();
    });

    const scheduleUpstreamRetry = () => {
        if (closed || stickSock.destroyed || !server.forwardCloud) {
            return;
        }
        if (upstreamRetryTimer) {
            return;
        }
        const delay = Math.min(60000, 2000 * 2 ** Math.min(upstreamAttempt, 5));
        upstreamAttempt += 1;
        server.error(`upstream reconnect in ${Math.round(delay / 1000)}s (attempt ${upstreamAttempt})`);
        upstreamRetryTimer = setTimeout(() => {
            upstreamRetryTimer = null;
            openUpstream();
        }, delay);
    };

    const openUpstream = () => {
        if (closed || stickSock.destroyed || !server.forwardCloud) {
            return;
        }
        server.resolver
            .resolve()
            .then((ip) => {
                if (closed || stickSock.destroyed) {
                    return;
                }
                const sock = net.connect({ host: ip, port: server.upstreamPort });
                /** @type {ReturnType<typeof setTimeout>|null} */
                let connectTimer = setTimeout(() => {
                    connectTimer = null;
                    server.error(`upstream connect timeout ${ip}:${server.upstreamPort}`);
                    try {
                        sock.destroy();
                    } catch {
                        // ignore
                    }
                }, 15000);
                sock.once('connect', () => {
                    if (connectTimer) {
                        clearTimeout(connectTimer);
                        connectTimer = null;
                    }
                    if (closed || stickSock.destroyed) {
                        try {
                            sock.destroy();
                        } catch {
                            // ignore
                        }
                        return;
                    }
                    upstream = sock;
                    upstreamReady = true;
                    upstreamAttempt = 0;
                    try {
                        sock.setKeepAlive(true, 30000);
                    } catch {
                        // ignore
                    }
                    server.debug(`upstream connected ${ip}:${server.upstreamPort}`);
                    for (const buf of pending) {
                        sock.write(buf);
                    }
                    pending.length = 0;
                    pendingBytes = 0;
                });
                sock.on('data', (chunk) => {
                    if (typeof server.onRawDown === 'function') {
                        try {
                            server.onRawDown(chunk);
                        } catch {
                            // ignore
                        }
                    }
                    for (const raw of downSplitter.push(chunk)) {
                        if (aesSession.observeDown(raw) && aesSession.serial) {
                            const k0 = aesSession.candidates[0];
                            const keyHex = k0 && k0.key ? k0.key.toString('ascii') : '?';
                            const ivHex = k0 && k0.iv ? k0.iv.toString('ascii') : '?';
                            server.log(
                                `AES session key from DOWN SN=${aesSession.serial} key=${redactKey(keyHex)} iv=${redactKey(ivHex)}`,
                            );
                            if (typeof server.onAesSession === 'function') {
                                try {
                                    server.onAesSession({
                                        serial: aesSession.serial,
                                        key: keyHex,
                                        iv: ivHex,
                                        raw,
                                        source: 'down',
                                    });
                                } catch (err) {
                                    server.debug(`onAesSession: ${err && err.message ? err.message : err}`);
                                }
                            }
                        }
                    }
                    if (!stickSock.destroyed) {
                        stickSock.write(chunk);
                    }
                });
                sock.on('error', (err) => {
                    server.error(`upstream error: ${err.message}`);
                });
                sock.on('close', () => {
                    if (connectTimer) {
                        clearTimeout(connectTimer);
                        connectTimer = null;
                    }
                    if (upstream === sock) {
                        upstream = null;
                    }
                    upstreamReady = false;
                    // Keep local stick; retry cloud forward with backoff.
                    scheduleUpstreamRetry();
                });
            })
            .catch((err) => {
                server.error(`cannot open upstream: ${err.message}`);
                scheduleUpstreamRetry();
            });
    };

    if (server.forwardCloud) {
        openUpstream();
    }

    stickSock.on('data', (chunk) => {
        try {
            if (typeof server.onRawUp === 'function') {
                try {
                    server.onRawUp(chunk);
                } catch {
                    // ignore
                }
            }
            if (server.forwardCloud) {
                if (upstream && upstreamReady) {
                    upstream.write(chunk);
                } else if (!pushPending(chunk)) {
                    return;
                }
            }

            for (const raw of splitter.push(chunk)) {
                if (aesSession.observeUp(raw)) {
                    const k0 = aesSession.candidates[0];
                    const keyHex = k0 && k0.key ? k0.key.toString('ascii') : '?';
                    const ivHex = k0 && k0.iv ? k0.iv.toString('ascii') : '?';
                    server.log(
                        `AES session derived SN=${aesSession.serial} key=${redactKey(keyHex)} iv=${redactKey(ivHex)}`,
                    );
                    if (typeof server.onAesSession === 'function') {
                        try {
                            server.onAesSession({
                                serial: aesSession.serial,
                                key: keyHex,
                                iv: ivHex,
                                raw,
                            });
                        } catch (err) {
                            server.debug(`onAesSession: ${err && err.message ? err.message : err}`);
                        }
                    }
                    try {
                        const prevSock = server._stickBySn.get(aesSession.serial);
                        if (prevSock && prevSock !== stickSock) {
                            const prevIp = String(prevSock.remoteAddress || '').replace(/^::ffff:/, '');
                            // Only evict same-peer zombies; different IP claiming SN needs AES (this path).
                            if (prevIp && prevIp !== peerIp) {
                                server.log(
                                    `SN ${aesSession.serial} claimed by ${peerIp} — replacing prior peer ${prevIp}`,
                                );
                            }
                            try {
                                prevSock.destroy();
                            } catch {
                                // ignore
                            }
                        }
                        // Register before callbacks so hasStickSession stays consistent on throw.
                        server._stickBySn.set(aesSession.serial, stickSock);
                        server.onStick(aesSession.serial);
                    } catch (err) {
                        server.debug(`onStick: ${err && err.message ? err.message : err}`);
                    }
                }
                const before = health.verdict;
                let after = health.observe(raw);
                const result = handleStickFrame(server, raw, stickSock);
                if (result && result.aesOk) {
                    health.data += 1;
                    after = health._updateVerdict();
                } else if (
                    aesSession.looksLikeAesData(raw) &&
                    !aesSession._recovering &&
                    !aesSession._recovered
                ) {
                    if (
                        !aesSession.serial &&
                        server.defaultSerial &&
                        server.isFeedStick(server.defaultSerial)
                    ) {
                        aesSession.serial = server.defaultSerial;
                    }
                    const sn = String(aesSession.serial || '').trim();
                    const labDecode =
                        typeof server.allowDecodeSn === 'function' && server.allowDecodeSn(sn);
                    if (sn && !server.isFeedStick(sn) && !labDecode) {
                        server.debug(`skip AES seed-recover for non-feed SN=${sn}`);
                    } else if (aesSession.serial) {
                        const pendingRaw = Buffer.from(raw);
                        if (!server._seedHintBySn) {
                            server._seedHintBySn = new Map();
                        }
                        const hint = server._seedHintBySn.get(sn) || null;
                        aesSession
                            .scheduleSeedRecover(pendingRaw, {
                                log: (m) => server.log(m),
                                debug: (m) => server.debug(m),
                                hint,
                                shouldAbort: () => stickSock.destroyed,
                                onHit: (h) => {
                                    const now = Date.now();
                                    const prev = server._seedHintBySn.get(sn);
                                    let rate = 100;
                                    if (prev && prev.seed != null && prev.at != null) {
                                        const dtS = Math.max(0.001, (now - Number(prev.at)) / 1000);
                                        const rawRate = (Number(h.seed) - Number(prev.seed)) / dtS;
                                        if (Number.isFinite(rawRate) && rawRate > 10 && rawRate < 500) {
                                            rate = rawRate;
                                        } else if (prev.rate && Number(prev.rate) > 0) {
                                            rate = Number(prev.rate);
                                        }
                                    }
                                    server._seedHintBySn.set(sn, {
                                        seed: h.seed,
                                        at: now,
                                        rate,
                                    });
                                },
                            })
                            .then((hit) => {
                                if (!hit || stickSock.destroyed) {
                                    return;
                                }
                                const keyHex = hit.key.toString('ascii');
                                const ivHex = hit.iv.toString('ascii');
                                if (typeof server.onAesSession === 'function') {
                                    try {
                                        server.onAesSession({
                                            serial: aesSession.serial,
                                            key: keyHex,
                                            iv: ivHex,
                                            raw: pendingRaw,
                                            source: 'seed',
                                            seed: hit.seed,
                                        });
                                    } catch (err) {
                                        server.debug(`onAesSession seed: ${err && err.message ? err.message : err}`);
                                    }
                                }
                                const again = handleStickFrame(server, pendingRaw, stickSock);
                                if (again && again.aesOk) {
                                    health.data += 1;
                                    const v = health._updateVerdict();
                                    if (v !== 'pending') {
                                        server._reportFrameHealth(v, health, {
                                            stickSn: aesSession.serial || '',
                                            peerIp,
                                        });
                                    }
                                }
                            })
                            .catch((err) => {
                                server.debug(
                                    `AES seed-recover failed: ${err && err.message ? err.message : err}`,
                                );
                            });
                    }
                }
                if (after !== before && after !== 'pending') {
                    server._reportFrameHealth(after, health, {
                        stickSn: aesSession.serial || '',
                        peerIp,
                    });
                }
            }
        } catch (err) {
            server.error(`stick data handler: ${err && err.message ? err.message : err}`);
        }
    });
}

module.exports = { attachStickClient };
