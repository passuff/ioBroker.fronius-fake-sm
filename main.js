'use strict';

const utils = require('@iobroker/adapter-core');
const { GrowattOpenApiClient } = require('./lib/growattOpenApi');
const { GrowattShinePollClient, isShineCloudAuth } = require('./lib/growattShinePoll');
const { Smoother } = require('./lib/smoother');
const { FroniusModbusServer } = require('./lib/modbusServer');
const {
    handleDiscoverGrowatt,
    handleDiscoverFronius,
    handleResetEnergyBaselines,
    handleApplyPollingTemplate,
} = require('./lib/adminMessages');
const {
    staleAfterS,
    effectivePollIntervalS,
    scheduleNextPoll,
    pollOnce,
    startSmoothLoop,
    loadLastNonZeroPower,
} = require('./lib/adapterPoll');
const { isAutoOffsetMode, getLastPublished } = require('./lib/energyBaselines');
const {
    seedEnergyFallback,
    pushEnergyToModbus,
    finalizeEnergySeedAfterModbus,
} = require('./lib/energyBoot');
const {
    onModbusClientOpen,
    onModbusClientData,
    onModbusClientClose,
    publishModbusClientConnected,
} = require('./lib/modbusClientHealth');
const { startGen24MeterMonitor, stopGen24MeterMonitor } = require('./lib/gen24MeterHealth');
const {
    migrateLegacyDeviceConfig,
    applySelectedFroniusFromTable,
    ensureGrowattTokenUsable,
    ensureFakeSmDefaults,
    ensurePollingTemplate,
    ensureInverterVarsConfig,
} = require('./lib/adapterBootstrap');
const { ensureInverterVarObjects } = require('./lib/inverterVarsStates');
const {
    handleInverterSettingChange,
    startSettingsHoldingPoll,
    stopSettingsHoldingPoll,
    attachHoldingReadHandler,
} = require('./lib/growattCloudSettings');
const {
    publishLocalIpHint,
    publishLocalWorkflowStatus,
    startLocalProxyIfEnabled,
    sanitizeLocalEnabled,
} = require('./lib/localProxy');
const { runStickSetup, checkStickOnline } = require('./lib/stickSetup');
const { runRestoreCloud } = require('./lib/stickRestore');
const { startStickOnlineMonitor, stopStickOnlineMonitor } = require('./lib/stickOnlineMonitor');
const {
    handleConnectShineLocal,
    handleListLocalPlants,
    handleListLocalSticks,
    handleAnalyzeLocalNetwork,
    handleListLocalHostIps,
} = require('./lib/localShineAdmin');
const {
    handleShineStatus,
    handleStickStatusText,
    handleStickSetupState,
    handleLocalWorkflowSnapshot,
} = require('./lib/localStatusAdmin');

