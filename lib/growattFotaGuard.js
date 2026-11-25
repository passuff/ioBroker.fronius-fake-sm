'use strict';

/**
 * Lab-only guard for Proxy-FOTA inject / CycleFota.
 *
 * Production sticks must never receive FOTA DOWN frames from the adapter.
 * Configure allowlist via:
 *   - env GROWATT_FOTA_LAB_SNS=SN1,SN2
 *   - or opts.labStickSns / config.fotaLabStickSns
 *
 * Known production SN (default blocklist) can be extended via GROWATT_FOTA_PROD_SNS.
 */

const DEFAULT_PROD_BLOCK = ['XGD6CK737N'];

/**
 * @param {string|string[]|undefined} raw
 * @returns {string[]}
 */
function parseSnList(raw) {
    if (Array.isArray(raw)) {
        return raw.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean);
    }
    if (raw == null || raw === '') {
        return [];
    }
    return String(raw)
        .split(/[,;\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
}

/**
 * @param {{ labStickSns?: string|string[], prodBlockSns?: string|string[], env?: NodeJS.ProcessEnv }} [opts]
 */
function resolveLabAllowlist(opts = {}) {
    const env = opts.env || process.env;
    const fromOpts = parseSnList(opts.labStickSns);
    const fromEnv = parseSnList(env.GROWATT_FOTA_LAB_SNS);
    return [...new Set([...fromOpts, ...fromEnv])];
}

/**
 * @param {{ prodBlockSns?: string|string[], env?: NodeJS.ProcessEnv }} [opts]
 */
function resolveProdBlocklist(opts = {}) {
    const env = opts.env || process.env;
    const extra = parseSnList(opts.prodBlockSns || env.GROWATT_FOTA_PROD_SNS);
    return [...new Set([...DEFAULT_PROD_BLOCK.map((s) => s.toUpperCase()), ...extra])];
}

/**
 * @param {string} sn
 * @param {{ labStickSns?: string|string[], prodBlockSns?: string|string[], env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: boolean, reason: string, sn: string }}
 */
function assertLabFotaTarget(sn, opts = {}) {
    const target = String(sn || '')
        .trim()
        .toUpperCase();
    if (!target) {
        return { ok: false, reason: 'missing stick SN', sn: '' };
    }
    const prod = resolveProdBlocklist(opts);
    if (prod.includes(target)) {
        return {
            ok: false,
            reason: `SN ${target} is on the production blocklist — FOTA inject forbidden`,
            sn: target,
        };
    }
    const lab = resolveLabAllowlist(opts);
    if (!lab.length) {
        return {
            ok: false,
            reason:
                'no lab SN allowlist — set GROWATT_FOTA_LAB_SNS or config.fotaLabStickSns before any FOTA inject',
            sn: target,
        };
    }
    if (!lab.includes(target)) {
        return {
            ok: false,
            reason: `SN ${target} is not in the lab allowlist (${lab.join(',')})`,
            sn: target,
        };
    }
    return { ok: true, reason: 'lab allowlist', sn: target };
}

/**
 * Heuristic: payload looks like CycleFota / remote FOTA type keyword.
 * @param {Buffer|string} payloadOrAscii
 */
function looksLikeFotaTypeKeyword(payloadOrAscii) {
    const s = Buffer.isBuffer(payloadOrAscii)
        ? payloadOrAscii.toString('ascii')
        : String(payloadOrAscii || '');
    return /CycleFota|remote_debug_flasherasechip/i.test(s);
}

/**
 * Detect FOTA-related configure / type frames (plain or already-built wire).
 * @param {{ func?: number, payload?: Buffer, reg?: number }} frameMeta
 */
function isFotaCommandMeta(frameMeta) {
    if (!frameMeta || typeof frameMeta !== 'object') {
        return false;
    }
    const func = Number(frameMeta.func);
    if (func === 0x06) {
        return true;
    }
    if (func === 0x18 && Number(frameMeta.reg) === 0x50) {
        return true;
    }
    if (frameMeta.payload && looksLikeFotaTypeKeyword(frameMeta.payload)) {
        return true;
    }
    return false;
}

/**
 * Throw if SN is not an allowed lab target.
 * @param {string} sn
 * @param {object} [opts]
 */
function requireLabFotaTarget(sn, opts) {
    const r = assertLabFotaTarget(sn, opts);
    if (!r.ok) {
        const err = new Error(`FOTA blocked: ${r.reason}`);
        err.code = 'FOTA_LAB_GUARD';
        throw err;
    }
    return r;
}

module.exports = {
    DEFAULT_PROD_BLOCK,
    parseSnList,
    resolveLabAllowlist,
    resolveProdBlocklist,
    assertLabFotaTarget,
    requireLabFotaTarget,
    looksLikeFotaTypeKeyword,
    isFotaCommandMeta,
};
