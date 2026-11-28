# Target Design — adapter-core remediation

## What changes

1. State-only energy publish on hot path; native persist on unload (budgeted, ≥0.5 kWh delta).
2. Shine floor init 60; auth vs rate-limit split; empty power payload fails closed (Shine **and** OpenAPI).
3. Upstream pending cap 64KB; on upstream death **reconnect with backoff** (keep local stick); redact AES logs.
4. Modbus client tracking + stop destroy; write rollback; peer allowlist when `froniusIp` known; publish actual port.
5. Stick monitor always reschedules; `fireAndLog` for void async (incl. `localProxyStart`).
6. Lab commands gated by `labCommandsEnabled` (default false) + Expert Admin checkbox + i18n.
7. Wire previously orphaned unit tests into `npm run test:unit`.
8. Local proxy bind prefers `advertisedModbusIp` when `localHost` is unset or `0.0.0.0`.

## What does not change

- Fake-SM register map / Gen24 Loc3 semantics
- Growatt vendor MD5 Shine login / AES KDF constants
- Multi-stick feed selection model
- Large module splits (deferred as P3 wont-fix for this slice)
- persistNative mutex (deferred / wont-fix with reason)

## Fix sequence

P1 correctness → P1 security gates → P2 lifecycle → test wiring → re-audit → gap remediation
