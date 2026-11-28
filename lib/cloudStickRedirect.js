'use strict';

const { LOGGER_REG } = require('./growattShineSession');
const { sessionFromAdapter } = require('./stickOnline');

const CLOUD_HOST_MARKERS = ['server.growatt.com', 'growatt.com'];

/**
 * True if value looks like an IPv4/IPv6/hostname (not Shine error tokens like inv_set_c).
 * @param {string} host
 * @returns {boolean}
 */
function looksLikeServerHost(host) {
    const h = String(host || '').trim();
    if (!h || h.length < 3) {
        return false;
    }
    if (/[\s<>]|inv_set|error_|datalog_lost|permission/i.test(h)) {
        return false;
    }
    // IPv4
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
        return true;
    }
    // IPv6 (loose)
    if (h.includes(':') && /^[0-9a-f:]+$/i.test(h)) {
        return true;
    }
    // Hostname must contain a dot (server.growatt.com / lan.local)
    if (h.includes('.') && /^[a-z0-9][a-z0-9._-]*$/i.test(h)) {
        return true;
    }
    return false;
}

/**
 * True when stick SERVERIP points away from Growatt cloud (local proxy / custom host).
 * @param {string|null|undefined} serverHost
 * @param {string} [advertisedModbusIp]
 * @returns {boolean}
 */
function isLocalProxyRedirect(serverHost, advertisedModbusIp) {
    const host = String(serverHost || '')
        .trim()
        .toLowerCase();
    if (!host || !looksLikeServerHost(host)) {
        return false;
    }
    for (const m of CLOUD_HOST_MARKERS) {
        if (host === m || host.endsWith(`.${m}`) || host.includes(m)) {
            return false;
        }
    }
    const adv = String(advertisedModbusIp || '')
        .trim()
        .toLowerCase();
    if (adv && host === adv) {
        return true;
    }
    return true;
}

/**
 * Only real hosts for display — never Shine error tokens (inv_set_datalog_lost, …).
 * @param {string} [serverIp]
 * @returns {string}
 */
function safeDisplayHost(serverIp) {
    const ip = String(serverIp || '').trim();
    return looksLikeServerHost(ip) ? ip : '';
}

/**
 * Short human labels for the devices table (no API jargon).
 * @param {boolean} redirected
 * @param {string} [serverIp]
 * @param {{offline?:boolean}} [opts]
 * @returns {string}
 */
function stickRedirectLabel(redirected, serverIp, opts) {
    const ip = safeDisplayHost(serverIp);
    const offline = !!(opts && opts.offline);
    if (redirected) {
        if (offline) {
            return ip ? `Umleitung aktiv (zuletzt ${ip})` : 'Umleitung aktiv (Stick offline)';
        }
        return ip ? `Umleitung aktiv (${ip})` : 'Umleitung aktiv';
    }
    if (offline) {
        return 'Status unbekannt (Stick offline)';
    }
    return 'Growatt-Cloud';
}

/**
 * Scrub legacy labels that still contain Shine error codes.
 * @param {object} row
 */
function sanitizeRedirectRow(row) {
    if (!row || typeof row !== 'object') {
        return;
    }
    const host = safeDisplayHost(row.stickServerIp);
    row.stickServerIp = host;
    const label = String(row.stickRedirectLabel || '');
    const redirected =
        !!row.stickRedirected || /umleitung/i.test(label) || !!(row.cloudStickRedirectActive);
    if (/inv_set|datalog_lost|error_|frequently_access/i.test(label) || /inv_set|datalog_lost/i.test(String(row.stickServerIp || ''))) {
        row.stickRedirected = redirected || /umleitung/i.test(label);
        row.stickRedirectLabel = stickRedirectLabel(row.stickRedirected, host, { offline: !host && row.stickRedirected });
    }
}

/**
 * @param {Map<string, object>} byPlant
 * @returns {boolean} true if at least one plant got a real SERVERIP host from Shine
 */
function probeHadLiveServerIp(byPlant) {
    if (!byPlant || !byPlant.size) {
        return false;
    }
    for (const info of byPlant.values()) {
        if (info && looksLikeServerHost(info.stickServerIp)) {
            return true;
        }
    }
    return false;
}

/**
 * Apply redirect status onto OpenAPI device rows.
 * Stick-SN comes from the cloud pairing (OpenAPI datalogger_sn) — never replace a
 * concrete OpenAPI stick with an unrelated plant stick (e.g. lab stick[0]).
 *
 * @param {object[]} devices
 * @param {Map<string, {stickSn:string,stickServerIp:string,stickRedirected:boolean,probeLive?:boolean}>} byPlant
 * @param {Map<string, {stickSn:string,stickServerIp:string,stickRedirected:boolean,probeLive?:boolean}>} [byStick]
 */
