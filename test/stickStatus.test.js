'use strict';

const assert = require('assert');
const { deriveStickStatus } = require('../lib/stickStatus');

const snapOffline = deriveStickStatus({
    listOnline: false,
    localConnected: false,
    cfg: {},
});
assert.strictEqual(snapOffline.online, false);
assert.strictEqual(snapOffline.target, 'unknown');
assert.ok(snapOffline.text.startsWith('offline'));

const snapShine = deriveStickStatus({
    listOnline: true,
    lastUpdate: '2026-11-23 09:13:03',
    serverIp: 'server.growatt.com',
    probeLive: true,
    localConnected: false,
    advertisedIp: '192.168.1.19',
    cfg: {},
});
assert.strictEqual(snapShine.online, true);
assert.strictEqual(snapShine.target, 'cloud');
assert.ok(snapShine.text.includes('Growatt-Cloud'));
assert.ok(snapShine.text.includes('09:13:03'));

const snapLocal = deriveStickStatus({
    listOnline: true,
    lastUpdate: '2026-11-23 09:13:03',
    serverIp: '192.168.1.19',
    probeLive: true,
    localConnected: true,
    advertisedIp: '192.168.1.19',
    cfg: { localForwardCloud: true, cloudStickRedirectActive: true },
});
assert.strictEqual(snapLocal.online, true);
assert.strictEqual(snapLocal.target, 'hier');
assert.strictEqual(snapLocal.targetLabel, 'hier (192.168.1.19)');
assert.ok(snapLocal.text.includes('zeigt auf 192.168.1.19'));
assert.ok(snapLocal.text.includes('Cloud-Forward'));
assert.strictEqual(snapLocal.configured, 'umgeleitet auf diesen Host');

const snapProxyOnly = deriveStickStatus({
    listOnline: false,
    localConnected: true,
    advertisedIp: '192.168.1.19',
    cfg: { cloudStickRedirectActive: true },
});
assert.strictEqual(snapProxyOnly.online, true);
assert.strictEqual(snapProxyOnly.target, 'hier');
assert.ok(snapProxyOnly.text.includes('lokal am Proxy'));

console.log('stickStatus.test.js OK');
