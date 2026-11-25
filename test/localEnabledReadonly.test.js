'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const io = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'io-package.json'), 'utf8'));
const obj = (io.instanceObjects || []).find((o) => o && o._id === 'info.localEnabled');
assert.ok(obj, 'info.localEnabled object missing');
assert.strictEqual(obj.common.write, false, 'info.localEnabled must be read-only');
assert.strictEqual(obj.common.read, true);

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert.ok(!main.includes("subscribeStatesAsync('info.localEnabled')"), 'must not subscribe localEnabled');
assert.ok(!main.includes("subscribeStates('info.localEnabled')"), 'must not subscribe localEnabled');
assert.ok(!/info\.localEnabled/.test(main) || !/onStateChange[\s\S]*localEnabled/.test(main), 'must not toggle localEnabled via stateChange');
assert.ok(!main.includes('setLocalEnabled'), 'main must not import setLocalEnabled for switch');

console.log('localEnabledReadonly.test.js OK');
