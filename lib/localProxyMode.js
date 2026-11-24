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

module.exports = {
    isLocalFeedMode,
    shouldRunLocalProxy,
    computeFeedStickSns,
    isFeedSn,
};
