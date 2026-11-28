'use strict';

const assert = require('assert');
const { encodeFrame } = require('../lib/growattProto');
const { classifyFrame, SessionFrameHealth, isTestedStickFw } = require('../lib/frameHealth');

assert.strictEqual(isTestedStickFw('3.1.0.5'), true);
assert.strictEqual(isTestedStickFw('3.1.1.7'), false);

const classic = encodeFrame({
    proto: 6,
    unit: 1,
    func: 0x04,
    payloadPlain: Buffer.alloc(20, 1),
    txn: 1,
});
const cOk = classifyFrame(classic);
assert.strictEqual(cOk.kind, 'data');
assert.strictEqual(cOk.crcOk, true);

const hex19 =
    '00010006003201190f3e8b74b2f9b09b71547515769253cca3809b8a2dccf82c98012479e87c61bf9452919507e8be5959d366f0eeeef1e1';
const hex16 =
    '0016000600220116ceea71c7a400713a801a0e8348225746c359ff615d444cf18dad1ab4d5a4e517';
const f19 = classifyFrame(Buffer.from(hex19, 'hex'));
const f16 = classifyFrame(Buffer.from(hex16, 'hex'));
// AES-era encrypted control must not be "unknown" (would warn before decrypt)
assert.strictEqual(f19.kind, 'control');
assert.strictEqual(f19.reason, 'control_aes_candidate');
assert.strictEqual(f16.kind, 'control');
assert.strictEqual(f16.reason, 'control_aes_candidate');

const keepalive = Buffer.from('75a600010006004201190f3e', 'hex');
assert.strictEqual(classifyFrame(keepalive).kind, 'control');

const hex41 =
    '00010006005601411f352b41223f4373632b6d7050617373776f7264262a32303234303733302e21' +
    '46706e66f745f5435bb3d5bd31d4e97ab59b6b9ddb3d1cb3593c8213dd52b7d6048d8d27ff161c4f' +
    '3aeee0d7ee85f9f2831da444';
assert.strictEqual(classifyFrame(Buffer.from(hex41, 'hex')).kind, 'control');
assert.strictEqual(classifyFrame(Buffer.from(hex41, 'hex')).reason, 'handshake_0x41');

// Live pattern: 0x22 after 0x41 (bad CRC, no SN) — AES candidate, not unknown
const hex22 =
    '0001000600220122' + 'ceea71c7a400713a801a0e8348225746c359ff615d444cf18dad1ab4d5a4e517';
const f22 = classifyFrame(Buffer.from(hex22, 'hex'));
assert.strictEqual(f22.kind, 'control');
assert.strictEqual(f22.reason, 'control_aes_candidate');
assert.strictEqual(f22.wireFunc, 0x22);

let now = 1_000_000;
// Live 3.1.1.7 handshake: 0x41 + 0x16 stay pending until AES data or timeout
const health = new SessionFrameHealth({ now: () => now, noDataMs: 60_000 });
assert.strictEqual(health.observe(Buffer.from(hex41, 'hex')), 'pending');
assert.strictEqual(health.observe(Buffer.from(hex16, 'hex')), 'pending');
assert.ok(!String(health.snapshot().text || '').includes('unbekannte'));

// Live warn pattern: 0x41 + 0x22 must stay pending (not unknown_fw)
const health22 = new SessionFrameHealth({ now: () => now, noDataMs: 60_000 });
assert.strictEqual(health22.observe(Buffer.from(hex41, 'hex')), 'pending');
assert.strictEqual(health22.observe(Buffer.from(hex22, 'hex')), 'pending');
assert.ok(!String(health22.snapshot().text || '').includes('unbekannte'));

// Live dayrun pattern: encrypted 0x04 after 0x41 must stay pending (not unknown_fw)
// length 0x0022 → 40-byte frame (same size as live 0x16 AES fixture)
const aesPad = 'ceea71c7a400713a801a0e8348225746c359ff615d444cf18dad1ab4d5a4e517';
const hex04aes = '0001000600220104' + aesPad;
const f04aes = classifyFrame(Buffer.from(hex04aes, 'hex'));
assert.strictEqual(f04aes.kind, 'data');
assert.strictEqual(f04aes.reason, 'data_aes_candidate');
assert.strictEqual(f04aes.wireFunc, 0x04);
const hex50aes = '0001000600220150' + aesPad;
const f50aes = classifyFrame(Buffer.from(hex50aes, 'hex'));
assert.strictEqual(f50aes.kind, 'data');
assert.strictEqual(f50aes.reason, 'data_aes_candidate');

const health04 = new SessionFrameHealth({ now: () => now, noDataMs: 60_000 });
assert.strictEqual(health04.observe(Buffer.from(hex41, 'hex')), 'pending');
assert.strictEqual(health04.observe(Buffer.from(hex04aes, 'hex')), 'pending');
assert.ok(!String(health04.snapshot().text || '').includes('unbekannte'));

const healthKeep = new SessionFrameHealth({ now: () => now });
assert.strictEqual(healthKeep.observe(Buffer.from(hex19, 'hex')), 'pending');
assert.strictEqual(
    healthKeep.observe(Buffer.from('75a600010006004201190f3e', 'hex')),
    'pending',
);

const health2 = new SessionFrameHealth({ now: () => now });
health2.observe(Buffer.from(hex19, 'hex'));
health2.observe(Buffer.from(hex16, 'hex'));
assert.strictEqual(health2.observe(classic), 'ok');

// True unknown (non-data/non-control wire func, bad CRC, no SN) still trips unknown_fw
const junk28 = '0001000600220128' + aesPad;
const healthJunk = new SessionFrameHealth({ now: () => now });
assert.strictEqual(classifyFrame(Buffer.from(junk28, 'hex')).kind, 'unknown');
assert.strictEqual(healthJunk.observe(Buffer.from(junk28, 'hex')), 'pending');
assert.strictEqual(healthJunk.observe(Buffer.from(junk28, 'hex')), 'unknown_fw');

now = 1_000_000;
const health3 = new SessionFrameHealth({ now: () => now, noDataMs: 1000 });
health3.observe(keepalive);
now = 1_000_000 + 2000;
assert.strictEqual(health3.checkTimeout(), 'no_data');

console.log('frameHealth.test.js OK');
