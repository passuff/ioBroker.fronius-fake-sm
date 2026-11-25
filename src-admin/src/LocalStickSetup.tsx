import React from 'react';
import {
    Box,
    Button,
    Chip,
    CircularProgress,
    FormControl,
    InputLabel,
    LinearProgress,
    MenuItem,
    Select,
    Skeleton,
    Stack,
    Typography,
} from '@mui/material';
import { ACCENT, OFFLINE, ONLINE } from './localStickStyles';
import type { StickOption, WorkflowSnapshot } from './types';

type Props = {
    lang: string;
    tr: (key: string, ...args: Array<string | number>) => string;
    sectionSx: object;
    snapshot: WorkflowSnapshot;
    sticks: StickOption[];
    selectedSn: string;
    selectedOffline: boolean;
    disabled: boolean;
    busy: string | null;
    busySince: number | null;
    onConnect: () => void;
    onSelect: (sn: string) => void;
    onPatch: () => void;
};

function Row(props: { label: string; children: React.ReactNode }): React.JSX.Element {
    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                gap: 1,
                alignItems: { sm: 'center' },
            }}
        >
            <Typography sx={{ minWidth: 110, fontWeight: 500 }}>{props.label}</Typography>
            {props.children}
        </Box>
    );
}

function elapsedLabel(busySince: number | null): string {
    if (!busySince) {
        return '';
    }
    const sec = Math.max(0, Math.floor((Date.now() - busySince) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export function LocalStickSetup(props: Props): React.JSX.Element {
    const {
        tr,
        sectionSx,
        snapshot,
        sticks,
        selectedSn,
        selectedOffline,
        disabled,
        busy,
        busySince,
        onConnect,
        onSelect,
        onPatch,
    } = props;
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
        if (!busy || !busySince) {
            return undefined;
        }
        const id = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, [busy, busySince]);

    const connected = !!snapshot.shine.connected;
    const shineText = connected
        ? tr('connected plants', snapshot.shine.plantCount)
        : snapshot.shine.error || tr('not connected');
    const selectDisabled = disabled || !!busy || !connected;
    const emptySticks = connected && sticks.length === 0;
    const showSelectSkeleton = busy === 'connect';
    const redirectState = snapshot.setup.selectedRedirectState;
    const elapsed = elapsedLabel(busySince);

    let guide: string | null = null;
    if (busy === 'patch') {
        guide = tr('Patch progress hint');
    } else if (busy === 'connect') {
        guide = tr('Connect progress hint');
    } else if (connected && emptySticks) {
        guide = tr('Next select empty');
    } else if (connected && selectedSn && redirectState === 'pending') {
        guide = tr('Waiting reconnect hint');
    } else if (connected && selectedSn && redirectState === 'verified') {
        guide = tr('Redirect done hint');
    } else if (connected && selectedSn && snapshot.setup.canPatch && !selectedOffline) {
        guide = tr('Next redirect');
    } else if (!connected && !busy) {
        guide = tr('Next connect');
    } else if (selectedOffline && redirectState === 'pending') {
        guide = tr('Waiting reconnect hint');
    } else if (selectedOffline && !redirectState) {
        guide = tr('Night offline hint');
    }

    return (
        <Box sx={sectionSx}>
            <Typography sx={{ fontWeight: 600, mb: 1.25 }}>{tr('Setup')}</Typography>
            <Stack spacing={1.5}>
                <Row label={tr('Shine cloud')}>
                    <Chip
                        size="small"
                        label={shineText}
                        sx={{
                            bgcolor: connected ? 'rgba(27,127,74,0.15)' : 'rgba(107,110,102,0.15)',
                            color: connected ? ONLINE : OFFLINE,
                            fontWeight: 500,
                        }}
                    />
                    <Box sx={{ flex: 1 }} />
                    <Button
                        variant="contained"
                        disabled={disabled || !!busy}
                        onClick={onConnect}
                        startIcon={
                            busy === 'connect' ? <CircularProgress size={16} color="inherit" /> : undefined
                        }
                        sx={{ bgcolor: ACCENT, '&:hover': { bgcolor: '#255A3F' }, textTransform: 'none' }}
                    >
                        {busy === 'connect' ? tr('Working…') : tr('Connect cloud')}
                    </Button>
                </Row>

                <Row label={tr('Stick')}>
                    {showSelectSkeleton ? (
                        <Skeleton
                            variant="rounded"
                            height={40}
                            sx={{ minWidth: 220, flex: 1, borderRadius: '4px' }}
                            aria-label={tr('Working…')}
                        />
                    ) : (
                        <FormControl size="small" sx={{ minWidth: 220, flex: 1 }} disabled={selectDisabled}>
                            <InputLabel id="ffs-stick-label">{tr('Stick')}</InputLabel>
                            <Select
                                labelId="ffs-stick-label"
                                label={tr('Stick')}
                                value={selectedSn || ''}
                                disabled={selectDisabled}
                                displayEmpty
                                onChange={e => onSelect(String(e.target.value))}
                                sx={{ opacity: selectDisabled ? 0.7 : 1 }}
                            >
                                {!selectedSn ? (
                                    <MenuItem value="">
                                        <em>{emptySticks ? tr('No sticks found') : tr('Select a stick')}</em>
                                    </MenuItem>
                                ) : null}
                                {sticks.map(o => (
                                    <MenuItem key={o.value} value={o.value}>
                                        {o.label}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    )}
                    <Button
                        variant="contained"
                        disabled={disabled || !!busy || !snapshot.setup.canPatch || !selectedSn}
                        onClick={onPatch}
                        startIcon={
                            busy === 'patch' ? <CircularProgress size={16} color="inherit" /> : undefined
                        }
                        sx={{ bgcolor: ACCENT, '&:hover': { bgcolor: '#255A3F' }, textTransform: 'none' }}
                    >
                        {busy === 'patch' ? tr('Working…') : tr('Redirect stick')}
                    </Button>
                </Row>

                {busy ? (
                    <Box role="status" sx={{ pl: { sm: '118px' } }}>
                        <LinearProgress sx={{ mb: 1, borderRadius: 1 }} />
                        <Typography sx={{ fontSize: '0.85rem', color: OFFLINE }}>
                            {busy === 'patch' ? tr('Patch progress hint') : tr('Working…')}
                            {elapsed ? ` · ${elapsed}` : ''}
                        </Typography>
                    </Box>
                ) : null}

                {!busy && guide ? (
                    <Typography sx={{ fontSize: '0.85rem', color: OFFLINE, pl: { sm: '118px' } }}>
                        {guide}
                    </Typography>
                ) : null}
            </Stack>
        </Box>
    );
}
