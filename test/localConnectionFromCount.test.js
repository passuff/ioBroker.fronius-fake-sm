'use strict';

const assert = require('assert');
const { publishLocalConnectionFromCount } = require('../lib/frameHealthReport');

(async () => {
    const states = {};
    const adapter = {
        setStateAsync: async (id, obj) => {
            states[id] = obj && obj.val;
        },
    };
    await publishLocalConnectionFromCount(adapter, 1);
    assert.strictEqual(states['info.localConnection'], true);
    await publishLocalConnectionFromCount(adapter, 0);
    assert.strictEqual(states['info.localConnection'], false);
    console.log('localConnectionFromCount.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
