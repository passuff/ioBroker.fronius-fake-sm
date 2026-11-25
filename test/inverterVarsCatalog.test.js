'use strict';

const assert = require('assert');
const {
    listCatalog,
    defaultInverterVarsConfig,
    mergeInverterVarsConfig,
    familyMatches,
    normalizeFamily,
    pickCloudValue,
    effectiveIntervalS,
    getCatalogEntry,
    resolveApiType,
} = require('../lib/inverterVarsCatalog');
const { parseSettingStateId } = require('../lib/inverterVarsStates');
const {
    buildReadHoldingFrame,
    buildWriteSingleHoldingFrame,
} = require('../lib/growattInverterModbus');
const { decodeFrame } = require('../lib/growattProto');

assert.ok(listCatalog().length >= 15, 'catalog should have read+write entries');
assert.ok(listCatalog('tlx').some((e) => e.id === 'pac'));
assert.ok(listCatalog('tlx').some((e) => e.id === 'activePowerRate'));
assert.ok(!listCatalog('inv').some((e) => e.id === 'soc'), 'classic inv has no SOC');

assert.strictEqual(normalizeFamily('TLXH'), 'tlx');
assert.strictEqual(normalizeFamily('shine'), 'tlx');
assert.ok(familyMatches('min', getCatalogEntry('pac')));

const defaults = defaultInverterVarsConfig();
assert.ok(defaults.some((r) => r.id === 'pac' && r.enabled));
assert.ok(defaults.some((r) => r.id === 'onOff' && !r.enabled));

const merged = mergeInverterVarsConfig([
    { id: 'pac', enabled: false, intervalS: 200 },
    { id: 'unknown', enabled: true },
]);
assert.ok(!merged.some((r) => r.id === 'unknown'));
const pac = merged.find((r) => r.id === 'pac');
assert.strictEqual(pac.enabled, false);
assert.strictEqual(pac.intervalS, 200);

assert.strictEqual(pickCloudValue({ pac: 12, ppv: 3 }, ['ppv', 'pac']), 3);
assert.strictEqual(pickCloudValue({ pac: 12 }, ['ppv', 'pac']), 12);

const entry = getCatalogEntry('pac');
assert.ok(effectiveIntervalS(entry, 10, 'openapi') >= 90);
assert.ok(effectiveIntervalS(entry, 10, 'shine') >= 30);
assert.strictEqual(effectiveIntervalS(entry, 120, 'local'), entry.localIntervalS);
assert.strictEqual(entry.group, 'power');
assert.strictEqual(effectiveIntervalS(entry, 1, 'local'), 1);
const eTotal = getCatalogEntry('eTotal');
assert.strictEqual(eTotal.group, 'energy');
assert.strictEqual(effectiveIntervalS(eTotal, 1, 'local'), eTotal.localIntervalS);
assert.strictEqual(effectiveIntervalS(eTotal, 120, 'local'), eTotal.localIntervalS);

assert.strictEqual(resolveApiType(getCatalogEntry('onOff'), 'tlx'), 'tlx_on_off');
assert.strictEqual(resolveApiType(getCatalogEntry('activePowerRate'), 'mix'), 'pv_active_p_rate');
assert.ok(getCatalogEntry('clock'));
assert.ok(!mergeInverterVarsConfig([], { families: ['inv'] }).some((r) => r.id === 'soc'));

const parsed = parseSettingStateId(
    'fronius-fake-sm.0.inverter.ABC123.settings.activePowerRate.value',
    'fronius-fake-sm.0',
);
assert.deepStrictEqual(parsed, { deviceSn: 'ABC123', catalogId: 'activePowerRate' });
assert.strictEqual(parseSettingStateId('fronius-fake-sm.0.meter.power', 'fronius-fake-sm.0'), null);

const w = buildWriteSingleHoldingFrame({ sn: 'XGDTEST', register: 3, value: 50 });
const dw = decodeFrame(w);
assert.strictEqual(dw.func, 0x06);
assert.ok(dw.crcOk);

const r = buildReadHoldingFrame({ sn: 'XGDTEST', register: 0, quantity: 10 });
const dr = decodeFrame(r);
assert.strictEqual(dr.func, 0x05);
assert.ok(dr.crcOk);

console.log('inverterVarsCatalog.test.js OK');
