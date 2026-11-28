import React from 'react';
import {
    Box,
    Chip,
    CircularProgress,
    IconButton,
    List,
    ListItem,
    ListItemText,
    Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { OFFLINE, ONLINE, redirectLabel } from './localStickStyles';
import type { WorkflowSnapshot } from './types';

type Props = {
    tr: (key: string, ...args: Array<string | number>) => string;
    sectionSx: object;
    border: string;
    snapshot: WorkflowSnapshot;
    setupBusy: boolean;
    onMenu: (el: HTMLElement, sn: string) => void;
};

export function LocalStickStatus(props: Props): React.JSX.Element {
    const { tr, sectionSx, border, snapshot, setupBusy, onMenu } = props;
    const empty = snapshot.sticks.length === 0;
    const listening = !!snapshot.proxy.listening;
    const proxyLabel = listening
        ? `${tr('Proxy')} :${snapshot.proxy.port} · ${tr('ready')}`
        : setupBusy
          ? `${tr('Proxy')} :${snapshot.proxy.port} · ${tr('starting')}`
          : `${tr('Proxy')} :${snapshot.proxy.port} · ${tr('not listening')}`;
    const proxySx = listening
        ? { bgcolor: 'rgba(27,127,74,0.15)', color: ONLINE, fontWeight: 500 }
        : setupBusy
          ? { bgcolor: 'rgba(180,120,20,0.15)', color: '#8A6A12', fontWeight: 500 }
          : { bgcolor: 'rgba(163,59,42,0.12)', color: '#A33B2A', fontWeight: 500 };

    return (
        <Box sx={sectionSx}>
            <Typography sx={{ fontWeight: 600, mb: 1 }}>{tr('Status')}</Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: empty ? 1.5 : 1, alignItems: 'center' }}>
                <Chip size="small" label={proxyLabel} sx={proxySx} />
                {snapshot.proxy.forward ? <Chip size="small" label={tr('Forward on')} /> : null}
                <Chip size="small" label={`${tr('Frames')}: ${snapshot.proxy.frameStatus}`} />
                <Chip size="small" label={`${snapshot.proxy.clientCount} ${tr('clients')}`} />
            </Box>

            {empty ? (
                <Box sx={{ py: 0.5 }}>
                    <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>
                        {tr('No redirected sticks')}
                    </Typography>
                    <Typography sx={{ fontSize: '0.85rem', color: OFFLINE, mt: 0.5 }}>
                        {tr('Next status empty')}
                    </Typography>
                </Box>
            ) : (
                <List dense disablePadding>
                    {snapshot.sticks.map(st => {
                        const pending = st.redirectState === 'pending';
                        return (
                            <ListItem
                                key={st.sn}
                                disableGutters
                                secondaryAction={
                                    <IconButton
                                        edge="end"
                                        aria-label={tr('Remove redirect')}
                                        onClick={e => onMenu(e.currentTarget, st.sn)}
                                    >
                                        <MoreVertIcon fontSize="small" />
                                    </IconButton>
                                }
                                sx={{ borderTop: border, py: 0.75, pr: 6 }}
                            >
                                {pending && !st.online ? (
                                    <CircularProgress size={14} sx={{ mr: 1.25, color: OFFLINE }} />
                                ) : (
                                    <Box
                                        aria-hidden
                                        sx={{
                                            width: 10,
                                            height: 10,
                                            borderRadius: '50%',
                                            bgcolor: st.online ? ONLINE : 'transparent',
                                            border: st.online ? 'none' : `2px solid ${OFFLINE}`,
                                            mr: 1.25,
                                            flexShrink: 0,
                                        }}
                                    />
                                )}
                                <ListItemText
                                    primary={st.sn}
                                    secondary={`${st.online ? tr('online') : tr('offline')} · ${
                                        st.role === 'feed' ? tr('Fake-SM') : tr('proxy only')
                                    } · ${redirectLabel(k => tr(k), st.redirectState)}${
                                        st.role === 'feed' && st.name ? ` · ${st.name}` : ''
                                    }${pending && !st.online ? ` · ${tr('Waiting short')}` : ''}`}
                                    slotProps={{
                                        primary: { sx: { fontWeight: 600, fontSize: '0.95rem' } },
                                        secondary: { sx: { fontSize: '0.8rem' } },
                                    }}
                                />
                            </ListItem>
                        );
                    })}
                </List>
            )}
        </Box>
    );
}
