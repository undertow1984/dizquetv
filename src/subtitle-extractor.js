/**
 * Tunarr-style embedded text subtitle extraction.
 *
 * Text subs baked into MKV/MP4 (srt, ass, mov_text, …) cannot be soft-muxed into
 * the live MPEG-TS stream. Tunarr extracts them to sidecar files with FFmpeg, then
 * burns them via the subtitles= filter. We do the same on demand with a disk cache.
 */
const spawn = require('child_process').spawn;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE_SUB_CODECS = [
    'hdmv_pgs_subtitle',
    'dvd_subtitle',
    'dvdsub',
    'vobsub',
    'pgssub',
    'pgs',
    'dvbsub',
    'dvb_subtitle',
    'dvb_teletext',
];

function isImageBasedSubtitle(codec) {
    if (!codec) {
        return false;
    }
    return IMAGE_SUB_CODECS.indexOf(String(codec).toLowerCase()) !== -1;
}

function subtitleCodecToExt(codec) {
    if (!codec) {
        return null;
    }
    let c = String(codec).toLowerCase();
    if (c === 'srt' || c === 'subrip' || c === 'mov_text' || c === 'text') {
        return 'srt';
    }
    if (c === 'ass' || c === 'ssa') {
        return 'ass';
    }
    if (c === 'webvtt' || c === 'vtt') {
        return 'vtt';
    }
    // Unknown text-ish — try srt container
    if (!isImageBasedSubtitle(c)) {
        return 'srt';
    }
    return null;
}

function getCacheRoot() {
    // Always absolute so FFmpeg on Windows can open the output path reliably
    try {
        const dbPaths = require('./database-paths');
        return path.resolve(dbPaths.subtitlesCacheDir());
    } catch (e) {
        let base = process.env.DATABASE || process.cwd();
        return path.resolve(path.join(base, 'cache', 'subtitles'));
    }
}

function cachePathFor(cacheKey, streamIndex, codec) {
    let ext = subtitleCodecToExt(codec);
    if (!ext) {
        return null;
    }
    let hash = crypto
        .createHash('md5')
        .update(String(cacheKey || ''))
        .update(String(streamIndex))
        .update(String(codec || ''))
        .digest('hex');
    // Tunarr-style sharded path: ab/cd/<hash>.ext
    return path.resolve(path.join(getCacheRoot(), hash.slice(0, 2), hash.slice(-2), `${hash}.${ext}`));
}

/**
 * Parse SRT timestamp "HH:MM:SS,mmm" or "HH:MM:SS.mmm" → milliseconds.
 */
function parseSrtTime(t) {
    let m = String(t).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!m) {
        return null;
    }
    let ms = parseInt(m[4], 10);
    if (m[4].length === 1) ms *= 100;
    else if (m[4].length === 2) ms *= 10;
    return (
        (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 + ms
    );
}

function formatSrtTime(ms) {
    if (ms < 0) {
        ms = 0;
    }
    let h = Math.floor(ms / 3600000);
    let m = Math.floor((ms % 3600000) / 60000);
    let s = Math.floor((ms % 60000) / 1000);
    let milli = Math.floor(ms % 1000);
    return (
        String(h).padStart(2, '0') + ':' +
        String(m).padStart(2, '0') + ':' +
        String(s).padStart(2, '0') + ',' +
        String(milli).padStart(3, '0')
    );
}

/**
 * Shift SRT cues so that times align with a mid-file video start.
 * When FFmpeg seeks with -ss, decoded timestamps often restart near 0, but the
 * extracted SRT still has absolute movie times — subtract offsetSec from every cue.
 */
