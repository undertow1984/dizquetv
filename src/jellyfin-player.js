/******************
 * Play a program that came from a Jellyfin library.
 * Uses a simple, dedicated FFmpeg pipeline (software decode) because the
 * shared FFMPEG filter graph is easy to break with CUDA + watermark on
 * already-transcoded Jellyfin TS streams.
 **/
const EventEmitter = require('events');
const fs = require('fs');
const spawn = require('child_process').spawn;
const path = require('path');
const helperFuncs = require('./helperFuncs');
const FFMPEG = require('./ffmpeg');
const constants = require('./constants');
const Jellyfin = require('./jellyfin');

function parseRes(resString, fallbackW, fallbackH) {
    fallbackW = fallbackW || 1920;
    fallbackH = fallbackH || 1080;
    if (!resString || typeof resString !== 'string') {
        return { w: fallbackW, h: fallbackH };
    }
    let m = resString.match(/(\d+)\s*[x×]\s*(\d+)/i);
    if (!m) return { w: fallbackW, h: fallbackH };
    return { w: parseInt(m[1], 10) || fallbackW, h: parseInt(m[2], 10) || fallbackH };
}

class JellyfinPlayer {
    constructor(context) {
        this.context = context;
        this.ffmpeg = null;
        this.ffmpegProc = null;
        this.killed = false;
        this.ffmpegName = 'Jellyfin FFMPEG';
    }

    cleanUp() {
        this.killed = true;
        if (this.ffmpegProc != null) {
            try { this.ffmpegProc.kill('SIGKILL'); } catch (e) { /* ignore */ }
            this.ffmpegProc = null;
        }
        if (this.ffmpeg != null) {
            try { this.ffmpeg.kill(); } catch (e) { /* ignore */ }
            this.ffmpeg = null;
        }
    }

