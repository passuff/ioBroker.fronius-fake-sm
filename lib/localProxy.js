'use strict';

const { advertisedListenIps } = require('./froniusDiscover');
const { publishLocalWorkflowStatus } = require('./localWorkflowStatus');
const { fetchCalibrateTruthOnce, resolveCloudTruth, persistLearnedLayout } = require('./localCalibration');
const { persistNative } = require('./persistNative');
const { stickMayPointAtProxy } = require('./stickRedirectGuard');
const { isLocalFeedMode, shouldRunLocalProxy } = require('./localProxyMode');
const { startLocalProxyIfEnabled } = require('./localProxyStart');

/**
 * Publish auto-detected ioBroker LAN IP for stick redirect instructions.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function publishLocalIpHint(adapter) {
    const ips = advertisedListenIps();
    const hint = (adapter.config.advertisedModbusIp && String(adapter.config.advertisedModbusIp)) || ips[0] || '';
    await adapter.setStateAsync('info.localIpHint', { val: hint, ack: true });
    if (hint && !adapter.config.advertisedModbusIp) {
        adapter.config.advertisedModbusIp = hint;
    }
    return hint;
}

/**
 * Persist that stick talks to us locally — unlocks + auto-enables local switch.
 * Only writes native when state actually changes (every frame would churn/restart).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} [stickSn]
 */
async function markLocalSetupVerified(adapter, stickSn) {
    if (!isLocalFeedMode(adapter)) {
        return;
    }
    const {
        getStickEntry,
        upsertStick,
        cloneRegistry,
        listSnsByState,
    } = require('./stickRedirectRegistry');
    const { computeFeedStickSns, isFeedSn } = require('./localProxyMode');
    const sn = String(stickSn || adapter.config.localStickSn || '').trim();
    const { shouldDeferNativeVerify } = require('./setupQuiet');
    // During/after setupLocalStick a native write restarts the instance and
    // drops the Admin callback / kills the fresh TCP session — memory only.
    if (shouldDeferNativeVerify(adapter)) {
        adapter._deferredVerifySn = sn || true;
        if (sn) {
            upsertStick(adapter.config, sn, {
                state: 'verified',
                serverIp: String(adapter.config.advertisedModbusIp || '').trim() || undefined,
            });
        } else {
            adapter.config.localSetupVerified = true;
            adapter.config.localSetupPending = false;
        }
        await publishLocalWorkflowStatus(adapter, { connected: true });
        return;
    }
    const entry = sn ? getStickEntry(adapter.config, sn) : null;
    const snAlreadyVerified = !!(entry && entry.state === 'verified');
    const feedSns = computeFeedStickSns(adapter.config);
    const isFeed = !sn || isFeedSn(feedSns, sn);
    const wantEnabled =
        isFeed || !!adapter.config.localEnabled || listSnsByState(adapter.config, 'verified').length > 0;
    // Legacy (no SN): already verified+enabled → no write
    if (
        !sn &&
        !!adapter.config.localSetupVerified &&
        !adapter.config.localSetupPending &&
        !!adapter.config.localEnabled
    ) {
        return;
    }
    const alreadyDone =
        snAlreadyVerified &&
        !!adapter.config.localSetupVerified &&
        !adapter.config.localSetupPending &&
        (!!adapter.config.localEnabled || !wantEnabled);
    if (alreadyDone) {
        return;
    }
    const firstVerify = !adapter.config.localSetupVerified;
    if (sn) {
        upsertStick(adapter.config, sn, {
            state: 'verified',
            serverIp: String(adapter.config.advertisedModbusIp || '').trim() || undefined,
        });
    } else {
        adapter.config.localSetupVerified = true;
        adapter.config.localSetupPending = false;
    }
    if (wantEnabled) {
        adapter.config.localEnabled = true;
    }
    await persistNative(
        adapter,
        {
            growattFeedMode: 'local',
            localSetupVerified: !!adapter.config.localSetupVerified,
            localSetupPending: !!adapter.config.localSetupPending,
            cloudStickRedirectActive: !!adapter.config.cloudStickRedirectActive,
            cloudStickRedirectSn: String(adapter.config.cloudStickRedirectSn || ''),
            stickRedirects: cloneRegistry(adapter.config.stickRedirects),
            localEnabled: !!adapter.config.localEnabled,
        },
        'markLocalSetupVerified',
    );
    await adapter.setStateAsync('info.localSetupVerified', {
        val: !!adapter.config.localSetupVerified,
        ack: true,
    });
    await adapter.setStateAsync('info.localEnabled', { val: !!adapter.config.localEnabled, ack: true });
    if (firstVerify || (sn && !snAlreadyVerified)) {
        await adapter.setStateAsync('info.setupStatus', {
            val: sn
                ? `Lokale Verbindung hergestellt (${sn}) — Gen24 bekommt lokale Echtzeit-Daten.`
                : 'Lokale Verbindung hergestellt — Gen24 bekommt lokale Echtzeit-Daten.',
            ack: true,
        });
        adapter.log.info(
            `Local stick connection verified${sn ? ` SN=${sn}` : ''} — localEnabled=${!!adapter.config.localEnabled}`,
        );
    }
    await publishLocalWorkflowStatus(adapter, { connected: true });
}

