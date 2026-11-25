'use strict';

const assert = require('assert');
const {
    isLocalProxyRedirect,
    looksLikeServerHost,
    stickRedirectLabel,
    enrichDevicesWithStickRedirect,
    probeSticksForPlants,
} = require('../lib/cloudStickRedirect');

(async () => {
    assert.strictEqual(isLocalProxyRedirect(''), false);
    assert.strictEqual(isLocalProxyRedirect(null), false);
    assert.strictEqual(isLocalProxyRedirect('server.growatt.com'), false);
    assert.strictEqual(isLocalProxyRedirect('SERVER.GROWATT.COM'), false);
    assert.strictEqual(isLocalProxyRedirect('https://server.growatt.com'), false);
    assert.strictEqual(isLocalProxyRedirect('inv_set_c'), false);
    assert.strictEqual(looksLikeServerHost('inv_set_c'), false);
    assert.strictEqual(looksLikeServerHost('192.168.1.19'), true);
    assert.strictEqual(isLocalProxyRedirect('inv_set_datalog_lost'), false);
    assert.strictEqual(isLocalProxyRedirect('error_frequently_access'), false);
    assert.strictEqual(isLocalProxyRedirect('192.168.1.19'), true);
    assert.strictEqual(isLocalProxyRedirect('192.168.1.19', '192.168.1.19'), true);
    assert.strictEqual(isLocalProxyRedirect('10.0.0.5', '192.168.1.19'), true);
    assert.strictEqual(isLocalProxyRedirect('proxy.lan.local'), true);

    assert.strictEqual(stickRedirectLabel(false, 'server.growatt.com'), 'Growatt-Cloud');
    assert.strictEqual(stickRedirectLabel(false, ''), 'Growatt-Cloud');
    assert.strictEqual(stickRedirectLabel(true, '192.168.1.19'), 'Umleitung aktiv (192.168.1.19)');
    assert.strictEqual(stickRedirectLabel(true, ''), 'Umleitung aktiv');
    assert.strictEqual(stickRedirectLabel(true, 'inv_set_datalog_lost'), 'Umleitung aktiv');
    assert.strictEqual(
        stickRedirectLabel(true, 'inv_set_datalog_lost', { offline: true }),
        'Umleitung aktiv (Stick offline)',
    );
    assert.strictEqual(
        stickRedirectLabel(true, '192.168.1.19', { offline: true }),
        'Umleitung aktiv (zuletzt 192.168.1.19)',
    );

    const rows = [
        { plantId: '1', deviceSn: 'A' },
        { plantId: '2', deviceSn: 'B' },
        { plantId: '1', deviceSn: 'C' },
    ];
    const byPlant = new Map([
        ['1', { stickSn: 'XGD1', stickServerIp: '192.168.1.19', stickRedirected: true, probeLive: true }],
        ['2', { stickSn: 'XGD2', stickServerIp: 'server.growatt.com', stickRedirected: false, probeLive: true }],
    ]);
    enrichDevicesWithStickRedirect(rows, byPlant);
    assert.strictEqual(rows[0].stickSn, 'XGD1');
    assert.ok(rows[0].stickRedirectLabel.includes('Umleitung aktiv'));
    assert.strictEqual(rows[0].stickRedirected, true);
    assert.strictEqual(rows[1].stickSn, 'XGD2');
    assert.ok(rows[1].stickRedirectLabel.includes('Growatt-Cloud'));
    assert.strictEqual(rows[2].stickSn, 'XGD1');

    // OpenAPI stick pairing must not be replaced by plant's preferred stick
    const paired = [
        {
            plantId: '1',
            deviceSn: 'WR1',
            stickSn: 'XGD_PROD',
            stickRedirected: false,
        },
    ];
    const byStick = new Map([
        [
            'XGD_PROD',
            {
                stickSn: 'XGD_PROD',
                stickServerIp: 'server.growatt.com',
                stickRedirected: false,
                probeLive: true,
            },
        ],
        [
            'XGD_LAB',
            {
                stickSn: 'XGD_LAB',
                stickServerIp: '192.168.1.19',
                stickRedirected: true,
                probeLive: true,
            },
        ],
    ]);
    enrichDevicesWithStickRedirect(
        paired,
        new Map([['1', byStick.get('XGD_LAB')]]),
        byStick,
    );
    assert.strictEqual(paired[0].stickSn, 'XGD_PROD');
    assert.strictEqual(paired[0].stickRedirected, false);

    const emptyRows = [{ plantId: '9', deviceSn: 'Z' }];
    enrichDevicesWithStickRedirect(emptyRows, new Map());
    assert.strictEqual(emptyRows[0].stickSn, '—');
    assert.strictEqual(emptyRows[0].stickRedirectLabel, '—');

    const session = {
        listDataloggers: async (plantId) => {
            if (plantId === 'p1') {
                return [{ sn: 'STICK1' }, { sn: 'STICK_LAB' }];
            }
            return [];
        },
        getRegister: async (sn) => {
            if (sn === 'STICK_LAB') {
                return { msg: '192.168.1.19' };
            }
            return { msg: 'server.growatt.com' };
        },
    };
    const probed = await probeSticksForPlants(session, ['p1', 'p2'], '192.168.1.19');
    assert.strictEqual(probed.anyRedirected, true);
    assert.strictEqual(probed.redirectSn, 'STICK_LAB');
    assert.strictEqual(probed.byPlant.get('p1').stickSn, 'STICK_LAB');
    assert.strictEqual(probed.byStick.get('STICK1').stickRedirected, false);
    assert.strictEqual(probed.byStick.get('STICK_LAB').stickRedirected, true);

    const sessionCloud = {
        listDataloggers: async () => [{ sn: 'STICK2' }],
        getRegister: async () => ({ msg: 'server.growatt.com' }),
    };
    const probedCloud = await probeSticksForPlants(sessionCloud, ['p3'], '');
    assert.strictEqual(probedCloud.anyRedirected, false);
    assert.strictEqual(probedCloud.byPlant.get('p3').stickRedirected, false);
    assert.strictEqual(probedCloud.byPlant.get('p3').probeLive, true);

    const sessionOffline = {
        listDataloggers: async () => [{ sn: 'STICK3' }],
        getRegister: async () => ({ msg: 'inv_set_c' }),
    };
    const probedOff = await probeSticksForPlants(sessionOffline, ['p4'], '192.168.1.19');
    assert.strictEqual(probedOff.anyRedirected, false);
    assert.strictEqual(probedOff.byPlant.get('p4').probeLive, false);

    const offlineRows = [
        {
            plantId: 'p4',
            deviceSn: 'A',
            stickRedirected: true,
            stickServerIp: '192.168.1.19',
            stickRedirectLabel: '⚠ Umleitung → 192.168.1.19',
        },
    ];
    enrichDevicesWithStickRedirect(offlineRows, probedOff.byPlant);
    assert.strictEqual(offlineRows[0].stickRedirected, true);
    assert.ok(offlineRows[0].stickRedirectLabel.includes('Umleitung aktiv'));
    assert.ok(offlineRows[0].stickRedirectLabel.includes('192.168.1.19'));
    assert.ok(!offlineRows[0].stickRedirectLabel.includes('inv_set'));

    console.log('cloudStickRedirect.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
