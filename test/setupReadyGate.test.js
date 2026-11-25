'use strict';

const assert = require('assert');
const { MSG } = require('../lib/stickMessages');
const { isSetupReady, buildOnlineStatusText } = require('../lib/stickOnline');

(async () => {
    // List online alone must NOT unlock Setup (the screenshot mismatch)
    assert.strictEqual(isSetupReady(true, false), false);
    assert.strictEqual(isSetupReady(false, false), false);
    assert.strictEqual(isSetupReady(null, false), false);
    assert.strictEqual(isSetupReady(true, true), true);
    assert.strictEqual(isSetupReady(null, true), true);
    assert.strictEqual(isSetupReady(false, true), true);

    const notReady = buildOnlineStatusText('XGD6CK737N', true, false, '', '2026-11-22 15:00:00');
    assert.ok(notReady.includes('Remote-Befehl'));
    assert.ok(notReady.includes('XGD6CK737N'));
    assert.ok(!notReady.includes('Server-IP'));

    const ready = buildOnlineStatusText('XGD6CK737N', true, true, '192.168.1.19', '2026-11-22 15:00:00');
    assert.ok(ready.includes('Shine'));
    assert.ok(ready.includes('192.168.1.19'));

    const offline = buildOnlineStatusText('XGD6CK737N', false, false, '', '');
    assert.strictEqual(offline, MSG.offline);

    assert.ok(MSG.remoteNotReady('ABC', '').includes('gesperrt'));

    console.log('setupReadyGate.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
