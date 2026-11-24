'use strict';

const assert = require('assert');
const { resolveCloudTruth, rememberTruthForDevice } = require('../lib/localCalibration');

function mockAdapter() {
    return {
        config: {
            devices: [
                { enabled: true, deviceSn: 'FRJ7CJD0S7', stickSn: 'XGD6CK737N' },
                { enabled: true, deviceSn: 'LABDEVICE01', stickSn: 'XGD6CJH2Y0' },
            ],
        },
        _calibrateTruth: null,
        _calibrateTruthByKey: null,
        _lastSample: { power_w: -999, e_total_kwh: 9999 },
        log: { info() {}, warn() {} },
    };
}

const adapter = mockAdapter();
rememberTruthForDevice(adapter, adapter.config.devices[0], { pac: 169, etotal: 2685.2 });
rememberTruthForDevice(adapter, adapter.config.devices[1], { pac: 1850, etotal: 10004 });

const prod = resolveCloudTruth(adapter, 'XGD6CK737N');
assert.ok(prod);
assert.strictEqual(prod.pac, 169);
assert.ok(Math.abs(prod.etotal - 2685.2) < 1e-9);

const lab = resolveCloudTruth(adapter, 'XGD6CJH2Y0');
assert.ok(lab);
assert.strictEqual(lab.pac, 1850);

const viaDevice = resolveCloudTruth(adapter, 'FRJ7CJD0S7');
assert.ok(viaDevice);
assert.strictEqual(viaDevice.pac, 169);

// Known stick without its own truth must not inherit the other plant
const lonely = mockAdapter();
rememberTruthForDevice(lonely, lonely.config.devices[0], { pac: 169, etotal: 2685.2 });
assert.strictEqual(resolveCloudTruth(lonely, 'XGD6CJH2Y0'), null, 'no cross-plant fallback');

console.log('localCalibrationTruth.test.js OK');
