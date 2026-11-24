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
 * Applies stick selection fields to native. Online/label flips are NOT written
 * to native (that restarts the instance every night). Setup/Restore sendTo
 * still write stickCloudOnline explicitly when needed.
 * @param {Record<string, any>} native mutated in place
 * @param {boolean} _online ignored for native persistence
 * @param {string} _label ignored for native persistence
 * @param {object} [extra]
 * @returns {boolean} true when native has to be written
 */
function applyStickStatusToNative(native, _online, _label, extra = {}) {
    let changed = false;
    if (extra.localStickSn && native.localStickSn !== extra.localStickSn) {
        native.localStickSn = extra.localStickSn;
        changed = true;
    }
    if (extra.localPlantId && native.localPlantId !== extra.localPlantId) {
        native.localPlantId = extra.localPlantId;
        changed = true;
    }
    if (changed && extra.stickStatusText != null) {
        native.stickStatusText = stableStatusText(extra.stickStatusText);
    }
    return changed;
}

/**
 * Publishes the stick status. States + in-memory config always; native only for
 * stick/plant selection changes (never for routine online↔offline).
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

    const { persistNative } = require('./persistNative');
    await persistNative(
        adapter,
        (native) => {
            applyStickStatusToNative(native, isOnline, label, extra);
        },
        'stickOnlineStatus',
    );
}

module.exports = {
    stableStatusText,
    applyStickStatusToNative,
    persistStickOnlineFlag,
};