function shiftSrtContent(content, offsetSec) {
    let offsetMs = Math.round(Number(offsetSec) * 1000);
    if (!offsetMs || offsetMs <= 0) {
        return content;
    }
    let blocks = String(content).replace(/\r\n/g, '\n').split(/\n\n+/);
    let out = [];
    let cueNum = 1;
    for (let i = 0; i < blocks.length; i++) {
        let block = blocks[i].trim();
        if (!block) {
            continue;
        }
        let lines = block.split('\n');
        // Find timing line
        let timeIdx = -1;
        for (let j = 0; j < lines.length; j++) {
            if (lines[j].indexOf('-->') !== -1) {
                timeIdx = j;
                break;
            }
        }
        if (timeIdx === -1) {
            // Keep non-cue blocks (headers) as-is if no offset needed for them
            continue;
        }
        let parts = lines[timeIdx].split(/\s*-->\s*/);
        if (parts.length < 2) {
            continue;
        }
        let start = parseSrtTime(parts[0]);
        let end = parseSrtTime(parts[1].split(/\s+/)[0]);
        if (start === null || end === null) {
            continue;
        }
        start -= offsetMs;
        end -= offsetMs;
        if (end <= 0) {
            // Entire cue is before the seek point
            continue;
        }
        if (start < 0) {
            start = 0;
        }
        let textLines = lines.slice(timeIdx + 1);
        out.push(
            String(cueNum++) + '\n' +
            formatSrtTime(start) + ' --> ' + formatSrtTime(end) + '\n' +
            textLines.join('\n')
        );
    }
    return out.join('\n\n') + (out.length ? '\n' : '');
}

/**
 * Shift ASS/SSA Dialogue start/end times by -offsetSec.
 */
function shiftAssContent(content, offsetSec) {
    let offsetMs = Math.round(Number(offsetSec) * 1000);
    if (!offsetMs || offsetMs <= 0) {
        return content;
    }
    // ASS time: H:MM:SS.cc (centiseconds)
    function parseAss(t) {
        let m = String(t).trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/);
        if (!m) {
            return null;
        }
        let cs = parseInt(m[4], 10);
        if (m[4].length === 1) {
            cs *= 10;
        }
        return (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 + cs * 10;
    }
    function formatAss(ms) {
        if (ms < 0) {
            ms = 0;
        }
        let h = Math.floor(ms / 3600000);
        let m = Math.floor((ms % 3600000) / 60000);
        let s = Math.floor((ms % 60000) / 1000);
        let cs = Math.floor((ms % 1000) / 10);
        return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
    }
    return String(content).replace(
        /^(Dialogue:\s*[^,]*,)([^,]+),([^,]+),/gm,
        function (full, prefix, startStr, endStr) {
            let start = parseAss(startStr);
            let end = parseAss(endStr);
            if (start === null || end === null) {
                return full;
            }
            start -= offsetMs;
            end -= offsetMs;
            if (end <= 0) {
                // Mark as empty dialogue far in the past (skip by zero duration at 0)
                return prefix + '0:00:00.00,0:00:00.00,';
            }
            if (start < 0) {
                start = 0;
            }
            return prefix + formatAss(start) + ',' + formatAss(end) + ',';
        }
    );
}

/**
 * Create a per-stream burn file (unique path) with timestamps shifted for mid-program start.
 * Never reuse a shared burn-active.srt — concurrent channels would race.
 *
 * @param {string} extractedPath - full-file extract in cache
 * @param {object} [opts]
 * @param {number} [opts.startOffsetSec] - video seek position (seconds into the file)
 * @param {string} [opts.instanceId] - unique id for this playback session
 * @returns {{ path: string, cleanup: function }|null}
 */
