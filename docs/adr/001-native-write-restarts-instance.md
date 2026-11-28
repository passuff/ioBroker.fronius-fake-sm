# ADR 001: Native writes restart the instance

- **Status:** proposed (reconstructed) — 2026-11-25 retro
- **Date of original decision:** predates this record (observed in `persistNative.js` header and runtime behavior)

## Context

ioBroker `setForeignObject` on `system.adapter.<ns>` causes the js-controller to restart the adapter instance. Early versions persisted runtime energy counters into native, causing periodic Modbus/stick session drops.

## Decision

Runtime counters such as `lastPublishedEProducedKwh` are written to states on the hot path. Native persistence of that value happens at most on unload (or rare admin actions), never from the smooth/poll loop.

## Consequences

- Survives unload/restart via state + optional unload native write.
- Avoids Gen24 meter flaps from energy-driven restarts.
- Operators must not expect live native config to track every Wh.
