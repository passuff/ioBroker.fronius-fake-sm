'use strict';

const assert = require('assert');
const { shouldClearSetupBusy } = require('../lib/setupBusyClear');

const empty = {
    shine: { connected: false, plantCount: 0 },
    sticks: [],
    selectedSn: '',
    setup: { canPatch: true, selectedRedirectState: null },
};

assert.strictEqual(shouldClearSetupBusy(null, empty, 'AAA'), false);
assert.strictEqual(shouldClearSetupBusy('patch', empty, 'AAA'), false);

assert.strictEqual(
    shouldClearSetupBusy(
        'patch',
        {
            ...empty,
            sticks: [{ sn: 'GPG0CHF1CT', redirectState: 'verified' }],
            setup: { canPatch: false, selectedRedirectState: 'verified' },
        },
        'GPG0CHF1CT',
    ),
    true,
    'patch busy clears when selected stick is configured in Status',
);

assert.strictEqual(
    shouldClearSetupBusy(
        'patch',
        {
            ...empty,
            sticks: [{ sn: 'XGD6C8737N', redirectState: 'pending' }],
            setup: { canPatch: false, selectedRedirectState: 'pending' },
        },
        'XGD6C8737N',
    ),
    true,
    'patch busy clears for pending redirect too',
);

assert.strictEqual(
    shouldClearSetupBusy(
        'restore',
        {
            ...empty,
            sticks: [{ sn: 'STILLHERE', redirectState: 'verified' }],
        },
        'STILLHERE',
    ),
    false,
);

assert.strictEqual(
    shouldClearSetupBusy('restore', { ...empty, sticks: [] }, 'GONE'),
    true,
    'restore busy clears when stick left the registry',
);

assert.strictEqual(
    shouldClearSetupBusy('connect', { ...empty, shine: { connected: true, plantCount: 0 } }, ''),
    true,
);

assert.strictEqual(shouldClearSetupBusy('connect', empty, ''), false);

console.log('setupBusyClear.test.js OK');