function prepareBurnSubtitleFile(extractedPath, opts) {
    opts = opts || {};
    if (!extractedPath || !fs.existsSync(extractedPath)) {
        return null;
    }
    let startOffsetSec = Number(opts.startOffsetSec) || 0;
    if (startOffsetSec < 0) {
        startOffsetSec = 0;
    }
    let ext = path.extname(extractedPath) || '.srt';
    let instanceId = opts.instanceId || (crypto.randomBytes(8).toString('hex') + '-' + process.pid);
    // Sanitize id for filesystem
    instanceId = String(instanceId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || String(Date.now());
    let burnDir = path.join(getCacheRoot(), 'burn');
    let burnPath = path.resolve(path.join(burnDir, instanceId + ext));

    try {
        fs.mkdirSync(burnDir, { recursive: true });
        let raw = fs.readFileSync(extractedPath);
        // Strip NULs again just in case
        let text = Buffer.from(raw.filter(function (b) { return b !== 0x00; })).toString('utf8');
        let shifted;
        if (ext === '.ass' || ext === '.ssa') {
            shifted = shiftAssContent(text, startOffsetSec);
        } else {
            // srt / vtt-like: VTT uses similar --> lines; use SRT shifter for both
            shifted = shiftSrtContent(text, startOffsetSec);
        }
        if (!shifted || !String(shifted).trim()) {
            console.log(
                `dizqueTV subtitles: after offset ${startOffsetSec}s no cues remain in ${extractedPath}`
            );
            // Still write empty-ish file so burn does not crash; no visible cues
            shifted = '';
        }
        fs.writeFileSync(burnPath, shifted, 'utf8');
        console.log(
            `dizqueTV subtitles: burn instance ${instanceId} offset=${startOffsetSec.toFixed(3)}s → ${burnPath}`
        );
        return {
            path: burnPath,
            cleanup: function () {
                try {
                    if (fs.existsSync(burnPath)) {
                        fs.unlinkSync(burnPath);
                    }
                } catch (e) { /* ignore */ }
            },
        };
    } catch (err) {
        console.error('dizqueTV subtitles: failed to prepare burn file:', err.message || err);
        return null;
    }
}

/**
 * Path for the subtitles filter that avoids Windows "C:" being parsed as an
 * option separator (which sets original_size="/rest/of/path" and fails).
 *
 * Prefer a path relative to process.cwd() with only forward slashes and NO colon.
 * Fallback: absolute path with *double* backslash-escape of ":".
 */
function pathForSubtitlesFilter(filePath) {
    let abs = path.resolve(String(filePath));
    let rel = path.relative(process.cwd(), abs);
    // Use relative path when it stays under cwd (no ".." escape) — no drive colon
    if (
        rel
        && rel.length > 0
        && !path.isAbsolute(rel)
        && rel.indexOf('..') !== 0
        && !rel.split(path.sep).includes('..')
    ) {
        return rel.replace(/\\/g, '/');
    }
    // Double-escape colons for filtergraph + option parser levels
    return abs
        .replace(/\\/g, '/')
        .replace(/:/g, '\\\\:')
        .replace(/,/g, '\\\\,')
        .replace(/\[/g, '\\\\[')
        .replace(/\]/g, '\\\\]');
}

/** @deprecated use pathForSubtitlesFilter — kept for callers */
function escapeSubtitlesFilterPath(filePath) {
    return pathForSubtitlesFilter(filePath);
}

/**
 * Build the subtitles= filter fragment (no input/output labels).
 *
 * @param {string} subtitleFilePath - full extracted SRT/ASS path
 * @param {object} [opts] - startOffsetSec, instanceId
 * @returns {{ filter: string, burnPath: string|null, cleanup: function }}
 */
function buildSubtitlesBurnFilter(subtitleFilePath, opts) {
    opts = opts || {};
    let prepared = prepareBurnSubtitleFile(subtitleFilePath, opts);
    if (!prepared) {
        return {
            filter: null,
            burnPath: null,
            cleanup: function () {},
        };
    }
    let filterPath = pathForSubtitlesFilter(prepared.path);
    console.log(`dizqueTV subtitles: filter path = ${filterPath}`);
    return {
        filter: `subtitles=${filterPath},format=yuv420p`,
        burnPath: prepared.path,
        cleanup: prepared.cleanup,
    };
}

function runFfmpegExtract(ffmpegPath, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
        let done = false;
        let stderr = '';
        let proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let timer = setTimeout(function () {
            if (!done) {
                done = true;
                try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
                reject(new Error('Subtitle extraction timed out'));
            }
        }, timeoutMs || 120000);

        if (proc.stderr) {
            proc.stderr.on('data', function (chunk) {
                stderr += chunk.toString();
                if (stderr.length > 8000) {
                    stderr = stderr.slice(-4000);
                }
            });
        }

        proc.on('error', function (err) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(err);
        });

        proc.on('exit', function (code) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error('ffmpeg extract exit ' + code + (stderr ? ': ' + stderr.trim() : '')));
            }
        });
    });
}