function enrichDevicesWithStickRedirect(devices, byPlant, byStick) {
    if (!Array.isArray(devices)) {
        return devices;
    }
    for (const row of devices) {
        if (!row || typeof row !== 'object') {
            continue;
        }
        const pid = String(row.plantId || '').trim();
        const openApiSn = String(row.stickSn || '').trim();
        const stickKey = openApiSn && openApiSn !== '—' ? openApiSn : '';
        const info =
            (stickKey && byStick && byStick.get(stickKey)) ||
            (pid && byPlant ? byPlant.get(pid) : null) ||
            null;
        if (!info) {
            row.stickSn = stickKey || '—';
            sanitizeRedirectRow(row);
            if (!row.stickRedirectLabel) {
                row.stickRedirectLabel = '—';
            }
            continue;
        }
        // Keep cloud WR↔stick pairing; only fill stickSn when OpenAPI left it empty.
        if (!stickKey) {
            row.stickSn = info.stickSn || '—';
        } else {
            row.stickSn = stickKey;
        }
        // No live SERVERIP (stick offline): keep prior redirect flag, never show API junk.
        if (info.probeLive === false) {
            sanitizeRedirectRow(row);
            if (row.stickRedirected || /umleitung/i.test(String(row.stickRedirectLabel || ''))) {
                row.stickRedirected = true;
                row.stickRedirectLabel = stickRedirectLabel(true, row.stickServerIp, { offline: true });
            } else {
                row.stickServerIp = '';
                row.stickRedirected = false;
                row.stickRedirectLabel = stickRedirectLabel(false, '', { offline: true });
            }
            continue;
        }
        row.stickServerIp = safeDisplayHost(info.stickServerIp);
        row.stickRedirected = !!info.stickRedirected;
        row.stickRedirectLabel = stickRedirectLabel(info.stickRedirected, row.stickServerIp);
    }
    return devices;
}

/**
 * Probe every Shine datalogger on each plant. byStick is keyed by SN (cloud truth);
 * byPlant keeps one representative (prefer redirected) for plant-level fallback only.
 *
 * @param {import('./growattShineSession').GrowattShineSession} session
 * @param {string[]} plantIds
 * @param {string} [advertisedModbusIp]
 * @returns {Promise<{byPlant:Map<string,object>, byStick:Map<string,object>, anyRedirected:boolean, redirectSn:string}>}
 */
async function probeSticksForPlants(session, plantIds, advertisedModbusIp) {
    const byPlant = new Map();
    const byStick = new Map();
    let anyRedirected = false;
    let redirectSn = '';
    const ids = [...new Set((plantIds || []).map((p) => String(p || '').trim()).filter(Boolean))];
    for (const plantId of ids) {
        let sticks = [];
        try {
            sticks = await session.listDataloggers(plantId);
        } catch (_err) {
            continue;
        }
        if (!sticks.length) {
            continue;
        }
        let plantPreferred = null;
        for (const stick of sticks) {
            const sn = String((stick && stick.sn) || '').trim();
            if (!sn) {
                continue;
            }
            let serverIp = '';
            let redirected = false;
            let probeLive = false;
            try {
                const probe = await session.getRegister(sn, LOGGER_REG.SERVERIP);
                serverIp = probe && probe.msg != null ? String(probe.msg).trim() : '';
                if (looksLikeServerHost(serverIp)) {
                    probeLive = true;
                    redirected = isLocalProxyRedirect(serverIp, advertisedModbusIp);
                } else {
                    serverIp = '';
                }
            } catch (_err) {
                serverIp = '';
                redirected = false;
                probeLive = false;
            }
            const info = {
                stickSn: sn,
                stickServerIp: serverIp,
                stickRedirected: redirected,
                probeLive,
                plantId,
            };
            byStick.set(sn, info);
            if (!plantPreferred || (redirected && !plantPreferred.stickRedirected)) {
                plantPreferred = info;
            }
            if (redirected && !anyRedirected) {
                anyRedirected = true;
                redirectSn = sn;
            }
        }
        if (plantPreferred) {
            byPlant.set(plantId, plantPreferred);
        }
    }
    return { byPlant, byStick, anyRedirected, redirectSn };
}

/**
 * Enrich discover rows + native flags when Shine creds exist.
 * @param {import('@iobroker/adapter-core').Adapter} adapter
 * @param {object[]} devices
 * @param {object} [message]
 * @returns {Promise<{devices:object[], cloudStickRedirectActive:boolean, cloudStickRedirectSn:string}>}
 */
