export type StickOption = { label: string; value: string };

export type SnapshotStick = {
    sn: string;
    name?: string;
    online: boolean;
    redirectState: string;
    serverHint?: string;
};

export type WorkflowSnapshot = {
    shine: { connected: boolean; plantCount: number; error?: string };
    proxy: {
        listening: boolean;
        forward: boolean;
        frameStatus: string;
        clientCount: number;
        port: number;
    };
    sticks: SnapshotStick[];
    selectedSn: string;
    setup: {
        canPatch: boolean;
        canRestore: boolean;
        selectedOnline: boolean;
        selectedRedirectState: string | null;
    };
};

export const emptySnapshot = (): WorkflowSnapshot => ({
    shine: { connected: false, plantCount: 0 },
    proxy: { listening: false, forward: true, frameStatus: '—', clientCount: 0, port: 5279 },
    sticks: [],
    selectedSn: '',
    setup: { canPatch: false, canRestore: false, selectedOnline: false, selectedRedirectState: null },
});

/** Shorten monster select labels: "SN - Name --- offline - …" → "SN · Name · offline" */
export function shortStickLabel(label: string, value: string): string {
    const raw = String(label || value || '').trim();
    if (!raw) {
        return value;
    }
    const sn = String(value || '').trim();
    const parts = raw.split(/\s*[—–-]{1,3}\s*|\s{2,}/).map(p => p.trim()).filter(Boolean);
    const name = parts.find(p => p !== sn && !/^(online|offline|verbunden|FW|Umleitung)/i.test(p));
    const online = /\boffline\b/i.test(raw) ? 'offline' : /\b(online|verbunden)\b/i.test(raw) ? 'online' : '';
    return [sn || parts[0], name, online].filter(Boolean).join(' · ');
}
