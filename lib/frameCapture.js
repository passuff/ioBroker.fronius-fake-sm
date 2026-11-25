'use strict';

const fs = require('fs');
const path = require('path');
const { FrameSplitter, decodeFrame } = require('./growattProto');

/**
 * Capture stick↔cloud TCP traffic to a rotating log under iobroker-data.
 */
class FrameCapture {
    /**
     * @param {object} opts
     * @param {string} opts.dir
     * @param {number} [opts.durationMs]
     * @param {number} [opts.maxBytes]
     * @param {{wire?:number, minLen?:number}|null} [opts.stopWhen]
     * @param {(m:string)=>void} [opts.log]
     */
    constructor(opts) {
        this.dir = opts.dir;
        this.durationMs = Number(opts.durationMs ?? 30 * 60 * 1000);
        this.maxBytes = Number(opts.maxBytes ?? 5 * 1024 * 1024);
        this.stopWhen = opts.stopWhen && typeof opts.stopWhen === 'object' ? opts.stopWhen : null;
        this.log = opts.log || (() => {});
        this.bytes = 0;
        this.lines = 0;
        this.active = false;
        this._timer = null;
        this._upSplit = new FrameSplitter();
        this._downSplit = new FrameSplitter();
        this.filePath = '';
        this._stream = null;
        /** @type {Set<string>} */
        this._keySources = new Set();
        this._matched = false;
    }

