'use strict';

const assert = require('assert');
const { handleApplyPollingTemplate } = require('../lib/adminMessages');
const { TEMPLATES } = require('../lib/pollingTemplates');
const { defaultInverterVarsConfig, getCatalogEntry } = require('../lib/inverterVarsCatalog');

function mockAdapter(config) {
    /** @type {object|null} */
    let lastPayload = null;
    /** @type {string[]} */
    const order = [];
    // Separate DB native from in-memory config (mirrors real adapter vs objects DB).
    const dbNative = JSON.parse(JSON.stringify(config || {}));
    return {
        config: { ...(config || {}) },
        namespace: 'fronius-fake-sm.0',
        log: { info() {}, warn() {}, debug() {}, error() {} },
        sendTo(_from, _cmd, payload, _cb) {
            order.push('sendTo');
            lastPayload = payload;
        },
        async getForeignObjectAsync() {
            order.push('getForeignObject');
            return { native: JSON.parse(JSON.stringify(dbNative)) };
        },
        async setForeignObjectAsync(_id, obj) {
            order.push('setForeignObject');
            Object.assign(dbNative, obj.native || {});
            Object.assign(this.config, dbNative);
        },
        _lastPayload() {
            return lastPayload;
        },
        _order() {
            return order;
        },
    };
}

async function run(adapter, message) {
    await handleApplyPollingTemplate(adapter, {
        from: 'system.adapter.admin.0',
        command: 'applyPollingTemplate',
        message,
        callback: true,
    });
    return adapter._lastPayload();
}

(async () => {
    const vars = defaultInverterVarsConfig();
    const localAdapter = mockAdapter({
        pollIntervalS: 120,
        nightPollIntervalS: 300,
        smoothIntervalS: 5,
        pollingTemplate: 'openapi',
        growattFeedMode: 'local',
        growattCloudAuth: 'openapi',
        inverterVars: vars.map((r) => ({ ...r, intervalS: 120 })),
    });
    const localRes = await run(localAdapter, { pollingTemplate: 'local' });
    assert.ok(localRes && localRes.ok && localRes.native);
    assert.strictEqual(localRes.native.pollingTemplate, 'local');
    assert.strictEqual(localRes.native.pollIntervalS, TEMPLATES.local.pollIntervalS);
    assert.strictEqual(localRes.native.smoothIntervalS, TEMPLATES.local.smoothIntervalS);
    const pacLocal = localRes.native.inverterVars.find((r) => r.id === 'pac');
    assert.strictEqual(pacLocal.intervalS, getCatalogEntry('pac').localIntervalS);
    const eLocal = localRes.native.inverterVars.find((r) => r.id === 'eTotal');
    assert.strictEqual(eLocal.intervalS, getCatalogEntry('eTotal').localIntervalS);

    const shineAdapter = mockAdapter({
        ...TEMPLATES.openapi,
        pollingTemplate: 'openapi',
        growattFeedMode: 'cloud',
        growattCloudAuth: 'shine',
        inverterVars: vars.map((r) => ({ ...r })),
    });
    const shineRes = await run(shineAdapter, { pollingTemplate: 'shine' });
    assert.strictEqual(shineRes.native.pollingTemplate, 'shine');
    assert.strictEqual(shineRes.native.pollIntervalS, TEMPLATES.shine.pollIntervalS);

    const openapiAdapter = mockAdapter({
        ...TEMPLATES.local,
        pollingTemplate: 'local',
        growattFeedMode: 'cloud',
        growattCloudAuth: 'openapi',
        inverterVars: vars.map((r) => ({ ...r, intervalS: 5 })),
    });
    const openapiRes = await run(openapiAdapter, { pollingTemplate: 'openapi' });
    assert.strictEqual(openapiRes.native.pollingTemplate, 'openapi');
    assert.deepStrictEqual(
        {
            pollIntervalS: openapiRes.native.pollIntervalS,
            nightPollIntervalS: openapiRes.native.nightPollIntervalS,
            smoothIntervalS: openapiRes.native.smoothIntervalS,
        },
        TEMPLATES.openapi,
    );
    const pacOpen = openapiRes.native.inverterVars.find((r) => r.id === 'pac');
    assert.strictEqual(pacOpen.intervalS, getCatalogEntry('pac').defaultIntervalS);

    const resolveAdapter = mockAdapter({
        ...TEMPLATES.openapi,
        pollingTemplate: 'custom',
        growattFeedMode: 'local',
        growattCloudAuth: 'openapi',
        inverterVars: vars.map((r) => ({ ...r })),
    });
    const resolved = await run(resolveAdapter, {
        pollingTemplate: 'custom',
        growattFeedMode: 'local',
    });
    assert.strictEqual(resolved.native.pollingTemplate, 'local');
    assert.strictEqual(resolved.native.smoothIntervalS, 1);

    // Reply must reach Admin before persist/restart
    const orderAdapter = mockAdapter({
        ...TEMPLATES.openapi,
        pollingTemplate: 'openapi',
        growattFeedMode: 'cloud',
        growattCloudAuth: 'openapi',
        inverterVars: vars.map((r) => ({ ...r, intervalS: 120 })),
    });
    await run(orderAdapter, { pollingTemplate: 'local' });
    const order = orderAdapter._order();
    assert.ok(order.indexOf('sendTo') >= 0, 'sendTo missing');
    assert.ok(
        order.indexOf('sendTo') < order.indexOf('setForeignObject'),
        `reply must precede persist, got ${order.join(',')}`,
    );

    // Empty inverterVars seeds catalog defaults (no wipe)
    const emptyAdapter = mockAdapter({
        ...TEMPLATES.local,
        pollingTemplate: 'local',
        growattFeedMode: 'local',
        growattCloudAuth: 'openapi',
        inverterVars: [],
    });
    const emptyRes = await run(emptyAdapter, { pollingTemplate: 'local' });
    assert.ok(emptyRes.native.inverterVars.length > 0);
    assert.strictEqual(
        emptyRes.native.inverterVars.find((r) => r.id === 'pac').intervalS,
        getCatalogEntry('pac').localIntervalS,
    );

    console.log('applyPollingTemplateAdmin.test.js OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
