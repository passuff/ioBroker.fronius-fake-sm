'use strict';

const { decodeFrame, buildAck, usesXorCrc } = require('./growattProto');
const {
    parseDataRecord,
    trySeedLayout,
    isDataFunc,
    isRealtimeDataFunc,
    extractSn,
    bodyAfterSn,
} = require('./growattRecord');

/** Known classic ShineWiFi-X funcs (data + control) for CRC-lenient acceptance. */
const CLASSIC_FUNCS = new Set([0x03, 0x04, 0x05, 0x16, 0x18, 0x19, 0x50]);

/**
 * True when a CRC-failed frame is a plausible classic XOR frame we should still
 * decode: XOR proto, a known func, and a readable datalogger SN in the payload.
 * @param {ReturnType<typeof decodeFrame>} frame
 */
function isClassicLenient(frame) {
    if (!frame || !usesXorCrc(frame.proto) || frame.func == null) {
        return false;
    }
    if (!CLASSIC_FUNCS.has(frame.func)) {
        return false;
    }
    return !!extractSn(frame.payload);
}

/**
 * Decode one stick UP frame (classic XOR+CRC or AES session fallback).
 * @param {import('./growattServer').GrowattServer} server
 * @param {Buffer} raw
 * @param {import('net').Socket} stickSock
 * @returns {{aesOk:boolean}|null}
 */
