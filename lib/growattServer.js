'use strict';

const net = require('net');
const { AutoCalibrator } = require('./growattRecord');
const { UpstreamResolver } = require('./growattUpstream');
const { applyServerCommands } = require('./growattServerCommands');
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
        /**
         * Feed-stick SET (multi-stick / multi-plant): sticks we mirror locally.
         * Built from enabled devices' SNs (user selection). Empty = feed any stick.
         * @type {Set<string>}
         */
        this.feedStickSns = new Set(
            (Array.isArray(opts.feedStickSns) ? opts.feedStickSns : this.feedStickSn ? [this.feedStickSn] : [])
                .map((s) => String(s || '').trim())
                .filter(Boolean),
        );
        /** Lab/debug SNs: seed-recover + decode without feeding Fake SM sum. */
        this.decodeAlsoSns = new Set(
            (Array.isArray(opts.decodeAlsoSns) ? opts.decodeAlsoSns : [])
                .map((s) => String(s || '').trim())
                .filter(Boolean),
        );
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

        /**
         * Per-stick layouts (multi-inverter: lab fake ≠ production record).
         * @type {Map<string, object>}
         */
        this.layoutsBySn = new Map();
        if (opts.layoutsBySn instanceof Map) {
            for (const [sn, L] of opts.layoutsBySn) {
                if (sn && L) {
                    this.layoutsBySn.set(String(sn).trim(), L);
                }
            }
        } else if (opts.layoutsBySn && typeof opts.layoutsBySn === 'object') {
            for (const [sn, L] of Object.entries(opts.layoutsBySn)) {
                if (sn && L) {
                    this.layoutsBySn.set(String(sn).trim(), L);
                }
            }
        }
        if (opts.layout && this.defaultSerial) {
            this.layoutsBySn.set(this.defaultSerial, opts.layout);
        }
        /** @type {Map<string, import('./growattRecord').AutoCalibrator>} */
        this._calibratorsBySn = new Map();

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
        /**
         * Last AES seed-recover HIT per SN for predicted window on reconnect.
         * @type {Map<string, { seed: number, at: number }>}
         */
        this._seedHintBySn = new Map();
    }

    get calibrated() {
        if (this.calibrator.calibrated) {
            return true;
        }
        for (const sn of this.feedStickSns.size ? this.feedStickSns : this.layoutsBySn.keys()) {
            if (this.layoutForSn(sn)) {
                return true;
            }
        }
        return this.layoutsBySn.size > 0;
    }

    /**
     * Is this SN a feed stick (mirror locally) or forward-only?
     * Empty feed set = treat every stick as a feed stick (legacy single-stick).
     * @param {string} sn
     * @returns {boolean}
     */
    isFeedStick(sn) {
        if (!this.feedStickSns || this.feedStickSns.size === 0) {
            return true;
        }
        return this.feedStickSns.has(String(sn || '').trim());
    }

    /**
     * Allow AES seed-recover for forward-only lab SNs (decode/health, not SM feed).
     * @param {string} sn
     * @returns {boolean}
     */
    allowDecodeSn(sn) {
        const key = String(sn || '').trim();
        return !!(key && this.decodeAlsoSns && this.decodeAlsoSns.has(key));
    }

    get layout() {
        return this.calibrator.layout;
    }

    /**
     * Layout for a stick SN (per-stick map, else shared calibrator).
     * @param {string} sn
     * @returns {object|null}
     */
    layoutForSn(sn) {
        const key = String(sn || '').trim();
        if (key && this.layoutsBySn.has(key)) {
            return this.layoutsBySn.get(key) || null;
        }
        return this.calibrator.layout || null;
    }

    /**
     * @param {string} sn
     * @param {object} layout
     */
    setLayoutForSn(sn, layout) {
        const key = String(sn || '').trim();
        if (!key || !layout) {
            return;
        }
        this.layoutsBySn.set(key, layout);
        if (this.isFeedStick(key) || !this.calibrator.layout) {
            this.calibrator.setLayout(layout);
        }
    }

    /**
     * Per-SN calibrator (lazy). Feed sticks share the primary when no SN layout yet.
     * @param {string} sn
     */
    calibratorForSn(sn) {
        const key = String(sn || '').trim();
        if (!key) {
            return this.calibrator;
        }
        if (this.layoutsBySn.has(key)) {
            let c = this._calibratorsBySn.get(key);
            if (!c) {
                c = new AutoCalibrator({
                    layout: this.layoutsBySn.get(key),
                    enabled: false,
                    log: (m) => this.log(m),
                });
                this._calibratorsBySn.set(key, c);
            }
            return c;
        }
        if (!this._calibratorsBySn.has(key)) {
            this._calibratorsBySn.set(
                key,
                new AutoCalibrator({
                    layout: null,
                    enabled: this.calibrator.enabled,
                    log: (m) => this.log(m),
                }),
            );
        }
        return this._calibratorsBySn.get(key);
    }

    _emitClientCount() {
        try {
            this.onClientCount(this._clients.size);
        } catch {
            // ignore
        }
    }

    _onClient(stickSock) {
        const { attachStickClient } = require('./growattServerClient');
        attachStickClient(this, stickSock);
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