/**
 * Strip NUL bytes that some Plex/mov_text extractions embed (Tunarr does this;
 * libass refuses files containing NUL).
 */
function copyStripNuls(src, dest) {
    let data = fs.readFileSync(src);
    let cleaned = Buffer.from(data.filter(function (b) { return b !== 0x00; }));
    fs.writeFileSync(dest, cleaned);
}

/**
 * Extract an embedded text subtitle stream from sourceUrl into the cache.
 * Returns absolute path to the extracted file, or null on skip/failure.
 *
 * @param {object} opts
 * @param {string} opts.ffmpegPath
 * @param {string} opts.sourceUrl - local file or Plex HTTP file URL
 * @param {number|string} opts.streamIndex - absolute container stream index
 * @param {string} opts.codec - Plex/ffmpeg subtitle codec
 * @param {string} opts.cacheKey - stable id (ratingKey, path, …)
 */
async function extractEmbeddedSubtitle(opts) {
    let ffmpegPath = opts.ffmpegPath;
    let sourceUrl = opts.sourceUrl;
    let streamIndex = opts.streamIndex;
    let codec = opts.codec || '';
    let cacheKey = opts.cacheKey || sourceUrl;

    if (!ffmpegPath || !sourceUrl || streamIndex === null || typeof(streamIndex) === 'undefined' || streamIndex === '') {
        return null;
    }

    if (isImageBasedSubtitle(codec)) {
        // Image-based: no text extraction; caller soft-maps / overlays from source
        return null;
    }

    let outPath = cachePathFor(cacheKey, streamIndex, codec);
    if (!outPath) {
        return null;
    }

    try {
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
            console.log(`dizqueTV subtitles: using cached extract ${outPath}`);
            return outPath;
        }
    } catch (e) {
        // continue to re-extract
    }

    let dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // FFmpeg picks the muxer from the file extension. A ".srt.partial" name fails with
    // "Unable to choose an output format". Use a real extension on the temp file.
    let ext = path.extname(outPath) || ('.' + (subtitleCodecToExt(codec) || 'srt'));
    let tmpPath = outPath.slice(0, outPath.length - ext.length) + '.extracting' + ext;
    try {
        if (fs.existsSync(tmpPath)) {
            fs.unlinkSync(tmpPath);
        }
    } catch (e) { /* ignore */ }

    // Tunarr: mov_text → -c:s text; otherwise copy the text stream as-is
    let cCodec = String(codec).toLowerCase() === 'mov_text' ? 'text' : 'copy';
    // Explicit -f so muxer is clear even if the path is odd on Windows
    let format = 'srt';
    if (ext === '.ass' || ext === '.ssa') {
        format = 'ass';
    } else if (ext === '.vtt') {
        format = 'webvtt';
    }

    let args = [
        '-nostdin',
        '-hide_banner',
        '-loglevel', 'warning',
        '-y',
        '-i', String(sourceUrl),
        '-map', `0:${streamIndex}`,
        '-c:s', cCodec,
        '-f', format,
        tmpPath,
    ];

    console.log(
        `dizqueTV subtitles: extracting embedded stream 0:${streamIndex} ` +
        `(codec=${codec || '?'}) → ${outPath}`
    );

    try {
        await runFfmpegExtract(ffmpegPath, args, opts.timeoutMs || 180000);
        if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
            throw new Error('Extraction produced empty file');
        }
        copyStripNuls(tmpPath, outPath);
        try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
        console.log(`dizqueTV subtitles: extracted OK ${outPath}`);
        return outPath;
    } catch (err) {
        console.error('dizqueTV subtitles: extraction failed:', err.message || err);
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
        return null;
    }
}

module.exports = {
    extractEmbeddedSubtitle,
    isImageBasedSubtitle,
    subtitleCodecToExt,
    escapeSubtitlesFilterPath,
    prepareBurnSubtitleFile,
    buildSubtitlesBurnFilter,
    shiftSrtContent,
    shiftAssContent,
    cachePathFor,
};
