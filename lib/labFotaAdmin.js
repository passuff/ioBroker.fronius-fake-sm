'use strict';

/**
 * Admin message: lab-only FOTA param-set (no CycleFota).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
async function handleSendFotaParamSetLab(adapter, message = {}) {
    const sn = String(message.sn || adapter.config.localStickSn || '').trim().toUpperCase();
    if (!sn) {
        return { ok: false, reason: 'missing sn' };
    }
    const server = adapter.localServer;
    if (!server || typeof server.sendFotaParamSetLab !== 'function') {
        return { ok: false, reason: 'local proxy not running' };
    }
    const labStickSns = message.labStickSns ||
        adapter.config.fotaLabStickSns ||
        process.env.GROWATT_FOTA_LAB_SNS ||
        sn;
    server.fotaLabStickSns = labStickSns;
    const opts = {
        labStickSns,
        host: message.host,
        path: message.path,
        port: message.port,
        cdnUrl: message.cdnUrl,
        httpServerBlob: message.httpServerBlob,
    };
    const result = server.sendFotaParamSetLab(sn, opts);
    return { sn, ...result };
}

/**
 * Lab-only: send FC 0x06 type keyword (e.g. remote_debug_ON) to stick.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
async function handleSendLabTypeFrame(adapter, message = {}) {
    const sn = String(message.sn || adapter.config.localStickSn || 'XGD6CJH2Y0').trim().toUpperCase();
    const type = String(message.type || 'remote_debug_ON');
    if (!sn) {
        return { ok: false, reason: 'missing sn' };
    }
    const server = adapter.localServer;
    if (!server || typeof server.sendToStick !== 'function') {
        return { ok: false, reason: 'local proxy not running' };
    }
    const labStickSns =
        message.labStickSns ||
        adapter.config.fotaLabStickSns ||
        process.env.GROWATT_FOTA_LAB_SNS ||
        sn;
    server.fotaLabStickSns = labStickSns;
    const { buildFotaTypeFrame } = require('./growattFotaFrames');
    const frame = buildFotaTypeFrame({
        sn,
        type,
        labGuard: { labStickSns, fotaLabStickSns: labStickSns },
    });
    const ok = server.sendToStick(frame, sn) || server.sendToStick(frame);
    adapter.log.info(`sendLabTypeFrame type=${type} sn=${sn} ok=${ok} len=${frame.length}`);
    return { ok, sn, type, hex: frame.toString('hex'), len: frame.length };
}

/**
 * Lab-only: reboot stick so it re-reads Fake-WR identity (model_code / SN).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
async function handleRebootLabStick(adapter, message = {}) {
    const sn = String(message.sn || 'XGD6CJH2Y0').trim().toUpperCase();
    if (!sn) {
        return { ok: false, reason: 'missing sn' };
    }
    const server = adapter.localServer;
    if (!server || typeof server.sendToStick !== 'function') {
        return { ok: false, reason: 'local proxy not running' };
    }
    const { buildRebootFrame } = require('./growattCommands');
    const frame = buildRebootFrame(sn);
    const ok = server.sendToStick(frame, sn) || server.sendToStick(frame);
    adapter.log.info(`rebootLabStick sn=${sn} ok=${ok} len=${frame.length}`);
    return { ok, sn, hex: frame.toString('hex'), len: frame.length };
}

module.exports = { handleSendFotaParamSetLab, handleSendLabTypeFrame, handleRebootLabStick };
