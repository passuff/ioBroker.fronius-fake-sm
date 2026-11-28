'use strict';

/**
 * Fire-and-forget with logged failures (avoids unhandled rejections).
 * @param {{ log?: { warn?: Function, debug?: Function } }} adapter
 * @param {string} label
 * @param {Promise<unknown>|(() => Promise<unknown>)} promiseOrFn
 */
function fireAndLog(adapter, label, promiseOrFn) {
    const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    Promise.resolve(p).catch((err) => {
        const msg = err && err.stack ? err.stack : String(err && err.message ? err.message : err);
        if (adapter && adapter.log && typeof adapter.log.warn === 'function') {
            adapter.log.warn(`${label}: ${msg}`);
        }
    });
}

module.exports = { fireAndLog };