    start() {
        if (this.active) {
            return this.filePath;
        }
        fs.mkdirSync(this.dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        this.filePath = path.join(this.dir, `capture-${stamp}.log`);
        const header = `# frame capture start ${new Date().toISOString()} durationMs=${this.durationMs}\n`;
        fs.writeFileSync(this.filePath, header);
        this.active = true;
        this.bytes = Buffer.byteLength(header);
        this.lines = 1;
        this._keySources = new Set();
        this._matched = false;
        this._timer = setTimeout(() => this.stop('timeout'), this.durationMs);
        this.log(`frame capture started → ${this.filePath}`);
        return this.filePath;
    }

    stop(reason = 'manual') {
        if (!this.active) {
            return this.filePath;
        }
        this.active = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._write(`# frame capture stop ${new Date().toISOString()} reason=${reason} lines=${this.lines} bytes=${this.bytes}\n`);
        this.log(`frame capture stopped (${reason}) → ${this.filePath}`);
        return this.filePath;
    }

    onUp(chunk) {
        this._onDir('UP', chunk, this._upSplit);
    }

    onDown(chunk) {
        this._onDir('DOWN', chunk, this._downSplit);
    }

    /**
     * Reset TCP reassembly — must run on each stick reconnect, otherwise a
     * leftover partial frame from the previous socket desyncs the capture.
     */
    resetStream() {
        this._upSplit = new FrameSplitter();
        this._downSplit = new FrameSplitter();
        if (this.active) {
            this._write(`# stream reset ${new Date().toISOString()}\n`);
        }
    }

    /**
     * @param {'UP'|'DOWN'} dir
     * @param {Buffer} chunk
     * @param {FrameSplitter} splitter
     */
    _onDir(dir, chunk, splitter) {
        if (!this.active || !Buffer.isBuffer(chunk) || !chunk.length) {
            return;
        }
        for (const raw of splitter.push(chunk)) {
            let func = '?';
            let wireFunc = '?';
            let crc = '';
            if (raw.length >= 8) {
                wireFunc = `0x${raw[7].toString(16)}`;
            }
            try {
                const f = decodeFrame(raw);
                func = `0x${Number(f.func).toString(16)}`;
                crc = f.crcOk ? 'ok' : `bad calc=${f.crcCalc} rx=${f.crcRx}`;
            } catch (err) {
                crc = `decode:${err.message}`;
            }
            const line =
                `${new Date().toISOString()} ${dir} len=${raw.length} ` +
                `wire=${wireFunc} xorFunc=${func} crc=${crc} hex=${raw.toString('hex')}\n`;
            this._write(line);
            if (this.bytes >= this.maxBytes) {
                this.stop('maxBytes');
                return;
            }
            this._maybeStopOnMatch(dir, raw);
            if (!this.active) {
                return;
            }
        }
    }

    /**
     * @param {'UP'|'DOWN'} dir
     * @param {Buffer} raw
     */
    _maybeStopOnMatch(dir, raw) {
        if (!this.stopWhen || this._matched || !this.active) {
            return;
        }
        const minLen = Number(this.stopWhen.minLen ?? 100);
        if (dir !== 'UP' || raw.length < minLen || raw.length < 8) {
            return;
        }
        const wires = Array.isArray(this.stopWhen.wires)
            ? this.stopWhen.wires.map((w) => Number(w) & 0xff)
            : [Number(this.stopWhen.wire ?? 4) & 0xff];
        if (!wires.includes(raw[7])) {
            return;
        }
        // Need at least one session key annotation (live or replayed)
        if (this._keySources.size === 0) {
            return;
        }
        this._matched = true;
        this.stop('matched');
    }

    /**
     * Append a raw line (frames or `# AES session ...` annotations).
     * @param {string} line
     */
    _write(line) {
        if (!this.filePath) {
            return;
        }
        fs.appendFileSync(this.filePath, line);
        this.bytes += Buffer.byteLength(line);
        this.lines += 1;
    }

    /**
     * @param {string} serial
     * @param {string} key
     * @param {string} iv
     * @param {'up'|'down'|string} [source]
     * @param {boolean} [replay]
     */
    noteAesSession(serial, key, iv, source, replay) {
        if (!this.active) {
            return;
        }
        const src = source ? ` source=${source}` : '';
        const rep = replay ? ' replay=1' : '';
        this._write(`# AES session SN=${serial} key=${key} iv=${iv}${src}${rep}\n`);
        if (source) {
            this._keySources.add(String(source));
        } else {
            this._keySources.add('up');
        }
    }

    /**
     * Replay remembered session keys into the capture log (no reconnect needed).
     * @param {Map<string, {entries: {source:string,key:string,iv:string,ts:number}[]}>|object} store
     * @param {string} [preferSn]
     * @returns {number} number of key lines written
     */
    replayAesSessions(store, preferSn) {
        if (!this.active || !store) {
            return 0;
        }
        let written = 0;
        const maps = store instanceof Map ? store : null;
        const keys = maps ? [...maps.keys()] : Object.keys(store);
        const ordered = preferSn && keys.includes(preferSn) ? [preferSn, ...keys.filter((k) => k !== preferSn)] : keys;
        for (const sn of ordered) {
            const bucket = maps ? maps.get(sn) : store[sn];
            if (!bucket || !Array.isArray(bucket.entries)) {
                continue;
            }
            for (const e of bucket.entries) {
                if (!e || !e.key || !e.iv) {
                    continue;
                }
                this.noteAesSession(sn, e.key, e.iv, e.source || 'up', true);
                written += 1;
            }
            // Prefer first SN with keys when capturing a single stick session
            if (written > 0 && preferSn) {
                break;
            }
        }
        return written;
    }
}

/**
 * Remember last AES session key material for a stick SN (live TCP session only).
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {{serial:string,key:string,iv:string,source?:string}} info
 */
function rememberAesSession(adapter, info) {
    if (!adapter || !info || !info.serial || !info.key || !info.iv) {
        return;
    }
    if (!adapter._lastAesSessions) {
        adapter._lastAesSessions = new Map();
    }
    const sn = String(info.serial);
    const source = String(info.source || 'up');
    let bucket = adapter._lastAesSessions.get(sn);
    if (!bucket) {
        bucket = { entries: [] };
        adapter._lastAesSessions.set(sn, bucket);
    }
    const next = { source, key: String(info.key), iv: String(info.iv), ts: Date.now() };
    const idx = bucket.entries.findIndex((e) => e.source === source);
    if (idx >= 0) {
        bucket.entries[idx] = next;
    } else {
        bucket.entries.push(next);
    }
}

/**
 * Drop remembered keys when the stick TCP session ends.
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {string} [serial]
 */
function forgetAesSession(adapter, serial) {
    if (!adapter || !adapter._lastAesSessions) {
        return;
    }
    if (serial) {
        adapter._lastAesSessions.delete(String(serial));
        return;
    }
    adapter._lastAesSessions.clear();
}

/**
 * @param {object} [msg]
 * @returns {{wire:number, minLen:number}|null}
 */
function parseStopWhen(msg) {
    if (!msg || msg.stopWhen == null) {
        return null;
    }
    if (msg.stopWhen === false) {
        return null;
    }
    const sw = typeof msg.stopWhen === 'object' ? msg.stopWhen : {};
    const wires = Array.isArray(sw.wires)
        ? sw.wires.map((w) => Number(w) & 0xff)
        : sw.wire != null
          ? [Number(sw.wire) & 0xff]
          : [0x03, 0x04];
    return {
        wire: wires[0],
        wires,
        minLen: Math.max(1, Number(sw.minLen ?? 100)),
    };
}

/**
 * @param {import('@iobroker/adapter-core').Adapter & object} adapter
 * @param {object} [message]
 */
async function startFrameCapture(adapter, message) {
    const msg = message && typeof message === 'object' ? message : {};
    const minutes = Math.max(1, Math.min(60, Number(msg.minutes ?? 20)));
    if (adapter._frameCapture && adapter._frameCapture.active) {
        return {
            ok: true,
            result: `Capture läuft bereits: ${adapter._frameCapture.filePath}`,
            file: adapter._frameCapture.filePath,
        };
    }
    const dataDir =
        (adapter.adapterDir && path.join(path.dirname(adapter.adapterDir), '..', 'iobroker-data', adapter.namespace)) ||
        path.join('/opt/iobroker/iobroker-data', adapter.namespace);
    // Prefer js-controller data dir when available
    let dir = dataDir;
    try {
        if (typeof adapter.getDataFolder === 'function') {
            dir = adapter.getDataFolder();
        }
    } catch {
        // keep fallback
    }
    const stopWhen = parseStopWhen(msg);
    const capture = new FrameCapture({
        dir,
        durationMs: minutes * 60 * 1000,
        maxBytes: 5 * 1024 * 1024,
        stopWhen,
        log: (m) => adapter.log.info(m),
    });
    const file = capture.start();
    adapter._frameCapture = capture;

    const preferSn =
        (adapter.config && (adapter.config.localStickSn || adapter.config.cloudStickRedirectSn)) || undefined;
    const replayed = capture.replayAesSessions(adapter._lastAesSessions, preferSn);

    let dropped = 0;
    if (msg.drop === true && adapter.localServer && typeof adapter.localServer.dropClients === 'function') {
        const { clientCount } = require('./stickRedirectGuard');
        dropped = clientCount(adapter.localServer);
        adapter.localServer.dropClients();
        adapter.log.info(`startFrameCapture: drop=true closed ${dropped} stick session(s)`);
    }

    await adapter.setStateAsync('info.setupStatus', {
        val: `Frame-Capture ${minutes} min → ${file}${stopWhen ? ` stopWhen=0x${stopWhen.wire.toString(16)}≥${stopWhen.minLen}` : ''}${replayed ? ` replayKeys=${replayed}` : ''}`,
        ack: true,
    });
    return {
        ok: true,
        result: `Frame-Capture gestartet (${minutes} min): ${file}`,
        file,
        minutes,
        stopWhen,
        replayedKeys: replayed,
        dropped,
    };
}

module.exports = {
    FrameCapture,
    startFrameCapture,
    rememberAesSession,
    forgetAesSession,
    parseStopWhen,
};
