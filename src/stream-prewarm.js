/**
 * Pre-warm the first real program stream while the loading screen plays.
 *
 * Loading duration is DYNAMIC: the splash ends when prewarm has enough data
 * (or on error / max wait), not after a fixed sleep.
 *
 * Flow:
 *  1. first=0 (loading) starts → begin HTTP prewarm of first=1
 *  2. Loading polls isReady() and ends as soon as enough TS is buffered
 *  3. releaseServe() allows handoff ONLY after the splash has finished
 *  4. Concat requests first=1 → tryServePrewarm() hands off the buffered stream
 *
 * Step 3 is critical: FFmpeg concat may open/probe first=1 while loading is still
 * playing. Serving program bytes early makes the client show video under/before the
 * loading image disappears. We hold first=1 until the splash ends.
 */
const http = require('http');
const { PassThrough } = require('stream');

/** @type {Map<string, any>} */
const prewarms = new Map();

// ~1–1.5s of typical 1080p/4K MPEG-TS — enough to hand off without a stall
const DEFAULT_READY_MIN_BYTES = 1024 * 1024;
const DEFAULT_MAX_WAIT_MS = 45000;
const DEFAULT_MIN_SPLASH_MS = 600;
// After first prewarm bytes, require a short stable window before READY
const DEFAULT_STABLE_MS = 400;

function keyOf(session, channel) {
    return String(session) + ':' + String(channel);
}

function getEntry(session, channel) {
    if (session === undefined || session === null || isNaN(Number(session))) {
        return null;
    }
    return prewarms.get(keyOf(session, channel)) || null;
}

/**
 * Start generating first=1 in the background. Safe to call multiple times.
 */
function startPrewarm(session, channel, port, audioOnly) {
    if (session === undefined || session === null || isNaN(Number(session))) {
        return;
    }
    let key = keyOf(session, channel);
    if (prewarms.has(key)) {
        return;
    }

    let entry = {
        chunks: [],
        bytes: 0,
        maxBytes: 100 * 1024 * 1024,
        ended: false,
        error: null,
        waiters: [],
        readyWaiters: [],
        // Held HTTP responses for first=1 opened before splash ended
        pendingServe: [],
        // false until loading splash calls releaseServe()
        allowServe: false,
        req: null,
        res: null,
        startedAt: Date.now(),
        firstDataAt: null,
        readyNotified: false,
    };
    prewarms.set(key, entry);

    let q =
        'channel=' + encodeURIComponent(channel) +
        '&first=1' +
        '&session=' + encodeURIComponent(session) +
        '&audioOnly=' + encodeURIComponent(audioOnly ? 'true' : 'false') +
        '&prewarmProducer=1';

    let url = 'http://127.0.0.1:' + port + '/stream?' + q;
    console.log('dizqueTV prewarm: starting ' + url);

    function notifyReady() {
        if (entry.readyNotified) {
            return;
        }
        if (!isEntryReady(entry, DEFAULT_READY_MIN_BYTES)) {
            return;
        }
        entry.readyNotified = true;
        let age = Date.now() - entry.startedAt;
        console.log(
            'dizqueTV prewarm: READY key=' + key +
            ' bytes=' + entry.bytes + ' after ' + age + 'ms'
        );
        let waiters = entry.readyWaiters.slice();
        entry.readyWaiters = [];
        for (let i = 0; i < waiters.length; i++) {
            try {
                waiters[i](true);
            } catch (e) { /* ignore */ }
        }
    }

    try {
        entry.req = http.get(url, function (res) {
            entry.res = res;
            res.on('data', function (chunk) {
                if (!entry.firstDataAt) {
                    entry.firstDataAt = Date.now();
                }
                if (entry.waiters.length > 0) {
                    for (let i = 0; i < entry.waiters.length; i++) {
                        try {
                            entry.waiters[i].write(chunk);
                        } catch (e) { /* ignore */ }
                    }
                } else {
                    entry.chunks.push(chunk);
                    entry.bytes += chunk.length;
                    while (entry.bytes > entry.maxBytes && entry.chunks.length > 1) {
                        let removed = entry.chunks.shift();
                        entry.bytes -= removed.length;
                    }
                }
                notifyReady();
            });
            res.on('end', function () {
                entry.ended = true;
                notifyReady();
                for (let i = 0; i < entry.waiters.length; i++) {
                    try {
                        entry.waiters[i].end();
                    } catch (e) { /* ignore */ }
                }
                entry.waiters = [];
            });
            res.on('error', function (err) {
                entry.error = err;
                entry.ended = true;
                console.error('dizqueTV prewarm: response error', err.message || err);
                let waiters = entry.readyWaiters.slice();
                entry.readyWaiters = [];
                for (let i = 0; i < waiters.length; i++) {
                    try {
                        waiters[i](false);
                    } catch (e) { /* ignore */ }
                }
            });
        });
        entry.req.on('error', function (err) {
            entry.error = err;
            entry.ended = true;
            console.error('dizqueTV prewarm: request error', err.message || err);
            let waiters = entry.readyWaiters.slice();
            entry.readyWaiters = [];
            for (let i = 0; i < waiters.length; i++) {
                try {
                    waiters[i](false);
                } catch (e) { /* ignore */ }
            }
            prewarms.delete(key);
        });
    } catch (err) {
        prewarms.delete(key);
        console.error('dizqueTV prewarm: failed to start', err.message || err);
        return;
    }

    setTimeout(function () {
        destroyPrewarm(key);
    }, 180000);
}

