'use strict';

const { listRedirectedSns } = require('./stickRedirectRegistry');
const { hasStickSession, maybeFallbackUnpatchedLocal } = require('./stickRedirectGuard');
const { sessionFromAdapter, LOGGER_REG, isCloudOk } = require('./stickOnline');
const { looksLikeServerHost } = require('./cloudStickRedirect');

/**
 * Probe stick SERVERIP via Shine. Returns host string or null when unavailable.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} sn
 * @param {object} [message]
 * @returns {Promise<string|null>}
 */
async function defaultProbeServerIp(adapter, sn, message) {
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        return null;
    }
    try {
        await cred.session.login();
        const probe = await cred.session.getRegister(sn, LOGGER_REG.SERVERIP);
        if (!isCloudOk(probe) || !looksLikeServerHost(probe && probe.msg)) {
            return null;
        }
        return String(probe.msg).trim();
    } catch (err) {
        if (adapter.log && adapter.log.debug) {
            adapter.log.debug(`reconcileRedirectRegistry probe ${sn}: ${err.message}`);
        }
        return null;
    }
}

/**
 * Drop stale registry entries: verified/redirected but SERVERIP no longer points at
 * the local proxy. Skips SNs with an active proxy TCP session. Night/offline without
 * a live SERVERIP probe keeps the entry (no wipe).
 *
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {{probeServerIp?: (sn: string) => Promise<string|null|undefined>, message?: object}} [opts]
 * @returns {Promise<{removed:string[], fellBack:boolean, texts:string[]}>}
 */
async function reconcileRedirectRegistry(adapter, opts = {}) {
    const cfg = (adapter && adapter.config) || {};
    const server = adapter && adapter.localServer;
    const sns = listRedirectedSns(cfg);
    const removed = [];
    const texts = [];
    let fellBack = false;

    // Snapshot/setup must not demote mid-redirect (native write = restart).
    if (adapter && adapter._setupInProgress) {
        return { removed, fellBack, texts };
    }

    const probe =
        typeof opts.probeServerIp === 'function'
            ? opts.probeServerIp
            : (sn) => defaultProbeServerIp(adapter, sn, opts.message);

    for (const sn of sns) {
        if (hasStickSession(server, sn)) {
            continue;
        }
        let host = null;
        try {
            host = await probe(sn);
        } catch {
            host = null;
        }
        if (!host) {
            continue;
        }
        const result = await maybeFallbackUnpatchedLocal(adapter, host, sn);
        if (result && result.removed) {
            removed.push(sn);
            if (result.text) {
                texts.push(result.text);
            }
            if (result.fellBack) {
                fellBack = true;
            }
        }
    }

    return { removed, fellBack, texts };
}

module.exports = {
    reconcileRedirectRegistry,
    defaultProbeServerIp,
};
