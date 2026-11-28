'use strict';

const { computeFeedStickSns, isFeedSn } = require('./localProxyMode');

const FRAME_UNKNOWN_MARK = 'Lokaler Stick sendet unbekannte Frames';

/**
 * @param {string} text
 * @returns {boolean}
 */
function isFrameUnknownLastError(text) {
    return String(text || '').includes(FRAME_UNKNOWN_MARK);
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @returns {Promise<string>}
 */
async function readLastErrorText(adapter) {
    if (adapter && adapter._frameHealthLastErrorText != null) {
        return String(adapter._frameHealthLastErrorText);
    }
    try {
        if (adapter && typeof adapter.getStateAsync === 'function') {
            const st = await adapter.getStateAsync('info.lastError');
            return st && st.val != null ? String(st.val) : '';
        }
    } catch {
        // ignore
    }
    return '';
}

/**
 * Clear frame-unknown lastError / setupStatus (not unrelated errors).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 */
async function clearFrameUnknownLastError(adapter) {
    if (adapter) {
        adapter._frameHealthLastErrorText = '';
    }
    try {
        await adapter.setStateAsync('info.lastError', { val: '', ack: true });
        await adapter.setStateAsync('info.setupStatus', { val: '', ack: true });
    } catch {
        // ignore
    }
}

/**
 * Publish frame-health verdict to states (no native writes).
 * Feed SNs = enabled devices[].stickSn (see computeFeedStickSns); proxy-only
 * redirects must not overwrite Fake-SM health / lastError.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} verdict
 * @param {object} [snap]
 */
async function reportFrameHealth(adapter, verdict, snap) {
    const s = snap || { verdict, text: verdict, wireFuncs: [], samples: [] };
    const cfg = (adapter && adapter.config) || {};
    const feedSns = computeFeedStickSns(cfg);
    const feedSn =
        feedSns[0] ||
        String(cfg.localStickSn || cfg.cloudStickRedirectSn || '').trim();
    const sessionSn = String(s.stickSn || '').trim();
    if (sessionSn && feedSns.length && !isFeedSn(feedSns, sessionSn)) {
        adapter.log.debug(
            `frame health ${verdict} ignored for non-feed SN=${sessionSn} (feed=${feedSns.join(',')})`,
        );
        // Drop stale Fake-SM lastError that still names this proxy-only stick.
        const cur = await readLastErrorText(adapter);
        if (isFrameUnknownLastError(cur) && cur.includes(sessionSn)) {
            await clearFrameUnknownLastError(adapter);
        }
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
        const cur = await readLastErrorText(adapter);
        if (isFrameUnknownLastError(cur)) {
            await clearFrameUnknownLastError(adapter);
        }
        return;
    }
    const funcs = (s.wireFuncs || []).join('/');
    const who = [sn && `SN ${sn}`, peer && `Peer ${peer}`, fw && `FW ${fw}`].filter(Boolean).join(', ');
    const msg =
        `${FRAME_UNKNOWN_MARK} (${who || 'unbekannt'}` +
        `${funcs ? `, wire ${funcs}` : ''}) — lokale Auswertung nicht möglich, ` +
        'Cloud-Forward läuft weiter. Capture an Issue anhängen.';
    if (prev !== verdict) {
        adapter.log.warn(msg);
        if (s.samples && s.samples.length) {
            adapter.log.debug(`frame samples: ${s.samples.join(' | ')}`);
        }
    }
    const clipped = msg.slice(0, 240);
    adapter._frameHealthLastErrorText = clipped;
    try {
        await adapter.setStateAsync('info.lastError', { val: clipped, ack: true });
        await adapter.setStateAsync('info.setupStatus', { val: clipped, ack: true });
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

/**
 * Keep info.localConnection aligned with proxy TCP client count.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {number} n
 */
async function publishLocalConnectionFromCount(adapter, n) {
    try {
        await adapter.setStateAsync('info.localConnection', {
            val: Number(n) > 0,
            ack: true,
        });
    } catch {
        // ignore
    }
}

module.exports = {
    reportFrameHealth,
    publishProxyClientCount,
    publishLocalConnectionFromCount,
    isFrameUnknownLastError,
    clearFrameUnknownLastError,
};
