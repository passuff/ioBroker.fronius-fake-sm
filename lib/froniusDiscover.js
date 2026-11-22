'use strict';

const dns = require('dns').promises;
const http = require('http');
const os = require('os');
const { URL } = require('url');

/**
 * Discover Fronius inverters on local IPv4 subnets via Solar API.
 */

const LOCATION_LABEL = {
    0: 'grid',
    1: 'load',
    3: 'extgen',
};

function localIpv4Infos() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const info of ifaces[name] || []) {
            if (info.family !== 'IPv4' || info.internal) {
                continue;
            }
            out.push({ address: info.address, netmask: info.netmask, name });
        }
    }
    return out;
}

function ipv4ToInt(ip) {
    return ip.split('.').reduce((a, o) => (a << 8) + (Number(o) & 255), 0) >>> 0;
}

function intToIpv4(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * /24 hosts for each local interface (skip .0 / .255). Cap total candidates.
 * @param {number} [maxHosts]
 */
function candidateHosts(maxHosts = 512) {
    const hosts = [];
    const seen = new Set();
    for (const info of localIpv4Infos()) {
        const ip = ipv4ToInt(info.address);
        const mask = ipv4ToInt(info.netmask);
        const network = ip & mask;
        const broadcast = network | (~mask >>> 0);
        const start = Math.max(network + 1, (ip & 0xffffff00) + 1);
        const end = Math.min(broadcast - 1, (ip & 0xffffff00) + 254);
        for (let n = start; n <= end; n++) {
            const h = intToIpv4(n);
            if (h === info.address || seen.has(h)) {
                continue;
            }
            seen.add(h);
            hosts.push(h);
            if (hosts.length >= maxHosts) {
                return hosts;
            }
        }
    }
    return hosts;
}

function httpGetJson(url, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const req = http.request(
            u,
            {
                method: 'GET',
                timeout: timeoutMs,
                headers: { Accept: 'application/json', Connection: 'close' },
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve({ status: res.statusCode || 0, body: JSON.parse(text) });
                    } catch {
                        reject(new Error('non-JSON'));
                    }
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.end();
    });
}

