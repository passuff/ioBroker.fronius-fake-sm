'use strict';

const assert = require('assert');
const { resolveStickSn, MSG } = require('../lib/stickOnline');

(async () => {
    const empty = await resolveStickSn({ config: { localStickSn: '' } });
    assert.strictEqual(empty, '');

    const onlyStateWouldHaveBeenIgnored = await resolveStickSn({
        config: { localStickSn: '' },
        getStateAsync: async () => ({ val: 'XGD6CJH2Y0' }),
    });
    assert.strictEqual(onlyStateWouldHaveBeenIgnored, '', 'must not autopick info.stickSn');

    const selected = await resolveStickSn({ config: { localStickSn: 'XGD6CK737N' } });
    assert.strictEqual(selected, 'XGD6CK737N');

    const fromForm = await resolveStickSn(
        { config: { localStickSn: 'XGD6CJH2Y0' } },
        null,
        { localStickSn: 'XGD6CK737N' },
    );
    assert.strictEqual(fromForm, 'XGD6CK737N', 'Admin form SN must win over stale native');

    assert.ok(MSG.needPassword.includes('verbinden') || MSG.needPassword.includes('wählen'));
    assert.ok(MSG.waitingStick.includes('Lokal') || MSG.waitingStick.includes('Stick'));
    assert.ok(MSG.permissionDenied('XGD').includes('wählen'));
    assert.ok(MSG.onlineList('XGD6CK737N', '2026-11-22').includes('Shine'));

    console.log('localStickSelect.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
