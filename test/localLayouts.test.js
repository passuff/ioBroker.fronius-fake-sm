'use strict';

const assert = require('assert');
const {
    KNOWN_LAYOUTS,
    normalizeLayout,
    layoutsBySnFromNative,
    primaryLayoutFromNative,
    applyLayoutToNative,
    layoutToStored,
} = require('../lib/localLayouts');
const { applyLayout, bodyAfterSn } = require('../lib/growattRecord');

function testKnownPinWinsOverStaleFlat() {
    const native = {
        localStickSn: 'XGD6CK737N',
        localCalibrated: true,
        // Stale lab-fake offsets (would decode pac=0 on real inverter)
        localPacOffset: 113,
        localPacKind: 'u16',
        localPacScale: 0.1,
        localEtotalOffset: 155,
        localEtotalKind: 'u32',
        localEtotalScale: 0.1,
        localVacOffset: 117,
        localFacOffset: 115,
    };
    const map = layoutsBySnFromNative(native);
    const L = map.get('XGD6CK737N');
    assert.ok(L, 'known SN present');
    assert.strictEqual(L.pacOff, 87, 'known pin beats stale flat pac@113');
    assert.strictEqual(L.pacKind, 'u32');
    assert.strictEqual(L.facOff, 91);
}

function testDevicesLocalLayoutOverridesKnown() {
    const custom = {
        pacOff: 99,
        pacKind: 'u16',
        pacScale: 0.1,
        etotalOff: 155,
        etotalKind: 'u32',
        etotalScale: 0.1,
        vacOff: 117,
        facOff: 91,
    };
    const native = {
        localStickSn: 'XGD6CK737N',
        devices: [{ deviceSn: 'FRJ7CJD0S7', stickSn: 'XGD6CK737N', localLayout: custom }],
    };
    const L = layoutsBySnFromNative(native).get('XGD6CK737N');
    assert.strictEqual(L.pacOff, 99, 'devices[].localLayout wins');
}

function testFlatFillsUnknownPrimary() {
    const native = {
        localStickSn: 'XGD6CJH2Y0',
        localPacOffset: 113,
        localPacKind: 'u16',
        localPacScale: 0.1,
        localEtotalOffset: 155,
        localEtotalKind: 'u32',
        localEtotalScale: 0.1,
        localVacOffset: 117,
        localFacOffset: 115,
    };
    const L = primaryLayoutFromNative(native);
    assert.ok(L);
    assert.strictEqual(L.pacOff, 113);
    assert.strictEqual(L.pacKind, 'u16');
}

function testApplyLayoutToNative() {
    const native = {
        localStickSn: 'XGD6CK737N',
        devices: [{ deviceSn: 'FRJ7CJD0S7', stickSn: 'XGD6CK737N', enabled: true }],
    };
    applyLayoutToNative(native, KNOWN_LAYOUTS.XGD6CK737N, 'XGD6CK737N', {
        primarySn: 'XGD6CK737N',
    });
    assert.strictEqual(native.localPacOffset, 87);
    assert.strictEqual(native.localPacKind, 'u32');
    assert.strictEqual(native.localFacOffset, 91);
    assert.ok(native.localLayouts.XGD6CK737N);
    assert.strictEqual(native.devices[0].localLayout.pacOff, 87);
    assert.deepStrictEqual(layoutToStored(native.localLayouts.XGD6CK737N).pacOff, 87);
}

function testRealRecordDecodesWithKnownLayout() {
    // body[80..179] window from live DIAG04 (peer .38 / XGD6CK737N)
    const win = Buffer.from(
        '00000000000000000006a513890946000c000006b80000000000000000000000000000000009460000000000000000000000000000000006d13b0d0000000200006701000068e400000002000068e4000000000000000000000000000000000000000000',
        'hex',
    );
    const body = Buffer.alloc(180);
    win.copy(body, 80);
    const L = normalizeLayout(KNOWN_LAYOUTS.XGD6CK737N);
    const vals = applyLayout(L, body);
    assert.ok(vals);
    assert.ok(Math.abs(vals.pac_w - 170.1) < 0.05, `pac=${vals.pac_w}`);
    assert.ok(Math.abs(vals.e_total_kwh - 2685.2) < 0.05, `etot=${vals.e_total_kwh}`);
    assert.ok(Math.abs(vals.f - 50.01) < 0.02, `fac=${vals.f}`);
    // bodyAfterSn exists for API stability
    assert.ok(typeof bodyAfterSn === 'function');
}

function testGrowattServerLayoutForSn() {
    const { GrowattServer } = require('../lib/growattServer');
    const server = new GrowattServer({
        layout: null,
        layoutsBySn: new Map([['XGD6CK737N', KNOWN_LAYOUTS.XGD6CK737N]]),
        feedStickSns: ['XGD6CK737N'],
        autoCalibrate: false,
        log: () => {},
        debug: () => {},
        error: () => {},
    });
    assert.strictEqual(server.calibrated, true);
    assert.strictEqual(server.layoutForSn('XGD6CK737N').pacOff, 87);
    assert.strictEqual(server.layoutForSn('XGD6CJH2Y0'), null);
    server.setLayoutForSn('XGD6CJH2Y0', { pacOff: 113, pacKind: 'u16', pacScale: 0.1, etotalOff: 155 });
    assert.strictEqual(server.layoutForSn('XGD6CJH2Y0').pacOff, 113);
    // Lab layout must not clobber prod
    assert.strictEqual(server.layoutForSn('XGD6CK737N').pacOff, 87);
}

testKnownPinWinsOverStaleFlat();
testDevicesLocalLayoutOverridesKnown();
testFlatFillsUnknownPrimary();
testApplyLayoutToNative();
testRealRecordDecodesWithKnownLayout();
testGrowattServerLayoutForSn();
console.log('localLayouts.test.js OK');
