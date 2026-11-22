'use strict';

/**
 * Smoke-run without js-controller: Modbus + optional Growatt OpenAPI.
 *
 * Usage:
 *   set GROWATT_TOKEN=...
 *   node run-standalone.js [--port 1502]
 */

const { GrowattOpenApiClient } = require('./lib/growattOpenApi');
const { Smoother } = require('./lib/smoother');
const { FroniusModbusServer } = require('./lib/modbusServer');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i >= 0 && process.argv[i + 1]) {
        return process.argv[i + 1];
    }
    return fallback;
}

async function main() {
    const port = Number(arg('--port', process.env.MODBUS_PORT || 1502));
    const token = process.env.GROWATT_TOKEN || '';
    const deviceSn = process.env.GROWATT_DEVICE_SN || 'FRJ7CJD0S7';
    const deviceType = process.env.GROWATT_DEVICE_TYPE || 'min';

    const smoother = new Smoother({ eTotalOffsetKwh: Number(process.env.E_OFFSET || 0) });
    const modbus = new FroniusModbusServer({
        host: '0.0.0.0',
        port,
        fakeUniqueId: 3,
        log: console.log,
        error: console.error,
    });
    await modbus.start();

    let lastSample = { power_w: 0, e_total_kwh: null, u1: 237, f: 50 };
    const client = token
        ? new GrowattOpenApiClient({
              token,
              deviceSn,
              deviceType,
              plantId: process.env.GROWATT_PLANT_ID || '10053900',
              log: console.log,
          })
        : null;

    async function poll() {
        if (!client) {
            return;
        }
        try {
            lastSample = await client.fetch();
            console.log(
                `sample power=${lastSample.power_w.toFixed(1)} W eTotal=${lastSample.e_total_kwh.toFixed(2)}`,
            );
        } catch (err) {
            console.error('poll failed', err.message);
        }
    }

    await poll();
    setInterval(poll, Number(process.env.POLL_S || 60) * 1000);

    setInterval(() => {
        const r = smoother.update(lastSample.power_w, lastSample.e_total_kwh, undefined, 5);
        const meter = modbus.updateFromMeter({
            powerW: r.powerW,
            eProducedKwh: r.eProducedKwh,
            u1: lastSample.u1 || 237,
            u2: 237,
            u3: 239,
            f: lastSample.f || 50,
        });
        console.log(
            `modbus pt=${r.powerW.toFixed(1)} e=${r.eProducedKwh.toFixed(3)} i1=${meter.i1.toFixed(2)}`,
        );
    }, 5000);

    console.log(`Standalone Fake SM on :${port} (set GROWATT_TOKEN for live cloud)`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