    _fileExists(p) {
        if (!p || typeof p !== 'string') return false;
        try {
            fs.accessSync(p, fs.constants.R_OK);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Build a minimal, reliable ffmpeg argv for Jellyfin → MPEG-TS pipe.
     */
    _buildArgs(streamUrl, opts) {
        let {
            ffmpegSettings,
            watermark,
            startSec,
            durationSec,
            channelName,
            wantedW,
            wantedH,
        } = opts;

        let args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-threads', String(ffmpegSettings.threads || 4),
            '-fflags', '+genpts+discardcorrupt+igndts',
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            '-thread_queue_size', '1024',
        ];

        if (typeof streamUrl === 'string' && /^https?:\/\//i.test(streamUrl)) {
            args.push(
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '2'
            );
        }

        // Only seek in FFmpeg when Jellyfin did not already start mid-file
        if (typeof startSec === 'number' && startSec > 0 && !opts.serverSeeked) {
            args.push('-ss', String(startSec));
        }

        args.push('-i', streamUrl);

        let filterParts = [];
        let videoOut = '0:v:0';
        let hasOverlay = !!(watermark && watermark.url);

        // Scale/pad to target (keeps SAR 1, even dims for encoders)
        let w = wantedW || 1920;
        let h = wantedH || 1080;
        filterParts.push(
            `[0:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bicubic,` +
            `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[vbase]`
        );
        videoOut = '[vbase]';

        if (hasOverlay) {
            // Still logo: loop; animated: no loop
            if (watermark.animated === true) {
                args.push('-ignore_loop', '0', '-i', watermark.url);
            } else {
                args.push('-loop', '1', '-i', watermark.url);
            }
            let pW = (typeof watermark.width === 'number' ? watermark.width : 10);
            let iconW = Math.max(16, Math.round(pW * w / 100.0));
            let mpHorz = (typeof watermark.horizontalMargin === 'number' ? watermark.horizontalMargin : 1);
            let mpVert = (typeof watermark.verticalMargin === 'number' ? watermark.verticalMargin : 1);
            let horz = Math.round(mpHorz * w / 100.0);
            let vert = Math.round(mpVert * h / 100.0);
            let pos = {
                'top-left': `x=${horz}:y=${vert}`,
                'top-right': `x=W-w-${horz}:y=${vert}`,
                'bottom-left': `x=${horz}:y=H-h-${vert}`,
                'bottom-right': `x=W-w-${horz}:y=H-h-${vert}`,
            };
            let xy = pos[watermark.position] || pos['bottom-right'];
            let enable = '';
            if (watermark.duration > 0) {
                enable = `:enable='between(t,0,${watermark.duration})'`;
            }
            filterParts.push(`[1:v]scale=${iconW}:-1[vicon]`);
            filterParts.push(`[vbase][vicon]overlay=${xy}${enable}:format=auto[vout]`);
            videoOut = '[vout]';
        }

        args.push('-filter_complex', filterParts.join(';'));
        args.push('-map', videoOut);
        // Prefer first audio; optional if missing
        args.push('-map', '0:a:0?');

        let vEnc = ffmpegSettings.videoEncoder || 'libx264';
        let aEnc = ffmpegSettings.audioEncoder || 'aac';
        let vBit = ffmpegSettings.videoBitrate || 8000;
        let aBit = ffmpegSettings.audioBitrate || 192;
        let aBuf = ffmpegSettings.audioBufSize || aBit;
        let vBuf = ffmpegSettings.videoBufSize || vBit;
        let preset = (ffmpegSettings.transcodingSpeed || 'veryfast').toString();

        args.push('-c:v', vEnc, '-pix_fmt', 'yuv420p');
        // Rate control
        let encL = vEnc.toLowerCase();
        if (encL.indexOf('nvenc') !== -1) {
            // Map UI speed names loosely to NVENC p-tiers
            let pmap = {
                'ultrafast': 'p1', 'superfast': 'p2', 'veryfast': 'p3',
                'faster': 'p4', 'fast': 'p5', 'medium': 'p5',
                'slow': 'p6', 'slower': 'p7', 'veryslow': 'p7',
            };
            args.push('-preset', pmap[preset.toLowerCase()] || 'p4');
            args.push('-b:v', `${vBit}k`, '-maxrate:v', `${vBit}k`, '-bufsize:v', `${vBuf}k`);
            args.push('-bf', '0', '-rc-lookahead', '0', '-delay', '0', '-g', '48', '-keyint_min', '24');
        } else if (encL.indexOf('libx264') !== -1) {
            args.push('-preset', preset);
            args.push('-b:v', `${vBit}k`, '-maxrate:v', `${vBit}k`, '-bufsize:v', `${vBuf}k`);
            args.push('-tune', 'zerolatency', '-bf', '0', '-g', '48');
        } else {
            args.push('-b:v', `${vBit}k`, '-maxrate:v', `${vBit}k`, '-bufsize:v', `${vBuf}k`);
            args.push('-g', '48');
        }
        args.push('-force_key_frames', 'expr:eq(n,0)');

        args.push(
            '-c:a', aEnc,
            '-b:a', `${aBit}k`,
            '-ac', String(ffmpegSettings.audioChannels || 2),
            '-ar', String((ffmpegSettings.audioSampleRate || 48) * 1000)
        );

        if (typeof durationSec === 'number' && durationSec > 0) {
            args.push('-t', String(durationSec));
        }

        args.push(
            '-metadata', `service_provider=dizqueTV`,
            '-metadata', `service_name=${(channelName || 'dizqueTV').replace(/"/g, '')}`,
            '-mpegts_flags', '+resend_headers+initial_discontinuity',
            '-f', 'mpegts',
            'pipe:1'
        );

        return args;
    }

    async play(outStream) {
        let lineupItem = this.context.lineupItem;
        let ffmpegSettings = Object.assign({}, this.context.ffmpegSettings || {});
        let db = this.context.db;
        let channel = this.context.channel;

        let serverRows = db['jellyfin-servers'].find({ name: lineupItem.serverKey });
        if (serverRows.length == 0) {
            throw Error(`Unable to find Jellyfin server "${lineupItem.serverKey}" specified by program.`);
        }
        let server = serverRows[0];
        if (server.uri.endsWith('/')) {
            server.uri = server.uri.slice(0, -1);
        }

        // Live FFmpeg settings from DB (same logo keys as PlexPlayer so PSD templates work)
        try {
            let liveFfmpeg = db['ffmpeg-settings'].find()[0] || {};
            const LIVE_KEYS = [
                'ffmpegPath', 'threads', 'logFfmpeg',
                'videoEncoder', 'audioEncoder',
                'targetResolution', 'videoBitrate', 'videoBufSize',
                'audioBitrate', 'audioBufSize', 'audioVolumePercent',
                'audioChannels', 'audioSampleRate',
                'transcodingSpeed', 'enableDynamicChannelLogos',
                'channelLogoTemplatePath', 'channelLogoTemplateTwoPath',
                'enableChannelWatermarkGlobally', 'disableChannelOverlay',
            ];
            for (let i = 0; i < LIVE_KEYS.length; i++) {
                let k = LIVE_KEYS[i];
                if (typeof liveFfmpeg[k] !== 'undefined' && liveFfmpeg[k] !== null) {
                    ffmpegSettings[k] = liveFfmpeg[k];
                }
            }
        } catch (e) { /* ignore */ }

        // Jellyfin always runs its own FFmpeg pipeline — allow overlays even when
        // global "Enable FFMPEG Transcoding" is off. Dynamic logos use the same
        // Plex-Template PSDs as Plex channels (no Plex server required).
        let watermark = null;
        try {
            watermark = helperFuncs.getWatermark(
                ffmpegSettings,
                channel,
                lineupItem.type,
                { forceOverlay: true }
            );
        } catch (wmErr) {
            console.error('dizqueTV jellyfin: watermark resolve failed', wmErr.message || wmErr);
        }
        // Simple pipeline only accepts local files for -i overlay
        if (watermark && watermark.url) {
            let u = watermark.url;
            let local = null;
            try {
                local = helperFuncs.resolveOverlayUrlForFfmpeg(u);
            } catch (e) { /* ignore */ }
            if (local && !/^https?:\/\//i.test(local) && this._fileExists(local)) {
                watermark.url = local;
            } else if (!/^https?:\/\//i.test(u) && this._fileExists(u)) {
                watermark.url = u;
            } else if (/^file:\/\//i.test(u) && this._fileExists(u.replace(/^file:\/\//i, ''))) {
                watermark.url = u.replace(/^file:\/\//i, '');
            } else if (
                ffmpegSettings.enableDynamicChannelLogos === true
                && (
                    helperFuncs.isStockOrEmptyIcon(channel && channel.icon)
                    || helperFuncs.isGeneratedLogoPath(u)
                    || helperFuncs.isStockOrEmptyIcon(u)
                )
            ) {
                // Last chance: generate PSD logo now (works with Jellyfin-only installs)
                try {
                    const logoGen = require('./channel-logo-generator');
                    let dyn = logoGen.resolveDynamicLogoUrl(ffmpegSettings, channel);
                    if (dyn && this._fileExists(dyn)) {
                        watermark.url = dyn;
                        console.log(
                            'dizqueTV jellyfin: applied PSD dynamic logo for ch' +
                            channel.number + ' → ' + dyn
                        );
                    } else {
                        console.log(
                            'dizqueTV jellyfin: watermark not local, continuing without overlay:',
                            u
                        );
                        watermark = null;
                    }
                } catch (logoErr) {
                    console.error(
                        'dizqueTV jellyfin: dynamic logo fallback failed',
                        logoErr.message || logoErr
                    );
                    watermark = null;
                }
            } else {
                console.log(
                    'dizqueTV jellyfin: watermark not a local file, continuing without overlay:',
                    u
                );
                watermark = null;
            }
        }
        if (watermark && watermark.url) {
            console.log('dizqueTV jellyfin: watermark url=' + watermark.url);
        } else {
            console.log(
                'dizqueTV jellyfin: no watermark ' +
                '(enabled=' + !!(channel.watermark && channel.watermark.enabled) +
                ', dynamicLogos=' + (ffmpegSettings.enableDynamicChannelLogos === true) + ')'
            );
        }

        let client = new Jellyfin(server);
        let itemId = lineupItem.jellyfinId || lineupItem.ratingKey || lineupItem.key;
        if (typeof itemId === 'string' && itemId.indexOf('/') !== -1) {
            let m = itemId.match(/\/Items\/([^/?]+)/i) || itemId.match(/([0-9a-fA-F]{16,}|[0-9a-fA-F-]{32,})$/i);
            if (m) itemId = m[1];
        }
        if (!itemId) {
            throw Error('Jellyfin program is missing item id');
        }

        let startMs = (typeof lineupItem.start === 'number' && lineupItem.start > 0) ? lineupItem.start : 0;

        console.log(
            `dizqueTV jellyfin: resolving playback server=${server.name} item=${itemId} ` +
            `startMs=${startMs} durationMs=${lineupItem.streamDuration || lineupItem.duration}`
        );

        // Path settings (like Plex): network stream vs direct file + path replace
        let pathSettings = { streamPath: 'jellyfin', pathReplace: '', pathReplaceWith: '' };
        try {
            let rows = db['jellyfin-settings'] ? db['jellyfin-settings'].find() : [];
            if (rows && rows[0]) {
                pathSettings.streamPath = rows[0].streamPath || 'jellyfin';
                pathSettings.pathReplace = rows[0].pathReplace || '';
                pathSettings.pathReplaceWith = rows[0].pathReplaceWith || '';
            }
        } catch (e) { /* ignore */ }

        let preferDirect = pathSettings.streamPath === 'direct';
        // When using direct paths for mid-program, prefer local file so FFmpeg can -ss.
        // Network mid-start still uses PlaybackInfo StartTimeTicks.
        let resolved = await client.resolvePlayback(itemId, {
            startMs: preferDirect ? 0 : startMs,
        });
        let streamUrl = resolved.streamUrl;
        let serverSeeked = !!resolved.serverSeeked;
        let usedLocalFile = false;

        let directPath = lineupItem.file || resolved.path || null;
        if (directPath && pathSettings.pathReplace) {
            try {
                // Global replace of the original Jellyfin path prefix
                let from = String(pathSettings.pathReplace);
                let to = String(pathSettings.pathReplaceWith || '');
                if (from.length > 0) {
                    // Case-sensitive first; also try normalizing slashes
                    if (directPath.indexOf(from) !== -1) {
                        directPath = directPath.split(from).join(to);
                    } else {
                        let normFrom = from.replace(/\//g, '\\');
                        let normPath = directPath.replace(/\//g, '\\');
                        if (normFrom && normPath.indexOf(normFrom) !== -1) {
                            directPath = normPath.split(normFrom).join(to.replace(/\//g, '\\'));
                        } else {
                            let unixFrom = from.replace(/\\/g, '/');
                            let unixPath = directPath.replace(/\\/g, '/');
                            if (unixFrom && unixPath.indexOf(unixFrom) !== -1) {
                                directPath = unixPath.split(unixFrom).join(to.replace(/\\/g, '/'));
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('dizqueTV jellyfin: path replace failed', e.message || e);
            }
        }

        if (preferDirect) {
            if (directPath && this._fileExists(directPath)) {
                streamUrl = directPath;
                usedLocalFile = true;
                serverSeeked = false;
                console.log('dizqueTV jellyfin: direct path mode → ' + directPath);
            } else {
                console.log(
                    'dizqueTV jellyfin: direct path mode but file not readable' +
                    (directPath ? (' (' + directPath + ')') : ' (no Path from Jellyfin)') +
                    ' — falling back to network stream'
                );
                // Mid-start network fallback needs server seek
                if (startMs > 0) {
                    resolved = await client.resolvePlayback(itemId, { startMs: startMs });
                    streamUrl = resolved.streamUrl;
                    serverSeeked = !!resolved.serverSeeked;
                }
            }
        } else if (directPath && this._fileExists(directPath)) {
            // Network mode still prefers a readable local file when available
            streamUrl = directPath;
            usedLocalFile = true;
            serverSeeked = false;
            console.log('dizqueTV jellyfin: using local file path for playback (readable on this host)');
        } else if (directPath) {
            console.log('dizqueTV jellyfin: MediaSource path not readable from this host, using HTTP stream');
        }

        console.log(
            `dizqueTV jellyfin: play server=${server.name} item=${itemId} ` +
            `startMs=${startMs} streamPath=${pathSettings.streamPath} mode=${resolved.mode || '?'} ` +
            `serverSeeked=${serverSeeked} localFile=${usedLocalFile} ` +
            `url=${usedLocalFile ? streamUrl : client.redactUrl(streamUrl)}`
        );

        let res = parseRes(ffmpegSettings.targetResolution, 1920, 1080);
        let durationSec;
        if (typeof lineupItem.streamDuration !== 'undefined') {
            if (lineupItem.start + lineupItem.streamDuration + constants.SLACK < lineupItem.duration) {
                durationSec = lineupItem.streamDuration / 1000;
            }
        }
        let startSec = (startMs > 0 && !serverSeeked) ? (startMs / 1000) : undefined;
        if (startMs > 0 && serverSeeked) {
            console.log(
                `dizqueTV jellyfin: server already seeked to ${(startMs / 1000).toFixed(1)}s — skipping ffmpeg -ss`
            );
        }

        let ffmpegPath = ffmpegSettings.ffmpegPath || 'ffmpeg';
        let args = this._buildArgs(streamUrl, {
            ffmpegSettings: ffmpegSettings,
            watermark: watermark,
            startSec: startSec,
            durationSec: durationSec,
            channelName: channel && channel.name,
            wantedW: res.w,
            wantedH: res.h,
            serverSeeked: serverSeeked,
        });

        console.log('dizqueTV jellyfin: simple pipeline ' + ffmpegPath + ' ' + args.join(' ').replace(/api_key=[^&\s]+/gi, 'api_key=***'));

        if (this.killed) return;

        let emitter = new EventEmitter();
        let stderrBuf = '';
        let gotData = false;

        let proc = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.ffmpegProc = proc;

        proc.stderr.on('data', (chunk) => {
            let s = chunk.toString();
            process.stderr.write(s);
            stderrBuf += s;
            if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-8000);
        });

        proc.on('error', (err) => {
            console.error('dizqueTV jellyfin: ffmpeg process error', err);
            emitter.emit('error', err);
        });

        proc.on('exit', (code, signal) => {
            if (this.killed) {
                console.log(`${this.ffmpegName} exited after kill (code=${code}, signal=${signal})`);
                emitter.emit('close', code);
                return;
            }
            if (code === 0) {
                console.log(`${this.ffmpegName} exited normally`);
                emitter.emit('end');
            } else {
                console.error(
                    `${this.ffmpegName} exited code=${code} signal=${signal}\n` +
                    (stderrBuf ? stderrBuf.trim().split('\n').slice(-25).join('\n') : '(no stderr)')
                );
                // Fall back to error slate so the channel keeps something on screen
                this._spawnErrorSlate(outStream, emitter, ffmpegSettings, channel).catch((e) => {
                    emitter.emit('error', e);
                });
            }
        });

        let ff = proc.stdout;
        let dataWatchdog = setTimeout(() => {
            if (!gotData && !this.killed) {
                console.error(
                    'dizqueTV jellyfin: no media data after 30s — killing ffmpeg. ' +
                    `url=${client.redactUrl(streamUrl)}`
                );
                try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
            }
        }, 30000);

        ff.once('data', () => {
            gotData = true;
            clearTimeout(dataWatchdog);
            console.log('dizqueTV jellyfin: first media data received');
        });
        ff.on('end', () => clearTimeout(dataWatchdog));
        ff.on('close', () => clearTimeout(dataWatchdog));

        ff.pipe(outStream, { end: false });

        return emitter;
    }

    async _spawnErrorSlate(outStream, emitter, ffmpegSettings, channel) {
        try {
            let ffmpeg = new FFMPEG(ffmpegSettings, channel);
            this.ffmpeg = ffmpeg;
            ffmpeg.on('close', () => emitter.emit('close'));
            ffmpeg.on('end', () => emitter.emit('end'));
            ffmpeg.on('error', (err2) => emitter.emit('error', err2));
            let ff = await ffmpeg.spawnError('Error', 'Technical difficulties', 30000);
            ff.pipe(outStream, { end: false });
            emitter.emit('error', new Error('Jellyfin ffmpeg failed; showing error slate'));
        } catch (e) {
            emitter.emit('error', e);
        }
    }
}

module.exports = JellyfinPlayer;
