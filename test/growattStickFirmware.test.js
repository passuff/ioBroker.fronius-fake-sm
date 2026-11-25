'use strict';

const assert = require('assert');
const {
    parseVer,
    formatVer,
    cmpVer,
    isUpdateOffered,
    extractWifiCatalog,
} = require('../lib/growattStickFirmware');

assert.deepStrictEqual(parseVer('3.1.1.7'), [3, 1, 1, 7]);
assert.strictEqual(formatVer([3, 1, 0, 5]), '3.1.0.5');
assert.ok(cmpVer('3.1.0.5', '3.1.1.7') < 0);
assert.ok(cmpVer('3.1.1.7', '3.1.0.5') > 0);
assert.strictEqual(cmpVer('3.1.0.5', '3.1.0.5'), 0);
assert.strictEqual(isUpdateOffered({ success: true, msg: 'find new version' }), true);
assert.strictEqual(isUpdateOffered({ success: false, msg: 'not find new version' }), false);

const cat = extractWifiCatalog(
    {
        'wifi-x_version2': '3.1.1.7',
        'wifi-x_version': '3.1.0.2',
        'wifi-x_1': 'http://cdn.example/user1.bin',
        'wifi-x_2': 'http://cdn.example/user2.bin',
    },
    '47',
);
assert.strictEqual(cat.catalogVersion, '3.1.1.7');
assert.strictEqual(cat.baselineVersion, '3.1.0.2');
assert.ok(cat.user1Url.includes('user1.bin'));

console.log('growattStickFirmware.test.js OK');
