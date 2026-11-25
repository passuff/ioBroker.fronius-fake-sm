'use strict';

const SHORT_SESSION_MS = 10_000;
const SHORT_STREAK_WARN = 3;
const RX_RING = 24;

/**
 * @param {string} remoteAddress
 * @returns {string}
 */
function normalizeIp(remoteAddress) {
    return String(remoteAddress || '').replace(/^::ffff:/, '').trim();
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isLoopbackIp(ip) {
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function ensureModbusHealth(adapter) {
    if (!adapter._modbusGen24Sockets) {
        /** @type {Map<object, { ip: string, peer: string, openedAt: number, rx: string[] }>} */
        adapter._modbusGen24Sockets = new Map();
    }
    if (!adapter._modbusShortStreak) {
        adapter._modbusShortStreak = 0;
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {boolean} connected
 */
async function publishModbusClientConnected(adapter, connected) {
    try {
        await adapter.setStateAsync('info.modbusClientConnected', { val: !!connected, ack: true });
    } catch {
        // ignore
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
function refreshConnectedState(adapter) {
    ensureModbusHealth(adapter);
    const n = adapter._modbusGen24Sockets.size;
    const connected = n > 0;
    if (adapter._modbusClientConnected !== connected) {
        adapter._modbusClientConnected = connected;
        void publishModbusClientConnected(adapter, connected);
    }
}

/**
 * Called when any Modbus TCP client connects.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} meta
 * @param {string} meta.remoteAddress
 * @param {string} meta.peer
 * @param {object} meta.socket
 */
function onModbusClientOpen(adapter, meta) {
    ensureModbusHealth(adapter);
    const ip = normalizeIp(meta.remoteAddress);
    const want = String(adapter.config.froniusIp || '').trim();
    const loopback = isLoopbackIp(ip);

    if (loopback) {
        adapter.log.debug(`Modbus probe client ${meta.peer}`);
        return { track: false, quiet: true };
    }

    // Boot wait / energy seed: only Gen24 IP (or any if froniusIp unset)
    if (!want || ip === want) {
        adapter._modbusClientFromFronius = true;
        if (typeof adapter._pendingModbusClientWait === 'function') {
            const done = adapter._pendingModbusClientWait;
            adapter._pendingModbusClientWait = null;
            done(true);
        }
        adapter._modbusGen24Sockets.set(meta.socket, {
            ip,
            peer: meta.peer,
            openedAt: Date.now(),
            rx: [],
        });
        refreshConnectedState(adapter);
        return { track: true, quiet: false, isFronius: true };
    }

    adapter.log.debug(`Modbus client ${meta.peer} (not froniusIp ${want})`);
    return { track: false, quiet: true };
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} meta
 * @param {object} meta.socket
 * @param {string} meta.peer
 * @param {Buffer} [meta.buf]
 */
function onModbusClientData(adapter, meta) {
    ensureModbusHealth(adapter);
    const entry = adapter._modbusGen24Sockets.get(meta.socket);
    if (!entry) {
        return;
    }
    const buf = meta.buf;
    let line = '';
    if (buf && buf.length >= 12) {
        const unit = buf.readUInt8(6);
        const fc = buf.readUInt8(7);
        const addr = buf.readUInt16BE(8);
        const qty = buf.readUInt16BE(10);
        line = `unit=${unit} fc=${fc} addr=${addr} qty=${qty}`;
    } else if (buf) {
        line = buf.toString('hex').slice(0, 48);
    }
    if (!line) {
        return;
    }
    entry.rx.push(line);
    if (entry.rx.length > RX_RING) {
        entry.rx.shift();
    }
    if (adapter._modbusShortStreak >= SHORT_STREAK_WARN) {
        adapter.log.info(`Modbus RX ${meta.peer} ${line}`);
    } else {
        adapter.log.debug(`Modbus RX ${meta.peer} ${line}`);
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} meta
 * @param {object} meta.socket
 * @param {string} meta.peer
 */
function onModbusClientClose(adapter, meta) {
    ensureModbusHealth(adapter);
    const entry = adapter._modbusGen24Sockets.get(meta.socket);
    if (!entry) {
        return;
    }
    adapter._modbusGen24Sockets.delete(meta.socket);
    refreshConnectedState(adapter);

    const dur = Date.now() - entry.openedAt;
    if (dur < SHORT_SESSION_MS) {
        adapter._modbusShortStreak = (Number(adapter._modbusShortStreak) || 0) + 1;
        if (adapter._modbusShortStreak >= SHORT_STREAK_WARN) {
            const rxDump = entry.rx.length ? ` lastRX=[${entry.rx.slice(-6).join('; ')}]` : '';
            adapter.log.warn(
                `Gen24 Modbus session short (${dur}ms) streak=${adapter._modbusShortStreak}${rxDump}`,
            );
        }
    } else {
        adapter._modbusShortStreak = 0;
    }
}

/**
 * Legacy hook used by energyBoot / main onConnection.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} remoteAddress
 */
function noteModbusClient(adapter, remoteAddress) {
    const ip = normalizeIp(remoteAddress);
    const want = String(adapter.config.froniusIp || '').trim();
    if (want && ip && ip !== want) {
        return;
    }
    if (isLoopbackIp(ip)) {
        return;
    }
    adapter._modbusClientFromFronius = true;
    if (typeof adapter._pendingModbusClientWait === 'function') {
        const done = adapter._pendingModbusClientWait;
        adapter._pendingModbusClientWait = null;
        done(true);
    }
}

module.exports = {
    SHORT_SESSION_MS,
    SHORT_STREAK_WARN,
    normalizeIp,
    isLoopbackIp,
    onModbusClientOpen,
    onModbusClientData,
    onModbusClientClose,
    noteModbusClient,
    publishModbusClientConnected,
};
