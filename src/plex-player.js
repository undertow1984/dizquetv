/******************
 * This module has to follow the program-player contract.
 * Async call to get a stream.
 * * If connection to plex or the file entry fails completely before playing
 *   it rejects the promise and the error is an Error() class.
 * * Otherwise it returns a stream.
 **/
const PlexTranscoder = require('./plexTranscoder')
const EventEmitter = require('events');
const helperFuncs = require('./helperFuncs')
const FFMPEG = require('./ffmpeg')
const constants = require('./constants');
const subtitleExtractor = require('./subtitle-extractor');

let USED_CLIENTS = {};

class PlexPlayer {

    constructor(context) {
        this.context = context;
        this.ffmpeg = null;
        this.plexTranscoder = null;
        this.killed = false;
        let coreClientId = this.context.db['client-id'].find()[0].clientId;
        let i = 0;
        while ( USED_CLIENTS[coreClientId+"-"+i]===true) {
            i++;
        }
        this.clientId = coreClientId+"-"+i;
        USED_CLIENTS[this.clientId] = true;
    }

    cleanUp() {
        USED_CLIENTS[this.clientId] = false;
        this.killed = true;
        if (this.plexTranscoder != null) {
            this.plexTranscoder.stopUpdatingPlex();
            this.plexTranscoder = null;
        }
        if (this.ffmpeg != null) {
            this.ffmpeg.kill();
            this.ffmpeg = null;
        }
    }

