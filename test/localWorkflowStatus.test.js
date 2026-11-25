'use strict';

const assert = require('assert');
const {
    buildLocalWorkflowStatus,
    buildStickConfiguredLabel,
    buildLocalConnectedLabel,
    publishLocalWorkflowStatus,
    buildLocalWorkflowSnapshot,
} = require('../lib/localWorkflowStatus');

(async () => {
    assert.strictEqual(
        buildLocalWorkflowStatus({ localSetupPending: false, localSetupVerified: false, localEnabled: false }, false),
        'Einrichtung: noch nicht · Verbindung: nein · Lokal: aus',
    );
    assert.strictEqual(
        buildLocalWorkflowStatus({ localSetupPending: true, localSetupVerified: false, localEnabled: false }, false),
        'Einrichtung: umgeleitet, warte auf Stick · Verbindung: nein · Lokal: aus',
    );
    assert.strictEqual(
        buildLocalWorkflowStatus({ localSetupPending: false, localSetupVerified: true, localEnabled: true }, true),
        'Einrichtung: erledigt · Verbindung: ja · Lokal: an',
    );
    assert.strictEqual(buildStickConfiguredLabel({}), 'nicht konfiguriert');
    assert.strictEqual(buildStickConfiguredLabel({ localSetupPending: true }), 'umgeleitet – warte auf Stick');
    assert.strictEqual(buildStickConfiguredLabel({ localSetupVerified: true }), 'konfiguriert');
    assert.strictEqual(
        buildStickConfiguredLabel({ cloudStickRedirectActive: true }),
        'umgeleitet auf diesen Host',
    );
    assert.strictEqual(buildStickConfiguredLabel({ _liveTarget: 'hier' }), 'umgeleitet auf diesen Host');
    assert.strictEqual(buildLocalConnectedLabel(false), 'nicht hergestellt');
    assert.strictEqual(buildLocalConnectedLabel(true), 'hergestellt');

    const states = {};
    const adapter = {
        config: { localSetupPending: true, localSetupVerified: false, localEnabled: false },
        _localConnected: false,
        localServer: null,
        setStateAsync: async (id, st) => {
            states[id] = st.val;
        },
    };
    const text = await publishLocalWorkflowStatus(adapter, { connected: false });
    assert.ok(text.includes('umgeleitet'));
    assert.strictEqual(states['info.localWorkflowStatus'], text);
    assert.strictEqual(states['info.wfStickConfigured'], 'umgeleitet – warte auf Stick');
    assert.strictEqual(states['info.wfLocalConnected'], 'nicht hergestellt');
    assert.strictEqual(adapter._localConnected, false);

    await publishLocalWorkflowStatus(adapter, { connected: true });
    assert.ok(states['info.localWorkflowStatus'].includes('Verbindung: ja'));
    assert.strictEqual(states['info.wfLocalConnected'], 'hergestellt');

    const snapAdapter = {
        config: {
            localStickSn: 'XGD6CK737N',
            localPort: 5279,
            localForwardCloud: true,
            stickRedirects: {
                XGD6CK737N: { state: 'verified', plantName: 'PV-Spielhaus', serverIp: '192.168.1.19' },
                XGD6CJH2Y0: { state: 'pending', plantName: 'Lab' },
            },
        },
        localServer: {
            listening: true,
            _clients: new Set([{ stickSn: 'XGD6CJH2Y0' }]),
        },
        _localFrameStatus: 'ok',
    };
    // hasStickSession checks server helpers — stub via null clients uses clientCount/hasStickSession
    const snap = buildLocalWorkflowSnapshot(snapAdapter, {
        selectedSn: 'XGD6CK737N',
        shine: { connected: true, plantCount: 2 },
        frameStatus: 'ok',
    });
    assert.strictEqual(snap.shine.connected, true);
    assert.strictEqual(snap.shine.plantCount, 2);
    assert.strictEqual(snap.proxy.listening, true);
    assert.strictEqual(snap.proxy.forward, true);
    assert.strictEqual(snap.proxy.frameStatus, 'ok');
    assert.strictEqual(snap.proxy.port, 5279);
    assert.strictEqual(snap.selectedSn, 'XGD6CK737N');
    assert.strictEqual(snap.setup.canPatch, false);
    assert.strictEqual(snap.setup.canRestore, true);
    assert.ok(Array.isArray(snap.sticks));
    assert.strictEqual(snap.sticks.length, 2);
    assert.ok(snap.sticks.every((s) => s.sn && s.redirectState));

    const emptySnap = buildLocalWorkflowSnapshot({
        config: { localStickSn: 'NEWSN' },
        localServer: null,
    });
    assert.strictEqual(emptySnap.setup.canPatch, true);
    assert.strictEqual(emptySnap.setup.canRestore, false);
    assert.strictEqual(emptySnap.sticks.length, 0);

    console.log('localWorkflowStatus.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
