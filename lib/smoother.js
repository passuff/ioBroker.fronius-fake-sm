'use strict';

/**
 * EMA + rate-limit power, integrate energy (anti Solar.web spikes).
 * Port of src/smoother.py from growatt-fronius-fakesm.
 */
class Smoother {
    /**
     * @param {object} opts
     */
    constructor(opts = {}) {
        this.emaTauS = Math.max(Number(opts.emaTauS ?? 20), 0.1);
        this.maxDeltaW = Number(opts.maxDeltaWPerTick ?? 200);
        this.driftPerHour = Number(opts.energyDriftCorrectPerHour ?? 0.01);
        this.powerEpsilonW = Number(opts.powerEpsilonW ?? 5);
        this.eTotalOffsetKwh = Number(opts.eTotalOffsetKwh ?? 0);
        this.state = {
            powerW: 0,
            eProducedKwh: 0,
            seeded: false,
            lastTs: Date.now() / 1000,
        };
    }

    /**
     * @param {number} powerW
     * @param {number|null|undefined} eTotalKwh
     * @param {number} [nowS]
     * @param {number} [dtHintS]
     * @param {{ freezeEnergy?: boolean, forcePowerZero?: boolean }} [opts]
     * @returns {{ powerW: number, eProducedKwh: number, changed: boolean, frozen: boolean }}
     */
    update(powerW, eTotalKwh, nowS, dtHintS, opts = {}) {
        const freezeEnergy = !!(opts && opts.freezeEnergy);
        const forcePowerZero = !!(opts && opts.forcePowerZero);
        const now = nowS ?? Date.now() / 1000;
        let dt = dtHintS != null ? dtHintS : Math.max(now - this.state.lastTs, 0);
        if (dt <= 0) {
            dt = 0.001;
        }

        const prevPower = this.state.powerW;
        const prevEnergy = this.state.eProducedKwh;

        if (freezeEnergy) {
            // Hold energy; optionally clear power after hard-stale timeout.
            const changed = forcePowerZero && Math.abs(this.state.powerW) > this.powerEpsilonW;
            if (forcePowerZero) {
                this.state.powerW = 0;
            }
            this.state.lastTs = now;
            return {
                powerW: this.state.powerW,
                eProducedKwh: this.state.eProducedKwh,
                changed,
                frozen: true,
            };
        }

        const target = Number(powerW) || 0;
        const alpha = 1 - Math.exp(-dt / this.emaTauS);
        let ema = this.state.powerW + alpha * (target - this.state.powerW);

        const delta = ema - this.state.powerW;
        if (delta > this.maxDeltaW) {
            ema = this.state.powerW + this.maxDeltaW;
        } else if (delta < -this.maxDeltaW) {
            ema = this.state.powerW - this.maxDeltaW;
        }

        this.state.powerW = ema;

        if (!this.state.seeded && eTotalKwh != null && eTotalKwh > 0) {
            this.state.eProducedKwh = Math.max(eTotalKwh - this.eTotalOffsetKwh, 0);
            this.state.seeded = true;
        } else if (!this.state.seeded) {
            this.state.eProducedKwh = 0;
            this.state.seeded = true;
        }

        this.state.eProducedKwh += (this.state.powerW * dt) / 3_600_000;

        if (eTotalKwh != null && eTotalKwh > 0) {
            const cloudRel = Math.max(eTotalKwh - this.eTotalOffsetKwh, 0);
            const err = cloudRel - this.state.eProducedKwh;
            const maxCorr = Math.abs(cloudRel) * this.driftPerHour * (dt / 3600);
            if (Math.abs(err) > 1e-6 && maxCorr > 0) {
                const step = Math.max(-maxCorr, Math.min(maxCorr, err));
                if (step > 0 || this.state.eProducedKwh + step >= prevEnergy) {
                    this.state.eProducedKwh += step;
                }
            }
        }

        if (this.state.eProducedKwh < prevEnergy) {
            this.state.eProducedKwh = prevEnergy;
        }

        this.state.lastTs = now;
        const changed =
            Math.abs(this.state.powerW - prevPower) >= this.powerEpsilonW ||
            Math.abs(this.state.eProducedKwh - prevEnergy) >= 1e-6;

        return {
            powerW: this.state.powerW,
            eProducedKwh: this.state.eProducedKwh,
            changed,
            frozen: false,
        };
    }
}

module.exports = { Smoother };