function isEntryReady(entry, minBytes, stableMs) {
    if (!entry || entry.error) {
        return false;
    }
    let need = minBytes || DEFAULT_READY_MIN_BYTES;
    let stable = (stableMs != null) ? stableMs : DEFAULT_STABLE_MS;
    // Producer finished with some data — always ready
    if (entry.ended && entry.bytes > 0) {
        return true;
    }
    // Enough buffered media AND data has been flowing briefly (avoids false READY
    // on a single small flush before the encoder is actually producing)
    if (entry.bytes >= need && entry.firstDataAt) {
        if ((Date.now() - entry.firstDataAt) >= stable) {
            return true;
        }
    }
    return false;
}

/**
 * True when prewarm has enough data to switch from loading → program.
 */
function isReady(session, channel, minBytes) {
    let entry = getEntry(session, channel);
    if (!entry) {
        return false;
    }
    if (entry.error) {
        // Failed — loading should stop and fall through to a normal first=1
        return true;
    }
    return isEntryReady(entry, minBytes || DEFAULT_READY_MIN_BYTES);
}

/**
 * Resolve when prewarm is ready, failed, or maxWaitMs elapsed.
 * Always resolves (never rejects) so loading can end cleanly.
 *
 * @returns {Promise<{ready: boolean, reason: string, waitMs: number, bytes: number}>}
 */
function waitUntilReady(session, channel, options) {
    options = options || {};
    let minBytes = options.minBytes || DEFAULT_READY_MIN_BYTES;
    let maxWaitMs = options.maxWaitMs || DEFAULT_MAX_WAIT_MS;
    let minSplashMs = options.minSplashMs != null ? options.minSplashMs : DEFAULT_MIN_SPLASH_MS;
    let started = Date.now();

    return new Promise(function (resolve) {
        let key = keyOf(session, channel);
        let settled = false;

        function finish(ready, reason) {
            if (settled) {
                return;
            }
            settled = true;
            let entry = prewarms.get(key);
            resolve({
                ready: ready,
                reason: reason,
                waitMs: Date.now() - started,
                bytes: entry ? entry.bytes : 0,
            });
        }

        function check() {
            if (settled) {
                return;
            }
            let elapsed = Date.now() - started;
            let entry = prewarms.get(key);

            if (!entry) {
                // Not started yet — keep waiting unless past max
                if (elapsed >= maxWaitMs) {
                    finish(false, 'no-prewarm-timeout');
                    return;
                }
                setTimeout(check, 50);
                return;
            }

            if (entry.error) {
                finish(false, 'prewarm-error');
                return;
            }

            if (elapsed >= minSplashMs && isEntryReady(entry, minBytes)) {
                finish(true, 'buffer-ready');
                return;
            }

            if (elapsed >= maxWaitMs) {
                finish(entry.bytes > 0, 'max-wait');
                return;
            }

            setTimeout(check, 50);
        }

        // Also wake immediately when data pushes ready
        let entry = prewarms.get(key);
        if (entry) {
            entry.readyWaiters.push(function () {
                // Still respect min splash
                let left = minSplashMs - (Date.now() - started);
                if (left > 0) {
                    setTimeout(check, left);
                } else {
                    check();
                }
            });
        }

        check();
    });
}

/**
 * Attach res to a live prewarm entry (write buffer + follow live).
 * Caller must ensure entry.allowServe is true (or accept early probe hold).
 */
