'use strict';

const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'admin', 'jsonConfig.json');
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const source = j.items.source.items;
const meter = j.items.meter.items;

source._cloudStickRedirectBanner = {
    type: 'staticText',
    format: 'html',
    text: {
        en: '<div style="display:flex;gap:10px;align-items:flex-start;background:#FFF8E1;border:1px solid #FFB300;border-radius:8px;padding:10px 12px;color:#5D4037;font-size:0.95rem;line-height:1.35"><span aria-hidden="true">⚠</span><span><b>Stick redirect active</b> — proxy :5279 forwards to Growatt. Use the button to restore cloud.</span></div>',
        de: '<div style="display:flex;gap:10px;align-items:flex-start;background:#FFF8E1;border:1px solid #FFB300;border-radius:8px;padding:10px 12px;color:#5D4037;font-size:0.95rem;line-height:1.35"><span aria-hidden="true">⚠</span><span><b>Stick-Umleitung aktiv</b> — Proxy :5279 leitet zu Growatt. Mit dem Button wieder Cloud.</span></div>',
    },
    xs: 12,
    sm: 8,
    md: 8,
    newLine: true,
    hidden: "data.manufacturer !== 'growatt' || data.growattFeedMode !== 'cloud' || !data.cloudStickRedirectActive",
};

source.restoreCloudStickCloudBtn.label = {
    en: 'Remove redirect',
    de: 'Umleitung entfernen',
};

source._donateText = {
    type: 'staticText',
    text: {
        en: 'Free adapter — donations welcome.',
        de: 'Kostenloser Adapter — Spenden willkommen.',
    },
    newLine: true,
    xs: 12,
    sm: 9,
    md: 10,
};

const emptyHint = {
    type: 'staticText',
    text: {
        en: 'No Gen24 found yet — search first, then enable the master.',
        de: 'Noch kein Gen24 — zuerst suchen, dann Master anhaken.',
    },
    xs: 12,
    // Show only while table empty
    hidden: 'data.froniusDevices && data.froniusDevices.length',
};

const ordered = {};
for (const [k, v] of Object.entries(meter)) {
    if (k === '_froniusEmptyHint') {
        continue;
    }
    if (k === 'froniusDevices') {
        ordered._froniusEmptyHint = emptyHint;
    }
    ordered[k] = v;
}
j.items.meter.items = ordered;

j.items.meter.items.froniusDevices.label = {
    en: 'Found Gen24 inverters (enable master)',
    de: 'Gefundene Gen24-WR (Master anhaken)',
};

j.items.meter.items.expertSettings.items._expertScopeHint = {
    type: 'staticText',
    text: {
        en: 'Instance-wide: all Growatt devices are summed, then smoothed into one Fake SM.',
        de: 'Instanzweit: alle Growatt-Geräte werden summiert, dann zu einem Fake-SM geglättet.',
    },
    xs: 12,
};

fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
const keys = Object.keys(j.items.meter.items);
console.log('phase23 craft ok', {
    emptyIdx: keys.indexOf('_froniusEmptyHint'),
    tableIdx: keys.indexOf('froniusDevices'),
});
