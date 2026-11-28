'use strict';

const assert = require('assert');
const { reportFrameHealth } = require('../lib/frameHealthReport');
const { buildFeedSelectionPatch } = require('../lib/localProxyMode');
const { deriveAggregateFlags, migrateLegacyFlags } = require('../lib/stickRedirectRegistry');

(async () => {
    const states = {};
    const logs = [];
    const adapter = {
        config: { localStickSn: 'XGD6CK737N' },
        _localPeerIp: '192.168.1.200',
        log: {
            warn(m) {
                logs.push(m);
            },
            debug() {},
        },
        async setStateAsync(id, obj) {
            states[id] = obj && obj.val;
        },
    };

    await reportFrameHealth(adapter, 'unknown_fw', {
        verdict: 'unknown_fw',
        text: 'unbekannte Stick-FW',
        wireFuncs: ['0x41', '0x16'],
        samples: [],
        stickSn: 'XGD6CJH2Y0',
        peerIp: '192.168.1.200',
    });
    assert.strictEqual(states['info.lastError'], undefined);
    assert.strictEqual(logs.length, 0);

    await reportFrameHealth(adapter, 'unknown_fw', {
        verdict: 'unknown_fw',
        text: 'unbekannte Stick-FW',
        wireFuncs: ['0x41'],
        samples: [],
        stickSn: 'XGD6CK737N',
        peerIp: '192.168.1.38',
    });
    assert.ok(String(states['info.lastError'] || '').includes('XGD6CK737N'));
    assert.strictEqual(states['info.localFrameUnknown'], true);

    // Feed unknown → ok must clear frame lastError
    await reportFrameHealth(adapter, 'ok', {
        verdict: 'ok',
        text: 'ok',
        wireFuncs: [],
        samples: [],
        stickSn: 'XGD6CK737N',
        peerIp: '192.168.1.38',
    });
    assert.strictEqual(states['info.lastError'], '');
    assert.strictEqual(states['info.setupStatus'], '');
    assert.strictEqual(states['info.localFrameUnknown'], false);
    assert.strictEqual(states['info.localFrameStatus'], 'ok');

    // devices feed ≠ localStickSn: session on mis-pointed localStickSn must not warn
    const mismatchStates = {
        'info.lastError':
            'Lokaler Stick sendet unbekannte Frames (SN GPG0CHF1CT, Peer 192.168.1.171, wire 0x28) — stale',
    };
    const mismatchLogs = [];
    const mismatch = {
        config: {
            localStickSn: 'GPG0CHF1CT',
            cloudStickRedirectSn: 'GPG0CHF1CT',
            devices: [{ enabled: true, stickSn: 'XGD6CK737N', inverterSn: 'FRJ7CJD0S7' }],
        },
        _frameHealthLastErrorText: mismatchStates['info.lastError'],
        log: {
            warn(m) {
                mismatchLogs.push(m);
            },
            debug() {},
        },
        async setStateAsync(id, obj) {
            mismatchStates[id] = obj && obj.val;
        },
        async getStateAsync(id) {
            return { val: mismatchStates[id] };
        },
    };
    await reportFrameHealth(mismatch, 'unknown_fw', {
        verdict: 'unknown_fw',
        text: 'unbekannte Stick-FW',
        wireFuncs: ['0x28'],
        samples: [],
        stickSn: 'GPG0CHF1CT',
        peerIp: '192.168.1.50',
    });
    assert.strictEqual(mismatchStates['info.lastError'], '');
    assert.strictEqual(mismatchLogs.length, 0);

    await reportFrameHealth(mismatch, 'unknown_fw', {
        verdict: 'unknown_fw',
        text: 'unbekannte Stick-FW',
        wireFuncs: ['0x16'],
        samples: [],
        stickSn: 'XGD6CK737N',
        peerIp: '192.168.1.38',
    });
    assert.ok(String(mismatchStates['info.lastError'] || '').includes('XGD6CK737N'));
    assert.ok(mismatchLogs.length >= 1);

    const patch = buildFeedSelectionPatch(mismatch.config);
    assert.ok(patch);
    assert.strictEqual(patch.localStickSn, 'XGD6CK737N');
    assert.strictEqual(patch.cloudStickRedirectSn, undefined);
    assert.strictEqual(
        buildFeedSelectionPatch({
            localStickSn: 'XGD6CK737N',
            cloudStickRedirectSn: 'GPG0CHF1CT',
            devices: [{ enabled: true, stickSn: 'XGD6CK737N' }],
        }),
        null,
        'cloudStickRedirectSn alone must not trigger sync (migrate owns it)',
    );

    // Lab multi-redirect: sync + migrate must not ping-pong cloudStickRedirectSn
    const lab = {
        localStickSn: 'XGD6CK737N',
        cloudStickRedirectSn: 'GPG0CHF1CT',
        devices: [{ enabled: true, stickSn: 'XGD6CK737N', inverterSn: 'FRJ7CJD0S7' }],
        stickRedirects: {
            GPG0CHF1CT: { state: 'verified' },
            XGD6CK737N: { state: 'verified', plantName: 'PV-Spielhaus' },
            XGD6CJH2Y0: { state: 'pending' },
        },
    };
    assert.strictEqual(buildFeedSelectionPatch(lab), null);
    const derived = deriveAggregateFlags(lab);
    assert.strictEqual(derived.cloudStickRedirectSn, 'XGD6CK737N');
    // First migrate may sync aggregate flags (verified/pending); cloud must stay feed SN
    assert.strictEqual(migrateLegacyFlags(lab), true);
    assert.strictEqual(lab.cloudStickRedirectSn, 'XGD6CK737N');
    assert.strictEqual(migrateLegacyFlags(lab), false, 'second migrate must be no-op');
    assert.strictEqual(lab.cloudStickRedirectSn, 'XGD6CK737N');
    // Even if cloud is wrongly GPG0, derive prefers local/devices feed — no alpha ping-pong
    lab.cloudStickRedirectSn = 'GPG0CHF1CT';
    assert.strictEqual(deriveAggregateFlags(lab).cloudStickRedirectSn, 'XGD6CK737N');
    assert.strictEqual(buildFeedSelectionPatch(lab), null);

    console.log('frameHealthFeedGate.test.js ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
