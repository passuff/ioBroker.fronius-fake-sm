'use strict';

const net = require('net');
const { FrameSplitter } = require('./growattProto');
const { AutoCalibrator } = require('./growattRecord');
const { UpstreamResolver } = require('./growattUpstream');
const { applyServerCommands } = require('./growattServerCommands');
const { AesSession } = require('./growattAesSession');
const { handleStickFrame } = require('./growattServerFrame');

/**
 * Local Growatt TCP proxy (:5279). Optional transparent forward to cloud.
 */
class GrowattServer {
    /**
     * @param {object} opts
     * @param {string} [opts.host]
     * @param {number} [opts.port]
     * @param {boolean} [opts.forwardCloud]
     * @param {string} [opts.upstreamHost]
     * @param {number} [opts.upstreamPort]
     * @param {string} [opts.upstreamIp] fixed IP override
     * @param {boolean} [opts.replyAckWhenNoForward]
     * @param {object|null} [opts.layout]
     * @param {(sample:object)=>void} [opts.onSample]
     * @param {(sn:string)=>void} [opts.onStick]
     * @param {(meta:object)=>void} [opts.onFrame]
     * @param {(layout:object)=>void} [opts.onCalibrated]
     * @param {(reason:string)=>void} [opts.onCalibrateFailed]
     * @param {()=>{pac:number,etotal:number}|null} [opts.getCloudTruth]
     * @param {boolean} [opts.autoCalibrate]
     * @param {boolean} [opts.autoPersistRedirect] write reg 17/18 once stick is known
     * @param {string} [opts.redirectServerIp] ioBroker LAN IP for reg 17
     * @param {number} [opts.redirectServerPort] for reg 18 (default 5279)
     * @param {(m:string)=>void} [opts.log]
     * @param {(m:string)=>void} [opts.debug]
     * @param {(m:string)=>void} [opts.error]
     */
    constructor(opts = {}) {
        this.host = opts.host || '0.0.0.0';
        this.port = Number(opts.port ?? 5279);
        this.forwardCloud = opts.forwardCloud !== false;
        this.upstreamPort = Number(opts.upstreamPort ?? 5279);
        this.replyAckWhenNoForward = !!opts.replyAckWhenNoForward;
        this.onSample = opts.onSample || (() => {});
        this.onStick = opts.onStick || (() => {});
        this.onPeer = opts.onPeer || (() => {});
        this.onClientClose = opts.onClientClose || (() => {});
        this.onClientCount = opts.onClientCount || (() => {});
        this.onFrame = opts.onFrame || (() => {});
        /** Fallback SN for seed-recover when 0x41 was not yet observed on this socket. */
        this.defaultSerial = opts.defaultSerial ? String(opts.defaultSerial) : '';
        /** When set, AES seed-recover + expensive decode only for this feed stick. */
        this.feedStickSn = opts.feedStickSn ? String(opts.feedStickSn).trim() : '';
        this.onFrameHealth = opts.onFrameHealth || (() => {});
        this.onRawUp = opts.onRawUp || null;
        this.onRawDown = opts.onRawDown || null;
        this.onAesSession = opts.onAesSession || null;
        this.onCalibrated = opts.onCalibrated || (() => {});
        this.onCalibrateFailed = opts.onCalibrateFailed || (() => {});
        this.getCloudTruth = opts.getCloudTruth || (() => null);
        this.log = opts.log || (() => {});
        this.debug = opts.debug || (() => {});
        this.error = opts.error || (() => {});
        this._calFailReported = false;

        this.autoPersistRedirect = opts.autoPersistRedirect !== false;
        this.redirectServerIp = opts.redirectServerIp || '';
        this.redirectServerPort = Number(opts.redirectServerPort ?? 5279);
        /** @type {Set<string>} */
        this._redirectDoneFor = new Set();

        this.resolver = new UpstreamResolver({
            host: opts.upstreamHost || 'server.growatt.com',
            fixedIp: opts.upstreamIp || '',
            log: (m) => this.log(m),
        });

        this.calibrator = new AutoCalibrator({
            layout: opts.layout || null,
            enabled: opts.autoCalibrate !== false,
            log: (m) => this.log(m),
        });

        /** @type {Map<string, object>} */
        this.stickSamples = new Map();
        this.listening = false;
        this._netServer = null;
        /** @type {Set<net.Socket>} */
        this._clients = new Set();
        /** @type {Map<string, net.Socket>} sn -> stick socket */
        this._stickBySn = new Map();
        /** @type {Map<net.Socket, Buffer[]>} */
        this._pendingToStick = new Map();
        /** Total stick sessions accepted (restore verification). */
        this.connectCount = 0;
    }

