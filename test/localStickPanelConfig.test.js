'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'admin', 'jsonConfig.json'), 'utf8'));
const items = cfg.items.source.items;
const panel = items._localStickPanel;

assert.ok(panel, 'custom LocalStickPanel must be in jsonConfig');
assert.strictEqual(panel.type, 'custom');
assert.strictEqual(panel.name, 'FroniusFakeSmSet/Components/LocalStickPanel');
assert.strictEqual(panel.url, 'custom/customComponents.js');
assert.strictEqual(panel.guiApi, 2);
assert.ok(!items._wfStep1, 'legacy _wfStep1 removed');
assert.ok(!items._localExplain, 'legacy _localExplain removed');
assert.ok(items.localStickSn && items.localStickSn.hidden === true);

// IA: Growatt-only; proxy live rows always hidden (banner covers cloud redirect)
assert.deepStrictEqual(
    items.manufacturer.options.map(o => o.value),
    ['growatt'],
);
assert.strictEqual(items._stickStatusLive.hidden, true);
assert.strictEqual(items._localFrameStatusLive.hidden, true);
assert.ok(!items._devicesVsLocalHint, '_devicesVsLocalHint should be removed');
assert.strictEqual(items._hintSoon.format, 'html');
assert.ok(String(items._hintSoon.text.en).includes('href='), 'hardware README link');

const meter = cfg.items.meter.items;
assert.ok(meter._gen24Setup.text.en.includes('Search Gen24'), 'Gen24 step matches button');
assert.ok(String(meter._gen24Setup.text.en).includes('href='), 'Gen24 README link');
assert.ok(meter._froniusEmptyHint, 'empty Gen24 table hint');
assert.strictEqual(meter.discoverFroniusBtn.label.en, 'Search Gen24');
assert.deepStrictEqual(Object.keys(cfg.items), ['source', 'meter'], 'only Fremd-WR + Modbus tabs');
assert.ok(!cfg.items.inverterVars, 'WR-Variablen tab removed');
assert.ok(items.pollingPresetPanel, 'polling collapsible on Fremd-WR');
assert.strictEqual(items.pollingPresetPanel.collapsable, true);
const preset = items.pollingPresetPanel.items;
assert.strictEqual(preset.pollingTemplate.default, 'openapi');
assert.strictEqual(preset.applyPollingTemplateBtn.command, 'applyPollingTemplate');
assert.ok(preset.pollIntervalS, 'poll intervals visible in preset panel');
assert.ok(preset.smoothIntervalS);
assert.strictEqual(preset.smoothIntervalS.min, 1);
assert.ok(preset.pollIntervalS.help.en.length < 100, 'poll help short');
assert.ok(items.inverterVarsPanel, 'WR-Variablen collapsible on Fremd-WR');
assert.strictEqual(items.inverterVarsPanel.collapsable, true);
assert.ok(items.inverterVarsPanel.items.inverterVars, 'inverterVars table inside panel');
assert.ok(!meter.expertSettings.items.pollingTemplate, 'preset moved off expert');
assert.ok(!meter.expertSettings.items.pollIntervalS, 'poll fields moved to Fremd-WR preset');
assert.ok(meter.expertSettings.items._pollingPresetHint, 'expert points to Fremd-WR preset');

// Visibility matrix (expression semantics after remediation)
function bannerHidden(data) {
    return data.manufacturer !== 'growatt' || data.growattFeedMode !== 'cloud' || !data.cloudStickRedirectActive;
}
assert.ok(items._stickStatusLive.hidden === true, 'live always hidden');
assert.strictEqual(bannerHidden({ manufacturer: 'growatt', growattFeedMode: 'cloud', cloudStickRedirectActive: false }), true);
assert.strictEqual(bannerHidden({ manufacturer: 'growatt', growattFeedMode: 'cloud', cloudStickRedirectActive: true }), false);
assert.strictEqual(bannerHidden({ manufacturer: 'growatt', growattFeedMode: 'local', cloudStickRedirectActive: true }), true);

const customJs = path.join(root, 'admin', 'custom', 'customComponents.js');
const manifest = path.join(root, 'admin', 'custom', 'mf-manifest.json');
assert.ok(fs.existsSync(customJs), 'admin/custom/customComponents.js missing — run npm run build:admin');
assert.ok(fs.existsSync(manifest), 'admin/custom/mf-manifest.json missing');
const mf = JSON.parse(fs.readFileSync(manifest, 'utf8'));
assert.strictEqual(mf.name, 'FroniusFakeSmSet');

console.log('localStickPanelConfig.test.js OK');
