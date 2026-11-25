export const ACCENT = '#2F6F4E';
export const ONLINE = '#1B7F4A';
export const OFFLINE = '#6B6E66';
export const DANGER = '#A33B2A';

export function sectionSx(dark: boolean, content: string, border: string) {
    return {
        border,
        borderRadius: '10px',
        backgroundColor: dark ? '#1C1F1A' : '#F6F7F4',
        padding: '12px 14px',
        color: content,
        width: '100%',
    } as const;
}

export function redirectLabel(tr: (k: string) => string, state: string): string {
    if (state === 'verified') {
        return tr('configured');
    }
    if (state === 'pending') {
        return tr('waiting');
    }
    return tr('redirected');
}
