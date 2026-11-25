'use strict';

/**
 * Proxy-FOTA frame builders (lab only — call through growattFotaGuard).
 *
 * Preferred param path (FW FUN_4023b8b8 paramnum 0x50):
 *   FC 0x18 configure reg 80 (0x50) value = "##<IP-or-host>/<path>/#<PORT>#"
 *   Parsed into pFotaServerIP (31), pFotaServerPORT (6), pFotaFileName (61).
 *
 * Cycle trigger (best-effort, FW-dependent layout):
 *   FC 0x06 payload = SN(30) + "Datalog_CycleFota_ON" + NUL
 *
 * Never send CycleFota without an explicit lab allowlist check.
 */

const { buildConfigureFrame } = require('./growattCommands');
const { encodeFrame } = require('./growattProto');
const { requireLabFotaTarget } = require('./growattFotaGuard');

/** CollectorParam register for HTTPServer / FOTA URL blob. */
const FOTA_HTTPSERVER_REG = 0x50;

const TYPE_DATALOG_CYCLE_FOTA_ON = 'Datalog_CycleFota_ON';
const TYPE_SYSTEM_CYCLE_FOTA_OFF = 'System_CycleFota_OFF';

/**
 * Build HTTPServer string expected by stick parser.
 * Example: ##192.168.1.10/update/device/.../user1.bin/#80#
 *
 * @param {{ host: string, path: string, port?: number|string }} opts
 * @returns {string}
 */
function buildHttpServerBlob(opts) {
    const host = String(opts.host || '').trim();
    if (!host) {
        throw new Error('buildHttpServerBlob: host required');
    }
    let path = String(opts.path || '/').trim();
    if (!path.startsWith('/')) {
        path = `/${path}`;
    }
    // Stick buffers: IP 31, path/filename 61 — keep path without leading host
    const port = String(opts.port != null ? opts.port : 80).trim();
    // Format from FW default / Grott: ##host/path/#port#
    // path in default is like /app/xml/ — include trailing slash style as given
    return `##${host}${path}/#${port}#`;
}

/**
 * Parse ShinePhone CDN URL into HTTPServer blob parts when possible.
 * e.g. http://cdn.growatt.com/update/device/GB/.../3.1.1.7/user1.bin
 *
 * @param {string} url
 * @returns {{ host: string, path: string, port: number, blob: string }}
 */
function cdnUrlToHttpServerBlob(url) {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('cdnUrlToHttpServerBlob: only http(s)');
    }
    // Stick FOTA uses plain HTTP/1.0 — prefer port 80 even if source was https listing
    const port = u.protocol === 'http:' ? Number(u.port || 80) : 80;
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const host = u.hostname;
    const blob = buildHttpServerBlob({ host, path, port });
    return { host, path, port, blob };
}

/**
 * FC 0x18 reg 0x50 — set FOTA HTTPServer (no flash by itself).
 * @param {object} opts
 * @param {string} opts.sn lab stick SN
 * @param {string} [opts.httpServerBlob] full ##host/path/#port#
 * @param {string} [opts.host]
 * @param {string} [opts.path]
 * @param {number|string} [opts.port]
 * @param {string} [opts.cdnUrl] alternative to host/path
 * @param {object} [opts.labGuard] guard options
 */
function buildFotaHttpServerFrame(opts) {
    requireLabFotaTarget(opts.sn, opts.labGuard);
    let blob = opts.httpServerBlob;
    if (!blob && opts.cdnUrl) {
        blob = cdnUrlToHttpServerBlob(opts.cdnUrl).blob;
    }
    if (!blob) {
        blob = buildHttpServerBlob({
            host: opts.host,
            path: opts.path,
            port: opts.port,
        });
    }
    if (blob.length > 120) {
        throw new Error(`HTTPServer blob too long (${blob.length})`);
    }
    return buildConfigureFrame({
        sn: opts.sn,
        reg: FOTA_HTTPSERVER_REG,
        value: blob,
        proto: opts.proto,
        txn: opts.txn ?? 10,
    });
}

/**
 * Best-effort FC 0x06 type keyword frame (SN + ASCII + NUL).
 * @param {object} opts
 * @param {string} opts.sn
 * @param {string} [opts.type]
 * @param {object} [opts.labGuard]
 */
function buildFotaTypeFrame(opts) {
    requireLabFotaTarget(opts.sn, opts.labGuard);
    const typ = String(opts.type || TYPE_DATALOG_CYCLE_FOTA_ON);
    if (/flasherasechip/i.test(typ)) {
        throw new Error('refusing destructive remote_debug_flasherasechip');
    }
    const snBuf = Buffer.alloc(30, 0);
    Buffer.from(String(opts.sn), 'ascii').copy(snBuf, 0, 0, Math.min(30, opts.sn.length));
    const typBuf = Buffer.from(`${typ}\0`, 'ascii');
    return encodeFrame({
        proto: opts.proto ?? 0x0006,
        unit: 1,
        func: opts.func ?? 0x06,
        payloadPlain: Buffer.concat([snBuf, typBuf]),
        txn: opts.txn ?? 11,
    });
}

/**
 * Param-set only (no CycleFota) — safe first lab step after allowlist.
 * @param {object} opts same as buildFotaHttpServerFrame
 * @returns {Buffer[]}
 */
function buildFotaParamSetFrames(opts) {
    return [buildFotaHttpServerFrame(opts)];
}

/**
 * Full lab sequence: HTTPServer then CycleFota ON.
 * Caller must ensure UART recovery is ready.
 * @param {object} opts
 * @returns {Buffer[]}
 */
function buildFotaCycleFrames(opts) {
    requireLabFotaTarget(opts.sn, opts.labGuard);
    return [
        buildFotaHttpServerFrame({ ...opts, txn: opts.txn ?? 10 }),
        buildFotaTypeFrame({
            sn: opts.sn,
            type: TYPE_DATALOG_CYCLE_FOTA_ON,
            labGuard: opts.labGuard,
            proto: opts.proto,
            txn: (opts.txn ?? 10) + 1,
        }),
    ];
}

module.exports = {
    FOTA_HTTPSERVER_REG,
    TYPE_DATALOG_CYCLE_FOTA_ON,
    TYPE_SYSTEM_CYCLE_FOTA_OFF,
    buildHttpServerBlob,
    cdnUrlToHttpServerBlob,
    buildFotaHttpServerFrame,
    buildFotaTypeFrame,
    buildFotaParamSetFrames,
    buildFotaCycleFrames,
};
