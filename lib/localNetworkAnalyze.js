'use strict';

const net = require('net');
const { localIpv4Infos, ipv4ToInt } = require('./froniusDiscover');

const DEFAULT_LOCAL_PORT = 5279;

/**
 * @param {string} ip
 * @param {string} netmask
 * @param {string} otherIp
 */
function sameSubnet(ip, netmask, otherIp) {
    if (!ip || !netmask || !otherIp) {
        return false;
    }
    const mask = ipv4ToInt(netmask);
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(otherIp) & mask);
}

/**
 * @param {{address:string,netmask:string,name?:string}[]} ifaces
 * @param {string} [peerIp] e.g. Fronius IP — prefer matching subnet
 * @param {string} [preferredIp] already chosen / form value
 */
function pickBestHostIp(ifaces, peerIp, preferredIp) {
    const usable = (ifaces || []).filter((i) => i && i.address && !String(i.address).startsWith('169.254.'));
    if (!usable.length) {
        return { ip: '', ambiguous: false, reason: 'no_ipv4', candidates: [] };
    }
    const candidates = usable.map((i) => i.address);
    const pref = String(preferredIp || '').trim();
    if (pref && candidates.includes(pref)) {
        return { ip: pref, ambiguous: candidates.length > 1, reason: 'preferred', candidates, iface: usable.find((i) => i.address === pref) };
    }
    if (peerIp) {
        const match = usable.find((i) => sameSubnet(i.address, i.netmask, peerIp));
        if (match) {
            return {
                ip: match.address,
                ambiguous: usable.filter((i) => sameSubnet(i.address, i.netmask, peerIp)).length > 1,
                reason: 'same_subnet',
                candidates,
                iface: match,
            };
        }
    }
    if (usable.length === 1) {
        return { ip: usable[0].address, ambiguous: false, reason: 'single', candidates, iface: usable[0] };
    }
    return {
        ip: usable[0].address,
        ambiguous: true,
        reason: 'first_of_many',
        candidates,
        iface: usable[0],
    };
}

/**
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<{ok:boolean, listening?:boolean, error?:string}>}
 */
function probeListenPort(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err && (err.code === 'EADDRINUSE' || /EADDRINUSE/i.test(err.message))) {
                // Port already in use — our proxy may already own it (OK for setup)
                resolve({ ok: true, listening: true, error: err.code || err.message });
                return;
            }
            resolve({ ok: false, listening: false, error: err.message || String(err) });
        });
        server.listen(port, host, () => {
            server.close(() => resolve({ ok: true, listening: false }));
        });
    });
}

/**
 * @param {object} [opts]
 * @param {{address:string,netmask:string,name?:string}[]} [opts.ifaces] inject for tests
 * @param {string} [opts.froniusIp]
 * @param {string} [opts.preferredIp]
 * @param {number} [opts.port]
 * @param {boolean} [opts.proxyAlreadyListening]
 * @param {() => Promise<{ok:boolean,listening?:boolean,error?:string}>} [opts.probePortFn]
 */
async function analyzeLocalNetwork(opts = {}) {
    const port = Number(opts.port ?? DEFAULT_LOCAL_PORT);
    const ifaces = opts.ifaces || localIpv4Infos();
    const pick = pickBestHostIp(ifaces, opts.froniusIp, opts.preferredIp);
    let portProbe = { ok: true, listening: !!opts.proxyAlreadyListening };
    if (!opts.proxyAlreadyListening) {
        portProbe = opts.probePortFn
            ? await opts.probePortFn()
            : await probeListenPort(port);
    }

    const warnings = [];
    if (!pick.ip) {
        warnings.push('Keine nutzbare LAN-IPv4 gefunden (nur APIPA/internal?).');
    }
    if (pick.ambiguous) {
        warnings.push(
            `Mehrere LAN-IPs (${pick.candidates.join(', ')}). Bitte die richtige Host-IP wählen — sonst schreibt Setup die falsche Adresse in den Stick.`,
        );
    }
    if (pick.reason === 'first_of_many' && opts.froniusIp) {
        warnings.push(
            `Keine Host-IP im Subnetz von Fronius ${opts.froniusIp} — Routing/VLAN prüfen oder IP manuell wählen.`,
        );
    }
    if (!portProbe.ok) {
        warnings.push(`Port ${port} nicht bindbar: ${portProbe.error || 'unbekannt'}`);
    } else if (portProbe.listening) {
        warnings.push(`Port ${port} ist bereits belegt (Proxy läuft vermutlich schon) — OK für Setup.`);
    }

    const summaryParts = [];
    if (pick.ip) {
        summaryParts.push(`Ziel für Stick: ${pick.ip}:${port}`);
        if (pick.reason === 'same_subnet' && opts.froniusIp) {
            summaryParts.push(`(gleiches Subnetz wie Fronius ${opts.froniusIp})`);
        }
    }
    if (warnings.length) {
        summaryParts.push(warnings[0]);
    }

    return {
        ok: !!pick.ip && portProbe.ok,
        ip: pick.ip,
        port,
        reason: pick.reason,
        ambiguous: !!pick.ambiguous,
        candidates: pick.candidates || [],
        ifaces: ifaces.map((i) => ({ address: i.address, netmask: i.netmask, name: i.name || '' })),
        froniusIp: opts.froniusIp || '',
        portOk: !!portProbe.ok,
        portListening: !!portProbe.listening,
        warnings,
        summary: summaryParts.join(' — ') || 'Netzwerkanalyse ohne Ergebnis',
    };
}

/**
 * Admin selectSendTo options for host IP.
 * @param {object} analysis from analyzeLocalNetwork
 */
function hostIpSelectOptions(analysis) {
    const list = (analysis && analysis.candidates) || [];
    return list.map((ip) => ({
        value: ip,
        label: ip === (analysis && analysis.ip) ? `${ip} (empfohlen)` : ip,
        noTranslation: true,
    }));
}

/**
 * After stick TCP connect: warn if peer subnet ≠ server IP subnet.
 * @param {string} serverIp
 * @param {string} peerIp
 * @param {{address:string,netmask:string}[]} [ifaces]
 */
function warnPeerSubnetMismatch(serverIp, peerIp, ifaces) {
    const list = ifaces || localIpv4Infos();
    const iface = list.find((i) => i.address === serverIp);
    if (!iface || !peerIp) {
        return null;
    }
    if (sameSubnet(serverIp, iface.netmask, peerIp)) {
        return null;
    }
    return `Stick ${peerIp} und Server-IP ${serverIp} liegen in unterschiedlichen Subnetzen — Routing/VLAN prüfen.`;
}

module.exports = {
    DEFAULT_LOCAL_PORT,
    sameSubnet,
    pickBestHostIp,
    probeListenPort,
    analyzeLocalNetwork,
    hostIpSelectOptions,
    warnPeerSubnetMismatch,
};
