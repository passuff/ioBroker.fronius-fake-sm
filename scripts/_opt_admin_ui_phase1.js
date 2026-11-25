'use strict';

const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'admin', 'jsonConfig.json');
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const items = j.items.source.items;

// 1.1 Growatt-only manufacturer
items.manufacturer.options = [
    {
        label: 'Growatt (OpenAPI)',
        value: 'growatt',
        icon: items.manufacturer.options[0].icon,
    },
];
items.manufacturer.xs = 12;
items.manufacturer.sm = 6;
items.manufacturer.md = 4;

items._hintSoon = {
    type: 'staticText',
    text: {
        en: 'v1: Growatt only. Hardware details: README → Supported hardware.',
        de: 'v1: nur Growatt. Hardware: README → Unterstützte Hardware.',
    },
    xs: 12,
    sm: 12,
    md: 8,
};

items._modeHint = {
    type: 'staticText',
    text: {
        en: 'Cloud uses OpenAPI token (or Shine login). Local needs Shine web login; device search still uses the token when set.',
        de: 'Cloud: OpenAPI-Token (oder Shine-Login). Lokal: Shine-Web-Login; Geräte-Suche nutzt den Token, falls gesetzt.',
    },
    xs: 12,
    sm: 12,
    md: 8,
    hidden: "data.manufacturer !== 'growatt'",
};

// 1.2 Shorten search hint; drop devicesVsLocalHint (redundant with table label + local panel)
items._searchHint = {
    type: 'staticText',
    text: {
        en: 'Instance must be running. Search, then enable rows that feed the Fake SM (powers summed).',
        de: 'Instanz muss laufen. Suchen, dann Zeilen aktivieren, die den Fake-SM speisen (Leistungen summiert).',
    },
    xs: 12,
    hidden: "data.manufacturer !== 'growatt' || !data.growattToken",
};
delete items._devicesVsLocalHint;

// Live status: only when cloud + redirect active (local uses React panel)
const liveHidden =
    "data.manufacturer !== 'growatt' || data.growattFeedMode === 'local' || !data.cloudStickRedirectActive";
for (const key of [
    '_stickStatusLive',
    '_stickSnLive',
    '_localConnectionLive',
    '_proxyClientCountLive',
    '_localFrameStatusLive',
]) {
    if (items[key]) {
        items[key].hidden = liveHidden;
    }
}

// Redirect banner — short alert copy
items._cloudStickRedirectBanner = {
    type: 'staticText',
    format: 'html',
    text: {
        en: '<div style="background:#fff8e1;border:1px solid #ffb300;border-radius:8px;padding:10px 12px;color:#5d4037;font-size:0.95rem;line-height:1.35">⚠ Stick redirect active — proxy :5279 forwards to Growatt. Use „Remove stick redirect“ to restore cloud.</div>',
        de: '<div style="background:#fff8e1;border:1px solid #ffb300;border-radius:8px;padding:10px 12px;color:#5d4037;font-size:0.95rem;line-height:1.35">⚠ Stick-Umleitung aktiv — Proxy :5279 leitet zu Growatt weiter. Mit „Umleitung entfernen“ wieder Cloud.</div>',
    },
    xs: 12,
    sm: 8,
    md: 8,
    newLine: true,
    hidden: "data.manufacturer !== 'growatt' || data.growattFeedMode !== 'cloud' || !data.cloudStickRedirectActive",
};

// Shine lock warn — shorter
items._shineCloudLockWarn = {
    type: 'staticText',
    format: 'html',
    text: {
        en: '<div style="background:#fff8e1;border:1px solid #ffb300;border-radius:8px;padding:10px 12px;color:#5d4037;font-size:0.95rem;line-height:1.35">⚠ Prefer OpenAPI when possible. Shine poll ≥30s; avoid frequent re-logins (portal lock risk).</div>',
        de: '<div style="background:#fff8e1;border:1px solid #ffb300;border-radius:8px;padding:10px 12px;color:#5d4037;font-size:0.95rem;line-height:1.35">⚠ OpenAPI bevorzugen. Shine-Poll ≥30 s; Relogins vermeiden (Portalsperr-Risiko).</div>',
    },
    xs: 12,
    hidden: items._shineCloudLockWarn.hidden,
};

fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
console.log('phase1 fremd-wr ok', {
    manufacturers: items.manufacturer.options.map((o) => o.value),
    devicesVsLocal: !!items._devicesVsLocalHint,
    liveHidden: items._stickStatusLive.hidden,
});
