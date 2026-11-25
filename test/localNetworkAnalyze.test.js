'use strict';

const assert = require('assert');
const {
    sameSubnet,
    pickBestHostIp,
    analyzeLocalNetwork,
    hostIpSelectOptions,
    warnPeerSubnetMismatch,
} = require('../lib/localNetworkAnalyze');

(async () => {
    assert.strictEqual(sameSubnet('192.168.1.19', '255.255.255.0', '192.168.1.80'), true);
    assert.strictEqual(sameSubnet('192.168.1.19', '255.255.255.0', '10.0.0.5'), false);

    // single NIC
    const one = pickBestHostIp([{ address: '10.0.0.2', netmask: '255.255.255.0', name: 'eth0' }]);
    assert.strictEqual(one.ip, '10.0.0.2');
    assert.strictEqual(one.ambiguous, false);
    assert.strictEqual(one.reason, 'single');

    // prefer same subnet as Fronius
    const multi = pickBestHostIp(
        [
            { address: '172.17.0.1', netmask: '255.255.0.0', name: 'docker0' },
            { address: '192.168.1.19', netmask: '255.255.255.0', name: 'eth0' },
        ],
        '192.168.1.80',
    );
    assert.strictEqual(multi.ip, '192.168.1.19');
    assert.strictEqual(multi.reason, 'same_subnet');

    // preferred wins
    const pref = pickBestHostIp(
        [
            { address: '192.168.1.19', netmask: '255.255.255.0' },
            { address: '10.0.0.2', netmask: '255.255.255.0' },
        ],
        '192.168.1.80',
        '10.0.0.2',
    );
    assert.strictEqual(pref.ip, '10.0.0.2');
    assert.strictEqual(pref.reason, 'preferred');

    // APIPA only → no ip
    const apipa = pickBestHostIp([{ address: '169.254.1.1', netmask: '255.255.0.0' }]);
    assert.strictEqual(apipa.ip, '');
    assert.strictEqual(apipa.reason, 'no_ipv4');

    // ambiguous first_of_many when no fronius match
    const amb = pickBestHostIp(
        [
            { address: '10.0.0.2', netmask: '255.255.255.0' },
            { address: '192.168.1.19', netmask: '255.255.255.0' },
        ],
        '172.16.0.1',
    );
    assert.strictEqual(amb.ambiguous, true);
    assert.strictEqual(amb.reason, 'first_of_many');

    const analysis = await analyzeLocalNetwork({
        ifaces: [
            { address: '192.168.1.19', netmask: '255.255.255.0', name: 'eth0' },
            { address: '172.17.0.1', netmask: '255.255.0.0', name: 'docker0' },
        ],
        froniusIp: '192.168.1.80',
        port: 5279,
        proxyAlreadyListening: true,
    });
    assert.strictEqual(analysis.ok, true);
    assert.strictEqual(analysis.ip, '192.168.1.19');
    assert.ok(analysis.summary.includes('192.168.1.19:5279'));
    const opts = hostIpSelectOptions(analysis);
    assert.ok(opts.some((o) => o.value === '192.168.1.19' && /empfohlen/.test(o.label)));

    assert.strictEqual(warnPeerSubnetMismatch('192.168.1.19', '192.168.1.38', [
        { address: '192.168.1.19', netmask: '255.255.255.0' },
    ]), null);
    assert.ok(
        /Subnetzen/.test(
            warnPeerSubnetMismatch('192.168.1.19', '10.0.0.5', [
                { address: '192.168.1.19', netmask: '255.255.255.0' },
            ]),
        ),
    );

    console.log('localNetworkAnalyze.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