async function enrichDiscoverWithStickRedirect(adapter, devices, message) {
    const empty = {
        devices,
        cloudStickRedirectActive: false,
        cloudStickRedirectSn: '',
    };
    if (!Array.isArray(devices) || !devices.length) {
        return empty;
    }
    // Fallback without live probe: last known redirect or prior local setup
    const cfg = adapter.config || {};
    const fallbackActive = !!(
        cfg.cloudStickRedirectActive ||
        cfg.localSetupPending ||
        cfg.localSetupVerified
    );
    const prevBySn = new Map(
        (Array.isArray(cfg.devices) ? cfg.devices : [])
            .filter((d) => d && d.deviceSn)
            .map((d) => [d.deviceSn, d]),
    );
    for (const row of devices) {
        const old = prevBySn.get(row.deviceSn);
        if (!old) {
            continue;
        }
        const openApiSn = String(row.stickSn || '').trim();
        // Cloud OpenAPI stick pairing wins; only reuse prior stickSn when discover left it empty.
        if (!openApiSn && old.stickSn) {
            row.stickSn = old.stickSn;
        }
        const sameStick =
            old.stickSn &&
            row.stickSn &&
            String(old.stickSn).toUpperCase() === String(row.stickSn).toUpperCase();
        if (sameStick) {
            if (old.stickServerIp) {
                row.stickServerIp = old.stickServerIp;
            }
            if (old.stickRedirected != null) {
                row.stickRedirected = !!old.stickRedirected;
            }
            if (old.stickRedirectLabel) {
                row.stickRedirectLabel = old.stickRedirectLabel;
            }
        }
    }

    const applyFallbackLabels = () => {
        for (const row of devices) {
            sanitizeRedirectRow(row);
            const label = String(row.stickRedirectLabel || '');
            const looksRedirect = row.stickRedirected || /umleitung/i.test(label);
            if (looksRedirect || fallbackActive) {
                row.stickRedirected = true;
                row.stickRedirectLabel = stickRedirectLabel(true, row.stickServerIp, { offline: true });
            } else {
                row.stickRedirected = false;
                row.stickRedirectLabel = stickRedirectLabel(false, '', { offline: true });
            }
            // Never invent a stick SN from localStickSn — that is a different role (proxy).
            if (!row.stickSn) {
                row.stickSn = '—';
            }
        }
    };

    const { shineLoginBlockedReason, noteShineAuthFailure } = require('./localStatusAdmin');
    if (shineLoginBlockedReason(adapter)) {
        applyFallbackLabels();
        return {
            devices,
            cloudStickRedirectActive: fallbackActive,
            cloudStickRedirectSn: String(cfg.cloudStickRedirectSn || cfg.localStickSn || ''),
        };
    }
    const cred = sessionFromAdapter(adapter, message);
    if (cred.error) {
        applyFallbackLabels();
        return {
            devices,
            cloudStickRedirectActive: fallbackActive,
            cloudStickRedirectSn: String(cfg.cloudStickRedirectSn || cfg.localStickSn || ''),
        };
    }
    try {
        await cred.session.login();
        const plantIds = devices.map((d) => d && d.plantId).filter(Boolean);
        const { byPlant, byStick, anyRedirected, redirectSn } = await probeSticksForPlants(
            cred.session,
            plantIds,
            cfg.advertisedModbusIp,
        );
        enrichDevicesWithStickRedirect(devices, byPlant, byStick);
        const live = probeHadLiveServerIp(byPlant);
        // Live SERVERIP wins; if stick offline / junk msg, keep last known redirect flag.
        const active = live ? anyRedirected : fallbackActive || anyRedirected;
        if (!live) {
            applyFallbackLabels();
        }
        return {
            devices,
            cloudStickRedirectActive: active,
            cloudStickRedirectSn:
                redirectSn ||
                String(cfg.cloudStickRedirectSn || cfg.localStickSn || ''),
        };
    } catch (err) {
        noteShineAuthFailure(adapter, err);
        adapter.log.warn(`stick redirect probe during discover: ${err.message}`);
        applyFallbackLabels();
        return {
            devices,
            cloudStickRedirectActive: fallbackActive,
            cloudStickRedirectSn: String(cfg.cloudStickRedirectSn || cfg.localStickSn || ''),
        };
    }
}

module.exports = {
    isLocalProxyRedirect,
    looksLikeServerHost,
    safeDisplayHost,
    stickRedirectLabel,
    sanitizeRedirectRow,
    probeHadLiveServerIp,
    enrichDevicesWithStickRedirect,
    probeSticksForPlants,
    enrichDiscoverWithStickRedirect,
    CLOUD_HOST_MARKERS,
};
