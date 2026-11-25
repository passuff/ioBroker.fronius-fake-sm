import React from 'react';
import {
    Box,
    Button,
    Collapse,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Link,
    Menu,
    MenuItem,
    Typography,
} from '@mui/material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { tr } from './i18n';
import { DANGER, sectionSx } from './localStickStyles';
import { LocalStickSetup } from './LocalStickSetup';
import { LocalStickStatus } from './LocalStickStatus';
import { SETUP_ACTION_TIMEOUT_MS, shouldClearSetupBusy } from './setupBusy';
import {
    emptySnapshot,
    shortStickLabel,
    type StickOption,
    type WorkflowSnapshot,
} from './types';

interface PanelState extends ConfigGenericState {
    snapshot: WorkflowSnapshot;
    sticks: StickOption[];
    busy: string | null;
    busySince: number | null;
    error: string;
    hintsOpen: boolean;
    menuAnchor: HTMLElement | null;
    menuSn: string;
    confirmSn: string | null;
}

export default class LocalStickPanel extends ConfigGeneric<ConfigGenericProps, PanelState> {
    pollTimer: ReturnType<typeof setInterval> | null = null;
    busyWatchTimer: ReturnType<typeof setInterval> | null = null;
    actionTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            snapshot: emptySnapshot(),
            sticks: [],
            busy: null,
            busySince: null,
            error: '',
            hintsOpen: false,
            menuAnchor: null,
            menuSn: '',
            confirmSn: null,
        };
    }

    uiLang(): string {
        return String((this.props.oContext as { lang?: string }).lang || 'en');
    }

    instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    async sendTo(command: string, message: object = {}): Promise<unknown> {
        return this.props.oContext.socket.sendTo(this.instanceId(), command, message);
    }

    credPayload(): object {
        const d = this.props.data || {};
        return {
            growattUser: d.growattUser || '',
            growattPassword: d.growattPassword || '',
            localStickSn: d.localStickSn || '',
            growattFeedMode: d.growattFeedMode || 'local',
            advertisedModbusIp: d.advertisedModbusIp || '',
        };
    }

    clearActionTimer(): void {
        if (this.actionTimer) {
            clearTimeout(this.actionTimer);
            this.actionTimer = null;
        }
    }

    syncBusyWatch(): void {
        if (this.state.busy && !this.busyWatchTimer) {
            this.busyWatchTimer = setInterval(() => {
                void this.refresh();
            }, 2000);
        } else if (!this.state.busy && this.busyWatchTimer) {
            clearInterval(this.busyWatchTimer);
            this.busyWatchTimer = null;
        }
    }

    async refresh(): Promise<void> {
        try {
            const [snap, sticks] = await Promise.all([
                this.sendTo('localWorkflowSnapshot', this.credPayload()) as Promise<WorkflowSnapshot>,
                this.sendTo('listLocalSticks', this.credPayload()) as Promise<StickOption[]>,
            ]);
            const options = Array.isArray(sticks)
                ? sticks.map(o => ({
                      value: String(o.value),
                      label: shortStickLabel(String(o.label || o.value), String(o.value)),
                  }))
                : [];
            const snapshot = snap && typeof snap === 'object' ? snap : emptySnapshot();
            const selectedSn = String(this.props.data?.localStickSn || snapshot.selectedSn || '');
            const clearBusy = shouldClearSetupBusy(this.state.busy, snapshot, selectedSn);
            if (clearBusy) {
                this.clearActionTimer();
            }
            const next: Pick<PanelState, 'snapshot' | 'sticks' | 'error' | 'busy' | 'busySince'> = {
                snapshot,
                sticks: options,
                error: '',
                busy: clearBusy ? null : this.state.busy,
                busySince: clearBusy ? null : this.state.busySince,
            };
            this.setState(next, () => this.syncBusyWatch());
        } catch (err) {
            this.setState({ error: String((err as Error)?.message || err) });
        }
    }

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        await this.refresh();
        this.pollTimer = setInterval(() => {
            void this.refresh();
        }, 8000);
    }

    componentWillUnmount(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.busyWatchTimer) {
            clearInterval(this.busyWatchTimer);
            this.busyWatchTimer = null;
        }
        this.clearActionTimer();
        if (typeof super.componentWillUnmount === 'function') {
            super.componentWillUnmount();
        }
    }

    runAction = async (busy: string, command: string, message?: object): Promise<void> => {
        const actionId = busy;
        this.clearActionTimer();
        this.setState({ busy: actionId, busySince: Date.now(), error: '' }, () => this.syncBusyWatch());
        this.actionTimer = setTimeout(() => {
            if (this.state.busy === actionId) {
                const lang = this.uiLang();
                this.setState(
                    {
                        busy: null,
                        busySince: null,
                        error: tr(lang, 'Setup timeout'),
                    },
                    () => this.syncBusyWatch(),
                );
            }
        }, SETUP_ACTION_TIMEOUT_MS);
        try {
            const result = (await this.sendTo(command, { ...this.credPayload(), ...(message || {}) })) as {
                error?: string;
                native?: Record<string, unknown>;
            };
            if (this.state.busy !== actionId) {
                return;
            }
            if (result && result.error) {
                this.clearActionTimer();
                this.setState(
                    { error: String(result.error), busy: null, busySince: null },
                    () => this.syncBusyWatch(),
                );
                return;
            }
            if (result && result.native && typeof result.native === 'object') {
                for (const [k, v] of Object.entries(result.native)) {
                    await this.onChange(k, v);
                }
            }
            await this.refresh();
        } catch (err) {
            if (this.state.busy === actionId) {
                this.setState({ error: String((err as Error)?.message || err) });
            }
        } finally {
            if (this.state.busy === actionId) {
                this.clearActionTimer();
                this.setState({ busy: null, busySince: null }, () => this.syncBusyWatch());
            }
        }
    };

    onSelectStick = async (sn: string): Promise<void> => {
        await this.onChange('localStickSn', sn);
        await this.onChange('shineStatusTick', Date.now());
        await this.refresh();
    };

    renderItem(_error: string, disabled: boolean): React.JSX.Element {
        const { snapshot, sticks, busy, busySince, error, hintsOpen, menuAnchor, confirmSn } = this.state;
        const lang = this.uiLang();
        const t = (key: string, ...args: Array<string | number>) => tr(lang, key, ...args);
        const dark = this.props.oContext.themeType === 'dark';
        const content = dark ? '#E8EAE4' : '#1A1C19';
        const border = dark ? '1px solid rgba(255,255,255,0.16)' : '1px solid rgba(0,0,0,0.12)';
        const selectedSn = String(this.props.data?.localStickSn || snapshot.selectedSn || '');
        const sx = sectionSx(dark, content, border);

        return (
            <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <Box>
                    <Typography sx={{ fontSize: '1.05rem', fontWeight: 600, color: content }}>
                        {t('Local setup')}
                    </Typography>
                    <Typography
                        sx={{
                            fontSize: '0.875rem',
                            color: dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.65)',
                            mt: 0.5,
                        }}
                    >
                        {t('Purpose')}
                    </Typography>
                </Box>

                <LocalStickSetup
                    lang={lang}
                    tr={t}
                    sectionSx={sx}
                    snapshot={snapshot}
                    sticks={sticks}
                    selectedSn={selectedSn}
                    selectedOffline={!!selectedSn && !snapshot.setup.selectedOnline}
                    disabled={disabled}
                    busy={busy}
                    busySince={busySince}
                    onConnect={() => void this.runAction('connect', 'connectShineLocal')}
                    onSelect={sn => void this.onSelectStick(sn)}
                    onPatch={() =>
                        void this.runAction('patch', 'setupLocalStick', { localStickSn: selectedSn })
                    }
                />

                <LocalStickStatus
                    tr={t}
                    sectionSx={sx}
                    border={border}
                    snapshot={snapshot}
                    setupBusy={busy === 'patch' || busy === 'restore'}
                    onMenu={(el, sn) => this.setState({ menuAnchor: el, menuSn: sn })}
                />

                <Link
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => this.setState({ hintsOpen: !hintsOpen })}
                    sx={{ alignSelf: 'flex-start', fontSize: '0.85rem', color: content }}
                >
                    {t('Hints')}
                </Link>
                <Collapse in={hintsOpen}>
                    <Typography sx={{ fontSize: '0.8rem', color: OFFLINE_HINT }}>{t('Hardware hint')}</Typography>
                </Collapse>

                {error ? (
                    <Typography role="alert" sx={{ color: DANGER, fontSize: '0.875rem' }}>
                        {error}
                    </Typography>
                ) : null}

                <Menu
                    anchorEl={menuAnchor}
                    open={!!menuAnchor}
                    onClose={() => this.setState({ menuAnchor: null, menuSn: '' })}
                >
                    <MenuItem
                        onClick={() => this.setState({ confirmSn: this.state.menuSn, menuAnchor: null })}
                        sx={{ color: DANGER }}
                    >
                        {t('Remove redirect')}
                    </MenuItem>
                </Menu>

                <Dialog open={!!confirmSn} onClose={() => this.setState({ confirmSn: null })}>
                    <DialogTitle>{t('Remove redirect')}</DialogTitle>
                    <DialogContent>{t('Remove redirect confirm')}</DialogContent>
                    <DialogActions>
                        <Button onClick={() => this.setState({ confirmSn: null })}>{t('Cancel')}</Button>
                        <Button
                            color="error"
                            variant="contained"
                            disabled={!!busy}
                            onClick={() => {
                                const sn = confirmSn;
                                this.setState({ confirmSn: null });
                                if (sn) {
                                    void this.runAction('restore', 'restoreCloudStick', { localStickSn: sn });
                                }
                            }}
                        >
                            {t('Remove redirect')}
                        </Button>
                    </DialogActions>
                </Dialog>
            </Box>
        );
    }
}

const OFFLINE_HINT = '#6B6E66';
