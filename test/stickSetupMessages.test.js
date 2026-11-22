'use strict';

const assert = require('assert');
const { MSG } = require('../lib/stickSetup');

assert.ok(MSG.offline.includes('Growatt') || MSG.offline.includes('Stick'));
assert.ok(MSG.offline.includes('Hintergrund') || MSG.offline.includes('grün'));
assert.ok(MSG.needPassword.includes('Passwort'));
assert.ok(!MSG.offline.includes('no_ap_stick'));
assert.ok(MSG.online('XGD', '1.2.3.4').includes('XGD'));
assert.ok(MSG.offlineBlocked.includes('wartet') || MSG.offlineBlocked.includes('grün'));
const { onlineLabel } = require('../lib/stickOnline');
assert.strictEqual(onlineLabel(true), 'WR verbunden');
assert.strictEqual(onlineLabel(false), 'WR nicht verbunden');

console.log('stickSetupMessages.test.js OK');