async function sanitizeLocalEnabled(adapter) {
    const { MSG } = require('./stickMessages');
    const {
        migrateLegacyFlags,
        persistRegistry,
        applyAggregateFlags,
    } = require('./stickRedirectRegistry');
    const cfg = adapter.config;
    if (!cfg.stickRedirects || typeof cfg.stickRedirects !== 'object' || Array.isArray(cfg.stickRedirects)) {
        cfg.stickRedirects = {};
    }
    const migrated = migrateLegacyFlags(cfg);
    if (migrated) {
        await persistRegistry(adapter, 'migrateLegacyStickRedirects');
    } else {
        const { getRegistry } = require('./stickRedirectRegistry');
        // Only re-sync aggregates from registry when it has entries — otherwise
        // empty registry would wipe legacy pending/verified flags (pre-migration).
        if (Object.keys(getRegistry(cfg)).length > 0) {
            applyAggregateFlags(cfg);
        }
    }
    if (!cfg.growattFeedMode && (cfg.localEnabled || cfg.localSetupVerified)) {
        cfg.growattFeedMode = 'local';
    }
    if (!cfg.growattFeedMode) {
        cfg.growattFeedMode = 'cloud';
    }

    let changed = false;
    if (!isLocalFeedMode(adapter)) {
        if (cfg.localEnabled) {
            if (stickMayPointAtProxy(cfg)) {
                adapter.log.warn('Feed mode Cloud but stick still local — keep proxy until Restore');
            }
            cfg.localEnabled = false;
            changed = true;
        }
        if (stickMayPointAtProxy(cfg)) {
            await adapter.setStateAsync('info.setupStatus', {
                val: MSG.restoreBeforeCloud,
                ack: true,
            });
        }
        if (!adapter.localServer && shouldRunLocalProxy(adapter)) {
            adapter.localServer = await startLocalProxyIfEnabled(adapter);
        }
        if (adapter.localServer && !shouldRunLocalProxy(adapter)) {
            try {
                await adapter.localServer.stop();
            } catch (err) {
                adapter.log.warn(`stop local proxy (cloud mode): ${err.message}`);
            }
            adapter.localServer = null;
            await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
            adapter._localConnected = false;
        }
        await adapter.setStateAsync('info.localSetupVerified', {
            val: !!cfg.localSetupVerified,
            ack: true,
        });
    } else {
        if (
            !!cfg.cloudStickRedirectActive &&
            !cfg.localSetupPending &&
            !cfg.localSetupVerified
        ) {
            cfg.localSetupPending = true;
            adapter.log.info(
                'Lokal: Stick already redirected — pending in memory (UI); native write deferred',
            );
        }
        const wantEnabled = !!cfg.localSetupVerified;
        if (!!cfg.localEnabled !== wantEnabled) {
            cfg.localEnabled = wantEnabled;
            changed = true;
        }
        if (!adapter.localServer && shouldRunLocalProxy(adapter)) {
            adapter.localServer = await startLocalProxyIfEnabled(adapter);
        }
    }

    if (changed) {
        await persistNative(
            adapter,
            {
                growattFeedMode: cfg.growattFeedMode,
                localEnabled: !!cfg.localEnabled,
                localSetupPending: !!cfg.localSetupPending,
                localSetupVerified: !!cfg.localSetupVerified,
            },
            'sanitizeLocalEnabled',
        );
    }
    await adapter.setStateAsync('info.localEnabled', { val: !!cfg.localEnabled, ack: true });
    await publishLocalWorkflowStatus(adapter);
}

/**
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
    await persistNative(adapter, { localEnabled: want }, 'setLocalEnabled');
    await adapter.setStateAsync('info.localEnabled', { val: want, ack: true });

    if (!want) {
        await adapter.setStateAsync('info.localConnection', { val: false, ack: true });
        adapter._localConnected = false;
        if (!shouldRunLocalProxy(adapter) && adapter.localServer) {
            try {
                await adapter.localServer.stop();
            } catch (err) {
                adapter.log.warn(`stop local proxy: ${err.message}`);
            }
            adapter.localServer = null;
        }
        await publishLocalWorkflowStatus(adapter);
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
            await publishLocalWorkflowStatus(adapter);
            return false;
        }
    }
    await publishLocalWorkflowStatus(adapter);
    return true;
}

module.exports = {
    publishLocalIpHint,
    publishLocalWorkflowStatus,
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
