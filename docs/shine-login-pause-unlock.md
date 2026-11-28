# Shine login pause / unlock (lab)

Growatt can lock the portal account for ~24h after `/login` storms. The adapter
supports a durable pause so local Fake-SM (Modbus + stick proxy) keeps running
without hitting Shine.

## Pause file (preferred on lab)

Path (on the ioBroker host, inside the adapter install):

```text
/opt/iobroker/node_modules/iobroker.fronius-fake-sm/.shine-pause-until
```

Contents: epoch milliseconds (UTC) until which Shine web logins stay blocked.
On adapter start, `applyShinePauseFromConfig` seeds `_shineAuthUntil` from this
file (and optionally from native `shinePauseLoginsUntil`).

While the pause is active you should see:

```text
Shine auth/lock backoff …s — shinePauseLoginsUntil
```

and **no** recurring `Shine web login OK` lines.

## Unlock (only after Growatt ban ends)

1. Confirm the portal account works again in a browser (server.growatt.com).
2. On the lab host:

```bash
rm -f /opt/iobroker/node_modules/iobroker.fronius-fake-sm/.shine-pause-until
cd /opt/iobroker && iobroker restart fronius-fake-sm.0
```

3. Expect at most rare `Shine web login OK` (session reuse, monitor every
   10–20 min) — **not** minutely doubles.
4. If `native write reason=stickOnlineStatus` appears again, treat as a
   regression (status must stay states-only).

## Do not unlock early

Removing the pause while the account is still locked re-triggers `/login` and
can extend the ban.
