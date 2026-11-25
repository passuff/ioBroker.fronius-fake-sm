import type { WorkflowSnapshot } from './types';

/**
 * Drop LocalStickPanel "Working…" when Status already shows the outcome.
 * setupLocalStick's sendTo often never returns after a native-write restart.
 */
export function shouldClearSetupBusy(
    busy: string | null | undefined,
    snapshot: WorkflowSnapshot | null | undefined,
    selectedSn?: string,
): boolean {
    const action = String(busy || '').trim();
    if (!action) {
        return false;
    }
    const snap = snapshot || ({} as WorkflowSnapshot);
    const sn = String(selectedSn || snap.selectedSn || '').trim();
    const sticks = Array.isArray(snap.sticks) ? snap.sticks : [];
    const setup = snap.setup || { canPatch: false, selectedRedirectState: null };

    if (action === 'patch') {
        if (sn && sticks.some(s => s && String(s.sn || '').trim() === sn)) {
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
        return !sticks.some(s => s && String(s.sn || '').trim() === sn);
    }

    if (action === 'connect') {
        return !!(snap.shine && snap.shine.connected);
    }

    return false;
}

/** Max wait for Admin sendTo before clearing busy (ms). Stick reboot often 1–4 min. */
export const SETUP_ACTION_TIMEOUT_MS = 240_000;
