'use strict';

/**
 * Central native-config writer for system.adapter.<namespace>.
 * Every write restarts the instance (js-controller) — log reason + changed keys
 * so routine restart loops are diagnosable, and skip no-op writes.
 */

/**
 * Top-level key names whose JSON values differ between two native objects.
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @returns {string[]}
 */
function diffNativeKeys(before, after) {
    const a = before || {};
    const b = after || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const changed = [];
    for (const k of keys) {
        try {
            if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
                changed.push(k);
            }
        } catch {
            if (a[k] !== b[k]) {
                changed.push(k);
            }
        }
    }
    return changed.sort();
}

/**
 * Deep-ish clone of native for before/after compare (JSON round-trip).
 * @param {Record<string, any>} native
 */
function cloneNative(native) {
    try {
        return JSON.parse(JSON.stringify(native || {}));
    } catch {
        return { ...(native || {}) };
    }
}

/**
 * Apply a patch object or mutator to adapter native config and persist only when
 * something actually changed.
 *
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {Record<string, any>|((native:Record<string, any>) => void)} patchOrMutate
 * @param {string} reason short machine-readable cause (shows in log before restart)
 * @returns {Promise<{wrote:boolean, keys:string[], error?:string}>}
 */
async function persistNative(adapter, patchOrMutate, reason) {
    const tag = String(reason || 'unspecified').slice(0, 80);
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (!obj || !obj.native) {
            return { wrote: false, keys: [], error: 'native object missing' };
        }
        const before = cloneNative(obj.native);
        if (typeof patchOrMutate === 'function') {
            patchOrMutate(obj.native);
        } else if (patchOrMutate && typeof patchOrMutate === 'object') {
            Object.assign(obj.native, patchOrMutate);
        } else {
            return { wrote: false, keys: [] };
        }
        const keys = diffNativeKeys(before, obj.native);
        if (!keys.length) {
            return { wrote: false, keys: [] };
        }
        if (adapter.log && typeof adapter.log.info === 'function') {
            adapter.log.info(`native write reason=${tag} keys=${keys.join(',')}`);
        }
        await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
        return { wrote: true, keys };
    } catch (err) {
        if (adapter.log && typeof adapter.log.warn === 'function') {
            adapter.log.warn(`persistNative(${tag}): ${err.message}`);
        }
        return { wrote: false, keys: [], error: String(err && err.message ? err.message : err) };
    }
}

/**
 * Merge only baseline-related fields from in-memory devices into native.devices
 * (avoids rewriting the whole table on every sample-path mutation).
 * @param {Record<string, any>} native
 * @param {Array<object>} devices
 */
function mergeDeviceBaselinesIntoNative(native, devices) {
    if (!Array.isArray(devices)) {
        return;
    }
    if (!Array.isArray(native.devices)) {
        native.devices = [];
    }
    const bySn = new Map(
        native.devices.filter((d) => d && d.deviceSn).map((d) => [String(d.deviceSn), d]),
    );
    for (const src of devices) {
        if (!src || !src.deviceSn) {
            continue;
        }
        const sn = String(src.deviceSn);
        let dst = bySn.get(sn);
        if (!dst) {
            dst = { deviceSn: sn, enabled: !!src.enabled };
            native.devices.push(dst);
            bySn.set(sn, dst);
        }
        if (src.eBaselineKwh != null) {
            dst.eBaselineKwh = src.eBaselineKwh;
        }
        if (src.eBaselineLocked != null) {
            dst.eBaselineLocked = !!src.eBaselineLocked;
        }
        if (src.eBaselineStatus != null) {
            dst.eBaselineStatus = src.eBaselineStatus;
        }
        if (src.localLayout && typeof src.localLayout === 'object') {
            dst.localLayout = src.localLayout;
        }
    }
}

module.exports = {
    diffNativeKeys,
    cloneNative,
    persistNative,
    mergeDeviceBaselinesIntoNative,
};
