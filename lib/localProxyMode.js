'use strict';

const { stickMayPointAtProxy, proxyAlwaysOn } = require('./stickRedirectGuard');

function isLocalFeedMode(adapter) {
    return String(adapter.config.growattFeedMode || 'cloud') === 'local';
}

/**
 * Proxy stays up when always-on, while stick may still point at us, or local feed is on.
 * Always-on avoids orphan sticks after reinstall / Cloud mode.
 */
function shouldRunLocalProxy(adapter) {
    const cfg = adapter.config || {};
    if (proxyAlwaysOn(cfg) || stickMayPointAtProxy(cfg)) {
        return true;
    }
    if (!isLocalFeedMode(adapter)) {
        return false;
    }
    return !!cfg.localEnabled;
}

/**
 * Feed-stick SNs = sticks the user selected to mirror locally (enabled devices[].stickSn).
 * Without enabled devices: all registry entries in state "verified", else localStickSn.
 * @param {object} cfg
 * @returns {string[]}
 */
function computeFeedStickSns(cfg) {
    const set = new Set();
    const devices = Array.isArray(cfg && cfg.devices) ? cfg.devices : [];
    for (const d of devices) {
        if (d && d.enabled && d.stickSn) {
            set.add(String(d.stickSn).trim());
        }
    }
    if (set.size === 0) {
        const { listSnsByState } = require('./stickRedirectRegistry');
        for (const sn of listSnsByState(cfg, 'verified')) {
            set.add(sn);
        }
    }
    if (set.size === 0 && cfg && cfg.localStickSn) {
        set.add(String(cfg.localStickSn).trim());
    }
    set.delete('');
    return [...set];
}

/**
 * @param {string[]} feedSns
 * @param {string} sn
 */
function isFeedSn(feedSns, sn) {
    if (!Array.isArray(feedSns) || feedSns.length === 0) {
        return true;
    }
    return feedSns.includes(String(sn || '').trim());
}

/**
 * Primary Fake-SM stick SN from enabled devices (first with stickSn).
 * @param {object} cfg
 * @returns {string}
 */
function primaryFeedStickSnFromDevices(cfg) {
    const devices = Array.isArray(cfg && cfg.devices) ? cfg.devices : [];
    for (const d of devices) {
        if (d && d.enabled && d.stickSn) {
            const sn = String(d.stickSn).trim();
            if (sn) {
                return sn;
            }
        }
    }
    return '';
}

/**
 * If localStickSn points at a non-feed SN while devices define a feed stick,
 * return a native patch to align selection to the primary feed.
 * cloudStickRedirectSn is owned by deriveAggregateFlags / migrate (prefers
 * localStickSn + devices) — do not patch it here or native-write restart loops.
 * @param {object} cfg
 * @returns {Record<string, string>|null}
 */
function buildFeedSelectionPatch(cfg) {
    const c = cfg || {};
    const primary = primaryFeedStickSnFromDevices(c);
    if (!primary) {
        return null;
    }
    const feedSet = new Set(
        (Array.isArray(c.devices) ? c.devices : [])
            .filter((d) => d && d.enabled && d.stickSn)
            .map((d) => String(d.stickSn).trim())
            .filter(Boolean),
    );
    const local = String(c.localStickSn || '').trim();
    if (!local || !feedSet.has(local)) {
        return { localStickSn: primary };
    }
    return null;
}

/**
 * Align in-memory + native selection to devices feed stick when mis-pointed.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<{wrote:boolean, keys:string[], error?:string, patch?:Record<string,string>|null}>}
 */
async function syncFeedSelectionFromDevices(adapter) {
    const patch = buildFeedSelectionPatch(adapter && adapter.config);
    if (!patch) {
        return { wrote: false, keys: [], patch: null };
    }
    Object.assign(adapter.config, patch);
    const { persistNative } = require('./persistNative');
    const result = await persistNative(adapter, patch, 'syncFeedSelection');
    return { ...result, patch };
}

module.exports = {
    isLocalFeedMode,
    shouldRunLocalProxy,
    computeFeedStickSns,
    isFeedSn,
    primaryFeedStickSnFromDevices,
    buildFeedSelectionPatch,
    syncFeedSelectionFromDevices,
};
