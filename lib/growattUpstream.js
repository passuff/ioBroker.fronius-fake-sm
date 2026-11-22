'use strict';

const dns = require('dns');
const { promisify } = require('util');

const resolve4 = promisify(dns.resolve4);

/** Public resolvers — bypass local DNS overrides of server.growatt.com. */
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const DEFAULT_HOST = 'server.growatt.com';
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Resolve Growatt cloud IP via public DNS to avoid loop when local DNS overrides
 * server.growatt.com → ioBroker.
 */
class UpstreamResolver {
    /**
     * @param {object} [opts]
     * @param {string} [opts.host]
     * @param {string} [opts.fixedIp] if set, skip resolve
     * @param {(m:string)=>void} [opts.log]
     */
    constructor(opts = {}) {
        this.host = opts.host || DEFAULT_HOST;
        this.fixedIp = opts.fixedIp ? String(opts.fixedIp).trim() : '';
        this.log = opts.log || (() => {});
        /** @type {string} */
        this._cachedIp = this.fixedIp || '';
        this._cachedAt = 0;
        this._inflight = null;
    }

    /**
     * @returns {Promise<string>}
     */
    async resolve() {
        if (this.fixedIp) {
            return this.fixedIp;
        }
        const now = Date.now();
        if (this._cachedIp && now - this._cachedAt < CACHE_TTL_MS) {
            return this._cachedIp;
        }
        if (this._inflight) {
            return this._inflight;
        }
        this._inflight = this._resolveOnce()
            .then((ip) => {
                this._cachedIp = ip;
                this._cachedAt = Date.now();
                this._inflight = null;
                return ip;
            })
            .catch((err) => {
                this._inflight = null;
                if (this._cachedIp) {
                    this.log(`upstream DNS failed (${err.message}) — using cached ${this._cachedIp}`);
                    return this._cachedIp;
                }
                throw err;
            });
        return this._inflight;
    }

    async _resolveOnce() {
        let lastErr = null;
        for (const server of PUBLIC_RESOLVERS) {
            try {
                const resolver = new dns.Resolver();
                resolver.setServers([server]);
                const resolve = promisify(resolver.resolve4.bind(resolver));
                const addrs = await resolve(this.host);
                if (addrs && addrs.length) {
                    this.log(`upstream ${this.host} → ${addrs[0]} (via ${server})`);
                    return addrs[0];
                }
            } catch (err) {
                lastErr = err;
            }
        }
        // last resort: system resolver
        try {
            const addrs = await resolve4(this.host);
            if (addrs && addrs.length) {
                this.log(`upstream ${this.host} → ${addrs[0]} (system DNS)`);
                return addrs[0];
            }
        } catch (err) {
            lastErr = err;
        }
        throw lastErr || new Error(`cannot resolve ${this.host}`);
    }

    cachedIp() {
        return this._cachedIp || this.fixedIp || '';
    }
}

module.exports = { UpstreamResolver, DEFAULT_HOST, PUBLIC_RESOLVERS };