function handleStickFrame(server, raw, stickSock) {
    let frame;
    try {
        frame = decodeFrame(raw);
    } catch (err) {
        server.debug(`frame decode: ${err.message}`);
        return null;
    }
    const aes = stickSock && stickSock._aesSession;
    let aesOk = false;
    if (!frame.crcOk) {
        if (aes && aes.ready) {
            const hit = aes.tryDecrypt(raw);
            if (hit && hit.plain && hit.plain.length >= 2) {
                // AES frames keep unit/func in the CLEAR 8-byte header; the
                // ciphertext (and thus the decrypted plaintext) is the payload
                // AFTER unit/func, i.e. it starts at the datalogger SN — exactly
                // like decodeFrame's XOR payload. Do NOT treat plain[0]/plain[1]
                // as unit/func (that misread 'X'/'G' of the SN as func and
                // gated real 0x04/0x50 data records out of the Modbus mirror).
                frame = {
                    txn: raw.readUInt16BE(0),
                    proto: raw.readUInt16BE(2),
                    length: raw.readUInt16BE(4),
                    unit: raw.length > 6 ? raw[6] : null,
                    func: raw.length > 7 ? raw[7] : null,
                    payload: hit.plain,
                    crcOk: true,
                    crcRx: null,
                    crcCalc: null,
                    aesVariant: hit.variant,
                };
                aesOk = true;
                server.debug(
                    `AES decrypt ok func=0x${Number(frame.func).toString(16)} variant=${hit.variant}`,
                );
            } else {
                server.debug(`bad CRC txn=${frame.txn} calc=${frame.crcCalc} rx=${frame.crcRx}`);
                return null;
            }
        } else if (isClassicLenient(frame)) {
            // Classic XOR path (ShineWiFi-X 3.1.0.x): the stick zero-fills the
            // record trailer, so the modbus CRC rarely matches even though the
            // XOR-decoded payload (SN + data) is fully intact. Accept it like
            // Grott does — CRC is advisory for these frames.
            server.debug(
                `classic CRC advisory-miss func=0x${Number(frame.func).toString(16)} — accepting`,
            );
        } else {
            server.debug(`bad CRC txn=${frame.txn} calc=${frame.crcCalc} rx=${frame.crcRx}`);
            return null;
        }
    }

    const sn = extractSn(frame.payload) || (aes && aes.serial) || null;
    if (sn) {
        // Same-SN zombie cleanup: if this datalogger already had a different live
        // socket (e.g. reconnected on a new DHCP IP), drop the old one so only the
        // freshest session for this SN survives. Distinct SNs are untouched.
        const prevSock = server._stickBySn.get(sn);
        if (prevSock && prevSock !== stickSock) {
            try {
                prevSock.destroy();
            } catch {
                // ignore
            }
        }
        server._stickBySn.set(sn, stickSock);
        server.onStick(sn);
        if (server.autoPersistRedirect && server.redirectServerIp && !server._redirectDoneFor.has(sn)) {
            server._redirectDoneFor.add(sn);
            setTimeout(() => {
                if (!server.persistRedirect(sn)) {
                    server._redirectDoneFor.delete(sn);
                }
            }, 1500);
        }
    }

    server.onFrame({
        txn: frame.txn,
        proto: frame.proto,
        func: frame.func,
        len: raw.length,
        sn,
    });

    if (!server.forwardCloud && server.replyAckWhenNoForward) {
        if (isDataFunc(frame.func) || frame.func === 0x16) {
            try {
                stickSock.write(buildAck(frame));
            } catch {
                // ignore
            }
        }
    }

    // Holding-register read response (FC 0x05) — settings readback path.
    if (frame.func === 0x05 && frame.payload && frame.payload.length) {
        try {
            const { parseReadHoldingResponse } = require('./growattInverterModbus');
            const parsed = parseReadHoldingResponse(frame.payload);
            if (parsed && parsed.values.length) {
                if (typeof server.onHoldingRead === 'function') {
                    server.onHoldingRead({
                        sn: parsed.sn || sn,
                        register: parsed.register,
                        value: parsed.values[0],
                        values: parsed.values,
                    });
                }
                if (server._pendingHoldingReads) {
                    server._pendingHoldingReads.delete(parsed.register);
                }
            }
        } catch (err) {
            server.debug && server.debug(`holding read parse: ${err.message}`);
        }
        return { aesOk };
    }

    // Only realtime records (0x04/0x50) feed calibration + the Modbus mirror.
    // 0x03 is a buffered/announce record (zero realtime fields on 3.1.0.x) —
    // it registered its SN above but must not inject 0 W between live updates.
    if (!isRealtimeDataFunc(frame.func)) {
        return { aesOk };
    }

    const body = bodyAfterSn(frame.payload);
    const stickKey = String(sn || extractSn(frame.payload) || '').trim();
    let layout =
        typeof server.layoutForSn === 'function' ? server.layoutForSn(stickKey) : server.calibrator.layout;

    if (!layout && body && body.length) {
        const cal =
            typeof server.calibratorForSn === 'function'
                ? server.calibratorForSn(stickKey)
                : server.calibrator;
        const truth = server.getCloudTruth();
        if (truth) {
            const was = cal.calibrated;
            const learned = cal.observe(body, truth);
            if (!was && learned) {
                if (typeof server.setLayoutForSn === 'function') {
                    server.setLayoutForSn(stickKey, learned);
                } else {
                    server.calibrator.setLayout(learned);
                }
                server.onCalibrated(learned, stickKey);
                layout = learned;
            }
        } else {
            const seed = trySeedLayout(body);
            if (seed) {
                server._seedTried = true;
                if (typeof server.setLayoutForSn === 'function') {
                    server.setLayoutForSn(stickKey, seed);
                } else {
                    server.calibrator.setLayout(seed);
                }
                server.onCalibrated(seed, stickKey);
                server.log(`local seed layout locked (${seed.seedName || 'seed'}) SN=${stickKey || '-'} — no cloud truth`);
                layout = seed;
            }
        }
        if (cal.failed && !server._calFailReported) {
            server._calFailReported = true;
            server.onCalibrateFailed(cal.failReason || 'auto-calibrate failed');
        }
    }

    if (!layout) {
        server.onSample({
            sn: stickKey || 'unknown',
            pac_w: null,
            e_total_kwh: null,
            u1: 0,
            f: 0,
            recordType: `0x${Number(frame.func).toString(16)}_${raw.length}`,
            calibrated: false,
            at: Date.now(),
        });
        return { aesOk };
    }

    const parsed = parseDataRecord({
        payload: frame.payload,
        func: frame.func,
        proto: frame.proto,
        frameLen: raw.length,
        layout,
    });

    if (!parsed.parsed || parsed.pac_w === null) {
        return { aesOk };
    }

    const stickSn = parsed.sn || sn || 'unknown';
    const sample = {
        sn: stickSn,
        pac_w: parsed.pac_w,
        e_total_kwh: parsed.e_total_kwh || 0,
        e_today_kwh: parsed.e_today_kwh,
        ppv_w: parsed.ppv_w,
        status: parsed.status,
        temp: parsed.temp,
        u1: parsed.u1 || 0,
        f: parsed.f || 0,
        recordType: parsed.recordType,
        calibrated: true,
        at: Date.now(),
        fields: parsed.fields || null,
    };
    server.stickSamples.set(stickSn, sample);
    server.onSample(sample);
    return { aesOk };
}

module.exports = { handleStickFrame };
