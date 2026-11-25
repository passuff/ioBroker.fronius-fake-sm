# ioBroker.fronius-fake-sm

[![Donate](https://img.shields.io/badge/paypal-donate%20%7C%20spenden-blue.svg?logo=paypal)](https://paypal.me/MichaelHeckler)

Lightweight **Fake Fronius Smart Meter** for Gen24 (external producer / Erzeugerzähler).

One adapter process:

1. Polls an inverter cloud API (v1: **Growatt OpenAPI token**) — **default**
2. Optionally receives **local ShineWiFi-X** stick traffic on `:5279` (transparent cloud forward + auto-calibrate)
3. Smooths power / integrates energy (anti Solar.web spikes)
4. Serves **Modbus TCP** with a Fronius TS65A-3 style register map (inspired by [pelle8/Fake-Fronius-Smartmeter](https://github.com/pelle8/Fake-Fronius-Smartmeter); **not a fork**)

No Mosquitto, no Blockly, no `growatt.0`, no external `fake_meter.py`.

## Supported hardware / Unterstützte Hardware

v1 is **Growatt → Fake Fronius SM → Gen24** only. Stick requirements differ by data path.

### Growatt — Cloud (default)

- Stick model largely **does not matter** as long as the plant reports data in Shine / OpenAPI.
- USB-X dongles (ShineWiFi-X, ShineLAN-X, ShineLink-X, …) fit inverters with the round USB port: MIN / MIC / MOD / MID / MAX, SPH with **UP** on the type label.
- **Not** the same dongle family: RS232 sticks (ShineWiFi-S, older ShineLAN, SPH/SPA without UP, S-series) and off-grid SPF (ShineWiFi-F). Those can still feed **cloud** if they already appear in Shine — they are not the target for the local proxy.

### Growatt — Local (`:5279` stick proxy)

| Status | Hardware |
|--------|----------|
| **Supported (tested)** | **ShineWiFi-X** — Growatt TCP `:5279`, SoftAP `:5280`, Shine remote SERVERIP |
| **Expected, not tested here** | **ShineLAN-X** — same cloud TCP `:5279` / server-IP redirect (Grott community); SoftAP / setup UI may differ |
| **Not supported** | ShineWiLan-X2 / ShineWiFi-X2 (local Modbus `:502`, different protocol), ShineWiFi-S / RS232, ShineLink LANbox as its own setup path, custom-flash firmware as a product requirement |

Local binary parse is tuned for **TLX / MIN**-like records. Cloud OpenAPI accepts more device type slugs.

### Fronius

- **Supported:** Primo / Symo **GEN24** with a **secondary** meter: type *Fronius Smart Meter (TCP)*, application **producer / Erzeugerzähler**, location/unit typically **3**, port **502**, **Technician** login.
- Emulates a TS65A-3-style register map. A physical Fronius Smart Meter is **not** required.
- **Not a target:** older Symo/Primo + Datamanager 2.0 without the Gen24 components UI; Fake SM as **primary** meter (Modbus address **1**).

### Growatt — Cloud (Default)

- Stick-Modell ist weitgehend **egal**, solange die Anlage in Shine / OpenAPI Daten liefert.
- USB-X-Dongles (ShineWiFi-X, ShineLAN-X, ShineLink-X, …) passen an WR mit USB-Rundbuchse: MIN / MIC / MOD / MID / MAX, SPH mit **UP** auf dem Typenschild.
- **Andere** Dongle-Familie: RS232 (ShineWiFi-S, älteres ShineLAN, SPH/SPA ohne UP, S-Serie) und SPF (ShineWiFi-F). Können die **Cloud** speisen, wenn sie in Shine sichtbar sind — nicht Ziel des lokalen Proxys.

### Growatt — Lokal (`:5279` Stick-Proxy)

| Status | Hardware |
|--------|----------|
| **Unterstützt (getestet)** | **ShineWiFi-X** — Growatt-TCP `:5279`, SoftAP `:5280`, Shine-Remote SERVERIP |
| **Erwartet, hier nicht getestet** | **ShineLAN-X** — gleiches Cloud-TCP `:5279` / Server-IP-Redirect (Grott-Community); SoftAP-/Setup-UI kann abweichen |
| **Nicht unterstützt** | ShineWiLan-X2 / ShineWiFi-X2 (lokales Modbus `:502`, anderes Protokoll), ShineWiFi-S / RS232, ShineLink-LANbox als eigener Setup-Pfad, Custom-Flash-FW als Produktvoraussetzung |

Lokales Binary-Parsing ist auf **TLX / MIN**-ähnliche Records ausgelegt. Cloud-OpenAPI kennt mehr Device-Typen.

### Fronius

- **Unterstützt:** Primo / Symo **GEN24** mit **Sekundärzähler**: Typ *Fronius Smart Meter (TCP)*, Anwendung **Erzeugerzähler**, Location/Unit typisch **3**, Port **502**, Login **Techniker**.
- Emuliert eine TS65A-3-ähnliche Registermap. Physischer Fronius-SM wird **nicht** benötigt.
- **Kein Ziel:** ältere Symo/Primo + Datamanager 2.0 ohne Gen24-Komponenten-UI; Fake-SM als **Primärzähler** (Modbus-Adresse **1**).

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

Two tabs: **Fremd-WR** (source + collapsible Polling / WR-Variablen) → **Modbus / Fronius**.

1. Tab **Fremd-WR**: manufacturer **Growatt** (v1), then **Datenweg** Cloud **or** Lokal
2. Collapsible **Polling-Vorlage**: choose OpenAPI / Shine / Local → **Anwenden** (instance running)
3. **Cloud**: OpenAPI **token** (or Shine login) → Search devices → tick feeders. Proxy live lines appear only with an active stick redirect.
4. **Lokal**: Shine web user/password → **Connect cloud** → pick stick → **Redirect stick**. Status lives in the custom panel (not duplicated as jsonConfig rows).
5. Collapsible **WR-Variablen**: enable datapoints under `inverter.<SN>`
6. Tab **Modbus / Fronius**: short Gen24 steps → **Gen24 suchen** → Unit ID + ioBroker IP (same values as on Gen24 as Technician)

Growatt `FREQUENTLY_ACCESS` triggers a cooldown; Modbus keeps the last sample. After a hard-stale timeout power goes to 0 W.

### Polling presets

Tab **Fremd-WR** → collapsible **Polling preset** + **Apply** fills cloud poll / night poll / Fake-SM smooth intervals (edit numbers under Modbus → Expert afterwards → `custom`):

| Preset | `pollIntervalS` | `nightPollIntervalS` | `smoothIntervalS` (Fake SM) |
|--------|-----------------|----------------------|-----------------------------|
| **OpenAPI** (slowest) | 120 | 300 | 5 |
| **Shine** login | 60 (≥30 floor) | 300 | 5 |
| **Local** stick | 300 (cloud fallback only) | 600 | **1** |

Fake-SM at **1 s** is the useful maximum for Gen24 Modbus. ioBroker inverter vars stay throttled (local power ~5 s catalog default; user may go down to 1 s for power). Do not write every state every second.

### Energy continuity (eTotal / Fake-SM)

On every adapter / ioBroker restart the instance first reads the Gen24 Solar API (`GetMeterRealtimeData`, meter with `Meter_Location_Current` = Fake Location, usually **3**) and takes `EnergyReal_WAC_Sum_Produced` (Wh→kWh) as truth. Fake-SM Modbus continues from that value; device baselines are unlocked only when missing or inconsistent with that truth.

Default **Auto baselines**: each enabled Growatt device locks an `eBaseline` on the first valid eTotal; Fake-SM energy is `Σ max(eTotal − baseline, 0)`. If Gen24 is unreachable, `lastPublishedEProduced` / `meter.eProduced` is the fallback. **Manual** mode keeps the classic global `eTotal − offset`. Expert → Reset baselines also re-anchors from Gen24.

### Local realtime

Local redirects the stick to this host (`:5279`). Forward keeps Growatt cloud fed. OpenAPI token is **not** required for the local path.

Admin **Lokal** panel (custom UI): short setup (Shine connect → pick stick → redirect) above a live status list of redirected sticks. Remove redirect is a per-stick menu action with confirmation.

Fallback if cloud redirect fails: AP scan on `:5280` (Expert).

Rebuild the panel after UI changes: `npm run build:admin` (writes `admin/custom/`).

### Proxy always on / reinstall

For Growatt the adapter always listens on `:5279` with cloud forward, even when the data path is **Cloud**. That way an already redirected stick (register 17 = ioBroker IP) reconnects after an adapter or ioBroker reinstall instead of staying orphaned and offline in Shine.

- A bind failure is a warning only (e.g. port already used by Grott); Cloud OpenAPI/Shine polling continues.
- Detecting a stick on the proxy sets `cloudStickRedirectActive` so the yellow banner and **Remove redirect** stay available.
- The proxy keeps **at most one** stick TCP session (replaces zombies after WiFi/power drops).

### Unknown stick firmware

ShineWiFi-X **3.1.1.7** encrypts data with AES-CBC-256 after a `0x41` key negotiation. Classic local decode (XOR + CRC) fails. From **0.5.51** the proxy derives the session key/IV from the `0x41` UP handshake (SHA256 of RandNum‖bootstrap → ASCII-hex AES-256 key) and attempts AES-CBC decrypt of later frames. If decrypt is not yet confirmed for a session, `info.localFrameUnknown` still warns while **Cloud-Forward continues**. Captures: sendTo `startFrameCapture`. Details: `docs/FW_3117_FRAME_ANALYSIS.md`.

## Standalone smoke test

```bash
cd iobroker.fronius-fake-sm
npm install
npm test
set GROWATT_TOKEN=...   # optional
node run-standalone.js --port 1502
```

## Testers

Forum post draft (German): [docs/FORUM_TESTER_POST.de.md](docs/FORUM_TESTER_POST.de.md)  
GitHub: https://github.com/passuff/ioBroker.fronius-fake-sm/issues/1

## Donate

Free adapter. If it helps you, a voluntary donation is welcome.  
Kostenloser Adapter. Wenn er dir hilft, freue ich mich über eine freiwillige Spende.

[![Donate with PayPal](admin/paypal-donate-button.png)](https://paypal.me/MichaelHeckler)

## Changelog

### 0.5.45

- (Passuff) Document supported Growatt sticks (Wifi-X / Lan-X) and Gen24-only Fronius target

### **WORK IN PROGRESS**

- (Passuff) Optional PayPal donation link (README, config page)
- (Passuff) Phase-1: `@iobroker/testing` package/integration tests, `test-and-release.yml`, release-script

Current development line is published from GitHub; npm / Latest follow after Forum validation. See `io-package.json` `common.news` for per-version notes.

## License

MIT
