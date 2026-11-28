'use strict';

const net = require('net');
const jsmodbus = require('jsmodbus');
const {
    buildStaticHoldingMap,
    convertValuesToRegisters,
    buildMeterValues,
} = require('./froniusRegisters');
const { isLoopbackIp, normalizeIp } = require('./modbusClientHealth');

/**
 * In-process Modbus TCP slave serving Fronius TS65A-3 holding/input registers.
 * Gen24 secondary meters use Modbus addresses 2–14 (1 = primary RTU).
 */
class FroniusModbusServer {
    /**
     * @param {object} opts
     * @param {string} [opts.host]
     * @param {number} [opts.port]
     * @param {number} [opts.unitId]
     * @param {number} [opts.fakeUniqueId]
     * @param {(msg: string) => void} [opts.log]
     * @param {(msg: string) => void} [opts.debug]
     * @param {(msg: string) => void} [opts.error]
     * @param {(meta: { remoteAddress: string, peer: string, socket: import('net').Socket }) => { quiet?: boolean }|void} [opts.onClientOpen]
     * @param {(meta: { remoteAddress: string, peer: string, socket: import('net').Socket, buf: Buffer }) => void} [opts.onClientData]
     * @param {(meta: { remoteAddress: string, peer: string, socket: import('net').Socket }) => void} [opts.onClientClose]
     * @param {(remoteAddress: string) => void} [opts.onConnection] legacy
     * @param {string[]} [opts.allowedRemoteIps] when non-empty, only these + loopback may connect
     * @param {boolean} [opts.allowPortFallback=true] fall back 502→1502 on EACCES/EADDRINUSE
     */
    constructor(opts = {}) {
        this.host = opts.host || '0.0.0.0';
        this.port = Number(opts.port ?? 502);
        this.configuredPort = this.port;
        this.usedFallbackPort = false;
        let unit = Number(opts.unitId ?? 3);
        if (!Number.isFinite(unit) || unit < 2 || unit > 127) {
            unit = 3;
        }
        this.unitId = unit;
        this.fakeUniqueId = Number(opts.fakeUniqueId ?? 3);
        this.log = opts.log || (() => {});
        this.debug = opts.debug || (() => {});
        this.error = opts.error || (() => {});
        this.onClientOpen = typeof opts.onClientOpen === 'function' ? opts.onClientOpen : null;
        this.onClientData = typeof opts.onClientData === 'function' ? opts.onClientData : null;
        this.onClientClose = typeof opts.onClientClose === 'function' ? opts.onClientClose : null;
        this.onConnection = typeof opts.onConnection === 'function' ? opts.onConnection : null;
        this.allowPortFallback = opts.allowPortFallback !== false;
        /** @type {Set<string>} */
        this.allowedRemoteIps = new Set(
            (Array.isArray(opts.allowedRemoteIps) ? opts.allowedRemoteIps : [])
                .map((ip) => normalizeIp(String(ip || '')))
                .filter(Boolean),
        );

        const words = 65536;
        /** @type {Buffer} */
        this.holding = Buffer.alloc(words * 2);
        /** @type {Buffer} */
        this.input = Buffer.alloc(words * 2);
        /** @type {Buffer|null} authoritative shadow for write rollback */
        this._authHolding = null;
        /** @type {Set<import('net').Socket>} */
        this._clientSockets = new Set();
        this._netServer = null;
        this._modbusServer = null;
        this.listening = false;

        const staticMap = buildStaticHoldingMap(this.fakeUniqueId);
        for (const [addr, val] of staticMap.entries()) {
            this._writeReg(addr, val);
        }
        this._snapshotAuthoritative();
    }

    _snapshotAuthoritative() {
        this._authHolding = Buffer.from(this.holding);
    }

    _restoreAuthoritative() {
        if (!this._authHolding) {
            return;
        }
        this._authHolding.copy(this.holding);
        this._authHolding.copy(this.input);
    }

    /**
     * @param {number} address PDU address
     * @param {number} value uint16
     */
    _writeReg(address, value) {
        const offset = address * 2;
        if (offset < 0 || offset + 2 > this.holding.length) {
            return;
        }
        const v = value & 0xffff;
        this.holding.writeUInt16BE(v, offset);
        this.input.writeUInt16BE(v, offset);
    }

    /**
     * @param {number} startAddress
     * @param {number[]} values
     */
    setHoldingBlock(startAddress, values) {
        for (let i = 0; i < values.length; i++) {
            this._writeReg(startAddress + i, values[i]);
        }
    }

    /**
     * Update live power/energy registers from smoothed meter values.
     * @param {object} meterOpts same as buildMeterValues
     */
    updateFromMeter(meterOpts) {
        const meter = buildMeterValues(meterOpts);
        const { reg258, reg286, reg1024 } = convertValuesToRegisters(meter);
        this.setHoldingBlock(258, reg258);
        this.setHoldingBlock(286, reg286);
        this.setHoldingBlock(1024, reg1024);
        this._snapshotAuthoritative();
        return meter;
    }

