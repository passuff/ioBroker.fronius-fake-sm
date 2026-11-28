# Reconstructed Spec — adapter-core

## Requirements

1. **WHEN** Growatt cloud sample arrives **THEN** Fake-SM Modbus power/energy registers update via smoother.
2. **WHEN** local stick feed is active and calibrated **THEN** cloud poll is skipped and local `pac_w` feeds Modbus.
3. **WHEN** OpenAPI returns rate-limit **THEN** cooldown applies and connection stays green only if a prior OK sample exists.
4. **WHEN** Shine/OpenAPI auth fails **THEN** connection is false (not painted as cooldown).
5. **WHEN** energy rises during runtime **THEN** `info.lastPublishedEProduced` updates without restarting the instance.
6. **WHEN** instance unloads **THEN** last-published energy may be written to native once.
7. **WHEN** Modbus bind falls back to 1502 **THEN** `info.modbusPort` reflects the actual port and lastError warns.
8. **WHEN** `labCommandsEnabled` is false **THEN** lab/FOTA admin commands are rejected.
9. **WHEN** stick upstream closes **THEN** stick socket is dropped (reconnect) and pending is capped.

## Invariants

- Native `setForeignObject` restarts the instance — must not be on the smooth/poll hot path.
- Shine poll floor default is 60s; OpenAPI 120s.
- Fake-SM holding registers are authoritative from Growatt samples; LAN Modbus writes are rolled back.
- Lab SN allowlist comes from config/env, never from the admin message payload.
