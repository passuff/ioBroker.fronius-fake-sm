'use strict';

const { GrowattServer } = require('./growattServer');
const { AutoCalibrator } = require('./growattRecord');
const { advertisedListenIps } = require('./froniusDiscover');
const { staleAfterS, applyLocalSample } = require('./adapterPoll');

/**
 * Publish auto-detected ioBroker LAN IP for stick redirect instructions.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function publishLocalIpHint(adapter) {
    const ips = advertisedListenIps();
    const hint = (adapter.config.advertisedModbusIp && String(adapter.config.advertisedModbusIp)) || ips[0] || '';
    await adapter.setStateAsync('info.localIpHint', { val: hint, ack: true });
    // Keep config field in sync so admin jsonConfig can show it read-only
    if (hint && !adapter.config.advertisedModbusIp) {
        adapter.config.advertisedModbusIp = hint;
    }
    return hint;
}

/**
 * Persist that stick talks to us locally — unlocks + auto-enables local switch.
 * Only writes native when state actually changes (every frame would churn/restart).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function markLocalSetupVerified(adapter) {
    if (!isLocalFeedMode(adapter)) {
        return;
    }
    const alreadyDone = !!adapter.config.localSetupVerified && !adapter.config.localSetupPending;
    if (alreadyDone) {
        return;
    }
    const firstVerify = !adapter.config.localSetupVerified;
    adapter.config.localSetupVerified = true;
    adapter.config.localSetupPending = false;
    // Auto-enable only the first time we prove the stick works — never force back on
    if (firstVerify) {
        adapter.config.localEnabled = true;
    }
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (obj && obj.native) {
            obj.native.growattFeedMode = 'local';
            obj.native.localSetupVerified = true;
            obj.native.localSetupPending = false;
            if (firstVerify) {
                obj.native.localEnabled = true;
            }
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
        }
    } catch (err) {
        adapter.log.warn(`markLocalSetupVerified: ${err.message}`);
    }
    await adapter.setStateAsync('info.localSetupVerified', { val: true, ack: true });
    if (firstVerify) {
        await adapter.setStateAsync('info.localEnabled', { val: true, ack: true });
        await adapter.setStateAsync('info.setupStatus', {
            val: 'Lokale Verbindung bestätigt — Schalter „Lokale Verbindung aktiv“ ist an.',
            ack: true,
        });
        adapter.log.info('Local stick connection verified — localEnabled auto-on');
    }
}

function isLocalFeedMode(adapter) {
    return String(adapter.config.growattFeedMode || 'cloud') === 'local';
}

/** Proxy must keep listening after redirect so stick/cloud forward stay alive. */
function shouldRunLocalProxy(adapter) {
    if (!isLocalFeedMode(adapter)) {
        return false;
    }
    const cfg = adapter.config;
    return !!(cfg.localSetupPending || cfg.localSetupVerified || cfg.localEnabled);
}

async function sanitizeLocalEnabled(adapter) {
    const cfg = adapter.config;
    // Migrate: previously verified/enabled local → feed mode local
    if (!cfg.growattFeedMode && (cfg.localEnabled || cfg.localSetupVerified)) {
        cfg.growattFeedMode = 'local';
    }
    if (!cfg.growattFeedMode) {
        cfg.growattFeedMode = 'cloud';
    }

    let changed = false;
    if (!isLocalFeedMode(adapter)) {
        if (cfg.localEnabled || cfg.localSetupPending) {
            adapter.log.info('Feed mode Cloud — local proxy off');
            cfg.localEnabled = false;
            cfg.localSetupPending = false;
            changed = true;
        }
    } else if (cfg.localEnabled && !cfg.localSetupVerified) {
        adapter.log.warn('localEnabled was on without verified setup — turning off');
        cfg.localEnabled = false;
        changed = true;
    }

    if (changed) {
        try {
            const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
            if (obj && obj.native) {
                obj.native.growattFeedMode = cfg.growattFeedMode;
                obj.native.localEnabled = !!cfg.localEnabled;
                obj.native.localSetupPending = !!cfg.localSetupPending;
                await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
            }
        } catch (err) {
            adapter.log.warn(`sanitizeLocalEnabled: ${err.message}`);
        }
    }
    await adapter.setStateAsync('info.localEnabled', { val: !!cfg.localEnabled, ack: true });
}

/**
 * Persist + apply localEnabled from the admin switch (or first verify).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {boolean} enabled
 */
