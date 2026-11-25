'use strict';

/**
 * Publish frame-health verdict to states (no native writes).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} verdict
 * @param {object} [snap]
 */
async function reportFrameHealth(adapter, verdict, snap) {
    const s = snap || { verdict, text: verdict, wireFuncs: [], samples: [] };
    const feedSn = String(
        (adapter.config && (adapter.config.localStickSn || adapter.config.cloudStickRedirectSn)) || '',
    ).trim();
    const sessionSn = String(s.stickSn || '').trim();
    // Lab / non-feed sticks must not overwrite Fake-SM feed health or lastError.
    if (feedSn && sessionSn && sessionSn !== feedSn) {
        adapter.log.debug(
            `frame health ${verdict} ignored for non-feed SN=${sessionSn} (feed=${feedSn})`,
        );
        return;
    }
    const unknown = verdict === 'unknown_fw' || verdict === 'no_data';
    const text =
        s.text ||
        (verdict === 'ok'
            ? 'ok'
            : verdict === 'no_data'
              ? 'keine Daten-Frames'
              : 'unbekannte Stick-FW');
    const fw = String(adapter._stickFw || '').trim();
    const sn = sessionSn || feedSn;
    const peer = String(s.peerIp || adapter._localPeerIp || '').trim();
    const prev = adapter._lastFrameHealthVerdict;
    if (prev === verdict && adapter._lastFrameHealthText === text) {
        return;
    }
    adapter._lastFrameHealthVerdict = verdict;
    adapter._lastFrameHealthText = text;
    try {
        await adapter.setStateAsync('info.localFrameStatus', { val: text, ack: true });
        await adapter.setStateAsync('info.localFrameUnknown', { val: unknown, ack: true });
    } catch {
        // ignore
    }
    if (!unknown) {
        return;
    }
    const funcs = (s.wireFuncs || []).join('/');
    const who = [sn && `SN ${sn}`, peer && `Peer ${peer}`, fw && `FW ${fw}`].filter(Boolean).join(', ');
    const msg =
        `Lokaler Stick sendet unbekannte Frames (${who || 'unbekannt'}` +
        `${funcs ? `, wire ${funcs}` : ''}) — lokale Auswertung nicht möglich, ` +
        'Cloud-Forward läuft weiter. Capture an Issue anhängen.';
    if (prev !== verdict) {
        adapter.log.warn(msg);
        if (s.samples && s.samples.length) {
            adapter.log.debug(`frame samples: ${s.samples.join(' | ')}`);
        }
    }
    try {
        await adapter.setStateAsync('info.lastError', { val: msg.slice(0, 240), ack: true });
        await adapter.setStateAsync('info.setupStatus', { val: msg.slice(0, 240), ack: true });
    } catch {
        // ignore
    }
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} n
 */
async function publishProxyClientCount(adapter, n) {
    try {
        await adapter.setStateAsync('info.proxyClientCount', { val: Number(n) || 0, ack: true });
    } catch {
        // ignore
    }
}

module.exports = {
    reportFrameHealth,
    publishProxyClientCount,
};
