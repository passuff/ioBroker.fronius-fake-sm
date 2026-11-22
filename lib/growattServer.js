'use strict';

const net = require('net');
const { FrameSplitter, decodeFrame, buildAck } = require('./growattProto');
const {
    parseDataRecord,
    trySeedLayout,
    isDataFunc,
    extractSn,
    bodyAfterSn,
    AutoCalibrator,
} = require('./growattRecord');
const { UpstreamResolver } = require('./growattUpstream');
const { buildRedirectFrames } = require('./growattCommands');

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
        this.onFrame = opts.onFrame || (() => {});
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
    }

    /**
     * Queue a raw Growatt frame to a connected stick (by SN) or all sticks.
     * @param {Buffer} frame
     * @param {string} [sn]
     * @returns {boolean}
     */
    sendToStick(frame, sn) {
        if (!Buffer.isBuffer(frame) || !frame.length) {
            return false;
        }
        if (sn) {
            const sock = this._stickBySn.get(sn);
            if (sock && !sock.destroyed) {
                sock.write(frame);
                return true;
            }
            return false;
        }
        let ok = false;
        for (const sock of this._clients) {
            if (!sock.destroyed) {
                sock.write(frame);
                ok = true;
            }
        }
        return ok;
    }

    /**
     * Persist redirect: datalogger reg 17=IP, 18=port (Grott FC 0x18).
     * @param {string} sn
     * @param {string} [serverIp]
     * @param {number} [port]
     */
    persistRedirect(sn, serverIp, port) {
        const ip = serverIp || this.redirectServerIp;
        if (!sn || !ip) {
            return false;
        }
        const frames = buildRedirectFrames(sn, ip, port || this.redirectServerPort);
        let ok = true;
        for (const f of frames) {
            if (!this.sendToStick(f, sn)) {
                ok = false;
            }
        }
        if (ok) {
            this._redirectDoneFor.add(sn);
            this.log(`persisted stick server ${ip}:${port || this.redirectServerPort} on ${sn}`);
        }
        return ok;
    }

    get calibrated() {
        return this.calibrator.calibrated;
    }

    get layout() {
        return this.calibrator.layout;
    }

    /**
     * @returns {Promise<void>}
     */
    start() {
        return new Promise((resolve, reject) => {
            if (this._netServer) {
                resolve();
                return;
            }
            const server = net.createServer((socket) => this._onClient(socket));
            server.once('error', (err) => {
                this.error(`local Growatt listen error: ${err.message}`);
                reject(err);
            });
            server.listen(this.port, this.host, () => {
                this.listening = true;
                this._netServer = server;
                this.log(`local Growatt listening on ${this.host}:${this.port} (forward=${this.forwardCloud})`);
                // warm upstream DNS
                if (this.forwardCloud) {
                    this.resolver.resolve().catch((err) => this.error(`upstream resolve: ${err.message}`));
                }
                resolve();
            });
        });
    }

    /**
     * @returns {Promise<void>}
     */
    stop() {
        return new Promise((resolve) => {
            this.listening = false;
            for (const s of this._clients) {
                try {
                    s.destroy();
                } catch {
                    // ignore
                }
            }
            this._clients.clear();
            if (!this._netServer) {
                resolve();
                return;
            }
            this._netServer.close(() => {
                this._netServer = null;
                resolve();
            });
        });
    }

    /**
     * Sum of fresh per-stick samples.
     * @param {number} [maxAgeMs]
     */
    sumFreshSamples(maxAgeMs = 90000) {
        const now = Date.now();
        let power = 0;
        let energy = 0;
        let u1 = 0;
        let f = 0;
        let n = 0;
        let sn = '';
        for (const [stickSn, s] of this.stickSamples) {
            if (!s || now - s.at > maxAgeMs) {
                continue;
            }
            power += Number(s.pac_w) || 0;
            energy += Number(s.e_total_kwh) || 0;
            if (!u1 && s.u1) {
                u1 = s.u1;
            }
            if (!f && s.f) {
                f = s.f;
            }
            sn = stickSn;
            n += 1;
        }
        if (!n) {
            return null;
        }
        return { pac_w: power, e_total_kwh: energy, u1, f, stickCount: n, sn };
    }

    /**
     * @param {net.Socket} stickSock
     */
    _onClient(stickSock) {
        const peer = `${stickSock.remoteAddress}:${stickSock.remotePort}`;
        this.log(`stick connected ${peer}`);
        this._clients.add(stickSock);
        const splitter = new FrameSplitter();
        /** @type {net.Socket|null} */
        let upstream = null;
        let upstreamReady = false;
        const pending = [];

        const cleanup = () => {
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
        };

        stickSock.on('close', () => {
            this.log(`stick closed ${peer}`);
            cleanup();
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
            if (this.forwardCloud) {
                if (upstream && upstreamReady) {
                    upstream.write(chunk);
                } else {
                    pending.push(Buffer.from(chunk));
                }
            }

            for (const raw of splitter.push(chunk)) {
                this._handleFrame(raw, stickSock);
            }
        });
    }

    /**
     * @param {Buffer} raw
     * @param {net.Socket} stickSock
     */
    _handleFrame(raw, stickSock) {
        let frame;
        try {
            frame = decodeFrame(raw);
        } catch (err) {
            this.debug(`frame decode: ${err.message}`);
            return;
        }
        if (!frame.crcOk) {
            this.debug(`bad CRC txn=${frame.txn} calc=${frame.crcCalc} rx=${frame.crcRx}`);
            return;
        }

        const sn = extractSn(frame.payload);
        if (sn) {
            this._stickBySn.set(sn, stickSock);
            this.onStick(sn);
            if (this.autoPersistRedirect && this.redirectServerIp && !this._redirectDoneFor.has(sn)) {
                this._redirectDoneFor.add(sn); // claim before async to avoid duplicates
                setTimeout(() => {
                    if (!this.persistRedirect(sn)) {
                        this._redirectDoneFor.delete(sn);
                    }
                }, 1500);
            }
        }

        this.onFrame({
            txn: frame.txn,
            proto: frame.proto,
            func: frame.func,
            len: raw.length,
            sn,
        });

        if (!this.forwardCloud && this.replyAckWhenNoForward) {
            if (isDataFunc(frame.func) || frame.func === 0x16) {
                try {
                    stickSock.write(buildAck(frame));
                } catch {
                    // ignore
                }
            }
        }

        if (!isDataFunc(frame.func)) {
            return;
        }

        const body = bodyAfterSn(frame.payload);

        // Auto-calibrate while not locked (cloud truth preferred; seed fallback for local-only)
        if (!this.calibrator.calibrated && body && body.length) {
            const truth = this.getCloudTruth();
            if (truth) {
                const was = this.calibrator.calibrated;
                const layout = this.calibrator.observe(body, truth);
                if (!was && layout) {
                    this.onCalibrated(layout);
                }
            } else {
                // Retry until a plausible frame locks — first garbage must not skip seed forever
                const seed = trySeedLayout(body);
                if (seed) {
                    this._seedTried = true;
                    this.calibrator.setLayout(seed);
                    this.onCalibrated(seed);
                    this.log(`local seed layout locked (${seed.seedName || 'seed'}) — no cloud truth`);
                }
            }
            if (this.calibrator.failed && !this._calFailReported) {
                this._calFailReported = true;
                this.onCalibrateFailed(this.calibrator.failReason || 'auto-calibrate failed');
            }
        }

        // Never emit Modbus samples without a locked layout
        if (!this.calibrator.calibrated || !this.calibrator.layout) {
            this.onSample({
                sn: sn || extractSn(frame.payload) || 'unknown',
                pac_w: null,
                e_total_kwh: null,
                u1: 0,
                f: 0,
                recordType: `0x${Number(frame.func).toString(16)}_${raw.length}`,
                calibrated: false,
                at: Date.now(),
            });
            return;
        }

        const parsed = parseDataRecord({
            payload: frame.payload,
            func: frame.func,
            proto: frame.proto,
            frameLen: raw.length,
            layout: this.calibrator.layout,
        });

        if (!parsed.parsed || parsed.pac_w === null) {
            return;
        }

        const stickSn = parsed.sn || sn || 'unknown';
        const sample = {
            sn: stickSn,
            pac_w: parsed.pac_w,
            e_total_kwh: parsed.e_total_kwh || 0,
            u1: parsed.u1 || 0,
            f: parsed.f || 0,
            recordType: parsed.recordType,
            calibrated: true,
            at: Date.now(),
        };
        this.stickSamples.set(stickSn, sample);
        this.onSample(sample);
    }
}

module.exports = { GrowattServer };
