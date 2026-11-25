'use strict';

const assert = require('assert');
const {
    getStickEntry,
    upsertStick,
    removeStick,
    listRedirectedSns,
    listSnsByState,
    deriveAggregateFlags,
    migrateLegacyFlags,
    needsLegacyMigration,
    configuredLabelFromEntry,
} = require('../lib/stickRedirectRegistry');

(async () => {
    // empty
    assert.deepStrictEqual(deriveAggregateFlags({}), {
        localSetupVerified: false,
        localSetupPending: false,
        cloudStickRedirectActive: false,
        cloudStickRedirectSn: '',
    });
    assert.strictEqual(getStickEntry({}, 'X'), null);
    assert.strictEqual(configuredLabelFromEntry(null), 'nicht konfiguriert');

    // upsert + aggregate
    const cfg = { stickRedirects: {} };
    upsertStick(cfg, 'AAA', { state: 'pending', plantId: '1' });
    assert.strictEqual(cfg.localSetupPending, true);
    assert.strictEqual(cfg.localSetupVerified, false);
    assert.strictEqual(cfg.cloudStickRedirectActive, true);
    assert.strictEqual(cfg.cloudStickRedirectSn, 'AAA');
    assert.strictEqual(configuredLabelFromEntry(getStickEntry(cfg, 'AAA')), 'umgeleitet – warte auf Stick');

    upsertStick(cfg, 'BBB', { state: 'verified' });
    assert.strictEqual(cfg.localSetupVerified, true);
    assert.strictEqual(cfg.localSetupPending, true); // AAA still pending
    assert.deepStrictEqual(listRedirectedSns(cfg), ['AAA', 'BBB']);
    assert.deepStrictEqual(listSnsByState(cfg, 'verified'), ['BBB']);
    assert.strictEqual(configuredLabelFromEntry(getStickEntry(cfg, 'BBB')), 'konfiguriert');

    // remove one stick — other remains
    assert.strictEqual(removeStick(cfg, 'AAA'), true);
    assert.strictEqual(cfg.localSetupPending, false);
    assert.strictEqual(cfg.localSetupVerified, true);
    assert.strictEqual(cfg.cloudStickRedirectSn, 'BBB');
    assert.strictEqual(getStickEntry(cfg, 'AAA'), null);

    removeStick(cfg, 'BBB');
    assert.strictEqual(cfg.cloudStickRedirectActive, false);
    assert.strictEqual(cfg.localSetupVerified, false);

    // legacy migration verified
    const legacy = {
        localSetupVerified: true,
        localSetupPending: false,
        cloudStickRedirectActive: true,
        cloudStickRedirectSn: 'R2D8CX727W',
        localStickSn: 'R2D8CX727W',
        localPlantId: '100',
        advertisedModbusIp: '192.168.1.19',
    };
    assert.strictEqual(needsLegacyMigration(legacy), true);
    assert.strictEqual(migrateLegacyFlags(legacy), true);
    assert.strictEqual(getStickEntry(legacy, 'R2D8CX727W').state, 'verified');
    assert.strictEqual(legacy.localSetupVerified, true);
    assert.strictEqual(needsLegacyMigration(legacy), false);
    assert.strictEqual(migrateLegacyFlags(legacy), false);

    // legacy pending
    const pend = {
        localSetupPending: true,
        localStickSn: 'GPGDC4F1CT',
    };
    assert.strictEqual(migrateLegacyFlags(pend), true);
    assert.strictEqual(getStickEntry(pend, 'GPGDC4F1CT').state, 'pending');

    // legacy redirected only
    const red = {
        cloudStickRedirectActive: true,
        cloudStickRedirectSn: 'ONLYSN',
    };
    assert.strictEqual(migrateLegacyFlags(red), true);
    assert.strictEqual(getStickEntry(red, 'ONLYSN').state, 'redirected');
    assert.strictEqual(configuredLabelFromEntry(getStickEntry(red, 'ONLYSN')), 'umgeleitet auf diesen Host');

    // flags without SN → leave alone (cannot seed registry)
    const nosn = { localSetupVerified: true };
    assert.strictEqual(migrateLegacyFlags(nosn), false);
    assert.strictEqual(nosn.localSetupVerified, true);

    console.log('stickRedirectRegistry.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
