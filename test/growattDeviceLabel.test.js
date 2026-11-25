'use strict';

const assert = require('assert');
const {
    isLikelyProductName,
    isJunkLabel,
    collectLabelCandidates,
    pickDeviceTypeLabel,
    labelFromDevicePayload,
    aliasLabel,
} = require('../lib/growattDeviceLabel');

assert.strictEqual(isLikelyProductName('min'), false);
assert.strictEqual(isLikelyProductName('tlx'), false);
assert.strictEqual(isLikelyProductName('S3EB08D00T00P0'), false);
assert.strictEqual(isLikelyProductName('GH1.0'), false);
assert.strictEqual(isJunkLabel('GH1.0'), true);
assert.strictEqual(isLikelyProductName('MIC 600TL-X'), true);
assert.strictEqual(isLikelyProductName('MIN 2500TL-XH'), true);
assert.strictEqual(isLikelyProductName('MOD 10KTL3-XH'), true);
assert.strictEqual(isLikelyProductName('ShinePano - XGD6CK737N'), false);

assert.strictEqual(
    pickDeviceTypeLabel(['GH1.0', 'S3EB08D00T00P0', '1', 'min']),
    '',
);
assert.strictEqual(pickDeviceTypeLabel(['GH1.0', 'MIC 600TL-X']), 'MIC 600TL-X');

assert.strictEqual(
    labelFromDevicePayload({
        model: 'S3EB08D00T00P0',
        machineVersion: 'GH1.0',
        type: 1,
        alias: 'ShinePano - XGD6CK737N',
        deviceType: 'min',
    }),
    '',
);

assert.strictEqual(
    labelFromDevicePayload({
        productName: 'MIC 600TL-X',
        machineVersion: 'GH1.0',
        model: 'S3EB08D00T00P0',
    }),
    'MIC 600TL-X',
);

assert.ok(!collectLabelCandidates({ machineVersion: 'GH1.0', model: 'S3EB08D00T00P0' }).includes('GH1.0'));

assert.strictEqual(aliasLabel('FRJ7CJD0S7', { deviceSn: 'FRJ7CJD0S7' }), '');
assert.strictEqual(aliasLabel('Spielhaus Ost', { deviceSn: 'FRJ7CJD0S7' }), 'Spielhaus Ost');
assert.strictEqual(aliasLabel('ShinePano - XGD6CK737N', { deviceSn: 'FRJ7CJD0S7', stickSn: 'XGD6CK737N' }), '');
assert.strictEqual(aliasLabel('', { deviceSn: 'FRJ7CJD0S7' }), '');

// DTC series labels count as identifiable product-family text for UI.
assert.strictEqual(isLikelyProductName('MIC/MIN TL-X'), true);

console.log('growattDeviceLabel.test.js OK');