    async play(outStream) {
        let lineupItem = this.context.lineupItem;
        let ffmpegSettings = this.context.ffmpegSettings;
        let db = this.context.db;
        let channel = this.context.channel;
        let server = db['plex-servers'].find( { 'name': lineupItem.serverKey } );
        if (server.length == 0) {
            throw Error(`Unable to find server "${lineupItem.serverKey}" specified by program.`);
        }
        server = server[0];
        if (server.uri.endsWith("/")) {
            server.uri = server.uri.slice(0, server.uri.length - 1);
        }

        try {
            // Always re-read FFmpeg settings from DB so UI changes apply on the next
            // program without requiring a full process restart.
            let liveFfmpeg = db['ffmpeg-settings'].find()[0] || {};
            // Do not re-apply streamMode/hlsDirectContainer here — those are request-scoped
            // (HDHR always mpegts; M3U may pass streamMode=). Re-applying global mode would
            // fight ProgramPlayer remux/outputFormat isolation.
            const LIVE_KEYS = [
                'ffmpegPath', 'threads', 'logFfmpeg', 'concatMuxDelay',
                'enableFFMPEGTranscoding', 'videoEncoder', 'audioEncoder',
                'targetResolution', 'videoBitrate', 'videoBufSize',
                'audioBitrate', 'audioBufSize', 'audioVolumePercent',
                'audioChannels', 'audioSampleRate', 'maxFPS',
                'scalingAlgorithm', 'deinterlaceFilter',
                'normalizeVideoCodec', 'normalizeAudioCodec',
                'normalizeResolution', 'normalizeAudio',
                'errorScreen', 'errorAudio',
                'preferredLanguage', 'includeSubtitles', 'subtitleMode',
                'enableHdrToneMapping', 'hdrToneMappingAlgorithm',
                'transcodingSpeed', 'hardwareDecode', 'hardwareDecodeDevice',
                'hwAccelExtraFrames', 'disableChannelOverlay',
                'enableDynamicChannelLogos', 'channelLogoTemplatePath',
                'channelLogoTemplateTwoPath',
                'enableChannelWatermarkGlobally',
            ];
            for (let i = 0; i < LIVE_KEYS.length; i++) {
                let k = LIVE_KEYS[i];
                if (typeof liveFfmpeg[k] !== 'undefined' && liveFfmpeg[k] !== null) {
                    ffmpegSettings[k] = liveFfmpeg[k];
                }
            }

            let preferredLanguage = (
                (ffmpegSettings.preferredLanguage != null && ffmpegSettings.preferredLanguage !== '')
                    ? ffmpegSettings.preferredLanguage
                    : 'eng'
            );
            preferredLanguage = String(preferredLanguage).trim().toLowerCase();
            ffmpegSettings.preferredLanguage = preferredLanguage;

            // Normalize subtitle mode (off | soft | soft_burn); keep legacy boolean in sync
            let subtitleMode = 'off';
            try {
                const { normalizeSubtitleMode } = require('./services/ffmpeg-settings-service');
                subtitleMode = normalizeSubtitleMode(ffmpegSettings);
            } catch (e) {
                subtitleMode = (ffmpegSettings.includeSubtitles === true) ? 'soft_burn' : 'off';
                if (ffmpegSettings.subtitleMode) {
                    let m = String(ffmpegSettings.subtitleMode).toLowerCase();
                    if (m === 'soft' || m === 'soft_burn' || m === 'off') {
                        subtitleMode = m;
                    }
                }
            }
            ffmpegSettings.subtitleMode = subtitleMode;
            ffmpegSettings.includeSubtitles = (subtitleMode !== 'off');
            let includeSubtitles = (subtitleMode !== 'off');
            let allowTextBurn = (subtitleMode === 'soft_burn');

            // Clone plex settings and attach FFmpeg language/subtitle preferences so track
            // selection and soft-subtitle mapping can use them during stream setup.
            let plexSettings = Object.assign({}, db['plex-settings'].find()[0]);
            plexSettings.preferredLanguage = preferredLanguage;
            plexSettings.includeSubtitles = includeSubtitles;
            plexSettings.subtitleMode = subtitleMode;
            console.log(
                `dizqueTV: stream language preference=${preferredLanguage}, ` +
                `subtitleMode=${subtitleMode}, ` +
                `hdrToneMap=${ffmpegSettings.enableHdrToneMapping === true}, ` +
                `hwDecode=${ffmpegSettings.hardwareDecode || 'none'}, ` +
                `speed=${ffmpegSettings.transcodingSpeed || 'default'}, ` +
                `encoder=${ffmpegSettings.videoEncoder}/${ffmpegSettings.audioEncoder}`
            );
            let plexTranscoder = new PlexTranscoder(this.clientId, server, plexSettings, channel, lineupItem);
            this.plexTranscoder = plexTranscoder;
            // Re-resolve watermark after live FFmpeg settings (dynamic PSD logos need enableDynamicChannelLogos)
            try {
                const helperFuncs = require('./helperFuncs');
                this.context.watermark = helperFuncs.getWatermark(
                    ffmpegSettings,
                    channel,
                    lineupItem.type
                );
            } catch (wmErr) {
                console.error('dizqueTV: watermark resolve failed', wmErr.message || wmErr);
            }
            let watermark = this.context.watermark;
            if (watermark && watermark.url) {
                console.log('dizqueTV: watermark url=' + watermark.url);
            } else {
                console.log(
                    'dizqueTV: no watermark ' +
                    '(enabled=' + !!(channel.watermark && channel.watermark.enabled) +
                    ', dynamicLogos=' + (ffmpegSettings.enableDynamicChannelLogos === true) + ')'
                );
            }
            let ffmpeg = new FFMPEG(ffmpegSettings, channel);  // Set the transcoder options
            ffmpeg.setAudioOnly( this.context.audioOnly );
            this.ffmpeg = ffmpeg;
            let streamDuration;
            if (typeof(lineupItem.streamDuration)!=='undefined') {
                if (lineupItem.start + lineupItem.streamDuration + constants.SLACK < lineupItem.duration) {
                    streamDuration = lineupItem.streamDuration / 1000;
                }
            }
            let deinterlace = ffmpegSettings.enableFFMPEGTranscoding; //for now it will always deinterlace when transcoding is enabled but this is sub-optimal

            let stream = await plexTranscoder.getStream(deinterlace);
            if (this.killed) {
                return;
            }

            //let streamStart = (stream.directPlay) ? plexTranscoder.currTimeS : undefined;
            //let streamStart = (stream.directPlay) ? plexTranscoder.currTimeS : lineupItem.start;
            let streamStart = (stream.directPlay) ? plexTranscoder.currTimeS : undefined;
            let streamStats = stream.streamStats;
            streamStats.duration = lineupItem.streamDuration;
            // Mid-program start: FFmpeg -ss seeks video; SRT times must be shifted to match
            if (typeof streamStart === 'number' && !isNaN(streamStart) && streamStart > 0) {
                streamStats.subtitleStartOffsetSec = streamStart;
            } else if (lineupItem && typeof lineupItem.start === 'number' && lineupItem.start > 0) {
                // lineupItem.start is milliseconds into the program file
                streamStats.subtitleStartOffsetSec = lineupItem.start / 1000;
            } else {
                streamStats.subtitleStartOffsetSec = 0;
            }
            streamStats.subtitleBurnInstanceId =
                'ch' + (channel && channel.number != null ? channel.number : 'x') +
                '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

            // Text extract+burn only in soft_burn mode. Soft-only never burns.
            // Image tracks are soft-mapped in ffmpeg when forceSubtitleTrack is set.
            if (
                allowTextBurn
                && stream.directPlay
                && streamStats.needsTextSubtitleExtract
                && streamStats.subtitleAbsoluteIndex != null
                && typeof(streamStats.subtitleAbsoluteIndex) !== 'undefined'
            ) {
                let cacheKey = lineupItem.ratingKey
                    || lineupItem.key
                    || lineupItem.plexFile
                    || stream.streamUrl;
                try {
                    let extracted = await subtitleExtractor.extractEmbeddedSubtitle({
                        ffmpegPath: ffmpegSettings.ffmpegPath,
                        sourceUrl: stream.streamUrl,
                        streamIndex: streamStats.subtitleAbsoluteIndex,
                        codec: streamStats.subtitleCodec || 'srt',
                        cacheKey: String(cacheKey),
                    });
                    if (extracted) {
                        streamStats.extractedSubtitlePath = extracted;
                        streamStats.burnExtractedSubtitles = true;
                        // Soft-map of text into MPEG-TS is unreliable; burn instead.
                        streamStats.forceSubtitleTrack = false;
                        console.log(
                            `dizqueTV subtitles: will BURN extracted file ${extracted} ` +
                            `(offset=${(streamStats.subtitleStartOffsetSec || 0).toFixed(3)}s, ` +
                            `instance=${streamStats.subtitleBurnInstanceId})`
                        );
                    } else {
                        console.log(
                            'dizqueTV subtitles: text extract failed or skipped; ' +
                            'no soft text track can be sent on MPEG-TS live streams'
                        );
                    }
                } catch (extractErr) {
                    console.error('dizqueTV subtitles: extract error', extractErr);
                }
            } else if (
                subtitleMode === 'soft'
                && streamStats.needsTextSubtitleExtract
                && !streamStats.subtitleImageBased
            ) {
                console.log(
                    'dizqueTV subtitles: soft-only mode — skipping text burn for ' +
                    (streamStats.subtitleCodec || 'text') +
                    ' (no soft SRT/ASS on MPEG-TS Live TV)'
                );
                streamStats.needsTextSubtitleExtract = false;
                streamStats.forceSubtitleTrack = false;
                streamStats.burnExtractedSubtitles = false;
            }
            if (this.killed) {
                return;
            }

            let emitter = new EventEmitter();
            //setTimeout( () => {
                let ff = await ffmpeg.spawnStream(stream.streamUrl, stream.streamStats, streamStart, streamDuration, watermark, lineupItem.type); // Spawn the ffmpeg process
                ff.pipe(outStream,  {'end':false} );
            //}, 100);
            plexTranscoder.startUpdatingPlex();

            
            ffmpeg.on('end', () => {
                emitter.emit('end');
            });
            ffmpeg.on('close', () => {
                emitter.emit('close');
            });
            ffmpeg.on('error', async (err) => {
                console.log("Replacing failed stream with error stream");
                ff.unpipe(outStream);
                ffmpeg.removeAllListeners('data');
                ffmpeg.removeAllListeners('end');
                ffmpeg.removeAllListeners('error');
                ffmpeg.removeAllListeners('close');
                ffmpeg = new FFMPEG(ffmpegSettings, channel);  // Set the transcoder options
                ffmpeg.setAudioOnly(this.context.audioOnly);
                ffmpeg.on('close', () => {
                    emitter.emit('close');
                });
                ffmpeg.on('end', () => {
                    emitter.emit('end');
                });
                ffmpeg.on('error', (err) => {
                    emitter.emit('error', err );
                });

                ff = await ffmpeg.spawnError('oops', 'oops', Math.min(streamStats.duration, 60000) );
                ff.pipe(outStream);

                emitter.emit('error', err);
            });
            return emitter;

        } catch(err) {
            return Error("Error when playing plex program: " + JSON.stringify(err) );
        }
    }
}

module.exports = PlexPlayer;
