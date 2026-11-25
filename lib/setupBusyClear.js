'use strict';

/**
 * Whether LocalStickPanel should drop its in-flight "Working…" busy flag.
 * sendTo(setupLocalStick) often never returns when persistNative restarts the
 * instance mid-setup, while the Status snapshot already shows configured.
 *
 * @param {string|null|undefined} busy
 * @param {{sticks?:Array<{sn?:string}>, setup?:{canPatch?:boolean,selectedRedirectState?:string|null}, selectedSn?:string}|null|undefined} snapshot
 * @param {string} [selectedSn]
 * @returns {boolean}
 */
function shouldClearSetupBusy(busy, snapshot, selectedSn) {
    const action = String(busy || '').trim();
    if (!action) {
        return false;
    }
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const sn = String(selectedSn || snap.selectedSn || '').trim();
    const sticks = Array.isArray(snap.sticks) ? snap.sticks : [];
    const setup = snap.setup && typeof snap.setup === 'object' ? snap.setup : {};

    if (action === 'patch') {
        if (sn && sticks.some((s) => s && String(s.sn || '').trim() === sn)) {
            return true;
        }
        if (sn && setup.canPatch === false) {
            return true;
        }
        if (sn && setup.selectedRedirectState) {
            return true;
        }
        return false;
    }

    if (action === 'restore') {
        if (!sn) {
            return false;
        }
        return !sticks.some((s) => s && String(s.sn || '').trim() === sn);
    }

    if (action === 'connect') {
        return !!(snap.shine && snap.shine.connected);
    }

    return false;
}

module.exports = {
    shouldClearSetupBusy,
};
