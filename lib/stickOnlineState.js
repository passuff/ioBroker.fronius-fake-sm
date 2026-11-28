'use strict';

const { onlineLabel } = require('./stickMessages');

/**
 * Status text without the Shine "last update" timestamp. The timestamp changes
 * on every check and must never reach native config.
 * @param {any} text
 */
function stableStatusText(text) {
    return String(text == null ? '' : text).replace(/ · Update [^.]*(?=\.)/, '');
}

/**
 * Stick status must NEVER mutate native config — setForeignObject restarts the
 * instance and historically caused Shine login storms. Selection changes belong
 * in setup/save handlers via persistNative.
 * @param {Record<string, any>} _native ignored
 * @param {boolean} _online ignored
 * @param {string} _label ignored
 * @param {object} [_extra] ignored
 * @returns {boolean} always false
 */
function applyStickStatusToNative(_native, _online, _label, _extra = {}) {
    return false;
}

/**
 * Publishes stick online status to states + in-memory config only.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {boolean} online
 * @param {object} [extra]
 */
async function persistStickOnlineFlag(adapter, online, extra = {}) {
    const isOnline = !!online;
    const label = onlineLabel(isOnline);
    adapter.config.stickCloudOnline = isOnline;
    adapter.config.stickOnlineLabel = label;
    if (extra.localStickSn) {
        adapter.config.localStickSn = extra.localStickSn;
    }
    if (extra.localPlantId) {
        adapter.config.localPlantId = extra.localPlantId;
    }

    await adapter.setStateAsync('info.stickOnline', { val: isOnline, ack: true });
    await adapter.setStateAsync('info.stickOnlineLabel', { val: label, ack: true });
    if (extra.stickStatusText != null) {
        await adapter.setStateAsync('info.setupStatus', {
            val: String(extra.stickStatusText).slice(0, 240),
            ack: true,
        });
    }
}

module.exports = {
    stableStatusText,
    applyStickStatusToNative,
    persistStickOnlineFlag,
};
