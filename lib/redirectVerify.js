'use strict';

const { looksLikeServerHost } = require('./cloudStickRedirect');

/**
 * Compare expected local proxy IP with Shine SERVERIP probe result.
 * Only exact match counts as confirmed — Growatt cloud often uses raw IPs
 * (e.g. 47.254.130.145), which must not look "local".
 * @param {string} expectedIp
 * @param {string|null|undefined} probedHost
 * @returns {{confirmed:boolean, pending:boolean, host:string}}
 */
function classifyRedirectProbe(expectedIp, probedHost) {
    const want = String(expectedIp || '').trim();
    const host = String(probedHost || '').trim();
    if (!host || !looksLikeServerHost(host)) {
        return { confirmed: false, pending: true, host };
    }
    if (want && host.toLowerCase() === want.toLowerCase()) {
        return { confirmed: true, pending: false, host };
    }
    return { confirmed: false, pending: false, host };
}

/**
 * Re-read SERVERIP after redirect. Stick reboot is slow — unconfirmed is normal briefly.
 * @param {object} session GrowattShineSession-like
 * @param {string} stickSn
 * @param {string} expectedIp
 * @param {number} [regAddr] LOGGER_REG.SERVERIP
 * @returns {Promise<{confirmed:boolean, pending:boolean, host:string, probe?:object}>}
 */
async function verifyRedirectServerIp(session, stickSn, expectedIp, regAddr = 17) {
    if (!session || typeof session.getRegister !== 'function') {
        return { confirmed: false, pending: true, host: '' };
    }
    try {
        const probe = await session.getRegister(stickSn, regAddr);
        const msg = probe && (probe.msg != null ? probe.msg : probe);
        const classified = classifyRedirectProbe(expectedIp, msg);
        return { ...classified, probe };
    } catch {
        return { confirmed: false, pending: true, host: '' };
    }
}

module.exports = {
    classifyRedirectProbe,
    verifyRedirectServerIp,
};
