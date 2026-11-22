'use strict';

const assert = require('assert');
const { decodeFrame } = require('../lib/growattProto');
const { buildConfigureFrame, buildRedirectFrames } = require('../lib/growattCommands');
const { previewRedirect } = require('../lib/stickSetup');

const frame = buildConfigureFrame({ sn: 'XGD6CJH2Y0', reg: 17, value: '192.168.1.19' });
const d = decodeFrame(frame);
assert.strictEqual(d.crcOk, true);
assert.strictEqual(d.func, 0x18);
assert.ok(d.payload.includes(Buffer.from('192.168.1.19')));

const frames = buildRedirectFrames('XGD6CJH2Y0', '192.168.1.19', 5279);
assert.strictEqual(frames.length, 2);
assert.strictEqual(decodeFrame(frames[0]).crcOk, true);
assert.strictEqual(decodeFrame(frames[1]).crcOk, true);

const hexes = previewRedirect('XGD6CJH2Y0', '192.168.1.19', 5279);
assert.strictEqual(hexes.length, 2);
assert.ok(/^[0-9a-f]+$/i.test(hexes[0]));

console.log('growattCommands.test.js OK');
