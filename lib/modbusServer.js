'use strict';

const net = require('net');
const jsmodbus = require('jsmodbus');
const {
    buildStaticHoldingMap,
    convertValuesToRegisters,
    buildMeterValues,
} = require('./froniusRegisters');

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
     * @param {(remoteAddress: string) => void} [opts.onConnection]
     */
    constructor(opts = {}) {
        this.host = opts.host || '0.0.0.0';
        this.port = Number(opts.port ?? 502);
        let unit = Number(opts.unitId ?? 3);
        if (!Number.isFinite(unit) || unit < 2 || unit > 127) {
            unit = 3;
        }
        this.unitId = unit;
        this.fakeUniqueId = Number(opts.fakeUniqueId ?? 3);
        this.log = opts.log || (() => {});
        this.debug = opts.debug || (() => {});
        this.error = opts.error || (() => {});
        this.onConnection = typeof opts.onConnection === 'function' ? opts.onConnection : null;

        // Large enough for Fronius map (~20k+). jsmodbus default input is only 1 KiB.
        const words = 65536;
        /** @type {Buffer} */
        this.holding = Buffer.alloc(words * 2);
        /** @type {Buffer} */
        this.input = Buffer.alloc(words * 2);
        this._netServer = null;
        this._modbusServer = null;
        this.listening = false;

        const staticMap = buildStaticHoldingMap(this.fakeUniqueId);
        for (const [addr, val] of staticMap.entries()) {
            this._writeReg(addr, val);
        }
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
        return meter;
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

            const server = net.createServer();
            const modbus = new jsmodbus.server.TCP(server, {
                holding: this.holding,
                input: this.input,
            });

            server.on('connection', (socket) => {
                const peer = `${socket.remoteAddress}:${socket.remotePort}`;
                this.log(`Modbus client connected ${peer} (Gen24 secondary unit ${this.unitId})`);
                try {
                    if (this.onConnection) {
                        this.onConnection(String(socket.remoteAddress || ''));
                    }
                } catch {
                    // ignore callback errors
                }
                socket.on('data', (buf) => {
                    // MBAP+PDU: tid,proto,len,unit,fc,addr,qty…
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
                socket.on('close', () => this.log(`Modbus client closed ${peer}`));
                socket.on('error', (err) => this.log(`Modbus client error ${peer}: ${err.message}`));
            });

            server.once('error', (err) => {
                this.error(`Modbus listen error: ${err.message}`);
                reject(err);
            });

            server.listen(this.port, this.host, () => {
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
    stop() {
        return new Promise((resolve) => {
            this.listening = false;
            if (!this._netServer) {
                resolve();
                return;
            }
            this._netServer.close(() => {
                this._netServer = null;
                this._modbusServer = null;
                resolve();
            });
        });
    }
}

module.exports = { FroniusModbusServer };
