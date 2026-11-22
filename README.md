# ioBroker.fronius-fake-sm

Lightweight **Fake Fronius Smart Meter** for Gen24 (external producer / Erzeugerzähler).

One adapter process:

1. Polls an inverter cloud API (v1: **Growatt OpenAPI token**) — **default**
2. Optionally receives **local ShineWiFi stick** traffic on `:5279` (transparent cloud forward + auto-calibrate)
3. Smooths power / integrates energy (anti Solar.web spikes)
4. Serves **Modbus TCP** with a Fronius TS65A-3 style register map (inspired by [pelle8/Fake-Fronius-Smartmeter](https://github.com/pelle8/Fake-Fronius-Smartmeter); **not a fork**)

No Mosquitto, no Blockly, no `growatt.0`, no external `fake_meter.py`.

## Manufacturer docs

- [Fronius Solar API / Gen24](https://www.fronius.com/en/solar-energy/installers-partners/technical-data/all-products/system-monitoring/open-interfaces/fronius-solar-api)
- [Growatt OpenAPI](https://www.growatt.com/) / Shine server (`server.growatt.com`)

## Why it stays light

| Do | Don't |
|----|--------|
| One OpenAPI call every 60–300 s | 115 states every 2 s |
| `setStateChanged` + deadband (~10 states) | Unconditional `setState` storms |
| Modbus answers from RAM | MQTT keepalive + Fake-SM restart loop |
| Night throttle when \|P\|≈0 | Busy-loop if cloud is slow |

Cloud APIs have **no push** — polling discovers changes. States and Modbus are decoupled: Fronius always sees live registers; ioBroker only writes when values change.

## Install (from GitHub)

Until the adapter is on npm / Latest:

```bash
cd /opt/iobroker
npm i passuff/ioBroker.fronius-fake-sm --production --prefix .
iobroker upload fronius-fake-sm
iobroker add fronius-fake-sm
```

Or install from the git URL, then `iobroker upload fronius-fake-sm` and create an instance.

**Port 502:** Gen24 usually requires TCP 502. On Linux grant capability or run privileged:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
```

### Gen24: add Fake SM as secondary meter

**Technician login is required** (Customer / Endkunde cannot add or edit secondary meters).

1. Open `https://<Gen24-IP>` → log in as **Technician**
2. **Device configuration → Components → Add component** (Gerätekonfiguration → Komponenten → Komponente hinzufügen)
3. Enter **ioBroker IP**, **Port 502**, free **Modbus address** (default **3**; never 1 = primary RTU)
4. Use the **same Modbus address** in the adapter
5. Application: **Producer meter (Erzeugerzähler)**, Category: **Inverter**; leave the rest default

Adapter defaults after Fronius LAN search: port `502`, Modbus address `3`, Location `3`, listen `0.0.0.0`. The scan auto-selects the inverter that already reports meters (master).

`connectionType`/`dataSource` are `cloud`/`poll` because the default feed is Growatt OpenAPI. The optional **local stick proxy** path is documented above and in the admin UI (Lokal).

## Config (admin)

1. Tab **Fremd-WR**: manufacturer **Growatt**, then **Datenweg** Cloud **or** Lokal (only one path is shown)
2. **Cloud**: OpenAPI **token** (encrypted) → Search devices → tick feeders
3. **Lokal**: Shine web user/password only (no API token) → status green → **Stick einrichten** → switch after verified
4. Tab **Modbus / Fronius**: Search Fronius → enter ioBroker IP + Modbus address on Gen24 as Technician

Growatt `FREQUENTLY_ACCESS` triggers a cooldown; Modbus keeps the last sample. After a hard-stale timeout power goes to 0 W.

### Energy continuity (eTotal / Fake-SM)

On every adapter / ioBroker restart the instance first reads the Gen24 Solar API (`GetMeterRealtimeData`, meter with `Meter_Location_Current` = Fake Location, usually **3**) and takes `EnergyReal_WAC_Sum_Produced` (Wh→kWh) as truth. Fake-SM Modbus continues from that value; device baselines are unlocked only when missing or inconsistent with that truth.

Default **Auto baselines**: each enabled Growatt device locks an `eBaseline` on the first valid eTotal; Fake-SM energy is `Σ max(eTotal − baseline, 0)`. If Gen24 is unreachable, `lastPublishedEProduced` / `meter.eProduced` is the fallback. **Manual** mode keeps the classic global `eTotal − offset`. Expert → Reset baselines also re-anchors from Gen24.

### Local realtime

Local redirects the stick to this host (`:5279`). Forward keeps Growatt cloud fed. Setup needs the stick online at Growatt (often unavailable at night). OpenAPI token is **not** required for the local path.

Fallback if stick offline: AP scan on `:5280` (button / LED blue).

## Standalone smoke test

```bash
cd iobroker.fronius-fake-sm
npm install
npm test
set GROWATT_TOKEN=...   # optional
node run-standalone.js --port 1502
```

## Changelog

### **WORK IN PROGRESS**

Current development line is published from GitHub only (not yet on npm / Latest). See `io-package.json` `common.news` for per-version notes.

## License

MIT
