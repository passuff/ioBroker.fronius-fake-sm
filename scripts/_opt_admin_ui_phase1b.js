'use strict';

const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'admin', 'jsonConfig.json');
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

// 1.5 WR-Variablen
j.items.inverterVars.items._invVarsHint = {
    type: 'staticText',
    text: {
        en: 'Enable datapoints under inverter.<SN>. Cloud interval for OpenAPI/Shine; local updates faster automatically.',
        de: 'Datenpunkte unter inverter.<SN> aktivieren. Cloud-Intervall für OpenAPI/Shine; lokal aktualisiert schneller.',
    },
    xs: 12,
};

// 1.4 + Phase 3 Modbus
const meter = j.items.meter.items;
meter._gen24Setup = {
    type: 'staticText',
    format: 'html',
    text: {
        en: '<ol style="margin:0;padding-left:1.25rem;line-height:1.45"><li>Gen24 web UI as <b>Technician</b>: Components → Add → Fronius Smart Meter (TCP).</li><li>IP = ioBroker IP below, Port <b>502</b>, Modbus address = Unit ID here (default <b>3</b>, never 1).</li><li>Application: <b>Producer meter</b> (Erzeugerzähler).</li><li>Then search Fronius below to pick the master.</li></ol><p style="margin:8px 0 0;font-size:0.85rem;opacity:0.75">Details: README → Gen24. Primo/Symo GEN24 only.</p>',
        de: '<ol style="margin:0;padding-left:1.25rem;line-height:1.45"><li>Gen24-Web-UI als <b>Techniker</b>: Komponenten → Hinzufügen → Fronius Smart Meter (TCP).</li><li>IP = ioBroker-IP unten, Port <b>502</b>, Modbus-Adresse = Unit-ID hier (Default <b>3</b>, nie 1).</li><li>Anwendung: <b>Erzeugerzähler</b>.</li><li>Danach unten Fronius suchen und Master wählen.</li></ol><p style="margin:8px 0 0;font-size:0.85rem;opacity:0.75">Details: README → Gen24. Nur Primo/Symo GEN24.</p>',
    },
    xs: 12,
};

meter._froniusHint = {
    type: 'staticText',
    text: {
        en: 'Pick the inverter that already reports meters (master). Empty list → search first.',
        de: 'Wechselrichter mit gemeldeten Zählern wählen (Master). Leere Liste → zuerst suchen.',
    },
    xs: 12,
};

meter.discoverFroniusBtn.label = {
    en: 'Search Gen24',
    de: 'Gen24 suchen',
};

meter.expertSettings.items.eOffsetMode.help = {
    en: 'Auto: per-device baselines; Fake-SM energy = Σ max(eTotal−baseline, 0). Manual: global eTotal − offset. Details: README.',
    de: 'Auto: Baselines pro Gerät; Fake-SM-Energie = Σ max(eTotal−Baseline, 0). Manuell: global eTotal − Offset. Details: README.',
};

meter.expertSettings.items.eTotalOffsetKwh.help = {
    en: 'Only in Manual mode. Prefer Auto baselines for multi-WR.',
    de: 'Nur im manuellen Modus. Bei Mehr-WR Auto-Baselines bevorzugen.',
};

meter.expertSettings.items.resetEnergyBaselinesBtn.help = {
    en: 'Clears baselines; next samples re-lock. May jump Solar.web energy — use only intentionally.',
    de: 'Löscht Baselines; nächste Samples sperren neu. Kann Solar.web-Energie springen — nur bewusst nutzen.',
};

// Expert panel labels — sentence-style consistency
meter.expertSettings.label = {
    en: 'Expert: poll, pipeline, Fake SM',
    de: 'Experten: Poll, Pipeline, Fake-SM',
};

fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
console.log('phase1b modbus+vars ok');
