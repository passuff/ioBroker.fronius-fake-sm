'use strict';

const assert = require('assert');
const { GrowattShineSession, LOGGER_REG, LOGGER_FN } = require('../lib/growattShineSession');

assert.strictEqual(LOGGER_REG.SERVERIP, 17);
assert.strictEqual(LOGGER_REG.SERVERPORT, 18);
assert.strictEqual(LOGGER_FN.REGISTER, 0);

const s = new GrowattShineSession({ user: 'u', password: 'p' });
assert.strictEqual(s.md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
assert.strictEqual(s.md5('test'), '098f6bcd4621d373cade4e832627b4f6');

console.log('growattShineSession.test.js OK');
