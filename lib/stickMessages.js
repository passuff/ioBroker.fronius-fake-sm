'use strict';

/** German user-facing texts for Admin sendTo (`error` / `result`). */
const MSG = {
    noIp: 'Keine lokale IP gefunden. Prüfe die Netzwerkverbindung von ioBroker.',
    needPassword:
        'Shine-Web-User/Passwort fehlt. Unter „Lokal“ eintragen — dann „Mit Cloud verbinden“ und Stick wählen.',
    noStickSn:
        'Kein Stick gewählt. Unter „Lokal“ → Stick wählen (nach „Cloud verbinden“).',
    loginFail: (detail) => `Shine-Login fehlgeschlagen: ${detail}`,
    offline:
        'Growatt erreicht den Stick gerade nicht (oft nachts: Stick/WR ohne Cloud-Session). Umbiegen braucht eine live Remote-Session — der Adapter prüft weiter im Hintergrund. Sobald der Status grün („WR verbunden“) ist: „Stick patchen“.',
    offlineShort: 'Stick bei Growatt nicht erreichbar — Patchen wartet.',
    offlineBlocked:
        '„Stick patchen“ wartet: Growatt hat gerade keine Remote-Session zum Stick (häufig nachts). Sobald der Status grün ist, wird der Button aktiv.',
    remoteNotReady: (sn, lastUpdate) =>
        `Stick ${sn} in Shine sichtbar${lastUpdate ? ` · Update ${lastUpdate}` : ''}, aber Remote-Befehl noch nicht bereit — „Stick patchen“ bleibt gesperrt.`,
    permissionDenied: (sn) =>
        `Stick-SN ${sn} ungültig oder kein Zugriff — bitte unter „Lokal“ den aktuellen Stick wählen.`,
    connectOk: (plants, sticksHint) =>
        `Cloud verbunden (${plants} Anlage${plants === 1 ? '' : 'n'})${sticksHint || ''}.`,
    online: (sn, ip) =>
        `Online: Stick ${sn} bei Growatt online.${ip ? ` Server-IP: ${ip}.` : ''}`,
    onlineList: (sn, lastUpdate) =>
        `Online: Stick ${sn} (Shine wie App)${lastUpdate ? ` · Update ${lastUpdate}` : ''}.`,
    waitingCreds: 'Warte auf Shine-User + Passwort (Lokal) — Online-Prüfung läuft dann automatisch.',
    waitingStick: 'Warte auf Stick-Auswahl unter „Lokal“.',
    checking: 'Prüfe Stick-Online-Status bei Growatt…',
    labelOnline: 'WR verbunden',
    labelOffline: 'WR nicht verbunden',
    labelUnknown: 'WR nicht verbunden',
    labelWaiting: 'WR nicht verbunden',
    setupOk: (sn, ip, port) =>
        `Fertig: Stick ${sn} soll ${ip}:${port} nutzen. Warte auf Verbindung (info.localConnection). Cloud bleibt per Forward.`,
    apOk: (hosts, ip) =>
        `AP-Stick gefunden (${hosts.join(', ')}). Stick sollte sich mit ${ip}:5279 verbinden.`,
    apOnlyHint:
        'Kein Stick im AP-Modus (:5280). Remote ging nicht, weil der Stick offline ist. Bei Sonne erneut versuchen — oder Taste drücken bis LED blau.',
    restoreOk: (sn, host = 'server.growatt.com') =>
        `Umleitung entfernt: Stick ${sn} zeigt wieder auf ${host}:5279. Datenweg Cloud — OpenAPI-Poll aktiv, lokaler Proxy aus.`,
    restoreNeedOnline:
        'Umleitung entfernen braucht eine erreichbare Stick-Session (Shine online oder lokale TCP-Verbindung). Der lokale Proxy bleibt aktiv und leitet weiter zur Cloud — später erneut versuchen oder Stick im AP-Modus (:5280).',
    localProxyOnly:
        'nicht verbunden bei Growatt – Stick ist aber lokal am Proxy (:5279) verbunden; Cloud-Sitzung baut sich über den Forward auf.',
    restoreWaitStick: 'Entferne Umleitung: warte auf den Stick am lokalen Proxy…',
    restoreWaitShine: (sn) => `Warte auf Growatt-Sitzung zu Stick ${sn} (über Proxy-Forward)…`,
    restoreSending: (sn, host, via) => `Setze Stick ${sn} auf ${host}:5279 (${via})…`,
    restoreVerifying: 'Prüfe, ob der Stick den lokalen Proxy verlässt…',
    restoreStillLocal: (sn) =>
        `Stick ${sn} verbindet sich weiterhin auf diesen Host — Umleitung NICHT entfernt. Proxy bleibt aktiv (Cloud-Forward läuft). Später erneut versuchen.`,
    cloudDefaultHost: 'server.growatt.com',
    ambiguousIps:
        'Mehrere LAN-IPs gefunden — bitte unter „Host-IP für Stick-Server“ wählen oder „Netzwerk prüfen“, sonst droht die falsche Adresse im Stick.',
    restoreBeforeCloud:
        'Datenweg ist Cloud, aber der Stick zeigt noch auf diesen Host. Bitte „Umleitung entfernen“ — der lokale Proxy bleibt bis dahin aktiv.',
};

/**
 * @param {boolean|null} online
 * @param {string} [_detail] ignored — UI shows one short phrase only
 */
function onlineLabel(online, _detail) {
    if (online === true) {
        return MSG.labelOnline;
    }
    return MSG.labelOffline;
}

module.exports = { MSG, onlineLabel };