async function setLocalEnabled(adapter, enabled) {
    const want = !!enabled;
    if (want && !isLocalFeedMode(adapter)) {
        adapter.log.warn('Lokale Verbindung nur im Datenweg „Lokal“');
        await adapter.setStateAsync('info.localEnabled', { val: false, ack: true });
        return false;
    }
    if (want && !adapter.config.localSetupVerified) {
        adapter.log.warn('Lokale Verbindung nur nach bestätigter Einrichtung einschaltbar');
        await adapter.setStateAsync('info.localEnabled', { val: false, ack: true });
        return false;
    }
    adapter.config.localEnabled = want;
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (obj && obj.native) {
            obj.native.localEnabled = want;
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
        }
    } catch (err) {
        adapter.log.warn(`setLocalEnabled: ${err.message}`);
    }
    await adapter.setStateAsync('info.localEnabled', { val: want, ack: true });

    // Keep proxy up after redirect/pending/verified — localEnabled only gates Modbus feed.
    if (!want) {
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        if (!shouldRunLocalProxy(adapter) && adapter.localServer) {
            try {
                await adapter.localServer.stop();
            } catch (err) {
                adapter.log.warn(`stop local proxy: ${err.message}`);
            }
            adapter.localServer = null;
        }
        return true;
    }

    if (!adapter.localServer) {
        adapter.localServer = await startLocalProxyIfEnabled(adapter);
        if (!adapter.localServer) {
            adapter.config.localEnabled = false;
            await adapter.setStateAsync('info.localEnabled', { val: false, ack: true });
            await adapter.setStateAsync('info.lastError', {
                val: 'Lokaler Proxy konnte nicht starten (Port belegt?)',
                ack: true,
            });
            return false;
        }
    }
    return true;
}

/**
 * One-shot OpenAPI sample for local auto-calibrate truth (no Dauer-Cloud-Poll).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<{pac:number,etotal:number}|null>}
 */
async function fetchCalibrateTruthOnce(adapter) {
    if (adapter._calibrateTruth && adapter._calibrateTruth.etotal != null) {
        return adapter._calibrateTruth;
    }
    if (adapter._calibrateTruthTried) {
        return adapter._calibrateTruth || null;
    }
    adapter._calibrateTruthTried = true;
    const token = String(adapter.config.growattToken || '').trim();
    if (!token) {
        return null;
    }
    if (typeof adapter._clientFor !== 'function' || typeof adapter._getEnabledDevices !== 'function') {
        return null;
    }
    const devices = adapter._getEnabledDevices();
    if (!devices.length) {
        return null;
    }
    try {
        const sample = await adapter._clientFor(devices[0]).fetch();
        const truth = {
            pac: Math.abs(Number(sample.power_w) || 0),
            etotal: Math.abs(Number(sample.e_total_kwh) || 0),
        };
        adapter._calibrateTruth = truth;
        adapter.log.info(
            `Local calibrate truth from OpenAPI (one-shot): pac=${truth.pac} e=${truth.etotal}`,
        );
        return truth;
    } catch (err) {
        adapter.log.info(`Local calibrate truth one-shot skipped: ${err.message}`);
        return null;
    }
}

/**
 * Prefer one-shot token truth, else last poll/local sample.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {{pac:number,etotal:number}|null}
 */
function resolveCloudTruth(adapter) {
    const t = adapter._calibrateTruth;
    if (t && t.etotal != null) {
        return {
            pac: Math.abs(Number(t.pac) || 0),
            etotal: Math.abs(Number(t.etotal) || 0),
        };
    }
    const s = adapter._lastSample;
    if (!s || s.e_total_kwh == null) {
        return null;
    }
    return {
        pac: Math.abs(Number(s.power_w) || 0),
        etotal: Math.abs(Number(s.e_total_kwh) || 0),
    };
}

