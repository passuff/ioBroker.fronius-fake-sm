'use strict';

const assert = require('assert');
const { MSG } = require('../lib/stickMessages');
const {
    stableStatusText,
    applyStickStatusToNative,
    persistStickOnlineFlag,
} = require('../lib/stickOnlineState');
const stickOnline = require('../lib/stickOnline');

function fakeAdapter(native) {
    const calls = { objectWrites: [], states: {} };
    const adapter = {
        namespace: 'fronius-fake-sm.0',
        config: { ...native },
        log: { warn: () => {}, info: () => {}, debug: () => {} },
        getForeignObjectAsync: async () => ({ native: { ...native } }),
        setForeignObjectAsync: async (_id, obj) => {
            calls.objectWrites.push(obj);
            Object.assign(native, obj.native);
        },
        setStateAsync: async (id, state) => {
            calls.states[id] = state.val;
        },
    };
    return { adapter, calls };
}

(async () => {
    assert.strictEqual(stickOnline.MSG, MSG);
    assert.strictEqual(stickOnline.persistStickOnlineFlag, persistStickOnlineFlag);

    const withStamp = MSG.onlineList('XGD6CK737N', '2026-11-22 13:59:04');
    assert.strictEqual(stableStatusText(withStamp), MSG.onlineList('XGD6CK737N', ''));
    assert.strictEqual(stableStatusText(MSG.offline), MSG.offline);
    assert.strictEqual(stableStatusText(null), '');

    const native = {
        stickCloudOnline: true,
        stickOnlineLabel: MSG.labelOnline,
        localStickSn: 'XGD6CK737N',
        localPlantId: '10053900',
        stickStatusText: 'alt',
    };
    const { adapter, calls } = fakeAdapter(native);

    // Routine online checks: states only, never native (avoids restart loop)
    await persistStickOnlineFlag(adapter, true, {
        localStickSn: 'XGD6CK737N',
        localPlantId: '10053900',
        stickStatusText: MSG.onlineList('XGD6CK737N', '2026-11-22 14:00:05'),
    });
    await persistStickOnlineFlag(adapter, true, {
        localStickSn: 'XGD6CK737N',
        localPlantId: '10053900',
        stickStatusText: MSG.onlineList('XGD6CK737N', '2026-11-22 14:01:05'),
    });
    assert.strictEqual(calls.objectWrites.length, 0, 'unchanged selection must not write native');
    assert.strictEqual(calls.states['info.stickOnline'], true);

    // Online → offline must NOT write native (night flip must not restart)
    await persistStickOnlineFlag(adapter, false, { stickStatusText: MSG.offline });
    assert.strictEqual(calls.objectWrites.length, 0, 'online flip must not write native');
    assert.strictEqual(adapter.config.stickCloudOnline, false);
    assert.strictEqual(calls.states['info.stickOnline'], false);
    assert.strictEqual(native.stickCloudOnline, true, 'native online flag stays until setup/restore');

    await persistStickOnlineFlag(adapter, true, {
        localStickSn: 'XGD6CK737N',
        stickStatusText: MSG.onlineList('XGD6CK737N', '2026-11-23 08:10:00'),
    });
    assert.strictEqual(calls.objectWrites.length, 0);
    assert.strictEqual(adapter.config.stickCloudOnline, true);

    // Newly selected stick is persisted
    await persistStickOnlineFlag(adapter, true, { localStickSn: 'NEWSTICK01', stickStatusText: 'x' });
    assert.strictEqual(calls.objectWrites.length, 1);
    assert.strictEqual(native.localStickSn, 'NEWSTICK01');
    assert.strictEqual(adapter.config.localStickSn, 'NEWSTICK01');

    // Mid-setup: selection change must stay in-memory (native write would restart & abort redirect)
    const mid = {
        stickCloudOnline: false,
        stickOnlineLabel: MSG.labelOffline,
        localStickSn: 'OLD',
    };
    const midFake = fakeAdapter(mid);
    midFake.adapter._setupInProgress = true;
    await persistStickOnlineFlag(midFake.adapter, true, {
        localStickSn: 'GPG0CHF1CT',
        stickStatusText: 'Setze Server…',
    });
    assert.strictEqual(midFake.calls.objectWrites.length, 0, 'setup must not write stickOnlineStatus native');
    assert.strictEqual(midFake.adapter.config.localStickSn, 'GPG0CHF1CT');
    assert.strictEqual(mid.localStickSn, 'OLD', 'native object unchanged during setup');

    const n = { stickCloudOnline: false, stickOnlineLabel: MSG.labelOffline, localStickSn: 'A', localPlantId: '1' };
    assert.strictEqual(applyStickStatusToNative(n, false, MSG.labelOffline, { localPlantId: undefined }), false);
    assert.strictEqual(n.localStickSn, 'A');
    assert.strictEqual(n.localPlantId, '1');

    console.log('stickOnlineState.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
