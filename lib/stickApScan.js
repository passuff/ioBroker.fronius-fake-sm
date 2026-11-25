'use strict';

const net = require('net');
const { candidateHosts } = require('./froniusDiscover');

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

module.exports = {
    probePort,
    scanLocalStickPorts,
    buildLocalFrame,
    tryTouchApStick,
};
