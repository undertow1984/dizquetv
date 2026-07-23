/******************
 * This module is to take a "program" and return a stream that plays the
 * program. OR the promise fails which would mean that there was an error
 * playing the program.
 *
 * The main purpose is to have an abstract interface for playing program
 * objects without having to worry the source of the program object.
 * A long-term goal is to be able to have sources other than plex to play
 * videos. This is the first step towards that goal.
 *
 * Returns an event emitter that will have the 'data' or 'end' events.
 * The contract is that the emitter will stream at least some media stream
 * before ending. Any errors that occur after sending the first data will
 * be dealt with internally and be presented as an 'end' event.
 *
 * If there is a timeout when receiving the initial data, or if the program
 * can't load at all for some reason, an Error will be thrown. Make sure to
 * deal with the thrown error.
 **/

let OfflinePlayer = require('./offline-player');
let PlexPlayer = require('./plex-player');
let JellyfinPlayer = require('./jellyfin-player');
const EventEmitter = require('events');
const helperFuncs = require('./helperFuncs');

/**
 * True when this program should play via JellyfinPlayer.
 * Prefer explicit source flags; also detect by jellyfin-servers registry
 * and stream path markers so older channel JSON still works.
 */
function isJellyfinProgram(program, db) {
    if (!program) return false;
    if (program.source === 'jellyfin' || program.serverType === 'jellyfin') {
        return true;
    }
    if (program.jellyfinId) {
        return true;
    }
    if (typeof program.plexFile === 'string' && program.plexFile.indexOf('/Videos/') === 0) {
        return true;
    }
    // serverKey registered as a Jellyfin server (not Plex)
    if (program.serverKey && db && db['jellyfin-servers']) {
        try {
            let rows = db['jellyfin-servers'].find({ name: program.serverKey });
            if (rows && rows.length > 0) {
                return true;
            }
        } catch (e) { /* ignore */ }
    }
    return false;
}

class ProgramPlayer {

    constructor( context ) {
        this.context = context;
        let program = context.lineupItem;
        // Clone settings so per-request mode flags do not mutate the shared DB object
        context.ffmpegSettings = Object.assign({}, context.ffmpegSettings);
        if (context.m3u8) {
            context.ffmpegSettings.normalizeAudio = false;
            // people might want the codec normalization to stay because of player support
            context.ffmpegSettings.normalizeResolution = false;
        }
        // Stream mode is taken from the request context only (set by /stream), not
        // re-read from global settings, so HDHR concat children stay classic MPEG-TS.
        let mode = (context.streamMode || 'mpegts').toString().toLowerCase();
        let remuxModes = { hls_direct: true, hls_direct_v2: true };
        let isPlaceholder = program && (
            program.type === 'loading' || program.type === 'offline' ||
            program.type === 'interlude' || typeof(program.err) !== 'undefined'
        );
        if ((context.remuxOnly === true || remuxModes[mode]) && !isPlaceholder) {
            context.ffmpegSettings.remuxOnly = true;
            context.ffmpegSettings.normalizeAudio = false;
            context.ffmpegSettings.normalizeResolution = false;
            context.ffmpegSettings.normalizeVideoCodec = false;
            context.ffmpegSettings.normalizeAudioCodec = false;
            context.ffmpegSettings.enableHdrToneMapping = false;
            if (context.ffmpegSettings.hlsDirectContainer) {
                context.ffmpegSettings.outputFormat = context.ffmpegSettings.hlsDirectContainer;
            }
            console.log(`ProgramPlayer: remux/direct mode (${mode}), outputFormat=${context.ffmpegSettings.outputFormat || 'mpegts'}`);
        } else {
            context.ffmpegSettings.remuxOnly = false;
            if (mode === 'mpegts' || !mode) {
                context.ffmpegSettings.outputFormat = 'mpegts';
            }
        }
        if (mode === 'hls_slower' && !isPlaceholder) {
            // Stronger normalize for transitions (Tunarr "HLS alt" idea)
            context.ffmpegSettings.normalizeAudio = true;
            context.ffmpegSettings.normalizeResolution = true;
            context.ffmpegSettings.normalizeVideoCodec = true;
            context.ffmpegSettings.normalizeAudioCodec = true;
            context.ffmpegSettings.remuxOnly = false;
            console.log('ProgramPlayer: hls_slower mode — full normalize enabled');
        }
        context.ffmpegSettings.noRealTime = program.noRealTime;
        if ( typeof(program.err) !== 'undefined') {
            console.log("About to play error stream");
            this.delegate = new OfflinePlayer(true, context);
        } else if (program.type === 'loading') {
            console.log("About to play loading stream");
            /* loading */
            context.isLoading = true;
            this.delegate = new OfflinePlayer(false, context);
        } else if (program.type === 'interlude') {
            console.log("About to play interlude stream");
            /* interlude */
            context.isInterlude = true;
            this.delegate = new OfflinePlayer(false, context);
        } else if (program.type === 'offline') {
            console.log("About to play offline stream");
            /* offline */
            this.delegate = new OfflinePlayer(false, context);
        } else if (isJellyfinProgram(program, context.db)) {
            console.log("About to play jellyfin stream");
            // Ensure identity fields survive even if lineup construction omitted them
            if (!program.source) program.source = 'jellyfin';
            if (!program.serverType) program.serverType = 'jellyfin';
            this.delegate = new JellyfinPlayer(context);
        } else {
            console.log("About to play plex stream");
            /* plex (default) */
            this.delegate = new PlexPlayer(context);
        }
        this.context.watermark = helperFuncs.getWatermark( context.ffmpegSettings, context.channel, context.lineupItem.type);
    }

    cleanUp() {
        this.delegate.cleanUp();
    }

    async playDelegate(outStream) {
        return await new Promise( async (accept, reject) => {

            try {
                let stream = await this.delegate.play(outStream);
                accept(stream);
                let emitter = new EventEmitter();
                function end() {
                    reject( Error("Stream ended with no data") );
                    stream.removeAllListeners("data");
                    stream.removeAllListeners("end");
                    stream.removeAllListeners("close");
                    stream.removeAllListeners("error");
                    emitter.emit("end");
                }
                stream.on("error", err => {
                    reject( Error("Stream ended in error with no data. " + JSON.stringify(err) ) );
                    end();
                });
                stream.on("end", end);
                stream.on("close", end);
            } catch (err) {
                reject(err);
            }
        })
    }
    async play(outStream) {
        try {
            return await this.playDelegate(outStream);
        } catch(err) {
            if (! (err instanceof Error) ) {
                err= Error("Program player had an error before receiving any data. " + JSON.stringify(err) );
            }
            if (this.context.lineupItem.err instanceof Error) {
                console.log(err.stack);
                throw Error("Additional error when attempting to play error stream.");
            }
            console.log("Error when attempting to play video. Fallback to error stream: " + err.stack);
            //Retry once with an error stream:
            this.context.lineupItem = {
                err: err,
                start: this.context.lineupItem.start,
                streamDuration: this.context.lineupItem.streamDuration,
            }
            this.delegate.cleanUp();
            this.delegate = new OfflinePlayer(true, this.context);
            return await this.play(outStream);
        }
    }
}

module.exports = ProgramPlayer;
