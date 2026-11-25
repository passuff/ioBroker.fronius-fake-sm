'use strict';

const assert = require('assert');
const { MSG } = require('../lib/stickMessages');
const { pickBestHostIp } = require('../lib/localNetworkAnalyze');

/**
 * Mirrors the gate in runStickSetup: ambiguous without preferred-from-candidates → block.
 * @param {object} analysis
 * @param {string} preferred
 */
function shouldBlockAmbiguousSetup(analysis, preferred) {
    const pref = String(preferred || '').trim();
    const preferredOk = pref && (analysis.candidates || []).includes(pref);
    return !!(analysis.ambiguous && !preferredOk);
}

(async () => {
    const ifaces = [
        { address: '10.0.0.2', netmask: '255.255.255.0' },
        { address: '192.168.1.19', netmask: '255.255.255.0' },
    ];
    const amb = pickBestHostIp(ifaces, '172.16.0.1');
    assert.strictEqual(amb.ambiguous, true);
    assert.strictEqual(shouldBlockAmbiguousSetup(amb, ''), true);
    assert.strictEqual(shouldBlockAmbiguousSetup(amb, '8.8.8.8'), true, 'preferred not in candidates');
    assert.strictEqual(shouldBlockAmbiguousSetup(amb, '192.168.1.19'), false);

    const single = pickBestHostIp([{ address: '192.168.1.19', netmask: '255.255.255.0' }]);
    assert.strictEqual(shouldBlockAmbiguousSetup(single, ''), false);

    assert.ok(MSG.ambiguousIps.includes('LAN-IPs'));
    assert.ok(MSG.restoreBeforeCloud.includes('Umleitung entfernen'));

    console.log('ambiguousSetupBlock.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
