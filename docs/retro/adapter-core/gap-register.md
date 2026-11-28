# Gap Register — adapter-core

**Current phase:** 6 (closure)  
**Branch:** `retro/adapter-brownfield-audit`  
**Date:** 2026-11-25

## Perimeter

| In scope | Role |
|----------|------|
| `main.js` (onReady / onMessage / onUnload) | Lifecycle |
| `lib/adapterBootstrap.js`, `lib/persistNative.js` | Boot + native writes |
| `lib/adapterPoll.js`, `lib/energyBaselines.js` | Cloud poll + energy |
| `lib/localProxy*.js`, `lib/stickOnlineMonitor.js`, `lib/stickSetup*.js` | Local stick path |
| `lib/growattServer*.js`, `lib/growattShinePoll.js`, `lib/growattOpenApi.js` | Proxy + cloud clients |
| `lib/modbusServer.js`, `lib/labFotaAdmin.js`, `lib/asyncSafe.js` | Meter + lab + helpers |

## Register

| ID | Axis | Gap | Evidence | Forward fix | Severity | Effort | Status |
|----|------|-----|----------|-------------|----------|--------|--------|
| G-001 | practice | Native persist of energy restarts instance | `energyBaselines.js` hot path | State-only + unload native | P1 | S | done |
| G-002 | practice | Shine floor stuck at 120s | `main.js` shine branch | Init floor 60 | P1 | S | done |
| G-003 | practice | Upstream leak + unbounded pending | `growattServerClient.js` | Cap 64KB + reconnect backoff | P1 | M | done |
| G-004 | practice | Modbus stop hangs on live socket | `modbusServer.js` | Track + destroy clients | P1 | S | done |
| G-005 | practice | Silent 502→1502 looks healthy | `modbusServer.js`, `main.js` | `info.modbusPort` + warn | P1 | S | done |
| G-006 | practice | Auth classified as rate-limit | `growattShinePoll.js`, `adapterPoll.js` | `GrowattAuthError` + backoff | P1 | M | done |
| G-007 | practice | Empty payload → 0 W OK | Shine + OpenAPI `_pickPowerW` | Require power fields | P1 | S | done |
| G-008 | practice | Fire-and-forget / monitor dies | stick monitor + localProxyStart | try/finally + fireAndLog | P1 | S | done |
| G-009 | practice | Sticky rate-limit flag | `adapterPoll.js` | Clear on non-RL; expire | P1 | S | done |
| G-010 | practice | AES key logged at info | `growattServerClient.js` | Redact fingerprint | P1 | S | done |
| G-011 | thinking | Lab/FOTA always exposed | labFotaAdmin + jsonConfig | `labCommandsEnabled` + Expert UI | P1 | S | done |
| G-012 | practice | Modbus writes from any LAN peer | `modbusServer.js` | Allowlist + write restore | P1 | M | done |
| G-013 | practice | onReady no try/catch / `_stopping` | `main.js` | Wrap + checks | P2 | S | done |
| G-014 | practice | Persist timer not cleared on unload | `main.js` | Clear + native once | P2 | S | done |
| G-015 | missing | Orphan unit tests | `package.json` | Wire into test:unit | P2 | S | done |
| G-016 | practice | Stick SN spoof / 0.0.0.0 bind | proxy path | Bind prefers advertised IP | P2 | M | done |
| G-017 | practice | persistNative no mutex | `persistNative.js` | leave-documented | P2 | M | wont-fix |
| G-018 | selection | God modules >400 LOC | explore | Split later | P3 | L | wont-fix |
| G-019 | thinking | Undocumented restart invariant | persistNative | ADR 001 | P2 | S | done |

## Phase 6 delta

| Metric | Before | After |
|--------|--------|-------|
| P1 open | 12 | 0 |
| P2 open (fixable) | 5 | 0 (G-017 wont-fix with reason) |
| Unit tests in npm chain | 55 | 67 |
| `npm run test:unit` | — | PASS (re-verify in remediation) |

### Upstream behavior (authoritative)

- Upstream close/error → **do not** destroy stick; schedule reconnect with exponential backoff.
- Pending buffer capped at 64KB; overflow still drops that stick session as last resort.

### Residual (Low / accepted)

- G-017 persistNative mutex
- G-018 module splits
- Admin `onMessage` command-table refactor
- Commit/push (await user)

### Remediation closure

- **v1** (`gap-remediation-adapter-brownfield_25cd1ebd`): OpenAPI fail-closed, lab Admin toggle, localProxyStart `fireAndLog`, proxy bind, docs sync — **closed**.
- **v2 recheck** (2026-11-25): `npm run test:unit` + `test:package` + `test:integration` exit 0; six Final Verification bullets spot-checked PASS; **no Blocking/High** remain.
