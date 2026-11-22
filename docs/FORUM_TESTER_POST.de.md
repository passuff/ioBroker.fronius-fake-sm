# Forum-Post (Tester) — Copy & paste

**Kategorie:** Tester → Adapter noch nicht im offiziellen Repo  
**Titel:** `[Tester] fronius-fake-sm — Fake Fronius Smart Meter (Gen24) aus Growatt Cloud/Stick`

---

Hallo,

ich suche Tester für einen neuen Adapter:

**ioBroker.fronius-fake-sm** — leichter Fake Fronius Smart Meter (Modbus TCP) für Gen24 als Erzeugerzähler / Sekundärzähler. Datenquelle v1: **Growatt OpenAPI (Cloud)** oder optional **lokaler ShineWiFi-Stick-Proxy**.

## Repo / Install (noch nicht auf npm / Latest)

- GitHub: https://github.com/passuff/ioBroker.fronius-fake-sm
- Install:

```bash
cd /opt/iobroker
npm i passuff/ioBroker.fronius-fake-sm --production --prefix .
iobroker upload fronius-fake-sm
iobroker add fronius-fake-sm
```

## Was bitte testen?

1. Cloud: Token → Geräte suchen → Feed → Leistung/Energie am Fake-SM
2. Gen24: Sekundärzähler Loc/Unit **3**, Port **502**, Technician-Login nötig
3. Adapter-/ioBroker-Restart: Energie-Kontinuität (kein Sprung auf 0, kein Restart-Loop)
4. Optional: lokaler Stick-Pfad (Shine-Login → Online → Stick einrichten)

## Bekannte Limits

- Noch **nicht** auf npm / nicht in Latest — nur GitHub-Install
- Linux Port 502 oft `setcap` / Privilegien nötig
- Gen24 Sekundärzähler nur als **Technician** anlegbar
- Registermap angelehnt an pelle8 Fake-SM (**kein Fork**)

Feedback gerne hier oder als GitHub Issue. Danke!
