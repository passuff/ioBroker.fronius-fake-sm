'use strict';

const assert = require('assert');
const { reportFrameHealth } = require('../lib/frameHealthReport');

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

    console.log('frameHealthFeedGate.test.js ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
