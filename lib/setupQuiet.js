'use strict';

/** Default quiet window after setupLocalStick (ms) — avoids verify/FC0x18 restart cascade. */
const POST_SETUP_QUIET_MS = 45_000;

/**
 * @param {object} adapter
 * @param {number} [ms]
 */
function beginPostSetupQuiet(adapter, ms = POST_SETUP_QUIET_MS) {
    if (!adapter || typeof adapter !== 'object') {
        return;
    }
    const until = Date.now() + Math.max(0, Number(ms) || POST_SETUP_QUIET_MS);
    adapter._postSetupQuietUntil = until;
    if (adapter.localServer) {
        adapter.localServer._autoPersistQuietUntil = until;
    }
}

/**
 * True while setup is running or post-setup quiet window is active.
 * @param {object} [adapter]
 * @returns {boolean}
 */
function shouldDeferNativeVerify(adapter) {
    if (!adapter) {
        return false;
    }
    if (adapter._setupInProgress) {
        return true;
    }
    const until = Number(adapter._postSetupQuietUntil || 0);
    return until > 0 && Date.now() < until;
}

/**
 * @param {object} [server] GrowattServer
 * @returns {boolean}
 */
function shouldDeferAutoPersist(server) {
    if (!server) {
        return false;
    }
    const until = Number(server._autoPersistQuietUntil || 0);
    return until > 0 && Date.now() < until;
}

module.exports = {
    POST_SETUP_QUIET_MS,
    beginPostSetupQuiet,
    shouldDeferNativeVerify,
    shouldDeferAutoPersist,
};
