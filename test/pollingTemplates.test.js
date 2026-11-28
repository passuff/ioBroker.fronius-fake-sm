'use strict';

const assert = require('assert');
const {
    TEMPLATES,
    resolvePollingTemplate,
    getPollingTemplate,
    matchesPollingTemplate,
    detectPollingTemplate,
    applyPollingTemplate,
    reconcilePollingConfig,
    pollingReconcilePatch,
} = require('../lib/pollingTemplates');
const { effectiveIntervalS, getCatalogEntry } = require('../lib/inverterVarsCatalog');

assert.strictEqual(resolvePollingTemplate('cloud', 'openapi'), 'openapi');
assert.strictEqual(resolvePollingTemplate('cloud', 'shine'), 'shine');
assert.strictEqual(resolvePollingTemplate('local', 'openapi'), 'local');
assert.strictEqual(resolvePollingTemplate('local', 'shine'), 'local');

assert.deepStrictEqual(getPollingTemplate('openapi'), TEMPLATES.openapi);
assert.strictEqual(getPollingTemplate('custom'), null);

const openapiCfg = { ...TEMPLATES.openapi, growattFeedMode: 'cloud', growattCloudAuth: 'openapi' };
assert.ok(matchesPollingTemplate(openapiCfg, 'openapi'));
assert.ok(!matchesPollingTemplate(openapiCfg, 'local'));
assert.strictEqual(detectPollingTemplate(openapiCfg), 'openapi');

const applied = applyPollingTemplate(
    {
        pollIntervalS: 999,
        growattFeedMode: 'local',
        inverterVars: [
            { id: 'pac', enabled: true, intervalS: 120 },
            { id: 'eTotal', enabled: true, intervalS: 300 },
        ],
    },
    'local',
);
assert.strictEqual(applied.pollingTemplate, 'local');
assert.strictEqual(applied.pollIntervalS, 300);
assert.strictEqual(applied.nightPollIntervalS, 600);
assert.strictEqual(applied.smoothIntervalS, 1);
assert.strictEqual(applied.emaTauS, 3);
assert.strictEqual(applied.growattFeedMode, 'local');
assert.strictEqual(applied.inverterVars.find((r) => r.id === 'pac').intervalS, getCatalogEntry('pac').localIntervalS);
assert.strictEqual(
    applied.inverterVars.find((r) => r.id === 'eTotal').intervalS,
    getCatalogEntry('eTotal').localIntervalS,
);

const customApplied = applyPollingTemplate({ pollIntervalS: 50 }, 'custom');
assert.strictEqual(customApplied.pollingTemplate, 'custom');
assert.strictEqual(customApplied.pollIntervalS, 50);

// Migration: missing template + stock openapi values + local mode → apply local
const migrated = reconcilePollingConfig({
    ...TEMPLATES.openapi,
    growattFeedMode: 'local',
    growattCloudAuth: 'openapi',
});
assert.strictEqual(migrated.pollingTemplate, 'local');
assert.strictEqual(migrated.smoothIntervalS, 1);
assert.strictEqual(migrated.pollIntervalS, 300);

// Stock openapi + cloud → keep openapi
const keep = reconcilePollingConfig({
    ...TEMPLATES.openapi,
    pollingTemplate: 'openapi',
    growattFeedMode: 'cloud',
    growattCloudAuth: 'openapi',
});
assert.strictEqual(keep.pollingTemplate, 'openapi');
assert.strictEqual(keep.pollIntervalS, 120);

// Mode follow: shine stock while feed still cloud/shine auth
const shineFollow = reconcilePollingConfig({
    ...TEMPLATES.openapi,
    pollingTemplate: 'openapi',
    growattFeedMode: 'cloud',
    growattCloudAuth: 'shine',
});
assert.strictEqual(shineFollow.pollingTemplate, 'shine');
assert.strictEqual(shineFollow.pollIntervalS, 60);

// Dirty numbers → custom (never overwrite)
const dirty = reconcilePollingConfig({
    pollIntervalS: 150,
    nightPollIntervalS: 300,
    smoothIntervalS: 5,
    pollingTemplate: 'openapi',
    growattFeedMode: 'cloud',
    growattCloudAuth: 'openapi',
});
assert.strictEqual(dirty.pollingTemplate, 'custom');
assert.strictEqual(dirty.pollIntervalS, 150);

// Explicit custom stays
const stayCustom = reconcilePollingConfig({
    ...TEMPLATES.local,
    pollingTemplate: 'custom',
    growattFeedMode: 'local',
});
assert.strictEqual(stayCustom.pollingTemplate, 'custom');
assert.strictEqual(stayCustom.smoothIntervalS, 1);

const patch = pollingReconcilePatch({
    ...TEMPLATES.openapi,
    growattFeedMode: 'local',
    inverterVars: [
        { id: 'pac', enabled: true, intervalS: 120 },
        { id: 'eTotal', enabled: true, intervalS: 300 },
    ],
});
assert.strictEqual(patch.pollingTemplate, 'local');
assert.strictEqual(patch.smoothIntervalS, 1);
assert.ok(Array.isArray(patch.inverterVars), 'mode-follow must persist WR intervals');
assert.strictEqual(patch.inverterVars.find((r) => r.id === 'pac').intervalS, getCatalogEntry('pac').localIntervalS);

// Local inverter var intervals: cloud-oriented 120 must not slow local; 1s only for power group
const pac = getCatalogEntry('pac');
assert.strictEqual(effectiveIntervalS(pac, 120, 'local'), pac.localIntervalS);
assert.strictEqual(effectiveIntervalS(pac, 1, 'local'), 1);
assert.strictEqual(effectiveIntervalS(pac, 2, 'local'), 2);
assert.ok(effectiveIntervalS(pac, 10, 'openapi') >= 90);
const eTotal = getCatalogEntry('eTotal');
assert.strictEqual(effectiveIntervalS(eTotal, 1, 'local'), eTotal.localIntervalS);

console.log('pollingTemplates.test.js OK');