function attachConsumer(entry, key, res) {
    let ageMs = Date.now() - entry.startedAt;
    console.log(
        'dizqueTV prewarm: serving consumer key=' + key +
        ' bufferedBytes=' + entry.bytes + ' ageMs=' + ageMs
    );

    try {
        for (let i = 0; i < entry.chunks.length; i++) {
            res.write(entry.chunks[i]);
        }
    } catch (e) {
        destroyPrewarm(key);
        return false;
    }
    entry.chunks = [];
    entry.bytes = 0;

    if (entry.ended) {
        try {
            res.end();
        } catch (e) { /* ignore */ }
        destroyPrewarm(key);
        return true;
    }

    let pt = new PassThrough();
    entry.waiters.push(pt);

    let cleaned = false;
    let cleanup = function () {
        if (cleaned) {
            return;
        }
        cleaned = true;
        entry.waiters = entry.waiters.filter(function (w) {
            return w !== pt;
        });
        try {
            pt.destroy();
        } catch (e) { /* ignore */ }
        // Only tear down when no consumers and no pending holds
        if (entry.waiters.length === 0 && (!entry.pendingServe || entry.pendingServe.length === 0)) {
            destroyPrewarm(key);
        }
    };

    pt.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    pt.pipe(res, { end: true });
    return true;
}

/**
 * If a prewarm exists for this session/channel, pipe it to res and return true.
 * If the loading splash has not finished yet, HOLD the response (no bytes) so
 * concat cannot display program video underneath the loading image.
 */
function tryServePrewarm(session, channel, res) {
    if (session === undefined || session === null || isNaN(Number(session))) {
        return false;
    }
    let key = keyOf(session, channel);
    let entry = prewarms.get(key);
    if (!entry || entry.error) {
        return false;
    }

    // Splash still up — claim the request so we don't start a second encode,
    // but do not send program bytes until releaseServe().
    if (!entry.allowServe) {
        console.log(
            'dizqueTV prewarm: holding first=1 until loading splash ends key=' + key +
            ' bufferedBytes=' + entry.bytes
        );
        entry.pendingServe = entry.pendingServe || [];
        entry.pendingServe.push(res);
        let onEarlyClose = function () {
            entry.pendingServe = (entry.pendingServe || []).filter(function (r) {
                return r !== res;
            });
        };
        res.on('close', onEarlyClose);
        res.on('error', onEarlyClose);
        return true;
    }

    return attachConsumer(entry, key, res);
}

/**
 * Allow prewarm handoff after the loading splash has finished ending.
 * Flushes any first=1 connections that were held during the splash.
 */
function releaseServe(session, channel) {
    if (session === undefined || session === null || isNaN(Number(session))) {
        return;
    }
    let key = keyOf(session, channel);
    let entry = prewarms.get(key);
    if (!entry) {
        return;
    }
    entry.allowServe = true;
    let pending = (entry.pendingServe || []).slice();
    entry.pendingServe = [];
    if (pending.length > 0) {
        console.log(
            'dizqueTV prewarm: releaseServe key=' + key +
            ' pending=' + pending.length + ' bytes=' + entry.bytes
        );
    } else {
        console.log('dizqueTV prewarm: releaseServe key=' + key + ' (no pending holders)');
    }
    for (let i = 0; i < pending.length; i++) {
        try {
            attachConsumer(entry, key, pending[i]);
        } catch (e) {
            console.error('dizqueTV prewarm: releaseServe attach failed', e.message || e);
        }
    }
}

function hasPrewarm(session, channel) {
    let entry = getEntry(session, channel);
    return !!(entry && !entry.error);
}

function destroyPrewarm(key) {
    let entry = prewarms.get(key);
    if (!entry) {
        return;
    }
    prewarms.delete(key);
    try {
        if (entry.req) {
            entry.req.destroy();
        }
    } catch (e) { /* ignore */ }
    try {
        if (entry.res) {
            entry.res.destroy();
        }
    } catch (e) { /* ignore */ }
    for (let i = 0; i < entry.waiters.length; i++) {
        try {
            entry.waiters[i].destroy();
        } catch (e) { /* ignore */ }
    }
    // Close any first=1 holders that never got released
    let pending = (entry.pendingServe || []).slice();
    entry.pendingServe = [];
    for (let i = 0; i < pending.length; i++) {
        try {
            pending[i].end();
        } catch (e) { /* ignore */ }
    }
    let rw = entry.readyWaiters.slice();
    entry.readyWaiters = [];
    for (let i = 0; i < rw.length; i++) {
        try {
            rw[i](false);
        } catch (e) { /* ignore */ }
    }
}

module.exports = {
    startPrewarm,
    tryServePrewarm,
    releaseServe,
    hasPrewarm,
    isReady,
    waitUntilReady,
    destroyPrewarm,
    DEFAULT_READY_MIN_BYTES,
    DEFAULT_MAX_WAIT_MS,
};
