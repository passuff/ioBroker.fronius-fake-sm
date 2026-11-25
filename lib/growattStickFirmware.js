'use strict';

/**
 * ShineWiFi / datalogger firmware catalog (ShinePhone source of truth).
 *
 * App path (APK DatalogUpdataUtils / DatalogUpdataManager):
 *   POST /newTwoEicAPI.do?op=getDatalogData  { datalogSn }
 *   → obj.datalogWifiFile.wifi-x_version2   = current catalog version for ShineWiFi-X
 *   → obj.datalogWifiFile.wifi-x_1 / _2     = CDN URLs for user1.bin / user2.bin
 *   (deviceModelId "47" = ShineWiFi-X in app; datalogType "16" = web deviceTypeIndicate)
 *
 * Legacy web check (often lags behind the app catalog):
 *   POST /ftp.do action=checkFirmwareVersion { deviceTypeIndicate, firmwareVersion, datalogSn }
 *   Same action also exists as /newTwoEicAPI.do?op=checkFirmwareVersion
 *
 * This module only reads catalog / URLs — it never calls updateFirmware.
 */

/** ShineWiFi-X keys inside datalogWifiFile. */
const SHINE_WIFI_X = {
    versionKey: 'wifi-x_version2',
    baselineKey: 'wifi-x_version',
    user1Key: 'wifi-x_1',
    user2Key: 'wifi-x_2',
    deviceModelId: '47',
};

/**
 * @param {string} v
 * @returns {number[]}
 */
function parseVer(v) {
    return String(v || '0')
        .trim()
        .split('.')
        .map((n) => {
            const x = parseInt(n, 10);
            return Number.isFinite(x) ? x : 0;
        })
        .concat([0, 0, 0, 0])
        .slice(0, 4);
}

/**
 * @param {number[]} parts
 * @returns {string}
 */
function formatVer(parts) {
    const p = [...parts, 0, 0, 0, 0].slice(0, 4);
    return p.join('.');
}

/**
 * Component-wise compare (not Growatt's lexicographic checkFirmware compare).
 * @param {string|number[]} a
 * @param {string|number[]} b
 * @returns {number}
 */
function cmpVer(a, b) {
    const A = Array.isArray(a) ? a : parseVer(a);
    const B = Array.isArray(b) ? b : parseVer(b);
    for (let i = 0; i < 4; i++) {
        const d = (A[i] || 0) - (B[i] || 0);
        if (d) {
            return d;
        }
    }
    return 0;
}

/**
 * @param {any} data
 * @returns {boolean}
 */
function isUpdateOffered(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    return data.success === true || data.success === 'true';
}

/**
 * Pick ShineWiFi-X (or family) fields from datalogWifiFile object.
 * @param {Record<string, any>} wifiFile
 * @param {string|number} [deviceModelId]
 */
function extractWifiCatalog(wifiFile, deviceModelId) {
    const wf = wifiFile && typeof wifiFile === 'object' ? wifiFile : {};
    const id = String(deviceModelId || '');
    // App maps model ids → keys (47=X, 48=S, …). Default ShineWiFi-X.
    let keys = SHINE_WIFI_X;
    if (id === '48') {
        keys = {
            versionKey: 'wifi-s_version2',
            baselineKey: 'wifi-s_version',
            user1Key: 'wifi-s_1',
            user2Key: 'wifi-s_2',
            deviceModelId: '48',
        };
    }
    return {
        deviceModelId: id || keys.deviceModelId,
        catalogVersion: String(wf[keys.versionKey] || '') || null,
        baselineVersion: String(wf[keys.baselineKey] || '') || null,
        user1Url: String(wf[keys.user1Key] || '') || null,
        user2Url: String(wf[keys.user2Key] || '') || null,
        rawWifiFile: wf,
    };
}

/**
 * Isolated Shine firmware helpers on top of an authenticated GrowattShineSession.
 */
class GrowattStickFirmware {
    /**
     * @param {import('./growattShineSession').GrowattShineSession} session
     */
    constructor(session) {
        this.session = session;
    }

    /**
     * ShinePhone catalog: current server FW + CDN bin URLs for a datalogger SN.
     * @param {string} datalogSn
     */
    async getDatalogData(datalogSn) {
        const sn = String(datalogSn || '').trim();
        if (!sn) {
            throw new Error('getDatalogData: datalogSn required');
        }
        const res = await this.session.postForm('/newTwoEicAPI.do?op=getDatalogData', {
            datalogSn: sn,
        });
        if (!res.data || typeof res.data !== 'object') {
            throw new Error(`getDatalogData failed: HTTP ${res.status} ${String(res.data).slice(0, 160)}`);
        }
        if (String(res.data.result) !== '1') {
            throw new Error(`getDatalogData rejected: ${JSON.stringify(res.data).slice(0, 220)}`);
        }
        const obj = res.data.obj || {};
        const catalog = extractWifiCatalog(obj.datalogWifiFile, obj.deviceModelId);
        return {
            sn,
            deviceModel: obj.deviceModel || null,
            deviceModelId: obj.deviceModelId != null ? String(obj.deviceModelId) : null,
            datalogType: obj.datalogType != null ? String(obj.datalogType) : null,
            deviceModelCode: obj.deviceModelCode || null,
            catalogVersion: catalog.catalogVersion,
            baselineVersion: catalog.baselineVersion,
            user1Url: catalog.user1Url,
            user2Url: catalog.user2Url,
            raw: obj,
        };
    }

