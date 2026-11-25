'use strict';

const assert = require('assert');
const {
    assertLabFotaTarget,
    requireLabFotaTarget,
    isFotaCommandMeta,
    DEFAULT_PROD_BLOCK,
} = require('../lib/growattFotaGuard');
const {
    buildHttpServerBlob,
    cdnUrlToHttpServerBlob,
    buildFotaHttpServerFrame,
    buildFotaParamSetFrames,
    buildFotaTypeFrame,
    FOTA_HTTPSERVER_REG,
} = require('../lib/growattFotaFrames');
const { decodeFrame } = require('../lib/growattProto');

const LAB = 'XGDLABTEST01';
const PROD = 'XGD6CK737N';
const guard = { labStickSns: [LAB], env: {} };

assert.ok(DEFAULT_PROD_BLOCK.includes(PROD));

assert.strictEqual(assertLabFotaTarget(PROD, guard).ok, false);
assert.strictEqual(assertLabFotaTarget(LAB, { env: {} }).ok, false, 'no allowlist');
assert.strictEqual(assertLabFotaTarget(LAB, guard).ok, true);

assert.throws(() => requireLabFotaTarget(PROD, guard), /production blocklist|FOTA blocked/);
assert.doesNotThrow(() => requireLabFotaTarget(LAB, guard));

assert.strictEqual(isFotaCommandMeta({ func: 0x06 }), true);
assert.strictEqual(isFotaCommandMeta({ func: 0x18, reg: FOTA_HTTPSERVER_REG }), true);
assert.strictEqual(isFotaCommandMeta({ func: 0x18, reg: 17 }), false);

const blob = buildHttpServerBlob({
    host: '192.168.1.10',
    path: '/fw/user1.bin',
    port: 80,
});
assert.strictEqual(blob, '##192.168.1.10/fw/user1.bin/#80#');

const fromCdn = cdnUrlToHttpServerBlob(
    'http://cdn.growatt.com/update/device/GB/autoUpgrade/e6b2/f16b5/1a2051/3.1.1.7/user1.bin',
);
assert.ok(fromCdn.blob.startsWith('##cdn.growatt.com/update/'));
assert.ok(fromCdn.blob.endsWith('/#80#'));

assert.throws(() => buildFotaHttpServerFrame({ sn: PROD, httpServerBlob: blob, labGuard: guard }));

const frame = buildFotaHttpServerFrame({
    sn: LAB,
    httpServerBlob: blob,
    labGuard: guard,
});
const dec = decodeFrame(frame);
assert.strictEqual(dec.func, 0x18);
assert.ok(dec.crcOk);
assert.ok(dec.payload.includes(Buffer.from(blob, 'ascii')));

const params = buildFotaParamSetFrames({ sn: LAB, host: '10.0.0.2', path: '/a.bin', labGuard: guard });
assert.strictEqual(params.length, 1);

const typ = buildFotaTypeFrame({ sn: LAB, labGuard: guard });
const typDec = decodeFrame(typ);
assert.strictEqual(typDec.func, 0x06);
assert.ok(typDec.payload.toString('ascii').includes('Datalog_CycleFota_ON'));

assert.throws(() =>
    buildFotaTypeFrame({ sn: LAB, type: 'remote_debug_flasherasechip', labGuard: guard }),
);

console.log('growattFotaGuard.test.js OK');