    /**
     * Bind TCP. Privileged ports (e.g. 502) fall back to 1502 on EACCES (CI / unprivileged hosts).
     * @param {number} [port]
     * @returns {Promise<void>}
     */
    _listenOnce(port) {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            const modbus = new jsmodbus.server.TCP(server, {
                holding: this.holding,
                input: this.input,
            });

            server.on('connection', (socket) => {
                const remoteAddress = normalizeIp(socket.remoteAddress || '');
                const peer = `${socket.remoteAddress}:${socket.remotePort}`;
                if (this.allowedRemoteIps.size > 0) {
                    const allowed =
                        isLoopbackIp(remoteAddress) || this.allowedRemoteIps.has(remoteAddress);
                    if (!allowed) {
                        this.log(`Modbus reject unauthorized peer ${peer}`);
                        try {
                            socket.destroy();
                        } catch {
                            // ignore
                        }
                        return;
                    }
                }
                this._clientSockets.add(socket);
                let quiet = isLoopbackIp(remoteAddress);

                /** @type {{ quiet?: boolean }|void} */
                let openMeta;
                try {
                    if (this.onClientOpen) {
                        openMeta = this.onClientOpen({ remoteAddress, peer, socket });
                    }
                } catch (err) {
                    this.debug(`onClientOpen: ${err && err.message ? err.message : err}`);
                }
                if (openMeta && openMeta.quiet) {
                    quiet = true;
                }

                if (!quiet) {
                    this.log(`Modbus client connected ${peer} (Gen24 secondary unit ${this.unitId})`);
                } else {
                    this.debug(`Modbus client connected ${peer}`);
                }

                try {
                    if (this.onConnection) {
                        this.onConnection(remoteAddress);
                    }
                } catch (err) {
                    this.debug(`onConnection: ${err && err.message ? err.message : err}`);
                }

                socket.on('data', (buf) => {
                    // Roll back write FCs — Fake-SM registers are authoritative from Growatt samples.
                    if (Buffer.isBuffer(buf) && buf.length >= 8) {
                        const fc = buf.readUInt8(7);
                        if (fc === 5 || fc === 6 || fc === 15 || fc === 16) {
                            this.debug(`Modbus write FC=${fc} from ${peer} — restoring authoritative registers`);
                            setImmediate(() => this._restoreAuthoritative());
                        }
                    }
                    try {
                        if (this.onClientData) {
                            this.onClientData({ remoteAddress, peer, socket, buf });
                            return;
                        }
                    } catch (err) {
                        this.debug(`onClientData: ${err && err.message ? err.message : err}`);
                    }
                    if (buf.length >= 12) {
                        const unit = buf.readUInt8(6);
                        const fc = buf.readUInt8(7);
                        const addr = buf.readUInt16BE(8);
                        const qty = buf.readUInt16BE(10);
                        this.debug(`Modbus RX ${peer} unit=${unit} fc=${fc} addr=${addr} qty=${qty}`);
                    } else {
                        this.debug(`Modbus RX ${peer} ${buf.toString('hex')}`);
                    }
                });
                socket.on('close', () => {
                    this._clientSockets.delete(socket);
                    try {
                        if (this.onClientClose) {
                            this.onClientClose({ remoteAddress, peer, socket });
                        }
                    } catch (err) {
                        this.debug(`onClientClose: ${err && err.message ? err.message : err}`);
                    }
                    if (!quiet) {
                        this.log(`Modbus client closed ${peer}`);
                    } else {
                        this.debug(`Modbus client closed ${peer}`);
                    }
                });
                socket.on('error', (err) => {
                    if (!quiet) {
                        this.log(`Modbus client error ${peer}: ${err.message}`);
                    } else {
                        this.debug(`Modbus client error ${peer}: ${err.message}`);
                    }
                });
            });

            const onListenError = (err) => {
                try {
                    server.close();
                } catch {
                    // ignore
                }
                reject(err);
            };
            server.once('error', onListenError);

            server.listen(port, this.host, () => {
                server.removeListener('error', onListenError);
                server.on('error', (err) => {
                    this.error(`Modbus server error: ${err && err.message ? err.message : err}`);
                });
                this.port = port;
                this.listening = true;
                this._netServer = server;
                this._modbusServer = modbus;
                this.log(
                    `Modbus TCP listening on ${this.host}:${this.port} ` +
                        `(Gen24 secondary unit ${this.unitId}; primary RTU stays 1)`,
                );
                resolve();
            });
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async start() {
        if (this._netServer) {
            return;
        }
        const preferred = Number(this.configuredPort) || Number(this.port) || 502;
        try {
            await this._listenOnce(preferred);
            this.usedFallbackPort = false;
            return;
        } catch (err) {
            const code = err && err.code;
            const canFallback =
                this.allowPortFallback &&
                preferred < 1024 &&
                preferred !== 1502 &&
                (code === 'EACCES' || code === 'EADDRINUSE');
            if (!canFallback) {
                this.error(`Modbus listen error: ${err.message}`);
                throw err;
            }
            this.error(
                `Modbus listen error on ${preferred}: ${err.message} — falling back to 1502 ` +
                    `(Gen24 must use this port; setcap/root needed for ${preferred})`,
            );
            await this._listenOnce(1502);
            this.usedFallbackPort = true;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    stop() {
        return new Promise((resolve) => {
            this.listening = false;
            for (const sock of this._clientSockets) {
                try {
                    sock.destroy();
                } catch {
                    // ignore
                }
            }
            this._clientSockets.clear();
            if (!this._netServer) {
                resolve();
                return;
            }
            const server = this._netServer;
            this._netServer = null;
            this._modbusServer = null;
            server.close(() => resolve());
            // Ensure close resolves even if a socket race remains.
            setTimeout(() => resolve(), 500).unref?.();
        });
    }
}

module.exports = { FroniusModbusServer };
