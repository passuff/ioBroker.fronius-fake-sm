# Lab smoke: Gen24 Modbus + Stick frames

Repeatable checks after deploy/restart of `fronius-fake-sm` on the lab host.
Do **not** commit host passwords; use environment variables.

## Prerequisites

| Env | Example | Purpose |
|-----|---------|---------|
| `LAB_HOST` | `192.168.1.19` | ioBroker lab IP |
| `LAB_USER` | `passuff` | SSH user |
| `LAB_PASS` | *(unset in git)* | SSH password |
| `LAB_INSTANCE` | `fronius-fake-sm.0` | Adapter instance |

Optional: `LAB_SSH` = path to private key instead of password.

## Checklist (after adapter restart, wait ~2–3 min)

1. **Modbus listening** — `info.modbusListening` = `true`
2. **No short-session spam** — log has no repeated `Gen24 Modbus session short` for healthy polls (≥3 RX). Occasional abort with Loc3 hint is OK if Gen24 is misconfigured.
3. **Loc3** — when Gen24 secondary meter is configured to `advertisedModbusIp` / unit: `info.gen24MeterVisible` = `true`. If false, lastError/warn should mention Loc3 meter IP/unit.
4. **Stick frames** — `info.localFrameUnknown` = `false` (or briefly true then clears); no lasting `Lokaler Stick sendet unbekannte Frames` for feed SN after AES handshake.
5. **Frame status** — `info.localFrameStatus` = `ok` when feed stick is online and AES data flows.
6. **Energy** — if Loc3 visible, no persistent `Energy continuity: Gen24 truth unavailable` without Loc3 setup hint.

## Env-based smoke script

From repo root (credentials via env only):

```bash
# PowerShell
$env:LAB_HOST="192.168.1.19"
$env:LAB_USER="passuff"
$env:LAB_PASS="***"
python scripts/_smoke_gen24_stick.py
```

Exit code `0` = checks passed; non-zero = failed assertion printed to stdout.

## Manual one-liners (on lab host)

```bash
iobroker state getValue fronius-fake-sm.0.info.modbusListening
iobroker state getValue fronius-fake-sm.0.info.gen24MeterVisible
iobroker state getValue fronius-fake-sm.0.info.localFrameUnknown
iobroker state getValue fronius-fake-sm.0.info.localFrameStatus
grep -E 'Modbus session short|unbekannte Frames|Loc3' /opt/iobroker/log/iobroker.current.log | tail -20
```
