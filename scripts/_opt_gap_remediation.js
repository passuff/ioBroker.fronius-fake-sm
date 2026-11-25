'use strict';

const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'admin', 'jsonConfig.json');
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const source = j.items.source.items;
const meter = j.items.meter.items;

const README = 'https://github.com/passuff/ioBroker.fronius-fake-sm/blob/main/README.md';
const HW = `${README}#supported-hardware--unterstützte-hardware`;
const GEN24 = `${README}#gen24-add-fake-sm-as-secondary-meter`;

// 2. README links
source._hintSoon = {
    type: 'staticText',
    format: 'html',
    text: {
        en: `v1: Growatt only. Hardware: <a href="${HW}" target="_blank" rel="noopener noreferrer">README → Supported hardware</a>.`,
        de: `v1: nur Growatt. Hardware: <a href="${HW}" target="_blank" rel="noopener noreferrer">README → Unterstützte Hardware</a>.`,
    },
    xs: 12,
    sm: 12,
    md: 8,
};

// 3. Cloud+Redirect dedupe — hide all jsonConfig live proxy rows always (banner covers cloud redirect)
const liveAlwaysHidden = true;
for (const key of [
    '_stickStatusLive',
    '_stickSnLive',
    '_localConnectionLive',
    '_proxyClientCountLive',
    '_localFrameStatusLive',
]) {
    if (source[key]) {
        source[key].hidden = liveAlwaysHidden;
    }
}

// 4. Gen24 steps + expert copy
meter._gen24Setup = {
    type: 'staticText',
    format: 'html',
    text: {
        en: `<ol style="margin:0;padding-left:1.25rem;line-height:1.45"><li>Gen24 web UI as <b>Technician</b>: Components → Add → Fronius Smart Meter (TCP).</li><li>IP = ioBroker IP below, Port <b>502</b>, Modbus address = Unit ID here (default <b>3</b>, never 1).</li><li>Application: <b>Producer meter</b> (Erzeugerzähler).</li><li>Then <b>Search Gen24</b> below and enable the master.</li></ol><p style="margin:8px 0 0;font-size:0.85rem;opacity:0.75">Details: <a href="${GEN24}" target="_blank" rel="noopener noreferrer">README → Gen24</a>. Primo/Symo GEN24 only.</p>`,
        de: `<ol style="margin:0;padding-left:1.25rem;line-height:1.45"><li>Gen24-Web-UI als <b>Techniker</b>: Komponenten → Hinzufügen → Fronius Smart Meter (TCP).</li><li>IP = ioBroker-IP unten, Port <b>502</b>, Modbus-Adresse = Unit-ID hier (Default <b>3</b>, nie 1).</li><li>Anwendung: <b>Erzeugerzähler</b>.</li><li>Danach unten <b>Gen24 suchen</b> und Master anhaken.</li></ol><p style="margin:8px 0 0;font-size:0.85rem;opacity:0.75">Details: <a href="${GEN24}" target="_blank" rel="noopener noreferrer">README → Gen24</a>. Nur Primo/Symo GEN24.</p>`,
    },
    xs: 12,
};

meter._froniusScan = {
    type: 'header',
    text: {
        en: 'Gen24 master (network search)',
        de: 'Gen24-Master (Netzwerksuche)',
    },
    size: 2,
    xs: 12,
};

const expert = meter.expertSettings.items;
expert.pollIntervalS.help = {
    en: 'OpenAPI ≥120s; Shine login ≥30s (portal lock risk). Details: README.',
    de: 'OpenAPI ≥120s; Shine-Login ≥30s (Portalsperr-Risiko). Details: README.',
};
expert.nightPollIntervalS.help = {
    en: 'Slower poll near zero power; not below the day interval.',
    de: 'Langsamerer Poll bei Nullleistung; nicht unter dem Day-Intervall.',
};
if (source.growattToken && source.growattToken.help) {
    source.growattToken.help = {
        en: 'Required for OpenAPI poll. Optional for search/local. Encrypted. Details: README.',
        de: 'Pflicht für OpenAPI-Poll. Optional für Suche/Lokal. Verschlüsselt. Details: README.',
    };
}

expert._srcPollHeader.text = {
    en: 'Source fetch (cloud)',
    de: 'Quellen-Abruf (Cloud)',
};
expert._pipelineHeader = expert._pipelineHeader || null;
if (expert._smoothHeader) {
    expert._smoothHeader.text = {
        en: expert._smoothHeader.text.en || expert._smoothHeader.text,
        de: expert._smoothHeader.text.de || expert._smoothHeader.text,
    };
}

// sentence-case spot-check common headers
for (const [k, v] of Object.entries(expert)) {
    if (v && v.type === 'header' && v.text && typeof v.text === 'object') {
        if (k === '_fakeSmHeader') {
            v.text = {
                en: 'Fake Smart Meter (what Gen24 sees)',
                de: 'Fake Smart Meter (was der Gen24 sieht)',
            };
        }
        if (k === '_srcPollHeader') {
            v.text = {
                en: 'Source fetch (cloud)',
                de: 'Quellen-Abruf (Cloud)',
            };
        }
    }
}

fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
console.log('gap remediation jsonConfig ok', {
    hintHtml: source._hintSoon.format,
    liveHidden: source._stickStatusLive.hidden,
    gen24HasLink: String(meter._gen24Setup.text.en).includes('href='),
    pollHelp: expert.pollIntervalS.help.en,
});
