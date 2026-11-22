'use strict';

const utils = require('@iobroker/adapter-core');
const { GrowattOpenApiClient } = require('./lib/growattOpenApi');
const { Smoother } = require('./lib/smoother');
const { FroniusModbusServer } = require('./lib/modbusServer');
const {
    handleDiscoverGrowatt,
    handleDiscoverFronius,
    handleResetEnergyBaselines,
} = require('./lib/adminMessages');
const {
    staleAfterS,
    scheduleNextPoll,
    pollOnce,
    startSmoothLoop,
} = require('./lib/adapterPoll');
const { isAutoOffsetMode, getLastPublished } = require('./lib/energyBaselines');
const {
    seedEnergyFallback,
    pushEnergyToModbus,
    finalizeEnergySeedAfterModbus,
    noteModbusClient,
} = require('./lib/energyBoot');
const {
    migrateLegacyDeviceConfig,
    applySelectedFroniusFromTable,
    ensureGrowattTokenUsable,
    ensureFakeSmDefaults,
} = require('./lib/adapterBootstrap');
const {
    publishLocalIpHint,
    startLocalProxyIfEnabled,
    sanitizeLocalEnabled,
    setLocalEnabled,
} = require('./lib/localProxy');
const { runStickSetup, checkStickOnline } = require('./lib/stickSetup');
const { startStickOnlineMonitor, stopStickOnlineMonitor } = require('./lib/stickOnline');

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
        await ensureGrowattTokenUsable(this);
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
            onConnection: (remoteAddress) => noteModbusClient(this, remoteAddress),
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
            pushEnergyToModbus(this);
        } catch (err) {
            await this.setStateAsync('info.modbusListening', { val: false, ack: true });
            this.log.error(
                `Cannot bind Modbus ${cfg.modbusHost}:${cfg.modbusPort}: ${err.message}. ` +
                    'On Linux, port 502 needs capability or root; free the port first.',
            );
            return;
        }

        await finalizeEnergySeedAfterModbus(this);

        this._lastSample = {
            power_w: 0,
            e_total_kwh: getLastPublished(this),
            u1: 0,
            f: 0,
        };
        startSmoothLoop(this);

        await publishLocalIpHint(this);
        await sanitizeLocalEnabled(this);
        await this.subscribeStatesAsync('info.localEnabled');
        this.localServer = await startLocalProxyIfEnabled(this);
        startStickOnlineMonitor(this, { firstDelayMs: 10000 });

        if (manufacturer !== 'growatt') {
            this.log.error(`Manufacturer '${manufacturer}' not implemented yet (v1 = growatt)`);
            await this.setStateAsync('info.connection', { val: false, ack: true });
            await this.setStateAsync('info.lastError', { val: `unsupported manufacturer: ${manufacturer}`, ack: true });
            return;
        }

        this._enabledDevices = this._getEnabledDevices();
        await this.setStateAsync('info.enabledDeviceCount', { val: this._enabledDevices.length, ack: true });

        const localMode = String(cfg.growattFeedMode || 'cloud') === 'local';
        if (localMode) {
            // Local path: Shine user/pass for stick redirect; OpenAPI token not required.
            this.log.info(
                `Local feed mode — OpenAPI poll skipped; local=${cfg.localEnabled ? 'on' : 'off'} ` +
                    `verified=${cfg.localSetupVerified ? 'yes' : 'no'}`,
            );
            if (!cfg.growattUser || !cfg.growattPassword) {
                await this.setStateAsync('info.lastError', {
                    val: 'Lokal: Shine-Web-User/Passwort eintragen (kein API-Token nötig)',
                    ack: true,
                });
            }
            return;
        }

        if (!cfg.growattToken) {
            this.log.error('growattToken missing — Modbus is up at 0 W; set token and search devices');
            await this.setStateAsync('info.connection', { val: false, ack: true });
            await this.setStateAsync('info.lastError', { val: 'growattToken missing', ack: true });
            return;
        }
        if (!this._enabledDevices.length) {
            this.log.warn('No enabled devices — use Search in admin and tick devices to feed Fake SM');
            await this.setStateAsync('info.connection', { val: false, ack: true });
            await this.setStateAsync('info.lastError', { val: 'no enabled devices', ack: true });
            return;
        }

        const firstDelayMs = Math.max(15, Math.min(60, Number(cfg.pollIntervalS ?? 60))) * 1000;
        this._pollTimer = setTimeout(() => {
            pollOnce(this)
                .catch((err) => this.log.error(`Poll error: ${err.message}`))
                .finally(() => scheduleNextPoll(this));
        }, firstDelayMs);
        this.log.info(
            `Started growatt devices=${this._enabledDevices.map((d) => d.deviceSn).join(',')} ` +
                `poll=${cfg.pollIntervalS ?? 60}s night=${cfg.nightPollIntervalS ?? 300}s smooth=${cfg.smoothIntervalS}s ` +
                `staleAfter=${staleAfterS(this)}s local=${cfg.localEnabled ? 'on' : 'off'} ` +
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
        if (obj.command === 'checkStickOnline') {
            try {
                const result = await checkStickOnline(this);
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
            try {
                const result = await runStickSetup(this);
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
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (!id || !state || state.ack) {
            return;
        }
        if (id === `${this.namespace}.info.localEnabled`) {
            try {
                await setLocalEnabled(this, !!state.val);
            } catch (err) {
                this.log.warn(`localEnabled switch: ${err.message}`);
                await this.setStateAsync('info.localEnabled', { val: !!this.config.localEnabled, ack: true });
            }
        }
    }

    onUnload(callback) {
        this._stopping = true;
        try {
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
            if (this.localServer) {
                void this.localServer.stop();
            }
            if (this.modbus) {
                void this.modbus.stop();
            }
            void this.setStateAsync('info.connection', { val: false, ack: true });
            void this.setStateAsync('info.modbusListening', { val: false, ack: true });
            void this.setStateAsync('info.localConnection', { val: false, ack: true });
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