    get calibrated() {
        return this.calibrator.calibrated;
    }

    get layout() {
        return this.calibrator.layout;
    }

    _emitClientCount() {
        try {
            this.onClientCount(this._clients.size);
        } catch {
            // ignore
        }
    }

    _onClient(stickSock) {
        const ip = String(stickSock.remoteAddress || '').replace(/^::ffff:/, '');
        const peer = `${stickSock.remoteAddress}:${stickSock.remotePort}`;
        const peerIp = ip;
        // Replace only stale sessions from the SAME peer IP (zombies left after a
        // WiFi/power-drop reconnect of this datalogger). Distinct sticks on
        // different IPs coexist so a real prod stick and a lab stick don't fight
        // over a single global session (per-SN cleanup happens once the SN is known).
        const replaced = typeof this.dropClientsByIp === 'function' ? this.dropClientsByIp(ip) : 0;
        if (replaced > 0) {
            this.log(`replaced ${replaced} previous stick session(s) from ${ip}`);
        }
        this.connectCount += 1;
        this.log(`stick connected ${peer}`);
        try {
            this.onPeer(String(stickSock.remoteAddress || '').replace(/^::ffff:/, ''));
        } catch {
            // ignore
        }
        try {
            stickSock.setKeepAlive(true, 30000);
            stickSock.setTimeout(180000);
        } catch {
            // ignore
        }
        this._clients.add(stickSock);
        this._emitClientCount();
        const { SessionFrameHealth } = require('./frameHealth');
        const health = new SessionFrameHealth();
        const aesSession = new AesSession();
        stickSock._aesSession = aesSession;
                let healthTimer = setTimeout(() => {
            healthTimer = null;
            this._reportFrameHealth(health.checkTimeout(), health, {
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
            this._clients.delete(stickSock);
            this._pendingToStick.delete(stickSock);
            for (const [snKey, sock] of this._stickBySn) {
                if (sock === stickSock) {
                    this._stickBySn.delete(snKey);
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
            this._emitClientCount();
        };

        stickSock.on('timeout', () => {
            this.log(`stick idle timeout ${peer}`);
            try {
                stickSock.destroy();
            } catch {
                // ignore
            }
        });
        stickSock.on('close', () => {
            this.log(`stick closed ${peer}`);
            const closedSn = aesSession && aesSession.serial ? String(aesSession.serial) : undefined;
            cleanup();
            try {
                this.onClientClose(closedSn);
            } catch {
                // ignore
            }
        });
        stickSock.on('error', (err) => {
            this.debug(`stick error ${peer}: ${err.message}`);
            cleanup();
        });

        if (this.forwardCloud) {
            this.resolver
                .resolve()
                .then((ip) => {
                    upstream = net.connect({ host: ip, port: this.upstreamPort }, () => {
                        upstreamReady = true;
                        this.debug(`upstream connected ${ip}:${this.upstreamPort}`);
                        for (const buf of pending) {
                            upstream.write(buf);
                        }
                        pending.length = 0;
                    });
                    upstream.on('data', (chunk) => {
                        if (typeof this.onRawDown === 'function') {
                            try {
                                this.onRawDown(chunk);
                            } catch {
                                // ignore
                            }
                        }
                        for (const raw of downSplitter.push(chunk)) {
                            if (aesSession.observeDown(raw) && aesSession.serial) {
                                const k0 = aesSession.candidates[0];
                                const keyHex = k0 && k0.key ? k0.key.toString('ascii') : '?';
                                const ivHex = k0 && k0.iv ? k0.iv.toString('ascii') : '?';
                                this.log(
                                    `AES session key from DOWN SN=${aesSession.serial} key=${keyHex} iv=${ivHex}`
                                );
                                if (typeof this.onAesSession === 'function') {
                                    try {
                                        this.onAesSession({
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
                        this.debug(`upstream error: ${err.message}`);
                    });
                    upstream.on('close', () => {
                        upstreamReady = false;
                        upstream = null;
                    });
                })
                .catch((err) => {
                    this.error(`cannot open upstream: ${err.message}`);
                });
        }

        stickSock.on('data', (chunk) => {
            if (typeof this.onRawUp === 'function') {
                try {
                    this.onRawUp(chunk);
                } catch {
                    // ignore
                }
            }
            if (this.forwardCloud) {
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
                    this.log(`AES session derived SN=${aesSession.serial} key=${keyHex} iv=${ivHex}`);
                    if (typeof this.onAesSession === 'function') {
                        try {
                            this.onAesSession({
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
                        const prevSock = this._stickBySn.get(aesSession.serial);
                        if (prevSock && prevSock !== stickSock) {
                            try {
                                prevSock.destroy();
                            } catch {
                                // ignore
                            }
                        }
                        this.onStick(aesSession.serial);
                        this._stickBySn.set(aesSession.serial, stickSock);
                    } catch {
                        // ignore
                    }
                }
                const before = health.verdict;
                let after = health.observe(raw);
                const result = handleStickFrame(this, raw, stickSock);
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
                        this.defaultSerial &&
                        (!this.feedStickSn || this.feedStickSn === this.defaultSerial)
                    ) {
                        aesSession.serial = this.defaultSerial;
                    }
                    const feedSn = String(this.feedStickSn || this.defaultSerial || '').trim();
                    const sn = String(aesSession.serial || '').trim();
                    // Lab / non-feed sticks: forward to cloud only — skip CPU-heavy seed crack.
                    if (feedSn && sn && sn !== feedSn) {
                        this.debug(`skip AES seed-recover for non-feed SN=${sn} (feed=${feedSn})`);
                    } else if (aesSession.serial) {
                        const pendingRaw = Buffer.from(raw);
                        aesSession
                            .scheduleSeedRecover(pendingRaw, {
                                log: (m) => this.log(m),
                                debug: (m) => this.debug(m),
                            })
                            .then((hit) => {
                                if (!hit || stickSock.destroyed) {
                                    return;
                                }
                                const keyHex = hit.key.toString('ascii');
                                const ivHex = hit.iv.toString('ascii');
                                if (typeof this.onAesSession === 'function') {
                                    try {
                                        this.onAesSession({
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
                                const again = handleStickFrame(this, pendingRaw, stickSock);
                                if (again && again.aesOk) {
                                    health.data += 1;
                                    const v = health._updateVerdict();
                                    if (v !== 'pending') {
                                        this._reportFrameHealth(v, health, {
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
                    this._reportFrameHealth(after, health, {
                        stickSn: aesSession.serial || '',
                        peerIp,
                    });
                }
            }
        });
    }

    /**
     * @param {string} verdict
     * @param {import('./frameHealth').SessionFrameHealth} [health]
     * @param {{ stickSn?: string, peerIp?: string }} [meta]
     */
    _reportFrameHealth(verdict, health, meta = {}) {
        try {
            const snap = health ? health.snapshot() : { verdict };
            snap.stickSn = meta.stickSn || snap.stickSn || '';
            snap.peerIp = meta.peerIp || snap.peerIp || '';
            this.onFrameHealth(verdict, snap);
        } catch {
            // ignore
        }
    }

    /**
     * @param {Buffer} raw
     * @param {import('net').Socket} stickSock
     * @returns {{aesOk:boolean}|null}
     */
    _handleFrame(raw, stickSock) {
        return handleStickFrame(this, raw, stickSock);
    }
}

applyServerCommands(GrowattServer);

module.exports = { GrowattServer };