class FroniusFakeSm extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'fronius-fake-sm',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));

        /** @type {Smoother|null} */
        this.smoother = null;
        /** @type {FroniusModbusServer|null} */
        this.modbus = null;
        this._pollTimer = null;
        this._smoothTimer = null;
        this._lastSample = null;
        this._stopping = false;
        /** @type {Array<object>} */
        this._enabledDevices = [];
        /** @type {number} epoch ms — skip Growatt polls until then after HTTP 429 */
        this._rateLimitUntil = 0;
        this._rateLimitBackoffS = 0;
        /** @type {number} learned OpenAPI poll floor (s), raised on FREQUENTLY_ACCESS */
        this._pollFloorS = 120;
        /** @type {boolean} last OpenAPI failure was rate-limit (survives cooldown clear) */
        this._lastFailWasRateLimit = false;
        /** @type {number} epoch ms of last successful Growatt poll */
        this._lastPollOkAt = 0;
        this._staleWarned = false;
        /** @type {GrowattServer|null} */
        this.localServer = null;
        /** @type {number} epoch ms of last local stick sample */
        this._lastLocalOkAt = 0;
        this._localCalibrated = false;
        this._persistLayoutTimer = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this._stickOnlineTimer = null;
    }

    async onReady() {
        migrateLegacyDeviceConfig(this);
        applySelectedFroniusFromTable(this);
        await ensureFakeSmDefaults(this);
        await ensurePollingTemplate(this);
        await ensureInverterVarsConfig(this);
        await ensureGrowattTokenUsable(this);
        {
            const { syncDevicesBaselineStatus, persistNativePatch } = require('./lib/energyBaselines');
            if (syncDevicesBaselineStatus(this.config.devices)) {
                await persistNativePatch(this, {});
            }
        }
        const cfg = this.config;
        const manufacturer = cfg.manufacturer || cfg.source || 'growatt';

        if (!cfg.eOffsetMode) {
            cfg.eOffsetMode = 'auto';
        }
        const manualOffset = Number(cfg.eTotalOffsetKwh ?? 0);
        this.smoother = new Smoother({
            emaTauS: Number(cfg.emaTauS ?? 20),
            maxDeltaWPerTick: Number(cfg.maxDeltaWPerTick ?? 200),
            energyDriftCorrectPerHour: Number(cfg.energyDriftCorrectPerHour ?? 0.01),
            powerEpsilonW: Number(cfg.powerEpsilonW ?? 5),
            // Auto mode uses relative eTotals (baselines); offset stays 0
            eTotalOffsetKwh: isAutoOffsetMode(this) ? 0 : manualOffset,
        });

        // Provisional seed so Modbus does not advertise 0 kWh while Gen24 reconnects
        await seedEnergyFallback(this, 'provisional');

        this.modbus = new FroniusModbusServer({
            host: cfg.modbusHost || '0.0.0.0',
            port: Number(cfg.modbusPort ?? 502),
            unitId: Number(cfg.modbusUnitId ?? 3),
            fakeUniqueId: Number(cfg.fakeUniqueId ?? 3),
            log: (m) => this.log.info(m),
            debug: (m) => this.log.debug(m),
            error: (m) => this.log.error(m),
            onClientOpen: (meta) => onModbusClientOpen(this, meta),
            onClientData: (meta) => onModbusClientData(this, meta),
            onClientClose: (meta) => onModbusClientClose(this, meta),
        });

        if (cfg.froniusIp) {
            this.log.info(
                `Target Fronius ${cfg.froniusIp}` +
                    (cfg.froniusSerial ? ` SN=${cfg.froniusSerial}` : '') +
                    ` → set Gen24 Location ${cfg.fakeUniqueId || 3} meter IP to ${cfg.advertisedModbusIp || '<this host>'}`,
            );
            await this.setStateAsync('info.froniusIp', { val: String(cfg.froniusIp), ack: true });
        }
        if (cfg.advertisedModbusIp) {
            await this.setStateAsync('info.advertisedModbusIp', {
                val: String(cfg.advertisedModbusIp),
                ack: true,
            });
        }

        try {
            await this.modbus.start();
            await this.setStateAsync('info.modbusListening', { val: true, ack: true });
            await publishModbusClientConnected(this, false);
            pushEnergyToModbus(this);
        } catch (err) {
            await this.setStateAsync('info.modbusListening', { val: false, ack: true });
            await publishModbusClientConnected(this, false);
            this.log.error(
                `Cannot bind Modbus ${cfg.modbusHost}:${cfg.modbusPort}: ${err.message}. ` +
                    'On Linux, port 502 needs capability or root; free the port first.',
            );
            return;
        }

        // Bind :5279 before Gen24 energy wait — sticks must not sit on a dead port
        // while finalizeEnergySeedAfterModbus blocks up to ~90s.
        await publishLocalIpHint(this);
        await sanitizeLocalEnabled(this);
        if (!this.localServer) {
            this.localServer = await startLocalProxyIfEnabled(this);
        }
        if (this.localServer) {
            attachHoldingReadHandler(this, this.localServer);
            startSettingsHoldingPoll(this);
        }
        await publishLocalWorkflowStatus(this);

        await finalizeEnergySeedAfterModbus(this);
        startGen24MeterMonitor(this, { firstDelayMs: 20000 });

        this._lastSample = {
            power_w: 0,
            e_total_kwh: getLastPublished(this),
            u1: 0,
            f: 0,
        };
        await loadLastNonZeroPower(this);
        startSmoothLoop(this);

        startStickOnlineMonitor(this, { firstDelayMs: 10000 });

        if (manufacturer !== 'growatt') {
            this.log.error(`Manufacturer '${manufacturer}' not implemented yet (v1 = growatt)`);
            await this.setStateAsync('info.connection', { val: false, ack: true });
            await this.setStateAsync('info.lastError', { val: `unsupported manufacturer: ${manufacturer}`, ack: true });
            return;
        }

        this._enabledDevices = this._getEnabledDevices();
        await this.setStateAsync('info.enabledDeviceCount', { val: this._enabledDevices.length, ack: true });
        try {
            await ensureInverterVarObjects(this);
            this.subscribeStates('inverter.*.settings.*.value');
        } catch (err) {
            this.log.warn(`inverter vars objects: ${err.message}`);
        }

        const localMode = String(cfg.growattFeedMode || 'cloud') === 'local';
        if (localMode) {
            if (!cfg.growattUser || !cfg.growattPassword) {
                await this.setStateAsync('info.lastError', {
                    val: 'Lokal: Shine-Web-User/Passwort eintragen',
                    ack: true,
                });
            }
            // Bridge: keep OpenAPI poll until local stick feed is active (Lokal Schritt 4)
            if (!cfg.growattToken || !this._enabledDevices.length) {
                this.log.info(
                    `Local mode — OpenAPI bridge unavailable (token/devices missing); ` +
                        `verified=${cfg.localSetupVerified ? 'yes' : 'no'}`,
                );
                if (!cfg.growattToken) {
                    await this.setStateAsync('info.lastError', {
                        val: 'Ohne Cloud-Token kein Übergang — bis lokale Verbindung: Gen24 ohne Cloud-Daten',
                        ack: true,
                    });
                }
                return;
            }
            this.log.info(
                `Local mode — OpenAPI bridge until local connected; ` +
                    `verified=${cfg.localSetupVerified ? 'yes' : 'no'} devices=${this._enabledDevices.length}`,
            );
        } else {
            const shineAuth = isShineCloudAuth(this);
            if (shineAuth) {
                this._pollFloorS = Math.max(30, Number(this._pollFloorS) || 60);
                if (!cfg.growattUser || !cfg.growattPassword) {
                    this.log.error('Shine cloud auth — growattUser/Password missing');
                    await this.setStateAsync('info.connection', { val: false, ack: true });
                    await this.setStateAsync('info.lastError', {
                        val: 'Shine-Login: User/Passwort eintragen',
                        ack: true,
                    });
                    return;
                }
            } else {
                this._pollFloorS = Math.max(120, Number(this._pollFloorS) || 120);
                if (!cfg.growattToken) {
                    this.log.error('growattToken missing — Modbus is up at 0 W; set token and search devices');
                    await this.setStateAsync('info.connection', { val: false, ack: true });
                    await this.setStateAsync('info.lastError', { val: 'growattToken missing', ack: true });
                    return;
                }
            }
            if (!this._enabledDevices.length) {
                this.log.warn('No enabled devices — use Search in admin and tick devices to feed Fake SM');
                await this.setStateAsync('info.connection', { val: false, ack: true });
                await this.setStateAsync('info.lastError', { val: 'no enabled devices', ack: true });
                return;
            }
        }

        const cloudAuth = isShineCloudAuth(this) ? 'shine' : 'openapi';
        const effPollS = effectivePollIntervalS(this);
        const firstDelayMs = Math.max(15, Math.min(effPollS, 60)) * 1000;
        this._pollTimer = setTimeout(() => {
            pollOnce(this)
                .catch((err) => this.log.error(`Poll error: ${err.message}`))
                .finally(() => scheduleNextPoll(this));
        }, firstDelayMs);
        this.log.info(
            `Started growatt devices=${this._enabledDevices.map((d) => d.deviceSn).join(',')} ` +
                `cloudAuth=${cloudAuth} poll=${effPollS}s (cfg=${cfg.pollIntervalS ?? (cloudAuth === 'shine' ? 60 : 120)} ` +
                `floor=${this._pollFloorS || (cloudAuth === 'shine' ? 60 : 120)}) ` +
                `night=${cfg.nightPollIntervalS ?? 300}s smooth=${cfg.smoothIntervalS}s ` +
                `staleAfter=${staleAfterS(this)}s local=${cfg.localEnabled ? 'on' : 'off'} ` +
                `mode=${localMode ? 'local+bridge' : 'cloud'} ` +
                `(first poll in ${Math.round(firstDelayMs / 1000)}s)`,
        );
    }

    _getEnabledDevices() {
        const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
        return devices.filter((d) => d && d.enabled && d.deviceSn);
    }

    _powerFields() {
        return String(this.config.powerFields || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }

    _clientFor(device) {
        if (isShineCloudAuth(this)) {
            const plantId = String(device.plantId || this.config.localPlantId || '').trim();
            const powerKw = Number(this.config.powerKwThreshold ?? 0);
            if (!this._shinePollClient) {
                this._shinePollClient = new GrowattShinePollClient({
                    user: this.config.growattUser,
                    password: this.config.growattPassword,
                    deviceSn: device.deviceSn,
                    plantId,
                    server: this.config.growattShineUrl || 'https://server.growatt.com',
                    powerFields: this._powerFields(),
                    powerSign: Number(this.config.powerSign ?? -1),
                    powerKwThreshold: powerKw > 0 ? powerKw : 100,
                    log: (m) => this.log.info(m),
                });
            } else {
                this._shinePollClient.deviceSn = String(device.deviceSn || '');
                this._shinePollClient.plantId = plantId;
                this._shinePollClient.powerFields = this._powerFields();
                this._shinePollClient.powerSign = Number(this.config.powerSign ?? -1);
                this._shinePollClient.powerKwThreshold = powerKw > 0 ? powerKw : 100;
            }
            return this._shinePollClient;
        }
        return new GrowattOpenApiClient({
            token: this.config.growattToken,
            deviceSn: device.deviceSn,
            deviceType: device.deviceType || 'min',
            plantId: device.plantId || '',
            baseUrl: this.config.growattOpenApiUrl || 'https://openapi.growatt.com/',
            powerFields: this._powerFields(),
            powerSign: Number(this.config.powerSign ?? -1),
            powerKwThreshold: Number(this.config.powerKwThreshold ?? 0),
            log: (m) => this.log.info(m),
        });
    }

    /**
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }
        if (obj.command === 'discoverDevices') {
            await handleDiscoverGrowatt(this, obj);
            return;
        }
        if (obj.command === 'discoverFronius') {
            await handleDiscoverFronius(this, obj);
            return;
        }
        if (obj.command === 'resetEnergyBaselines') {
            await handleResetEnergyBaselines(this, obj);
            return;
        }
        if (obj.command === 'applyPollingTemplate') {
            await handleApplyPollingTemplate(this, obj);
            return;
        }
        if (obj.command === 'connectShineLocal') {
            await handleConnectShineLocal(this, obj);
            return;
        }
        if (obj.command === 'shineStatus') {
            await handleShineStatus(this, obj);
            return;
        }
        if (obj.command === 'stickStatusText') {
            await handleStickStatusText(this, obj);
            return;
        }
        if (obj.command === 'stickSetupState') {
            await handleStickSetupState(this, obj);
            return;
        }
        if (obj.command === 'localWorkflowSnapshot') {
            await handleLocalWorkflowSnapshot(this, obj);
            return;
        }
        if (obj.command === 'listLocalPlants') {
            await handleListLocalPlants(this, obj);
            return;
        }
        if (obj.command === 'listLocalSticks') {
            await handleListLocalSticks(this, obj);
            return;
        }
        if (obj.command === 'checkStickOnline') {
            try {
                const result = await checkStickOnline(this, obj.message);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            }
            return;
        }
        if (obj.command === 'setupLocalStick') {
            this._setupInProgress = true;
            try {
                const result = await runStickSetup(this, obj.message);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            } finally {
                this._setupInProgress = false;
                const { beginPostSetupQuiet, POST_SETUP_QUIET_MS } = require('./lib/setupQuiet');
                beginPostSetupQuiet(this);
                const deferred = this._deferredVerifySn;
                this._deferredVerifySn = null;
                if (deferred) {
                    const { markLocalSetupVerified } = require('./lib/localProxy');
                    const sn = deferred === true ? '' : String(deferred);
                    // Persist after quiet window so the stick's first TCP session survives
                    setTimeout(() => {
                        void markLocalSetupVerified(this, sn).catch((err) => {
                            this.log.warn(
                                `deferred markLocalSetupVerified: ${err && err.message ? err.message : err}`,
                            );
                        });
                    }, POST_SETUP_QUIET_MS + 500);
                }
            }
            return;
        }
        if (obj.command === 'restoreCloudStick') {
            try {
                const result = await runRestoreCloud(this, obj.message);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            }
            return;
        }
        if (obj.command === 'analyzeLocalNetwork') {
            await handleAnalyzeLocalNetwork(this, obj);
            return;
        }
        if (obj.command === 'listLocalHostIps') {
            await handleListLocalHostIps(this, obj);
            return;
        }
        if (obj.command === 'startFrameCapture') {
            try {
                const { startFrameCapture } = require('./lib/frameCapture');
                const result = await startFrameCapture(this, obj.message);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            }
            return;
        }
        if (obj.command === 'dropProxyClients') {
            try {
                const { clientCount } = require('./lib/stickRedirectGuard');
                const n = clientCount(this.localServer);
                if (this.localServer && typeof this.localServer.dropClients === 'function') {
                    this.localServer.dropClients();
                }
                this.log.info(`dropProxyClients: closed ${n} stick session(s)`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true, closed: n }, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            }
            return;
        }
        if (obj.command === 'sendFotaParamSetLab') {
            try {
                const { handleSendFotaParamSetLab } = require('./lib/labFotaAdmin');
                const result = await handleSendFotaParamSetLab(this, obj.message || {});
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            }
            return;
        }
        if (obj.command === 'sendLabTypeFrame') {
            try {
                const { handleSendLabTypeFrame } = require('./lib/labFotaAdmin');
                const result = await handleSendLabTypeFrame(this, obj.message || {});
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            }
            return;
        }
        if (obj.command === 'rebootLabStick') {
            try {
                const { handleRebootLabStick } = require('./lib/labFotaAdmin');
                const result = await handleRebootLabStick(this, obj.message || {});
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            }
            return;
        }
        if (obj.command === 'setLabUartAesKey') {
            try {
                const msg = obj.message || {};
                const sn = String(msg.sn || 'XGD6CJH2Y0');
                const key = String(msg.key || '');
                const iv = msg.iv != null ? String(msg.iv) : undefined;
                if (key.length !== 32) {
                    throw new Error('key must be 32 ASCII hex chars');
                }
                if (!this.localServer || typeof this.localServer.installUartAesKey !== 'function') {
                    throw new Error('localServer.installUartAesKey unavailable');
                }
                const result = this.localServer.installUartAesKey(key, iv, sn);
                try {
                    const { rememberAesSession } = require('./lib/frameCapture');
                    rememberAesSession(this, {
                        serial: sn,
                        key,
                        iv: iv || key.slice(16, 32),
                        source: 'uart',
                    });
                } catch {
                    // ignore
                }
                this.log.info(
                    `setLabUartAesKey SN=${sn} installed=${result.installed} serials=${(result.serials || []).join(',')}`
                );
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                }
            } catch (err) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: String(err.message || err) }, obj.callback);
                }
            }
            return;
        }
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, { error: `unknown command ${obj.command}` }, obj.callback);
        }
    }

    /**
     * Writable inverter settings (inverter.<sn>.settings.<id>.value).
     * @param {string} id
     * @param {ioBroker.State|null|undefined} state
     */
    onStateChange(id, state) {
        handleInverterSettingChange(this, id, state);
    }

    async onUnload(callback) {
        this._stopping = true;
        try {
            if (this._frameCapture && this._frameCapture.active) {
                this._frameCapture.stop('unload');
            }
            if (this._pollTimer) {
                clearTimeout(this._pollTimer);
            }
            if (this._smoothTimer) {
                clearTimeout(this._smoothTimer);
            }
            if (this._persistLayoutTimer) {
                clearTimeout(this._persistLayoutTimer);
            }
            stopStickOnlineMonitor(this);
            stopGen24MeterMonitor(this);
            stopSettingsHoldingPoll(this);
            // Bounded await so unload finishes before js-controller SIGKILL
            const stopWithBudget = async (stoppable, ms = 1500) => {
                if (!stoppable || typeof stoppable.stop !== 'function') {
                    return;
                }
                await Promise.race([
                    Promise.resolve(stoppable.stop()).catch(() => undefined),
                    new Promise((r) => setTimeout(r, ms)),
                ]);
            };
            await stopWithBudget(this.localServer);
            this.localServer = null;
            await stopWithBudget(this.modbus);
            try {
                await this.setStateAsync('info.connection', { val: false, ack: true });
                await this.setStateAsync('info.modbusListening', { val: false, ack: true });
                await this.setStateAsync('info.modbusClientConnected', { val: false, ack: true });
                await this.setStateAsync('info.gen24MeterVisible', { val: false, ack: true });
                await this.setStateAsync('info.localConnection', { val: false, ack: true });
            } catch {
                // ignore
            }
        } catch {
            // ignore
        }
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options) => new FroniusFakeSm(options);
} else {
    // eslint-disable-next-line no-new
    new FroniusFakeSm({});
}
