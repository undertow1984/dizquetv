/******************
 * Offline player is for special screens, like the error
 * screen or the Flex Fallback screen.
 *
 * This module has to follow the program-player contract.
 * Asynchronous call to return a stream. Then the stream
 * can be used to play the program.
 **/
const EventEmitter = require('events');
const FFMPEG = require('./ffmpeg')
const streamPrewarm = require('./stream-prewarm');

class OfflinePlayer {
    constructor(error, context) {
        this.context = context;
        this.error = error;
        this._endedIntentionally = false;
        if (context.isLoading === true) {
            context.channel = JSON.parse( JSON.stringify(context.channel) );
            context.channel.offlinePicture = `http://localhost:${process.env.PORT}/images/loading-screen.png`;
            context.channel.offlineSoundtrack = undefined;
        }
        if (context.isInterlude === true) {
            context.channel = JSON.parse( JSON.stringify(context.channel) );
            context.channel.offlinePicture = `http://localhost:${process.env.PORT}/images/black.png`;
            context.channel.offlineSoundtrack = undefined;
        }
        this.ffmpeg = new FFMPEG(context.ffmpegSettings, context.channel);
        this.ffmpeg.setAudioOnly(this.context.audioOnly);
    }

    cleanUp() {
        this._endedIntentionally = true;
        this.ffmpeg.kill();
    }

    async play(outStream) {
        try {
            let emitter = new EventEmitter();
            let ffmpeg = this.ffmpeg;
            let lineupItem = this.context.lineupItem;
            let duration = lineupItem.streamDuration - lineupItem.start;
            let ff;
            if (this.error) {
                ff = await ffmpeg.spawnError(duration);
            } else {
                ff = await ffmpeg.spawnOffline(duration);
            }
            ff.pipe(outStream,  {'end':false} );

            let finishSegment = () => {
                if (this._endedIntentionally) {
                    return;
                }
                this._endedIntentionally = true;
                try {
                    ff.unpipe(outStream);
                } catch (e) { /* ignore */ }
                try {
                    // End this HTTP segment so concat moves to the next playlist entry
                    if (outStream && typeof outStream.end === 'function' && !outStream.writableEnded) {
                        outStream.end();
                    }
                } catch (e) { /* ignore */ }
                try {
                    ffmpeg.kill();
                } catch (e) { /* ignore */ }
                emitter.emit('end');
            };

            ffmpeg.on('end', () => {
                if (!this._endedIntentionally) {
                    emitter.emit('end');
                }
            });
            ffmpeg.on('close', () => {
                if (!this._endedIntentionally) {
                    emitter.emit('close');
                }
            });
            ffmpeg.on('error', async (err) => {
                if (this._endedIntentionally) {
                    return;
                }
                //wish this code wasn't repeated.
                if (! this.error ) {
                    console.log("Replacing failed stream with error stream");
                    ff.unpipe(outStream);
                    ffmpeg.removeAllListeners('data');
                    ffmpeg.removeAllListeners('end');
                    ffmpeg.removeAllListeners('error');
                    ffmpeg.removeAllListeners('close');
                    ffmpeg = new FFMPEG(this.context.ffmpegSettings, this.context.channel);  // Set the transcoder options
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

                    ff = await ffmpeg.spawnError('oops', 'oops', Math.min(duration, 60000) );
                    ff.pipe(outStream);
                } else {
                    emitter.emit('error', err);
                }

            });

            // Dynamic loading: end splash as soon as prewarm has enough media buffered
            if (
                this.context.isLoading === true
                && lineupItem
                && lineupItem.waitForPrewarm
            ) {
                let w = lineupItem.waitForPrewarm;
                streamPrewarm.waitUntilReady(w.session, w.channel, {
                    minBytes: w.minBytes,
                    maxWaitMs: w.maxWaitMs,
                    minSplashMs: w.minSplashMs,
                }).then((result) => {
                    console.log(
                        'dizqueTV loading: ending splash dynamically — ' +
                        result.reason + ' after ' + result.waitMs + 'ms' +
                        ' (buffered ' + result.bytes + ' bytes)'
                    );
                    // Release first=1 ONLY after splash is done so program video
                    // cannot appear under/before the loading image.
                    try {
                        streamPrewarm.releaseServe(w.session, w.channel);
                    } catch (e) { /* ignore */ }
                    finishSegment();
                }).catch((err) => {
                    console.error('dizqueTV loading: waitUntilReady error', err);
                    try {
                        streamPrewarm.releaseServe(w.session, w.channel);
                    } catch (e) { /* ignore */ }
                    finishSegment();
                });
            }

            return emitter;
        } catch(err) {
            if (err instanceof Error) {
                throw err;
            } else {
                throw Error("Error when attempting to play offline screen: " + JSON.stringify(err) );
            }
        }
    }


}

module.exports = OfflinePlayer;
