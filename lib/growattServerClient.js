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
        server.onPeer(String(stickSock.remoteAddress || '').replace(/^::ffff:/, ''));
    } catch {
        // ignore
    }
    try {
        stickSock.setKeepAlive(true, 30000);
        stickSock.setTimeout(180000);
    } catch {
        // ignore
    }
    server._clients.add(stickSock);
    server._emitClientCount();
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
    const pending = [];

    const cleanup = () => {
        if (healthTimer) {
            clearTimeout(healthTimer);
            healthTimer = null;
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

    if (server.forwardCloud) {
        server.resolver
            .resolve()
            .then((ip) => {
                upstream = net.connect({ host: ip, port: server.upstreamPort }, () => {
                    upstreamReady = true;
                    server.debug(`upstream connected ${ip}:${server.upstreamPort}`);
                    for (const buf of pending) {
                        upstream.write(buf);
                    }
                    pending.length = 0;
                });
                upstream.on('data', (chunk) => {
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
                                `AES session key from DOWN SN=${aesSession.serial} key=${keyHex} iv=${ivHex}`
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
                                } catch {
                                    // ignore
                                }
                            }
                        }
                    }
                    if (!stickSock.destroyed) {
                        stickSock.write(chunk);
                    }
                });
                upstream.on('error', (err) => {
                    server.debug(`upstream error: ${err.message}`);
                });
                upstream.on('close', () => {
                    upstreamReady = false;
                    upstream = null;
                });
            })
            .catch((err) => {
                server.error(`cannot open upstream: ${err.message}`);
            });
    }

    stickSock.on('data', (chunk) => {
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
            } else {
                pending.push(Buffer.from(chunk));
            }
        }

        for (const raw of splitter.push(chunk)) {
            if (aesSession.observeUp(raw)) {
                const k0 = aesSession.candidates[0];
                const keyHex = k0 && k0.key ? k0.key.toString('ascii') : '?';
                const ivHex = k0 && k0.iv ? k0.iv.toString('ascii') : '?';
                server.log(`AES session derived SN=${aesSession.serial} key=${keyHex} iv=${ivHex}`);
                if (typeof server.onAesSession === 'function') {
                    try {
                        server.onAesSession({
                            serial: aesSession.serial,
                            key: keyHex,
                            iv: ivHex,
                            raw,
                        });
                    } catch {
                        // ignore
                    }
                }
                try {
                    const prevSock = server._stickBySn.get(aesSession.serial);
                    if (prevSock && prevSock !== stickSock) {
                        try {
                            prevSock.destroy();
                        } catch {
                            // ignore
                        }
                    }
                    server.onStick(aesSession.serial);
                    server._stickBySn.set(aesSession.serial, stickSock);
                } catch {
                    // ignore
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
                !aesSession._recovered &&
                !aesSession._recoverFailed
            ) {
                // Bootstrap KDF from wire rand16 fails on 3.1.1.7 — recover via seed brute.
                if (
                    !aesSession.serial &&
                    server.defaultSerial &&
                    server.isFeedStick(server.defaultSerial)
                ) {
                    aesSession.serial = server.defaultSerial;
                }
                const sn = String(aesSession.serial || '').trim();
                // Non-feed sticks: forward to cloud. Optionally still seed-recover for
                // lab/debug SNs (decode/health only — localProxyStart still skips sum).
                const labDecode =
                    typeof server.allowDecodeSn === 'function' && server.allowDecodeSn(sn);
                if (sn && !server.isFeedStick(sn) && !labDecode) {
                    server.debug(`skip AES seed-recover for non-feed SN=${sn}`);
                } else if (aesSession.serial) {
                    const pendingRaw = Buffer.from(raw);
                    aesSession
                        .scheduleSeedRecover(pendingRaw, {
                            log: (m) => server.log(m),
                            debug: (m) => server.debug(m),
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
                                } catch {
                                    // ignore
                                }
                            }
                            // Re-process the frame that triggered recovery with the real key.
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
                        .catch(() => {});
                }
            }
            if (after !== before && after !== 'pending') {
                server._reportFrameHealth(after, health, {
                    stickSn: aesSession.serial || '',
                    peerIp,
                });
            }
        }
    });
}

module.exports = { attachStickClient };
