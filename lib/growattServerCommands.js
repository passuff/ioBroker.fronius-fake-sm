'use strict';

const net = require('net');
const { buildRedirectFrames, buildRebootFrame } = require('./growattCommands');
const { requireLabFotaTarget } = require('./growattFotaGuard');
const {
    buildFotaParamSetFrames,
    buildFotaCycleFrames,
} = require('./growattFotaFrames');

/**
 * Server→stick command methods, mixed into GrowattServer.prototype.
 * Sticks with newer firmware (e.g. ShineWiFi-X 3.1.1.7, func 0x41 frames) are not
 * decodable, so no SN→socket mapping exists — commands then go to every session.
 *
 * FOTA inject is lab-only (see growattFotaGuard) — never broadcast to all sockets.
 */
const commandMethods = {
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
                if (this.forwardCloud) {
                    this.resolver.resolve().catch((err) => this.error(`upstream resolve: ${err.message}`));
                }
                resolve();
            });
        });
    },

    /**
     * @returns {Promise<void>}
     */
    stop() {
        return new Promise((resolve) => {
            this.listening = false;
            this.dropClients();
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
    },

    /**
     * Sum of fresh per-stick samples.
     * @param {number} [maxAgeMs]
     */
    sumFreshSamples(maxAgeMs = 90000, filterSn) {
        const now = Date.now();
        const want = filterSn ? String(filterSn).trim() : '';
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
            // When a specific local stick is designated, ignore samples from any
            // other stick (e.g. a real prod stick also hitting the proxy) so the
            // local mirror stays deterministic and is not summed with a foreign SN.
            if (want && String(stickSn).trim() !== want) {
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
        /** @type {object|null} */
        let fields = null;
        for (const [stickSn, s] of this.stickSamples) {
            if (want && String(stickSn).trim() !== want) {
                continue;
            }
            if (s && s.fields && now - s.at <= maxAgeMs) {
                fields = s.fields;
                break;
            }
        }
        return { pac_w: power, e_total_kwh: energy, u1, f, stickCount: n, sn, fields };
    },

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
    },

    /**
     * Send to the SN-mapped socket, else to every connected session.
     * @param {Buffer} frame
     * @param {string} sn
     * @returns {boolean}
     */
    sendToStickOrAll(frame, sn) {
        return this.sendToStick(frame, sn) || this.sendToStick(frame);
    },

    /**
     * Persist redirect: datalogger reg 17=IP, 18=port (Grott FC 0x18).
     * @param {string} sn
     * @param {string} [serverIp]
     * @param {number} [port]
     * @param {{reboot?:boolean}} [opts] reboot: also send reg 32 (0x20) restart
     */
    persistRedirect(sn, serverIp, port, opts = {}) {
        const ip = serverIp || this.redirectServerIp;
        if (!sn || !ip) {
            return false;
        }
        const p = port || this.redirectServerPort;
        const frames = buildRedirectFrames(sn, ip, p);
        if (opts.reboot) {
            frames.push(buildRebootFrame(sn));
        }
        let ok = true;
        for (const f of frames) {
            if (!this.sendToStickOrAll(f, sn)) {
                ok = false;
            }
        }
        if (ok) {
            this._redirectDoneFor.add(sn);
            this.log(`persisted stick server ${ip}:${p} on ${sn}${opts.reboot ? ' (+reboot)' : ''}`);
        }
        return ok;
    },

    /**
     * Close all stick sessions (stick reconnects with its current server setting).
     * @returns {number} how many sockets were destroyed
     */
    dropClients() {
        const list = [...this._clients];
        for (const s of list) {
            try {
                s.destroy();
            } catch {
                // ignore
            }
        }
        return list.length;
    },

    /**
     * Close only stale stick sessions that share the given peer IP (zombies left
     * after a WiFi/power-drop reconnect from the same datalogger). Distinct sticks
     * on different IPs are left untouched so a real prod stick and a lab stick can
     * coexist instead of fighting over a single global session.
     * @param {string} ip peer IP (::ffff: prefix tolerated)
     * @returns {number} how many sockets were destroyed
     */
    dropClientsByIp(ip) {
        const target = String(ip || '').replace(/^::ffff:/, '');
        if (!target) {
            return 0;
        }
        let n = 0;
        for (const s of [...this._clients]) {
            const sip = String((s && s.remoteAddress) || '').replace(/^::ffff:/, '');
            if (sip === target) {
                try {
                    s.destroy();
                } catch {
                    // ignore
                }
                n += 1;
            }
        }
        return n;
    },

    /**
     * Lab-only: install UART-sniffed AES key/IV onto live stick socket(s).
     * Prefer SN match; else all connected sessions with an AesSession.
     * @param {string} key 32-char ASCII hex key
     * @param {string} [iv] 16-char ASCII IV
     * @param {string} [sn]
     * @returns {{ ok: boolean, installed: number, serials: string[] }}
     */
    installUartAesKey(key, iv, sn) {
        const serials = [];
        const trySock = (sock) => {
            if (!sock || sock.destroyed || !sock._aesSession) {
                return false;
            }
            if (typeof sock._aesSession.installUartKey !== 'function') {
                return false;
            }
            if (!sock._aesSession.installUartKey(key, iv, sn || sock._aesSession.serial)) {
                return false;
            }
            serials.push(String(sock._aesSession.serial || sn || '?'));
            return true;
        };
        let installed = 0;
        if (sn && this._stickBySn) {
            if (trySock(this._stickBySn.get(sn))) {
                installed += 1;
            }
        }
        if (!installed) {
            for (const sock of this._clients || []) {
                if (trySock(sock)) {
                    installed += 1;
                }
            }
        }
        return { ok: installed > 0, installed, serials };
    },

    /**
     * Lab-only: send FOTA HTTPServer param-set (FC 0x18 reg 0x50) — no CycleFota.
     * Requires GROWATT_FOTA_LAB_SNS / this.fotaLabStickSns allowlist.
     * Does NOT fall back to send-to-all (would hit production sticks).
     *
     * @param {string} sn lab stick SN
     * @param {object} opts host/path/port or cdnUrl / httpServerBlob
     * @returns {{ ok: boolean, sent: number, reason?: string }}
     */
    sendFotaParamSetLab(sn, opts = {}) {
        const labGuard = {
            labStickSns: opts.labStickSns || this.fotaLabStickSns,
            prodBlockSns: opts.prodBlockSns || this.fotaProdBlockSns,
        };
        try {
            requireLabFotaTarget(sn, labGuard);
        } catch (err) {
            this.error(`FOTA param-set blocked: ${err.message}`);
            return { ok: false, sent: 0, reason: err.message };
        }
        const frames = buildFotaParamSetFrames({ ...opts, sn, labGuard });
        let sent = 0;
        for (const f of frames) {
            if (this.sendToStick(f, sn)) {
                sent += 1;
            }
        }
        if (sent) {
            this.log(`lab FOTA param-set sent to ${sn} (${sent} frame(s)) — no CycleFota`);
        } else {
            this.error(`lab FOTA param-set: stick ${sn} not connected (SN-mapped socket required)`);
        }
        return { ok: sent === frames.length, sent, reason: sent ? undefined : 'stick not connected' };
    },

    /**
     * Lab-only: HTTPServer + Datalog_CycleFota_ON. UART recovery must be ready.
     * @param {string} sn
     * @param {object} opts
     */
    sendFotaCycleLab(sn, opts = {}) {
        const labGuard = {
            labStickSns: opts.labStickSns || this.fotaLabStickSns,
            prodBlockSns: opts.prodBlockSns || this.fotaProdBlockSns,
        };
        try {
            requireLabFotaTarget(sn, labGuard);
        } catch (err) {
            this.error(`FOTA cycle blocked: ${err.message}`);
            return { ok: false, sent: 0, reason: err.message };
        }
        if (!opts.confirmCycleFota) {
            const msg = 'refusing CycleFota without confirmCycleFota:true';
            this.error(msg);
            return { ok: false, sent: 0, reason: msg };
        }
        const frames = buildFotaCycleFrames({ ...opts, sn, labGuard });
        let sent = 0;
        for (const f of frames) {
            if (this.sendToStick(f, sn)) {
                sent += 1;
            }
        }
        if (sent) {
            this.log(`lab FOTA CycleFota sequence sent to ${sn} (${sent} frame(s))`);
        } else {
            this.error(`lab FOTA cycle: stick ${sn} not connected`);
        }
        return { ok: sent === frames.length, sent, reason: sent ? undefined : 'stick not connected' };
    },
};

/**
 * @param {Function} Cls
 */
function applyServerCommands(Cls) {
    Object.assign(Cls.prototype, commandMethods);
}

module.exports = { applyServerCommands };
