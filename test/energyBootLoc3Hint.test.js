'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loc3SetupHint } = require('../lib/energyBoot');
const { loc3SetupHint: fromHealth } = require('../lib/gen24MeterHealth');

const cfg = {
    advertisedModbusIp: '192.168.1.19',
    modbusUnitId: 3,
    fakeUniqueId: 3,
};

const hint = loc3SetupHint(cfg);
assert.strictEqual(hint, fromHealth(cfg, 3));
assert.ok(hint.includes('IP=192.168.1.19'));
assert.ok(hint.includes('unit=3'));
assert.ok(hint.includes('Loc3'));
assert.ok(loc3SetupHint({ fakeUniqueId: 3 }).includes('this host'));

const timeoutMsg = `Energy continuity: no Gen24 Modbus client within timeout — trying Solar API anyway${hint}`;
const failMsg = `Energy continuity: Gen24 truth unavailable (no Loc3 in Solar API)${hint}`;
assert.ok(timeoutMsg.includes('192.168.1.19'));
assert.ok(failMsg.includes('set Gen24 Loc3 meter IP=192.168.1.19'));

// Source must append loc3SetupHint on timeout and seed failure paths
const src = fs.readFileSync(path.join(__dirname, '../lib/energyBoot.js'), 'utf8');
assert.ok(src.includes('loc3SetupHint'));
assert.ok(src.includes('no Gen24 Modbus client within timeout'));
assert.ok(src.includes('Gen24 truth unavailable'));
assert.ok(
    /no Gen24 Modbus client within timeout[\s\S]{0,200}\$\{hint\}/.test(src) ||
        /trying Solar API anyway\$\{hint\}/.test(src),
);
assert.ok(/Gen24 truth unavailable[\s\S]{0,120}\$\{hint\}/.test(src));

console.log('energyBootLoc3Hint.test.js ok');