    /**
     * Legacy portal/app check (does not return the target version string).
     * @param {string|number} deviceTypeIndicate
     * @param {string} firmwareVersion
     * @param {string} datalogSn
     */
    async checkFirmwareVersion(deviceTypeIndicate, firmwareVersion, datalogSn) {
        const res = await this.session.postForm('/newTwoEicAPI.do?op=checkFirmwareVersion', {
            deviceTypeIndicate,
            firmwareVersion,
            datalogSn,
        });
        if (!res.data || typeof res.data !== 'object') {
            // fall back to ftp.do (same payload)
            const res2 = await this.session.postForm('/ftp.do', {
                action: 'checkFirmwareVersion',
                deviceTypeIndicate,
                firmwareVersion,
                datalogSn,
            });
            if (!res2.data || typeof res2.data !== 'object') {
                throw new Error(`checkFirmwareVersion failed: HTTP ${res2.status}`);
            }
            return {
                success: !!isUpdateOffered(res2.data),
                updateAvailable: !!isUpdateOffered(res2.data),
                msg: String(res2.data.msg || ''),
                raw: res2.data,
                via: 'ftp.do',
            };
        }
        return {
            success: !!isUpdateOffered(res.data),
            updateAvailable: !!isUpdateOffered(res.data),
            msg: String(res.data.msg || ''),
            raw: res.data,
            via: 'newTwoEicAPI',
        };
    }

    /**
     * One-shot: stick-reported FW vs ShinePhone catalog (+ optional legacy check).
     * @param {object} loggerRow raw getDatalogList row or {sn, firmwareVersion, deviceTypeIndicate}
     */
    async inspectLogger(loggerRow) {
        const sn = String(loggerRow.sn || loggerRow.datalogSn || loggerRow.dataLogSn || '');
        const stickVersion = String(loggerRow.firmwareVersion || loggerRow.version || '');
        const type =
            loggerRow.deviceTypeIndicate != null
                ? loggerRow.deviceTypeIndicate
                : loggerRow.datalogType != null
                  ? loggerRow.datalogType
                  : loggerRow.deviceType;
        if (!sn) {
            throw new Error('inspectLogger: need sn');
        }

        const app = await this.getDatalogData(sn);
        const stick = stickVersion || null;
        let updateAvailableForStick = null;
        let checkMsg = null;
        if (stick && app.catalogVersion) {
            updateAvailableForStick = cmpVer(stick, app.catalogVersion) < 0;
        }
        if (stick && type != null && type !== '') {
            try {
                const check = await this.checkFirmwareVersion(type, stick, sn);
                checkMsg = check.msg;
                // Prefer explicit catalog compare; keep legacy flag for diagnostics
                if (updateAvailableForStick == null) {
                    updateAvailableForStick = check.updateAvailable;
                }
            } catch (err) {
                checkMsg = `legacy check failed: ${err.message}`;
            }
        }

        let note = null;
        if (stick && app.catalogVersion && cmpVer(stick, app.catalogVersion) === 0) {
            note = 'stick matches ShinePhone catalog (wifi-x_version2)';
        } else if (stick && app.catalogVersion && cmpVer(stick, app.catalogVersion) > 0) {
            note = `stick ${stick} ahead of catalog ${app.catalogVersion}`;
        } else if (stick && app.catalogVersion && cmpVer(stick, app.catalogVersion) < 0) {
            note = `update available: ${stick} → ${app.catalogVersion}`;
        }

        return {
            sn,
            deviceType: loggerRow.deviceType || app.deviceModel || null,
            deviceTypeIndicate: type != null ? String(type) : app.datalogType,
            deviceModelId: app.deviceModelId,
            deviceModelCode: app.deviceModelCode,
            stickVersion: stick,
            catalogVersion: app.catalogVersion,
            baselineVersion: app.baselineVersion,
            user1Url: app.user1Url,
            user2Url: app.user2Url,
            updateAvailableForStick,
            checkMsg,
            note,
            source: 'newTwoEicAPI.getDatalogData',
        };
    }
}

module.exports = {
    GrowattStickFirmware,
    SHINE_WIFI_X,
    parseVer,
    formatVer,
    cmpVer,
    isUpdateOffered,
    extractWifiCatalog,
};