function decodeHtmlEntities(s) {
    return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Parse GetMeterRealtimeData Scope=System body into location map.
 * @param {object} body
 * @returns {{ count: number, locations: number[], summary: string }}
 */
function parseMeterRealtime(body) {
    const data = (body && body.Body && body.Body.Data) || {};
    const locations = [];
    const parts = [];
    for (const [id, row] of Object.entries(data)) {
        if (!row || typeof row !== 'object') {
            continue;
        }
        const locRaw = row.Meter_Location_Current ?? row.Meter_Location;
        const loc = Number(locRaw);
        if (Number.isFinite(loc)) {
            locations.push(loc);
            const label = LOCATION_LABEL[loc] || String(loc);
            parts.push(`${id}:${label}`);
        } else {
            locations.push(Number(id));
            parts.push(String(id));
        }
    }
    return {
        count: Object.keys(data).length,
        locations,
        summary: parts.join(','),
    };
}

/**
 * Suggest Location prefer 3, else first free in 1..4 not used by Meter_Location_Current.
 * @param {number[]} usedLocations
 */
function suggestMeterLocation(usedLocations) {
    const used = new Set((usedLocations || []).map((n) => Number(n)).filter((n) => Number.isFinite(n)));
    if (!used.has(3)) {
        return 3;
    }
    return [1, 2, 3, 4].find((n) => !used.has(n)) || 3;
}

/**
 * Format count for admin table: "1 (Loc 0:grid)" or "0".
 * @param {number} count
 * @param {string} summary
 */
function formatExistingMeters(count, summary) {
    if (!count) {
        return '0';
    }
    if (summary) {
        return `${count} (Loc ${summary})`;
    }
    return String(count);
}

async function reverseHostname(ip) {
    try {
        const names = await dns.reverse(ip);
        if (Array.isArray(names) && names[0]) {
            return String(names[0]).replace(/\.$/, '');
        }
    } catch {
        // no PTR
    }
    return '';
}

async function probeFronius(ip) {
    const base = `http://${ip}`;
    let apiVersion = null;
    try {
        const r = await httpGetJson(`${base}/solar_api/GetAPIVersion.cgi`);
        apiVersion = r.body;
    } catch {
        try {
            const r = await httpGetJson(`${base}/solar_api/v1/GetAPIVersion.cgi`);
            apiVersion = r.body;
        } catch {
            return null;
        }
    }

    const apiVer = apiVersion && (apiVersion.APIVersion || apiVersion.Version || '');
    if (apiVer === '' && !(apiVersion && apiVersion.CompatibilityRange)) {
        return null;
    }

    let serial = '';
    let model = '';
    let hostname = '';
    let meterCount = 0;
    let meterSummary = '';
    let usedLocations = [];
    let hasInverterDetail = false;

    try {
        const info = await httpGetJson(`${base}/solar_api/v1/GetActiveDeviceInfo.cgi?DeviceClass=System`);
        const data = (info.body && info.body.Body && info.body.Body.Data) || {};
        const inv = data.Inverter || {};
        const firstInv = Object.values(inv)[0];
        if (firstInv && typeof firstInv === 'object') {
            serial = String(firstInv.Serial || firstInv.serial || '');
            hasInverterDetail = true;
        }
        const meter = data.Meter || {};
        if (Object.keys(meter).length && !meterCount) {
            meterCount = Object.keys(meter).length;
        }
    } catch {
        // optional
    }

    try {
        const meterInfo = await httpGetJson(`${base}/solar_api/v1/GetActiveDeviceInfo.cgi?DeviceClass=Meter`);
        const data = (meterInfo.body && meterInfo.body.Body && meterInfo.body.Body.Data) || {};
        const n = Object.keys(data).length;
        if (n > meterCount) {
            meterCount = n;
        }
    } catch {
        // optional
    }

    try {
        const rt = await httpGetJson(`${base}/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`);
        const parsed = parseMeterRealtime(rt.body);
        if (parsed.count > 0) {
            meterCount = Math.max(meterCount, parsed.count);
            meterSummary = parsed.summary;
            usedLocations = parsed.locations;
        }
    } catch {
        // optional / not available on some firmwares
    }

    try {
        const inv = await httpGetJson(`${base}/solar_api/v1/GetInverterInfo.cgi`);
        const data = (inv.body && inv.body.Body && inv.body.Body.Data) || {};
        const first = Object.values(data)[0];
        if (first && typeof first === 'object') {
            hasInverterDetail = true;
            model = decodeHtmlEntities(first.CustomName || first.DeviceType || first.DT || model || '');
            if (!serial) {
                serial = String(first.UniqueID || first.Serial || '');
            }
        }
    } catch {
        // optional
    }

    // Datamanager / Hybrid: LoggerInfo may have hostname; GEN24 usually errors.
    try {
        const common = await httpGetJson(`${base}/solar_api/v1/GetLoggerInfo.cgi`);
        const d = common.body && common.body.Body && common.body.Body.LoggerInfo;
        if (d) {
            hasInverterDetail = true;
            hostname = String(d.Hostname || d.HostName || '');
            if (!serial) {
                serial = String(d.UniqueIdentifier || d.SerialNumber || '');
            }
        }
    } catch {
        // optional
    }

    if (!hostname) {
        hostname = await reverseHostname(ip);
    }

    if (!hasInverterDetail && !serial) {
        return null;
    }

    const suggestedLocation = suggestMeterLocation(usedLocations);

    return {
        enabled: false,
        ip,
        serial,
        model: model || (apiVersion && apiVersion.CompatibilityRange) || 'Fronius',
        hostname,
        apiVersion: apiVer,
        existingMeters: formatExistingMeters(meterCount, meterSummary),
        meterCount,
        meterLocations: meterSummary,
        suggestedLocation,
        suggestedModbusPort: 502,
        // Gen24 secondary meter Modbus address range is 2–14 (1 = primary)
        suggestedUnitId: 3,
    };
}

/**
 * Parallel probe with concurrency limit.
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.concurrency]
 * @param {string[]} [opts.extraHosts] always probe these first (e.g. known IP)
 */
async function discoverFroniusOnLan(opts = {}) {
    const log = opts.log || (() => {});
    const concurrency = Math.max(1, Number(opts.concurrency || 40));
    const extras = Array.isArray(opts.extraHosts) ? opts.extraHosts : [];
    const hosts = [...new Set([...extras.filter(Boolean), ...candidateHosts()])];
    log(`Fronius scan: ${hosts.length} host(s)`);

    const found = [];
    let idx = 0;

    async function worker() {
        while (idx < hosts.length) {
            const i = idx++;
            const ip = hosts[i];
            try {
                const hit = await probeFronius(ip);
                if (hit) {
                    found.push(hit);
                    log(`Fronius at ${ip} (${hit.serial || hit.hostname || hit.model})`);
                }
            } catch {
                // ignore
            }
        }
    }

    const workers = [];
    for (let w = 0; w < concurrency; w++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
    return found;
}

/**
 * Local IPs the Gen24 should use as Fake-SM host (exclude APIPA).
 */
function advertisedListenIps() {
    return localIpv4Infos()
        .map((i) => i.address)
        .filter((a) => !a.startsWith('169.254.'));
}

module.exports = {
    discoverFroniusOnLan,
    probeFronius,
    advertisedListenIps,
    candidateHosts,
    parseMeterRealtime,
    suggestMeterLocation,
    formatExistingMeters,
    httpGetJson,
};
