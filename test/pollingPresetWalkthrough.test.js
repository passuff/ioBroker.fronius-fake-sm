'use strict';

/**
 * Automated stand-in for the Expert UI walkthrough:
 * Preset Local → Apply → intervals → edit → restart reconcile → custom → Apply again.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { handleApplyPollingTemplate } = require('../lib/adminMessages');
const {
    TEMPLATES,
    reconcilePollingConfig,
    applyPollingTemplate,
} = require('../lib/pollingTemplates');
const { defaultInverterVarsConfig, getCatalogEntry } = require('../lib/inverterVarsCatalog');

const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'admin', 'jsonConfig.json'), 'utf8'));
const source = cfg.items.source.items;
const expert = cfg.items.meter.items.expertSettings.items;
assert.deepStrictEqual(Object.keys(cfg.items), ['source', 'meter']);
assert.ok(source.pollingPresetPanel && source.pollingPresetPanel.collapsable);
assert.ok(source.inverterVarsPanel && source.inverterVarsPanel.collapsable);
assert.strictEqual(source.pollingPresetPanel.items.applyPollingTemplateBtn.command, 'applyPollingTemplate');
assert.ok(source.pollingPresetPanel.items.smoothIntervalS);
assert.strictEqual(source.pollingPresetPanel.items.smoothIntervalS.min, 1);
assert.ok(!expert.pollingTemplate, 'not buried only in expert');
assert.ok(!expert.pollIntervalS && !expert.smoothIntervalS, 'intervals live in Fremd-WR preset');

const i18nKeys = ['Polling preset', 'Apply polling preset', 'OpenAPI (cloud token)', 'Shine login (credentials)', 'Local (stick realtime)', 'Custom'];
for (const loc of ['en', 'de', 'fr', 'es']) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'admin', 'i18n', `${loc}.json`), 'utf8'));
    for (const k of i18nKeys) {
        assert.ok(j[k], `missing i18n ${loc}: ${k}`);
    }
}

function mockAdapter(config) {
    /** @type {object|null} */
    let lastPayload = null;
    const nativeStore = { ...(config || {}) };
    return {
        config: nativeStore,
        namespace: 'fronius-fake-sm.0',
        log: { info() {}, warn() {}, debug() {}, error() {} },
        sendTo(_from, _cmd, payload, _cb) {
            lastPayload = payload;
        },
        async getForeignObjectAsync() {
            return { native: { ...nativeStore } };
        },
        async setForeignObjectAsync(_id, obj) {
            Object.assign(nativeStore, obj.native || {});
            Object.assign(this.config, nativeStore);
        },
        _lastPayload() {
            return lastPayload;
        },
    };
}

async function applyViaSendTo(config, pollingTemplate) {
    const adapter = mockAdapter(config);
    await handleApplyPollingTemplate(adapter, {
        from: 'admin.0',
        command: 'applyPollingTemplate',
        message: {
            pollingTemplate,
            growattFeedMode: config.growattFeedMode,
            growattCloudAuth: config.growattCloudAuth,
        },
        callback: true,
    });
    const payload = adapter._lastPayload();
    assert.ok(payload && payload.ok && payload.native);
    return { ...config, ...payload.native };
}

(async () => {
    // 1) Start on openapi stock (cloud-ish WR intervals)
    let native = {
        ...TEMPLATES.openapi,
        pollingTemplate: 'openapi',
        growattFeedMode: 'local',
        growattCloudAuth: 'openapi',
        inverterVars: defaultInverterVarsConfig().map((r) => ({ ...r, intervalS: 120 })),
    };

    // 2) User picks Local + Apply (form fill) — Fake-SM + WR intervals
    native = await applyViaSendTo(native, 'local');
    assert.strictEqual(native.pollingTemplate, 'local');
    assert.strictEqual(native.smoothIntervalS, 1);
    assert.strictEqual(native.emaTauS, 3);
    assert.strictEqual(native.pollIntervalS, 300);
    assert.strictEqual(native.nightPollIntervalS, 600);
    assert.strictEqual(
        native.inverterVars.find((r) => r.id === 'pac').intervalS,
        getCatalogEntry('pac').localIntervalS,
    );
    assert.strictEqual(
        native.inverterVars.find((r) => r.id === 'eTotal').intervalS,
        getCatalogEntry('eTotal').localIntervalS,
    );

    // 3) User edits a number (form) then saves → on ready reconcile → custom
    native.smoothIntervalS = 3;
    native = reconcilePollingConfig(native);
    assert.strictEqual(native.pollingTemplate, 'custom');
    assert.strictEqual(native.smoothIntervalS, 3, 'edited value preserved');

    // 4) Apply Local again restores stock local intervals
    native = await applyViaSendTo(native, 'local');
    assert.strictEqual(native.pollingTemplate, 'local');
    assert.deepStrictEqual(
        {
            pollIntervalS: native.pollIntervalS,
            nightPollIntervalS: native.nightPollIntervalS,
            smoothIntervalS: native.smoothIntervalS,
            emaTauS: native.emaTauS,
        },
        TEMPLATES.local,
    );

    // 5) Mode-follow: stock openapi while feed=local → local on reconcile
    const followed = reconcilePollingConfig({
        ...TEMPLATES.openapi,
        pollingTemplate: 'openapi',
        growattFeedMode: 'local',
    });
    assert.strictEqual(followed.pollingTemplate, 'local');
    assert.strictEqual(followed.smoothIntervalS, 1);

    // 6) Explicit apply helper parity
    const applied = applyPollingTemplate({ growattFeedMode: 'cloud' }, 'shine');
    assert.strictEqual(applied.pollingTemplate, 'shine');
    assert.strictEqual(applied.pollIntervalS, 60);

    // 7) Empty inverterVars seeds catalog on Apply
    const seeded = await applyViaSendTo(
        {
            ...TEMPLATES.openapi,
            pollingTemplate: 'openapi',
            growattFeedMode: 'cloud',
            growattCloudAuth: 'openapi',
            inverterVars: [],
        },
        'openapi',
    );
    assert.ok(Array.isArray(seeded.inverterVars) && seeded.inverterVars.length > 0);
    assert.strictEqual(
        seeded.inverterVars.find((r) => r.id === 'pac').intervalS,
        getCatalogEntry('pac').defaultIntervalS,
    );

    console.log('pollingPresetWalkthrough.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