/**
 * Start local Growatt :5279 proxy when enabled or waiting after setup.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function startLocalProxyIfEnabled(adapter) {
    const cfg = adapter.config;
    if (!shouldRunLocalProxy(adapter)) {
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        await adapter.setStateAsync('info.localCalibrated', { val: false, ack: true });
        return null;
    }

    const learned = AutoCalibrator.layoutFromNative(cfg);
    // Only trust calibrated flag when a real layout exists
    if (cfg.localCalibrated && !learned) {
        adapter.log.warn('localCalibrated was set without offsets — resetting until auto-calibrate succeeds');
        cfg.localCalibrated = false;
    }
    adapter._localCalibrated = !!learned;
    await adapter.setStateAsync('info.localCalibrated', { val: adapter._localCalibrated, ack: true });

    const autoCalibrate = cfg.localAutoCalibrate !== false;
    if (!learned && !autoCalibrate) {
        await adapter.setStateAsync('info.lastError', {
            val: 'local mode: no learned layout and auto-calibrate disabled',
            ack: true,
        });
        adapter.log.error('Local mode enabled but no layout and localAutoCalibrate=false');
    }

    if (!learned && autoCalibrate) {
        await fetchCalibrateTruthOnce(adapter);
    }

    const ips = advertisedListenIps();
    const redirectIp = cfg.advertisedModbusIp || ips[0] || '';

    const server = new GrowattServer({
        host: cfg.localHost || '0.0.0.0',
        port: Number(cfg.localPort ?? 5279),
        forwardCloud: cfg.localForwardCloud !== false,
        upstreamHost: 'server.growatt.com',
        upstreamPort: Number(cfg.localUpstreamPort ?? 5279),
        upstreamIp: cfg.localUpstreamHost || '',
        layout: learned,
        autoCalibrate,
        autoPersistRedirect: cfg.localAutoPersistRedirect !== false,
        redirectServerIp: redirectIp,
        redirectServerPort: Number(cfg.localPort ?? 5279),
        replyAckWhenNoForward: cfg.localForwardCloud === false,
        getCloudTruth: () => resolveCloudTruth(adapter),
        onStick: (sn) => {
            void adapter.setStateChangedAsync('info.stickSn', { val: String(sn), ack: true });
        },
        onCalibrated: (layout) => {
            adapter._localCalibrated = true;
            void adapter.setStateAsync('info.localCalibrated', { val: true, ack: true });
            void adapter.setStateAsync('info.lastError', { val: '', ack: true });
            void persistLearnedLayout(adapter, layout);
            adapter.log.info('Local stick layout auto-calibrated — local samples will feed Modbus');
        },
        onCalibrateFailed: (reason) => {
            adapter._localCalibrated = false;
            void adapter.setStateAsync('info.localCalibrated', { val: false, ack: true });
            void adapter.setStateAsync('info.lastError', { val: String(reason || 'local auto-calibrate failed'), ack: true });
            adapter.log.warn(String(reason || 'local auto-calibrate failed'));
        },
        onSample: (sample) => {
            void adapter.setStateAsync('info.localConnection', { val: true, ack: true });
            void adapter.setStateAsync('info.lastLocalFrame', { val: Date.now(), ack: true });
            void markLocalSetupVerified(adapter);
            if (sample.recordType) {
                void adapter.setStateChangedAsync('local.recordType', { val: sample.recordType, ack: true });
            }
            // Gate: only feed Modbus after real calibration + numeric sample
            if (!sample.calibrated || sample.pac_w == null || !server.calibrated) {
                return;
            }
            if (!adapter.config.localEnabled) {
                return;
            }
            adapter._localCalibrated = true;
            const summed = server.sumFreshSamples(staleAfterS(adapter) * 1000) || sample;
            applyLocalSample(adapter, summed).catch((err) => adapter.log.warn(`applyLocalSample: ${err.message}`));
        },
        onFrame: (meta) => {
            adapter.log.debug(
                `local frame func=0x${Number(meta.func).toString(16)} len=${meta.len} sn=${meta.sn || '-'}`,
            );
        },
        log: (m) => adapter.log.info(m),
        debug: (m) => adapter.log.debug(m),
        error: (m) => adapter.log.error(m),
    });

    try {
        await server.start();
        const ips = advertisedListenIps();
        const hint = cfg.advertisedModbusIp || ips[0] || '<ioBroker-IP>';
        adapter.log.info(`Local Growatt proxy enabled — set stick server to ${hint}:5279`);
        return server;
    } catch (err) {
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        adapter.log.error(
            `Cannot bind local Growatt ${cfg.localHost || '0.0.0.0'}:${cfg.localPort ?? 5279}: ${err.message}`,
        );
        return null;
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} layout
 */
async function persistLearnedLayout(adapter, layout) {
    if (adapter._persistLayoutTimer) {
        clearTimeout(adapter._persistLayoutTimer);
    }
    adapter._persistLayoutTimer = setTimeout(() => {
        void persistLearnedLayoutNow(adapter, layout);
    }, 1500);
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} layout
 */
async function persistLearnedLayoutNow(adapter, layout) {
    const patch = {
        localPacOffset: layout.pacOff,
        localPacKind: layout.pacKind || 'u32',
        localPacScale: layout.pacScale,
        localEtotalOffset: layout.etotalOff,
        localEtotalKind: layout.etotalKind || 'u32',
        localEtotalScale: layout.etotalScale,
        localVacOffset: layout.vacOff,
        localFacOffset: layout.facOff,
        localCalibrated: true,
    };
    Object.assign(adapter.config, patch);
    try {
        const obj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        if (obj && obj.native) {
            Object.assign(obj.native, patch);
            await adapter.setForeignObjectAsync(`system.adapter.${adapter.namespace}`, obj);
            adapter.log.info('Persisted local layout offsets');
        }
    } catch (err) {
        adapter.log.warn(`Could not persist local layout: ${err.message}`);
    }
}

module.exports = {
    publishLocalIpHint,
    startLocalProxyIfEnabled,
    markLocalSetupVerified,
    persistLearnedLayout,
    sanitizeLocalEnabled,
    setLocalEnabled,
    isLocalFeedMode,
    shouldRunLocalProxy,
    fetchCalibrateTruthOnce,
    resolveCloudTruth,
};
