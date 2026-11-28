# Baseline Audit — adapter-core (2026-11-25)

## Recon

- Stack: Node ≥20 CommonJS ioBroker adapter (`@iobroker/adapter-core`, `jsmodbus`)
- Entry: `main.js` → `onReady` / `onMessage` / `onUnload`
- Hot path: cloud poll (`adapterPoll`) + optional local `:5279` (`localProxyStart` → `growattServer*`) → Fake-SM Modbus (`modbusServer`) → Gen24
- Tests: 66 `*.test.js`; pre-retro only 55 in `npm test` chain; no coverage tool
- TODO/FIXME: none in perimeter

## Reviewer summary (pre-fix)

| Source | P0 | P1/HIGH | P2 | P3 |
|--------|----|---------|----|----|
| silent-failure-hunter | 0 | 5 | 8 | many |
| typescript-reviewer (JS) | 0 | 4 | 19 | 14 |
| security-reviewer | 0 | 2 | 4 | 5 |
| explore | — | hotspot list | god modules | 11 untested lib files |

Top evidence pointers: `energyBaselines.js:213-230`, `growattServerClient.js:104-280`, `modbusServer.js:220-252`, `main.js:98/261`, `growattShinePoll.js:44-51`, `labFotaAdmin.js:17-54`.
