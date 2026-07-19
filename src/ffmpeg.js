const spawn = require('child_process').spawn
const events = require('events')
const subtitleExtractor = require('./subtitle-extractor')

const MAXIMUM_ERROR_DURATION_MS = 60000;
const REALLY_RIDICULOUSLY_HIGH_FPS_FOR_DIZQUETVS_USECASE = 120;

class FFMPEG extends events.EventEmitter {
    constructor(opts, channel) {
        super()
        this.opts = opts;
        this.errorPicturePath = `http://localhost:${process.env.PORT}/images/generic-error-screen.png`;
        this.ffmpegName = "unnamed ffmpeg";
        if (! this.opts.enableFFMPEGTranscoding) {
            //this ensures transcoding is completely disabled even if
            // some settings are true
            this.opts.normalizeAudio = false;
            this.opts.normalizeAudioCodec = false;
            this.opts.normalizeVideoCodec = false;
            this.opts.errorScreen = 'kill';
            this.opts.normalizeResolution = false;
            this.opts.audioVolumePercent = 100;
            this.opts.maxFPS = REALLY_RIDICULOUSLY_HIGH_FPS_FOR_DIZQUETVS_USECASE;
            this.opts.enableHdrToneMapping = false;
        }
        if (this.opts.remuxOnly === true) {
            this.opts.normalizeAudio = false;
            this.opts.normalizeAudioCodec = false;
            this.opts.normalizeVideoCodec = false;
            this.opts.normalizeResolution = false;
            this.opts.enableHdrToneMapping = false;
            this.opts.audioVolumePercent = 100;
            this.apad = false;
            this.audioChannelsSampleRate = false;
            this.alignAudio = false;
            this.ensureResolution = false;
        }
        this.channel = channel
        this.ffmpegPath = opts.ffmpegPath

        let resString = opts.targetResolution;
        if (
            (typeof(channel.transcoding) !== 'undefined')
            && (channel.transcoding.targetResolution != null)
            && (typeof(channel.transcoding.targetResolution) != 'undefined')
            && (channel.transcoding.targetResolution != "")
        ) {
            resString = channel.transcoding.targetResolution;
        }

        if (
            (typeof(channel.transcoding) !== 'undefined')
            && (channel.transcoding.videoBitrate != null)
            && (typeof(channel.transcoding.videoBitrate) != 'undefined')
            && (channel.transcoding.videoBitrate != 0)
        ) {
            opts.videoBitrate = channel.transcoding.videoBitrate;
        }

        if (
            (typeof(channel.transcoding) !== 'undefined')
            && (channel.transcoding.videoBufSize != null)
            && (typeof(channel.transcoding.videoBufSize) != 'undefined')
            && (channel.transcoding.videoBufSize != 0)
        ) {
            opts.videoBufSize = channel.transcoding.videoBufSize;
        }

        let parsed = parseResolutionString(resString);
        this.wantedW = parsed.w;
        this.wantedH = parsed.h;

        this.sentData = false;
        // Normalize Audio UI option → apad + force channels/sample rate + -shortest
        this.apad = this.opts.normalizeAudio === true;
        this.audioChannelsSampleRate = this.opts.normalizeAudio === true;
        this.alignAudio = this.opts.normalizeAudio === true;
        this.ensureResolution = this.opts.normalizeResolution === true;
        this.volumePercent = (typeof this.opts.audioVolumePercent === 'number')
            ? this.opts.audioVolumePercent
            : parseFloat(this.opts.audioVolumePercent) || 100;
        this.hasBeenKilled = false;
        this.audioOnly = false;
        this._subtitleBurnCleanup = null;
    }
    setAudioOnly(audioOnly) {
        this.audioOnly = audioOnly;
    }
    async spawnConcat(streamUrl) {
        return await this.spawn(streamUrl, undefined, undefined, undefined, true, false, undefined, true)
    }
    async spawnStream(streamUrl, streamStats, startTime, duration, enableIcon, type) {
        return await this.spawn(streamUrl, streamStats, startTime, duration, true, enableIcon, type, false);
    }
    async spawnError(title, subtitle, duration) {
        if (! this.opts.enableFFMPEGTranscoding || this.opts.errorScreen == 'kill') {
            console.error("error: " + title + " ; " + subtitle);
            this.emit('error', { code: -1, cmd: `error stream disabled. ${title} ${subtitle}`} )
            return;
        }
        if (typeof(duration) === 'undefined') {
            //set a place-holder duration
            console.log("No duration found for error stream, using placeholder");
            duration = MAXIMUM_ERROR_DURATION_MS ;
        }
        duration = Math.min(MAXIMUM_ERROR_DURATION_MS, duration);
        let streamStats = {
            videoWidth : this.wantedW,
            videoHeight : this.wantedH,
            duration : duration,
        };
        return await this.spawn({ errorTitle: title , subtitle: subtitle }, streamStats, undefined, `${streamStats.duration}ms`, true, false, 'error', false)
    }
    async spawnOffline(duration) {
        if (! this.opts.enableFFMPEGTranscoding) {
            console.log("The channel has an offline period scheduled for this time slot. FFMPEG transcoding is disabled, so it is not possible to render an offline screen. Ending the stream instead");
            this.emit('end', { code: -1, cmd: `offline stream disabled.`} )
            return;
        }

        let streamStats = {
            videoWidth : this.wantedW,
            videoHeight : this.wantedH,
            duration : duration,
        };
        return await this.spawn( {errorTitle: 'offline'}, streamStats, undefined, `${duration}ms`, true, false, 'offline', false);
    }
    async spawn(streamUrl, streamStats, startTime, duration, limitRead, watermark, type, isConcatPlaylist) {

        // genpts/igndts keep MPEG-TS stable; fastseek helps mid-program joins.
        // Do NOT use +nobuffer / -avioflags direct here — they stall or break many
        // Plex HTTP / 4K HDR inputs (time-to-first-frame can jump to minutes).
        let ffmpegArgs = [
             `-threads`, isConcatPlaylist? 1 : this.opts.threads,
                          `-fflags`, `+genpts+discardcorrupt+igndts+fastseek`];
        let stillImage = false;
        let isGenerated = (typeof streamUrl === 'object' && typeof streamUrl.errorTitle !== 'undefined');

        // -re (realtime read) only for:
        //  - client-facing concat pipe (pace live output)
        //  - generated offline/error/loading screens with fixed duration
        // Program segments should encode ASAP so prewarm can fill a buffer quickly;
        // TCP backpressure stops them from racing ahead of the concat consumer.
        if (limitRead === true && (isConcatPlaylist || isGenerated)) {
            ffmpegArgs.push(`-re`);
        }

        // Fast input analysis — enough for common containers once Plex gave us the URL
        if (!isConcatPlaylist && !isGenerated) {
            ffmpegArgs.push(
                `-probesize`, `1000000`,
                `-analyzeduration`, `500000`,
                `-thread_queue_size`, `1024`
            );
        }

        // Put -ss BEFORE -i for input-level seek (much faster than decode-seek).
        // -noaccurate_seek trades frame-exactness for speed on mid-program joins.
        if (typeof startTime !== 'undefined' && !isGenerated) {
            ffmpegArgs.push(`-ss`, startTime);
            if (this.opts.fastSeek !== false) {
                ffmpegArgs.push(`-noaccurate_seek`);
            }
        }

        if (isConcatPlaylist == true)
            ffmpegArgs.push(`-f`, `concat`,
                            `-safe`, `0`,
                            `-protocol_whitelist`, `file,http,tcp,https,tcp,tls`)

        // Resolve which audio stream FFmpeg should map (preferred language track).
        // Priority: absolute container index → relative a:N → language metadata → first audio.
        let audioIndex = resolveAudioMapIndex(streamStats);
        let forceAudioTrack = !!(streamStats && streamStats.forceAudioTrack && audioIndex !== 'a');

        //TODO: Do something about missing audio stream
        if (!isConcatPlaylist) {
            let inputFiles = 0;
            let audioFile = -1;
            let videoFile = -1;
            let overlayFile = -1;
            if ( !isGenerated ) {
                // Hardware decode (CUDA/QSV/etc.) — before -i. Frames stay in system
                // memory so CPU filters (scale/tonemap/subtitles) keep working.
                appendHardwareDecodeFlags(ffmpegArgs, this.opts, streamStats);
                // HTTP reconnect helps when reading from Plex over the network
                if (typeof streamUrl === 'string' && /^https?:\/\//i.test(streamUrl)) {
                    ffmpegArgs.push(
                        `-reconnect`, `1`,
                        `-reconnect_streamed`, `1`,
                        `-reconnect_delay_max`, `2`
                    );
                }
                ffmpegArgs.push(`-i`, streamUrl);
                videoFile = inputFiles++;
                audioFile = videoFile;
            }


            // When we have an individual stream, there is a pipeline of possible
            // filters to apply.
            //
            var doOverlay = ( (typeof(watermark)==='undefined') || (watermark != null) );
            var iW =  streamStats.videoWidth;
            var iH =  streamStats.videoHeight;

            // (explanation is the same for the video and audio streams)
            // The initial stream is called '[video]'
            var currentVideo = "[video]";
            var currentAudio = "[audio]";
            // Initially, videoComplex does nothing besides assigning the label
            // to the input stream
            var videoIndex = 'v';
            // Always pin the chosen audio stream as [audio] so later filters
            // (volume/apad) and -map never fall back to stream 0 / first audio.
            var audioComplex = `;[${audioFile}:${audioIndex}]anull[audio]`;
            var videoComplex = `;[${videoFile}:${videoIndex}]null[video]`;
            if (forceAudioTrack) {
                console.log(`dizqueTV ffmpeg: mapping audio stream ${audioFile}:${audioIndex}`);
            }
            // Depending on the options we will apply multiple filters
            // each filter modifies the current video stream. Adds a filter to
            // the videoComplex variable. The result of the filter becomes the 
            // new currentVideo value.
            //
            // When adding filters, make sure that
            // videoComplex always begins wiht ; and doesn't end with ;

            if ( streamStats.videoFramerate >= this.opts.maxFPS + 0.000001 ) {
                videoComplex += `;${currentVideo}fps=${this.opts.maxFPS}[fpchange]`;
                currentVideo ="[fpchange]";
            }

            // deinterlace if desired
            if (streamStats.videoScanType == 'interlaced' && this.opts.deinterlaceFilter != 'none') {
                videoComplex += `;${currentVideo}${this.opts.deinterlaceFilter}[deinterlaced]`;
                currentVideo = "[deinterlaced]";
            }

            // HDR → SDR tone mapping when enabled and source reports HDR metadata.
            // Chain mirrors Tunarr's software TonemapFilter: explicit tin= is required
            // so zscale correctly inverts PQ/HLG (without it FFmpeg often fails on HDR).
            let shouldToneMap = (
                this.opts.enableHdrToneMapping === true
                && this.audioOnly !== true
                && typeof(streamUrl.errorTitle) === 'undefined'
                && streamStats
                && streamStats.isHDR === true
                && !streamStats.audioOnly
            );
            if (shouldToneMap) {
                let tonemapFilter = buildHdrTonemapFilter(
                    streamStats.colorTrc || streamStats.colorTransfer,
                    this.opts.hdrToneMappingAlgorithm,
                    streamStats.colorPrimaries || streamStats.colorSpace
                );
                // currentVideo is always [label] from earlier steps
                let tIn = currentVideo.charAt(0) === '[' ? currentVideo : `[${currentVideo}]`;
                videoComplex += `;${tIn}${tonemapFilter}[tonemapped]`;
                currentVideo = "[tonemapped]";
                console.log(
                    `dizqueTV: applying HDR tone mapping filter=${tonemapFilter} ` +
                    `(trc=${streamStats.colorTrc || streamStats.colorTransfer || '?'}, ` +
                    `primaries=${streamStats.colorPrimaries || streamStats.colorSpace || '?'})`
                );
            }

            // prepare input streams
            if  ( ( typeof(streamUrl.errorTitle) !== 'undefined') || (streamStats.audioOnly) ) {
                doOverlay = false; //never show icon in the error screen
                // for error stream, we have to generate the input as well
                this.apad = false; //all of these generate audio correctly-aligned to video so there is no need for apad
                this.audioChannelsSampleRate = true; //we'll need these

                //all of the error strings already choose the resolution to
                //match iW x iH , so with this we save ourselves a second
                // scale filter
                iW = this.wantedW;
                iH = this.wantedH;

                let durstr = `duration=${streamStats.duration}ms`;

              if (this.audioOnly !== true) {
                let pic = null;

                //does an image to play exist?
                if (
                    (typeof(streamUrl.errorTitle) === 'undefined')
                    &&
                    (streamStats.audioOnly)
                ) {
                    pic = streamStats.placeholderImage;
                } else if ( streamUrl.errorTitle == 'offline') {
                    pic = `${this.channel.offlinePicture}`;
                } else if ( this.opts.errorScreen == 'pic' ) {
                    pic = `${this.errorPicturePath}`;
                }

                if (pic != null) {
                    if (this.opts.noRealTime === true) {
                        ffmpegArgs.push("-r" , "60");
                    } else {
                        ffmpegArgs.push("-r" , "24");
                    }
                    ffmpegArgs.push(
                        '-i', pic,
                    );
                    if (
                        (typeof duration === 'undefined')
                        &&
                        (typeof(streamStats.duration) !== 'undefined' )
                    ) {
                        //add 150 milliseconds just in case, exact duration seems to cut out the last bits of music some times.
                        duration = `${streamStats.duration + 150}ms`;
                    }
                    videoComplex = `;[${inputFiles++}:0]format=yuv420p[formatted]`;
                    videoComplex +=`;[formatted]scale=w=${iW}:h=${iH}:force_original_aspect_ratio=1[scaled]`;
                    videoComplex += `;[scaled]pad=${iW}:${iH}:(ow-iw)/2:(oh-ih)/2[padded]`;
                    videoComplex += `;[padded]loop=loop=-1:size=1:start=0`;
                    if (this.opts.noRealTime !== true) {
                        videoComplex +=`[looped];[looped]realtime[videox]`;
                    } else {
                        videoComplex +=`[videox]`
                    }
                    //this tune apparently makes the video compress better
                    // when it is the same image
                    stillImage = true;
                    this.volumePercent = Math.min(70, this.volumePercent);

                } else if (this.opts.errorScreen == 'static') {
                    ffmpegArgs.push(
                        '-f', 'lavfi',
                        '-i', `nullsrc=s=64x36`);
                    videoComplex = `;geq=random(1)*255:128:128[videoz];[videoz]scale=${iW}:${iH}[videoy];[videoy]realtime[videox]`;
                    inputFiles++;
                } else if (this.opts.errorScreen == 'testsrc') {
                    ffmpegArgs.push(
                        '-f', 'lavfi',
                        '-i', `testsrc=size=${iW}x${iH}`,
                    );
                    videoComplex = `;realtime[videox]`;
                    inputFiles++;
                } else if (this.opts.errorScreen == 'text') {
                    var sz2 = Math.ceil( (iH) / 33.0);
                    var sz1 = Math.ceil( sz2 * 3. / 2. );
                    var sz3 = 2*sz2;
                  
                    ffmpegArgs.push(
                        '-f', 'lavfi',
                        '-i', `color=c=black:s=${iW}x${iH}`
                    );
                    inputFiles++;

                    videoComplex = `;drawtext=fontfile=${process.env.DATABASE}/font.ttf:fontsize=${sz1}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:text='${streamUrl.errorTitle}',drawtext=fontfile=${process.env.DATABASE}/font.ttf:fontsize=${sz2}:fontcolor=white:x=(w-text_w)/2:y=(h+text_h+${sz3})/2:text='${streamUrl.subtitle}'[videoy];[videoy]realtime[videox]`;
                } else { //blank
                    ffmpegArgs.push(
                        '-f', 'lavfi',
                        '-i', `color=c=black:s=${iW}x${iH}`
                    );
                    inputFiles++;
                    videoComplex = `;realtime[videox]`;
                }
              }

              if (typeof(streamUrl.errorTitle) !== 'undefined') {
                //silent
                audioComplex = `;aevalsrc=0:${durstr}[audioy]`;
                if ( streamUrl.errorTitle == 'offline' ) {
                    if (
                        (typeof(this.channel.offlineSoundtrack) !== 'undefined') 
                        && (this.channel.offlineSoundtrack != '' )
                    ) {
                        ffmpegArgs.push('-i', `${this.channel.offlineSoundtrack}`);
                        // I don't really understand why, but you need to use this
                        // 'size' in order to make the soundtrack actually loop
                        audioComplex = `;[${inputFiles++}:a]aloop=loop=-1:size=2147483647[audioy]`;
                    }
                } else if (
                    (this.opts.errorAudio == 'whitenoise')
                    ||
                    (
                        !(this.opts.errorAudio == 'sine')
                        &&
                        (this.audioOnly === true)  //when it's in audio-only mode, silent stream is confusing for errors.
                    )
                ) {
                    audioComplex = `;aevalsrc=random(0):${durstr}[audioy]`;
                    this.volumePercent = Math.min(70, this.volumePercent);
                } else if (this.opts.errorAudio == 'sine') {
                    audioComplex = `;sine=f=440:${durstr}[audioy]`;
                    this.volumePercent = Math.min(70, this.volumePercent);
                }
                if ( this.audioOnly !== true ) {
                    ffmpegArgs.push('-pix_fmt' , 'yuv420p' );
                }
                audioComplex += ';[audioy]arealtime[audiox]';
                currentAudio = "[audiox]";
              }
                currentVideo = "[videox]";
            }
            if (doOverlay) {
                if (watermark.animated === true) {
                    ffmpegArgs.push('-ignore_loop', '0');
                } else {
                    // Still PNG/GIF/JPG: loop so overlay lasts the full segment
                    ffmpegArgs.push('-loop', '1');
                }
                ffmpegArgs.push(`-i`, `${watermark.url}`);
                overlayFile = inputFiles++;
                this.ensureResolution = true;
            }

            // Resolution fix: Add scale filter, current stream becomes [siz]
            let beforeSizeChange = currentVideo;
            let algo =  this.opts.scalingAlgorithm;
            let resizeMsg = "";
            if (
                (!streamStats.audioOnly)
                &&
                (
                  (this.ensureResolution && ( streamStats.anamorphic || (iW != this.wantedW || iH != this.wantedH) ) )
                  ||
                  isLargerResolution(iW, iH, this.wantedW, this.wantedH)
                )
            ) {
                //scaler stuff, need to change the size of the video and also add bars
                // calculate wanted aspect ratio
                let p = iW * streamStats.pixelP ;
                let q = iH * streamStats.pixelQ;
                let g = gcd(q,p); // and people kept telling me programming contests knowledge had no use real programming!
                p = Math.floor(p / g);
                q = Math.floor(q / g);
                let hypotheticalW1 = this.wantedW;
                let hypotheticalH1 = Math.floor(hypotheticalW1*q / p);
                let hypotheticalH2 = this.wantedH;
                let hypotheticalW2 = Math.floor( (this.wantedH * p) / q );
                let cw, ch;
                if (hypotheticalH1 <= this.wantedH) {
                    cw = hypotheticalW1;
                    ch = hypotheticalH1;
                } else {
                    cw = hypotheticalW2;
                    ch = hypotheticalH2;
                }
                videoComplex += `;${currentVideo}scale=${cw}:${ch}:flags=${algo}[scaled]`;
                currentVideo = "scaled";
                resizeMsg = `Stretch to ${cw} x ${ch}. To fit target resolution of ${this.wantedW} x ${this.wantedH}.`;
                if (this.ensureResolution) {
                    console.log(`First stretch to ${cw} x ${ch}. Then add padding to make it ${this.wantedW} x ${this.wantedH} `);
                } else if (cw % 2 == 1 || ch % 2 ==1)  {
                    //we need to add padding so that the video dimensions are even
                    let xw  = cw + cw % 2;
                    let xh  = ch + ch % 2;
                    resizeMsg = `Stretch to ${cw} x ${ch}. To fit target resolution of ${this.wantedW} x ${this.wantedH}. Then add 1 pixel of padding so that dimensions are not odd numbers, because they are frowned upon. The final resolution will be ${xw} x ${xh}`;
                    this.wantedW = xw;
                    this.wantedH = xh;
                } else {
                    resizeMsg = `Stretch to ${cw} x ${ch}. To fit target resolution of ${this.wantedW} x ${this.wantedH}.`;
                }
                if ( (this.wantedW != cw) || (this.wantedH != ch) ) {
                    // also add black bars, because in this case it HAS to be this resolution
                    videoComplex += `;[${currentVideo}]pad=${this.wantedW}:${this.wantedH}:(ow-iw)/2:(oh-ih)/2[blackpadded]`;
                    currentVideo = "blackpadded";
                }
                let name = "siz";
                if (! this.ensureResolution && (beforeSizeChange != '[fpchange]') ) {
                    name = "minsiz";
                }
                videoComplex += `;[${currentVideo}]setsar=1[${name}]`;
                currentVideo = `[${name}]`;
                iW = this.wantedW;
                iH = this.wantedH;
            }

            // After scale/pad (and before burn), force 8-bit 4:2:0 so NVENC/h264
            // always get a compatible pixel format (10-bit/HDR sources often fail otherwise).
            if (
                this.audioOnly !== true
                && typeof(streamUrl.errorTitle) === 'undefined'
                && !streamStats.audioOnly
                && currentVideo !== '[video]'
            ) {
                let needFmt = true;
                // tonemap filter already ends in format=yuv420p
                if (this.opts.enableHdrToneMapping === true && streamStats && streamStats.isHDR === true) {
                    needFmt = false;
                }
                if (needFmt) {
                    let vIn = currentVideo.charAt(0) === '[' ? currentVideo : `[${currentVideo}]`;
                    // Only add if we will filter video (scale already did, or watermark will)
                    if (vIn !== '[video]') {
                        videoComplex += `;${vIn}format=yuv420p[vfmt]`;
                        currentVideo = "[vfmt]";
                    }
                }
            }

            // Burn extracted text subtitles AFTER scale/pad (final frame size).
            // Tunarr-style subtitles= filter; format=yuv420p required for NVENC.
            // Per-stream burn file + timestamp shift for mid-program starts.
            if (
                streamStats
                && streamStats.burnExtractedSubtitles === true
                && streamStats.extractedSubtitlePath
                && this.audioOnly !== true
                && typeof(streamUrl.errorTitle) === 'undefined'
                && !streamStats.audioOnly
            ) {
                try {
                    let offsetSec = 0;
                    if (typeof startTime !== 'undefined' && startTime !== null && startTime !== '') {
                        // startTime may be "123.45" seconds or "HH:MM:SS"
                        let st = String(startTime);
                        if (st.indexOf(':') !== -1) {
                            let parts = st.split(':').map(Number);
                            if (parts.length === 3) {
                                offsetSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
                            } else if (parts.length === 2) {
                                offsetSec = parts[0] * 60 + parts[1];
                            }
                        } else {
                            offsetSec = parseFloat(st) || 0;
                        }
                    } else if (streamStats.subtitleStartOffsetSec) {
                        offsetSec = Number(streamStats.subtitleStartOffsetSec) || 0;
                    }
                    let burnResult = subtitleExtractor.buildSubtitlesBurnFilter(
                        streamStats.extractedSubtitlePath,
                        {
                            startOffsetSec: offsetSec,
                            instanceId: streamStats.subtitleBurnInstanceId ||
                                ('s' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)),
                        }
                    );
                    if (burnResult && burnResult.filter) {
                        this._subtitleBurnCleanup = burnResult.cleanup;
                        // currentVideo may be [label] or bare label depending on prior steps
                        let vIn = currentVideo.charAt(0) === '[' ? currentVideo : `[${currentVideo}]`;
                        videoComplex += `;${vIn}${burnResult.filter}[subburned]`;
                        currentVideo = "[subburned]";
                        console.log(
                            `dizqueTV: burning extracted subtitle file ${streamStats.extractedSubtitlePath} ` +
                            `offset=${offsetSec.toFixed(3)}s via ${burnResult.filter.substring(0, 100)}...`
                        );
                    }
                } catch (burnErr) {
                    console.error(
                        'dizqueTV: subtitle burn setup failed, continuing without burn:',
                        burnErr.message || burnErr
                    );
                }
            } else if (
                streamStats
                && streamStats.subtitleImageBased === true
                && streamStats.burnSubtitles === true
                && streamStats.burnSubtitleIndex != null
                && this.audioOnly !== true
                && typeof(streamUrl.errorTitle) === 'undefined'
                && !streamStats.audioOnly
            ) {
                let subIn = `${videoFile}:${streamStats.burnSubtitleIndex}`;
                let vIn = currentVideo.charAt(0) === '[' ? currentVideo : `[${currentVideo}]`;
                videoComplex += `;${vIn}[${subIn}]overlay=eof_action=pass,format=yuv420p[subburned]`;
                currentVideo = "[subburned]";
                console.log(`dizqueTV: burning image subtitle stream ${subIn}`);
            }

            // Channel watermark:
            if (doOverlay && (this.audioOnly !== true) ) {
                var pW =watermark.width;
                var w = Math.round( pW * iW / 100.0 );
                var mpHorz = watermark.horizontalMargin;
                var mpVert = watermark.verticalMargin;
                var horz = Math.round( mpHorz * iW / 100.0 );
                var vert = Math.round( mpVert * iH / 100.0 );

                let posAry = {
                    'top-left': `x=${horz}:y=${vert}`,
                    'top-right': `x=W-w-${horz}:y=${vert}`,
                    'bottom-left': `x=${horz}:y=H-h-${vert}`,
                    'bottom-right':  `x=W-w-${horz}:y=H-h-${vert}`,
                }
                let icnDur = ''
                if (watermark.duration > 0) {
                    icnDur = `:enable='between(t,0,${watermark.duration})'`
                }
                let waterVideo = `[${overlayFile}:v]`;
                if ( ! watermark.fixedSize) {
                    videoComplex += `;${waterVideo}scale=${w}:-1[icn]`;
                    waterVideo = '[icn]';
                }
                let p = posAry[watermark.position];
                if (typeof(p) === 'undefined') {
                    throw Error("Invalid watermark position: " + watermark.position);
                }
                let overlayShortest = "";
                if (watermark.animated) {
                    overlayShortest = "shortest=1:";
                }
                videoComplex += `;${currentVideo}${waterVideo}overlay=${overlayShortest}${p}${icnDur}[comb]`
                currentVideo = '[comb]';
            }


            if (this.volumePercent != 100) {
                var f = this.volumePercent / 100.0;
                audioComplex += `;${currentAudio}volume=${f}[boosted]`;
                currentAudio = '[boosted]';
            }
            // Align audio is just the apad filter applied to audio stream
            if (this.apad &&  (this.audioOnly !== true) ) {
                //it doesn't make much sense to pad audio when there is no video
                audioComplex += `;${currentAudio}apad=whole_dur=${streamStats.duration}ms[padded]`;
                currentAudio = '[padded]';
            }

            // If no filters have been applied, then the stream will still be
            // [video] , in that case, we do not actually add the video stuff to
            // filter_complex and this allows us to avoid transcoding.
            let forceChannels = this.audioChannelsSampleRate === true;
            let transcodeVideo = (this.opts.normalizeVideoCodec &&  isDifferentVideoCodec( streamStats.videoCodec, this.opts.videoEncoder) );
            // Normalize Audio (channels/rate/apad) always requires audio re-encode when on
            let transcodeAudio = (
                (this.opts.normalizeAudioCodec && isDifferentAudioCodec( streamStats.audioCodec, this.opts.audioEncoder))
                || forceChannels
                || this.apad === true
                || (this.volumePercent != 100)
            );
            let filterComplex = '';
            if ( (!transcodeVideo) && (currentVideo == '[minsiz]') ) {
                //do not change resolution if no other transcoding will be done
                // and resolution normalization is off
                currentVideo = beforeSizeChange;
            } else {
                console.log(resizeMsg)
            }
            if (this.audioOnly !== true) {
                if (currentVideo != '[video]') {
                    transcodeVideo = true; //this is useful so that it adds some lines below
                    filterComplex += videoComplex;
                } else {
                    currentVideo = `${videoFile}:${videoIndex}`;
                }
            }
            // same with audio:
            // currentAudio stays '[audio]' only if no volume/apad filters ran.
            // In that case map the resolved stream specifier directly (e.g. 0:2).
            // If filters ran, audioComplex already starts from that same specifier.
            if (currentAudio != '[audio]') {
                transcodeAudio = true;
                filterComplex += audioComplex;
            } else {
                // Direct map of preferred stream (0:N or 0:a:N) — no first-track fallback
                currentAudio = `${audioFile}:${audioIndex}`;
            }

            //If there is a filter complex, add it.
            if (filterComplex != '') {
                ffmpegArgs.push(`-filter_complex` , filterComplex.slice(1) );
                // -shortest pairs with apad so video end cuts padded audio (Normalize Audio)
                if (this.alignAudio || this.apad) {
                    ffmpegArgs.push('-shortest');
                }
            }
            if (this.audioOnly !== true) {
                ffmpegArgs.push(
                    '-map', currentVideo,
                    `-c:v`, (transcodeVideo ? this.opts.videoEncoder : 'copy'),
                    `-sc_threshold`, `1000000000`,
                );
                // NVENC (and most software encoders) need a standard pixel format after
                // filters like subtitles=/zscale. Force yuv420p whenever we transcode.
                if (transcodeVideo) {
                    ffmpegArgs.push('-pix_fmt', 'yuv420p');
                    // Low-latency encode path (faster first frame, less internal buffering)
                    appendVideoEncoderLowLatencyFlags(ffmpegArgs, this.opts.videoEncoder);
                }
                // do not use -tune stillimage for nv
                if (stillImage && ! this.opts.videoEncoder.toLowerCase().includes("nv") ) {
                    ffmpegArgs.push('-tune', 'stillimage');
                }
            }
            // cgop keeps closed GOPs for MPEG-TS (do not force low_delay — breaks some NVENC/filter graphs)
            ffmpegArgs.push(
                            '-map', currentAudio,
                            `-flags`, `cgop+ilme`,
            );
            console.log(`dizqueTV ffmpeg: -map audio ${currentAudio} (spec=${audioIndex}, force=${forceAudioTrack})`);

            // Soft pass-through of preferred IMAGE subtitle track (PGS/VOBSUB/DVB).
            // Text is never soft-mapped into MPEG-TS (use soft_burn extract+burn instead).
            let subMode = (streamStats && streamStats.subtitleMode)
                || this.opts.subtitleMode
                || (this.opts.includeSubtitles === true ? 'soft_burn' : 'off');
            let mapSubtitle = (
                subMode !== 'off'
                && this.audioOnly !== true
                && typeof(streamStats) !== 'undefined'
                && streamStats.forceSubtitleTrack === true
                && typeof(streamUrl.errorTitle) === 'undefined'
                && videoFile >= 0
            );
            if (mapSubtitle) {
                let subCodec = (streamStats.subtitleCodec || '').toString().toLowerCase();
                let imageSub = streamStats.subtitleImageBased === true || isMpegTsSubtitleCodec(subCodec);
                let subSpec = resolveSubtitleMapSpec(videoFile, streamStats);
                if (subSpec && imageSub) {
                    // Hard-map image tracks (no trailing ?) so the stream is always present
                    // for clients that can list/toggle soft subs. Absolute 0:N preferred.
                    if (String(subSpec).indexOf('?') !== -1) {
                        subSpec = String(subSpec).replace(/\?+$/, '');
                    }
                    ffmpegArgs.push('-map', subSpec);
                    // copy keeps PGS/VOBSUB/DVB bitmaps; do not re-encode
                    ffmpegArgs.push('-c:s', 'copy');
                    // Help Plex / players discover the track
                    let subLang = (
                        streamStats.subtitleLanguage
                        || this.opts.preferredLanguage
                        || 'eng'
                    );
                    let subTitle = streamStats.subtitleTitle || subLang;
                    // Sanitize metadata for FFmpeg arg safety
                    subLang = String(subLang).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'eng';
                    subTitle = String(subTitle).replace(/['"\\:=]/g, ' ').slice(0, 64) || subLang;
                    let disposition = streamStats.subtitleForced ? 'default+forced' : 'default';
                    ffmpegArgs.push(
                        '-disposition:s:0', disposition,
                        '-metadata:s:s:0', `language=${subLang}`,
                        '-metadata:s:s:0', `handler_name=${subTitle}`,
                        '-metadata:s:s:0', `title=${subTitle}`
                    );
                    // Avoid dropping late subtitle packets when A/V encode is heavy
                    ffmpegArgs.push('-max_muxing_queue_size', '1024');
                    console.log(
                        `dizqueTV ffmpeg: SOFT-MAP image subtitle -map ${subSpec} -c:s copy ` +
                        `(codec=${subCodec || '?'}, lang=${subLang}, title="${subTitle}", ` +
                        `disposition=${disposition})`
                    );
                } else if (subSpec && !imageSub) {
                    console.log(
                        `dizqueTV ffmpeg: skip soft-map for text codec "${subCodec || '?'}" ` +
                        `(mode=${subMode}; use soft_burn to burn text into video)`
                    );
                } else {
                    console.log('dizqueTV ffmpeg: subtitle soft-map requested but no stream index resolved');
                }
            }
            if ( transcodeVideo && (this.audioOnly !== true) ) {
                // Encoder-specific rate control. -crf is for libx264/libx265 only;
                // NVENC/QSV/AMF reject or ignore it and can stall or fail the encode.
                appendVideoEncoderRateControlFlags(
                    ffmpegArgs,
                    this.opts.videoEncoder,
                    this.opts.videoBitrate,
                    this.opts.videoBufSize
                );
                // Encoder speed preset (very slow → ultra fast)
                appendVideoEncoderSpeedFlags(ffmpegArgs, this.opts.videoEncoder, this.opts.transcodingSpeed);
            }
            if ( transcodeAudio ) {
                // Audio bitrate / buffer from UI (was incorrectly using videoBufSize)
                let aBr = this.opts.audioBitrate || 192;
                let aBuf = this.opts.audioBufSize || aBr;
                ffmpegArgs.push(
                            `-b:a`, `${aBr}k`,
                            `-maxrate:a`, `${aBr}k`,
                            `-bufsize:a`, `${aBuf}k`
                );
                if (this.audioChannelsSampleRate) {
                    ffmpegArgs.push(
                        `-ac`, `${this.opts.audioChannels}`,
                        `-ar`, `${this.opts.audioSampleRate}k`
                    );
                }
            }
            if (transcodeAudio && transcodeVideo) {
                console.log("Video and Audio are being transcoded by ffmpeg");
            } else if (transcodeVideo) {
                console.log("Video is being transcoded by ffmpeg. Audio is being copied.");
            } else  if (transcodeAudio) {
                console.log("Audio is being transcoded by ffmpeg. Video is being copied.");
            } else {
                console.log("Video and Audio are being copied. ffmpeg is not transcoding.");
            }
            // When mapping a soft subtitle, keep stream language metadata if we set it above.
            // Global map_metadata -1 still clears file-level tags which we do not need.
            //
            // Program segments must emit ASAP (muxdelay 0). Applying Video Buffer here
            // literally holds the first packets for N seconds and makes tune-in / prewarm
            // feel slow. The UI Video Buffer only applies on the outer concat pipe below.
            ffmpegArgs.push(
                            `-c:a`,  (transcodeAudio ? this.opts.audioEncoder : 'copy'),
                            '-map_metadata', '-1',
                            '-movflags', '+faststart',
                            // Flush packets out of the muxer immediately (pipe consumers see data sooner)
                            `-flush_packets`, `1`,
                            `-max_interleave_delta`, `0`,
                            `-muxdelay`, `0`,
                            `-muxpreload`, `0`
            );
            if (this.opts.preferredLanguage && typeof(streamStats) !== 'undefined' && typeof(streamStats.audioIndex) !== 'undefined') {
                ffmpegArgs.push(
                    `-metadata:s:a:0`, `language=${this.opts.preferredLanguage}`
                );
            }
        } else {
            // Concat stream (client-facing continuous pipe for /video).
            // Keep demux options minimal — large probesize/analyzeduration or
            // muxpreload *before* -i breaks concat+HTTP playlist (exit -22).
            // Video Buffer only applies as output -muxdelay/-muxpreload (seconds).
            let muxDelay = getMuxDelaySeconds(this.opts);
            console.log(`dizqueTV concat: video buffer muxdelay/muxpreload=${muxDelay}s`);
            ffmpegArgs.push(
                            // Small probesize is intentional for ffconcat playlist of HTTP URLs
                            `-probesize`, `32`,
                            `-i`, streamUrl );
            if (this.audioOnly !== true) {
                ffmpegArgs.push( `-map`, `0:v` );
            }
            ffmpegArgs.push(
                            `-map`, `0:${audioIndex}`,
                            `-c`, `copy`,
                            `-muxdelay`, String(muxDelay),
                            `-muxpreload`, String(muxDelay)
            );
        }

        ffmpegArgs.push(`-metadata`,
                        `service_provider="dizqueTV"`,
                        `-metadata`,
                        `service_name="${this.channel.name}"`,
                        );

        //t should be before -f
        if (typeof duration !== 'undefined') {
            ffmpegArgs.push(`-t`, `${duration}`);
        }

        // Output container (mpegts default; HLS Direct may use mkv/mp4)
        let outFmt = (this.opts.outputFormat || 'mpegts').toString().toLowerCase();
        if (outFmt === 'mkv' || outFmt === 'matroska') {
            ffmpegArgs.push(`-f`, `matroska`, `pipe:1`);
        } else if (outFmt === 'mp4') {
            // fragmented mp4 for streaming over HTTP pipe
            ffmpegArgs.push(`-movflags`, `frag_keyframe+empty_moov+default_base_moof`, `-f`, `mp4`, `pipe:1`);
        } else {
            // MPEG-TS: resend PAT/PMT so late joiners / prewarm handoff lock quickly
            ffmpegArgs.push(
                `-mpegts_flags`, `+resend_headers`,
                `-f`, `mpegts`, `pipe:1`
            );
        }

        let doLogs = this.opts.logFfmpeg && !isConcatPlaylist;
        // Capture stderr for all program encodes so startup failures (bad hwaccel,
        // rejected NVENC flags, filter errors) appear even when "Log FFMPEG" is off.
        let captureStderr = doLogs || !isConcatPlaylist;
        if (this.hasBeenKilled) {
            return ;
        }
        if (!isConcatPlaylist && !isGenerated) {
            console.log(
                `dizqueTV ffmpeg opts: encoder=${this.opts.videoEncoder}/${this.opts.audioEncoder} ` +
                `speed=${this.opts.transcodingSpeed || 'default'} ` +
                `hwDecode=${this.opts.hardwareDecode || 'none'} ` +
                `hdrTonemap=${this.opts.enableHdrToneMapping === true} ` +
                `normV=${this.opts.normalizeVideoCodec === true}/A=${this.opts.normalizeAudioCodec === true}/` +
                `res=${this.opts.normalizeResolution === true}/aud=${this.opts.normalizeAudio === true} ` +
                `subs=${this.opts.subtitleMode || (this.opts.includeSubtitles ? 'on' : 'off')} lang=${this.opts.preferredLanguage || '-'} ` +
                `v=${this.opts.videoBitrate || '?'}k a=${this.opts.audioBitrate || '?'}k ` +
                `vol=${this.volumePercent}% threads=${this.opts.threads}`
            );
        }
        if (doLogs) {
            console.log(this.ffmpegPath + " " + ffmpegArgs.join(" "));
        }
        this.ffmpeg = spawn(this.ffmpegPath, ffmpegArgs, {
            stdio: ['ignore', 'pipe', captureStderr ? 'pipe' : 'ignore']
        });
        if (this.hasBeenKilled) {
            console.log("Send SIGKILL to ffmpeg");
            this.ffmpeg.kill("SIGKILL");
            return;
        }

        let stderrBuf = '';
        if (captureStderr && this.ffmpeg.stderr) {
            this.ffmpeg.stderr.on('data', (chunk) => {
                let s = chunk.toString();
                if (doLogs) {
                    process.stderr.write(s);
                }
                stderrBuf += s;
                if (stderrBuf.length > 12000) {
                    stderrBuf = stderrBuf.slice(-6000);
                }
            });
        }

        this.ffmpegName = (isConcatPlaylist ? "Concat FFMPEG":  "Stream FFMPEG");

        this.ffmpeg.on('error', (code, signal) => {
            console.log( `${this.ffmpegName} received error event: ${code}, ${signal}` );
         });
        this.ffmpeg.on('exit', (code, signal) => {
            this._cleanupSubtitleBurn();
            if (code === null) {
                if (!this.hasBeenKilled) {
                    console.log( `${this.ffmpegName} exited due to signal: ${signal}` );
                } else {
                    console.log( `${this.ffmpegName} exited due to signal: ${signal} as expected.`);
                }
                this.emit('close', code)
            } else if (code === 0) {
                console.log( `${this.ffmpegName} exited normally.` );
                this.emit('end')
            } else if (code === 255) {
                if (this.hasBeenKilled) {
                    console.log( `${this.ffmpegName} finished with code 255.` );
                    this.emit('close', code)
                    return;
                }
                if (stderrBuf) {
                    console.log(`${this.ffmpegName} stderr (last lines):\n${stderrBuf.trim().split('\n').slice(-20).join('\n')}`);
                }
                if (! this.sentData) {
                    this.emit('error', { code: code, cmd: `${this.opts.ffmpegPath} ${ffmpegArgs.join(' ')}` })
                }
                console.log( `${this.ffmpegName} exited with code 255.` );
                this.emit('close', code)
            } else {
                console.log( `${this.ffmpegName} exited with code ${code}.` );
                if (stderrBuf) {
                    console.log(`${this.ffmpegName} stderr (last lines):\n${stderrBuf.trim().split('\n').slice(-20).join('\n')}`);
                }
                this.emit('error', { code: code, cmd: `${this.opts.ffmpegPath} ${ffmpegArgs.join(' ')}` })
            }
        });

        return this.ffmpeg.stdout;
    }
    kill() {
        console.log(`${this.ffmpegName} RECEIVED kill() command`);
        this.hasBeenKilled = true;
        this._cleanupSubtitleBurn();
        if (typeof(this.ffmpeg) != "undefined") {
            console.log(`${this.ffmpegName} this.ffmpeg.kill()`);
            this.ffmpeg.kill("SIGKILL")
        }
    }
    _cleanupSubtitleBurn() {
        if (typeof this._subtitleBurnCleanup === 'function') {
            try {
                this._subtitleBurnCleanup();
            } catch (e) { /* ignore */ }
            this._subtitleBurnCleanup = null;
        }
    }
}

/**
 * Tunarr-style software HDR→SDR tonemap chain.
 * Explicit tin= (input transfer) is required for PQ/HLG; without it zscale often fails.
 * Also sets pin= (input primaries) when known so BT.2020 content maps correctly.
 */
function buildHdrTonemapFilter(colorTrc, algorithm, colorPrimaries) {
    let algo = (algorithm || 'hable').toString().toLowerCase().trim();
    const allowed = ['hable', 'reinhard', 'mobius', 'gamma', 'linear', 'clip', 'bt2390'];
    if (allowed.indexOf(algo) === -1) {
        algo = 'hable';
    }
    let transfer = normalizeColorTransfer(colorTrc);
    let prim = normalizeColorPrimaries(colorPrimaries);
    // Match Tunarr TonemapFilter: zscale=t=linear:tin=<trc>:npl=100,...
    let tinParam = transfer ? `:tin=${transfer}` : ':tin=smpte2084';
    let pinParam = prim ? `:pin=${prim}` : ':pin=bt2020';
    // Prefer zscale+tonemap (needs libzimg). This is the Tunarr software path.
    // format=gbrpf32le keeps full range for the tonemap operator.
    return (
        `zscale=t=linear${tinParam}${pinParam}:npl=100,format=gbrpf32le,` +
        `zscale=p=bt709,tonemap=tonemap=${algo}:desat=0:peak=100,` +
        `zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
    );
}

/** Normalize primaries names for zscale pin=. */
function normalizeColorPrimaries(primaries) {
    if (!primaries) {
        return 'bt2020';
    }
    let p = String(primaries).toLowerCase().trim();
    if (p.indexOf('2020') !== -1 || p.indexOf('bt2020') !== -1) {
        return 'bt2020';
    }
    if (p.indexOf('709') !== -1) {
        return 'bt709';
    }
    if (p.indexOf('601') !== -1) {
        return 'bt470bg';
    }
    // Default wide-gamut for HDR sources
    return 'bt2020';
}

/** Normalize Plex/FFmpeg color transfer names to values zscale accepts. */
function normalizeColorTransfer(trc) {
    if (!trc) {
        // HDR10/DoVi default to PQ when transfer unknown (Tunarr DV Profile 5 handling)
        return 'smpte2084';
    }
    let t = String(trc).toLowerCase().trim();
    if (t === 'smpte2084' || t === 'smpte2086' || t.indexOf('pq') !== -1 || t.indexOf('2084') !== -1) {
        return 'smpte2084';
    }
    if (t === 'arib-std-b67' || t.indexOf('hlg') !== -1 || t.indexOf('b67') !== -1) {
        return 'arib-std-b67';
    }
    if (t === 'bt709' || t === 'iec61966-2-1' || t === 'gamma22' || t === 'gamma28') {
        // Already SDR-ish; still return so tin= is set
        return t === 'bt709' ? 'bt709' : t;
    }
    // Unknown HDR tag — assume PQ
    return 'smpte2084';
}

/**
 * Subtitle map specifier for soft pass-through.
 * Prefer absolute Plex stream.index (0:N), else relative among subtitle streams (0:s:N).
 */
function resolveSubtitleMapSpec(videoFile, streamStats) {
    if (typeof(streamStats.subtitleAbsoluteIndex) !== 'undefined'
        && streamStats.subtitleAbsoluteIndex !== null
        && streamStats.subtitleAbsoluteIndex !== ''
        && !isNaN(Number(streamStats.subtitleAbsoluteIndex))) {
        return `${videoFile}:${streamStats.subtitleAbsoluteIndex}`;
    }
    if (typeof(streamStats.subtitleRelativeIndex) !== 'undefined'
        && streamStats.subtitleRelativeIndex !== null
        && !isNaN(Number(streamStats.subtitleRelativeIndex))) {
        return `${videoFile}:s:${streamStats.subtitleRelativeIndex}`;
    }
    if (typeof(streamStats.subtitleIndex) !== 'undefined'
        && streamStats.subtitleIndex !== null
        && streamStats.subtitleIndex !== '') {
        let idx = String(streamStats.subtitleIndex);
        // Already an s:N form?
        if (idx.indexOf('s:') === 0 || idx === 's') {
            return `${videoFile}:${idx}`;
        }
        return `${videoFile}:${idx}`;
    }
    return null;
}

function isMpegTsSubtitleCodec(codec) {
    if (!codec) {
        return false;
    }
    let c = String(codec).toLowerCase();
    return (
        c === 'pgs' ||
        c === 'pgssub' ||
        c === 'hdmv_pgs_subtitle' ||
        c === 'dvd_subtitle' ||
        c === 'dvdsub' ||
        c === 'vobsub' ||
        c === 'dvb_subtitle' ||
        c === 'dvbsub' ||
        c === 'dvb_teletext' ||
        c === 'xsub'
    );
}

/**
 * Build FFmpeg audio stream specifier for -map / filter_complex.
 * Prefers absolute container index from Plex, then relative a:N, then language.
 */
function resolveAudioMapIndex(streamStats) {
    if (typeof streamStats === 'undefined' || streamStats === null) {
        return 'a';
    }

    // 1) Absolute container stream index (Plex Stream.index) — best match for FFmpeg 0:N
    if (
        typeof(streamStats.audioAbsoluteIndex) !== 'undefined'
        && streamStats.audioAbsoluteIndex !== null
        && streamStats.audioAbsoluteIndex !== ''
        && !isNaN(Number(streamStats.audioAbsoluteIndex))
    ) {
        return String(streamStats.audioAbsoluteIndex);
    }

    // 2) Explicit audioIndex already set (number or a:N)
    if (
        typeof(streamStats.audioIndex) !== 'undefined'
        && streamStats.audioIndex !== null
        && streamStats.audioIndex !== ''
        && streamStats.audioIndex !== 'a'
    ) {
        return String(streamStats.audioIndex);
    }

    // 3) Relative audio stream among audio-only streams
    if (
        typeof(streamStats.audioRelativeIndex) !== 'undefined'
        && streamStats.audioRelativeIndex !== null
        && !isNaN(Number(streamStats.audioRelativeIndex))
    ) {
        return `a:${streamStats.audioRelativeIndex}`;
    }

    // 4) Language metadata (container tags) — last resort before default
    if (Array.isArray(streamStats.audioLanguageCodes) && streamStats.audioLanguageCodes.length > 0) {
        // FFmpeg stream specifier: a:m:language:eng
        return `a:m:language:${streamStats.audioLanguageCodes[0]}`;
    }

    return 'a';
}

/**
 * Video Buffer setting (UI: concatMuxDelay) as seconds for -muxdelay/-muxpreload.
 * Accepts number or string from the settings form ("0"…"10").
 */
function getMuxDelaySeconds(opts) {
    if (!opts) {
        return 0;
    }
    let d = opts.concatMuxDelay;
    if (d === undefined || d === null || d === '') {
        return 0;
    }
    let n = parseFloat(d);
    if (isNaN(n) || n < 0) {
        return 0;
    }
    // Cap to avoid multi-minute startup
    if (n > 30) {
        n = 30;
    }
    return n;
}

/**
 * Hardware decode (-hwaccel …) before -i.
 * Frames are left in system memory (no -hwaccel_output_format) so software
 * filters (scale, zscale tonemap, subtitles burn) continue to work. Still a
 * large win for 4K HEVC/HDR decode on CUDA/QSV/D3D11.
 *
 * IMPORTANT: when software HDR→SDR tonemap is enabled, hwaccel is skipped.
 * CUDA/D3D11 download often collapses 10-bit PQ/HLG to 8-bit before zscale
 * runs, which makes tonemap a no-op and leaves the picture looking wrong.
 */
function appendHardwareDecodeFlags(ffmpegArgs, opts, streamStats) {
    if (!opts || opts.enableFFMPEGTranscoding === false) {
        return;
    }
    // Remux/copy-only paths do not need decode accel
    if (opts.remuxOnly === true) {
        return;
    }
    // Generated offline/error screens have no real video input
    if (!streamStats || streamStats.audioOnly === true) {
        return;
    }

    let mode = (opts.hardwareDecode || 'none').toString().toLowerCase().trim();
    if (!mode || mode === 'none' || mode === 'off' || mode === 'disabled') {
        return;
    }

    // Software tonemap needs full bit-depth + transfer metadata from the decoder
    let needsSoftTonemap = (
        opts.enableHdrToneMapping === true
        && streamStats.isHDR === true
    );
    if (needsSoftTonemap) {
        console.log(
            'dizqueTV: skipping hwaccel — HDR tone mapping needs software decode ' +
            '(10-bit PQ/HLG). Encode still uses NVENC/QSV if configured.'
        );
        return;
    }

    let accel = mode;
    if (mode === 'auto') {
        let enc = (opts.videoEncoder || '').toString().toLowerCase();
        if (enc.indexOf('nvenc') !== -1) {
            accel = 'cuda';
        } else if (enc.indexOf('qsv') !== -1) {
            accel = 'qsv';
        } else if (enc.indexOf('amf') !== -1) {
            // D3D11VA is the usual Windows path for AMD/Intel/NVIDIA software filters
            accel = 'd3d11va';
        } else if (enc.indexOf('videotoolbox') !== -1) {
            accel = 'videotoolbox';
        } else {
            // Software encoder: leave decode on CPU unless user picks an explicit accel
            return;
        }
    }

    const allowed = [
        'cuda', 'qsv', 'd3d11va', 'dxva2', 'vaapi', 'videotoolbox',
        'opencl', 'vulkan', 'drm', 'mediacodec'
    ];
    if (allowed.indexOf(accel) === -1) {
        console.log(`dizqueTV: unknown hardwareDecode="${mode}", skipping hwaccel`);
        return;
    }

    ffmpegArgs.push(`-hwaccel`, accel);

    // Extra surfaces avoid "not enough frames in hw pool" with filters after decode
    if (accel === 'cuda' || accel === 'qsv' || accel === 'vaapi' || accel === 'd3d11va') {
        let n = parseInt(opts.hwAccelExtraFrames, 10);
        if (isNaN(n) || n < 2) {
            n = 8;
        }
        if (n > 64) {
            n = 64;
        }
        ffmpegArgs.push(`-extra_hw_frames`, String(n));
    }

    // Optional device index (multi-GPU): hardwareDecodeDevice = "0", "1", …
    if (opts.hardwareDecodeDevice !== undefined && opts.hardwareDecodeDevice !== null && String(opts.hardwareDecodeDevice).trim() !== '') {
        let dev = String(opts.hardwareDecodeDevice).trim();
        // cuda uses -hwaccel_device; qsv often uses -qsv_device / init_hw_device
        if (accel === 'cuda' || accel === 'd3d11va' || accel === 'dxva2' || accel === 'opencl' || accel === 'vulkan') {
            ffmpegArgs.push(`-hwaccel_device`, dev);
        } else if (accel === 'qsv') {
            ffmpegArgs.push(`-qsv_device`, dev);
        } else if (accel === 'vaapi') {
            // Path like /dev/dri/renderD128
            ffmpegArgs.push(`-vaapi_device`, dev);
        }
    }

    console.log(
        `dizqueTV: hardware decode hwaccel=${accel}` +
        (opts.hardwareDecodeDevice != null && String(opts.hardwareDecodeDevice).trim() !== ''
            ? ` device=${opts.hardwareDecodeDevice}`
            : '') +
        ` (frames → system memory for CPU filters)`
    );
}

/**
 * Low-latency encoder flags so the first keyframe / packets emit sooner.
 * Kept conservative — exotic NVENC options (ull, forced-idr, strict_gop) break
 * on many FFmpeg/driver builds and produce zero output until kill.
 */
function appendVideoEncoderLowLatencyFlags(ffmpegArgs, videoEncoder) {
    let enc = (videoEncoder || '').toString().toLowerCase();
    if (enc.indexOf('nvenc') !== -1) {
        // Compatible low-latency NVENC (h264 + hevc): no B-frames, no lookahead
        ffmpegArgs.push(
            '-bf', '0',
            '-rc-lookahead', '0',
            '-delay', '0'
        );
        // Short GOP so a keyframe appears quickly after seek
        ffmpegArgs.push('-g', '48', '-keyint_min', '24');
        return;
    }
    if (enc.indexOf('qsv') !== -1) {
        ffmpegArgs.push('-bf', '0', '-look_ahead', '0', '-g', '48');
        return;
    }
    if (enc.indexOf('libx264') !== -1) {
        ffmpegArgs.push(
            '-tune', 'zerolatency',
            '-bf', '0',
            '-g', '48',
            '-keyint_min', '24',
            '-sc_threshold', '0'
        );
        return;
    }
    if (enc.indexOf('libx265') !== -1) {
        ffmpegArgs.push('-tune', 'zerolatency', '-bf', '0', '-g', '48');
        return;
    }
    if (enc.indexOf('amf') !== -1) {
        ffmpegArgs.push('-bf_max', '0', '-g', '48');
        return;
    }
    // Generic: short GOP
    ffmpegArgs.push('-g', '48');
}

/**
 * Rate-control flags per encoder family.
 * Software x264/x265: CRF + maxrate. NVENC/QSV/AMF: bitrate/VBR (no -crf).
 */
function appendVideoEncoderRateControlFlags(ffmpegArgs, videoEncoder, videoBitrate, videoBufSize) {
    let enc = (videoEncoder || '').toString().toLowerCase();
    let br = videoBitrate || 2000;
    let buf = videoBufSize || br;

    if (enc.indexOf('nvenc') !== -1) {
        // NVIDIA NVENC: VBR with target bitrate (crf is not valid / unreliable).
        // Use configured buffer size (capping too hard can confuse rate control on 4K).
        let nvBuf = Math.max(buf || br, br);
        ffmpegArgs.push(
            '-rc:v', 'vbr',
            '-cq:v', '23',
            `-b:v`, `${br}k`,
            `-maxrate:v`, `${br}k`,
            `-bufsize:v`, `${nvBuf}k`
        );
        return;
    }
    if (enc.indexOf('qsv') !== -1) {
        ffmpegArgs.push(
            '-global_quality', '23',
            `-b:v`, `${br}k`,
            `-maxrate`, `${br}k`,
            `-bufsize`, `${buf}k`
        );
        return;
    }
    if (enc.indexOf('amf') !== -1) {
        ffmpegArgs.push(
            '-rc', 'vbr_latency',
            `-b:v`, `${br}k`,
            `-maxrate`, `${br}k`,
            `-bufsize`, `${buf}k`
        );
        return;
    }
    if (enc.indexOf('videotoolbox') !== -1) {
        ffmpegArgs.push(
            `-b:v`, `${br}k`,
            `-maxrate`, `${br}k`,
            `-bufsize`, `${buf}k`
        );
        return;
    }
    if (enc === 'mpeg2video' || enc.indexOf('mpeg2') !== -1) {
        // qscale + bitrate — same approach as original dizqueTV
        ffmpegArgs.push(
            `-qscale:v`, `1`,
            `-b:v`, `${br}k`,
            `-maxrate:v`, `${br}k`,
            `-bufsize:v`, `${buf}k`
        );
        return;
    }
    // libx264 / libx265 / default software
    ffmpegArgs.push(
        '-crf', '22',
        `-maxrate:v`, `${br}k`,
        `-bufsize:v`, `${buf}k`
    );
}

/**
 * Map UI transcoding speed (libx264-style names) to encoder-specific FFmpeg flags.
 * Speeds: veryslow, slower, slow, medium, fast, faster, veryfast, superfast, ultrafast
 */
function appendVideoEncoderSpeedFlags(ffmpegArgs, videoEncoder, transcodingSpeed) {
    let speed = (transcodingSpeed || 'veryfast').toString().toLowerCase().trim();
    const allowed = ['veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast'];
    if (allowed.indexOf(speed) === -1) {
        speed = 'veryfast';
    }
    let enc = (videoEncoder || '').toString().toLowerCase();

    // Software H.264 / H.265 — native -preset names
    if (enc.indexOf('libx264') !== -1 || enc.indexOf('libx265') !== -1 || enc.indexOf('libx266') !== -1) {
        ffmpegArgs.push('-preset', speed);
        console.log(`dizqueTV: video encoder speed preset=${speed} (${enc})`);
        return;
    }

    // NVIDIA NVENC — p1 (fastest) … p7 (slowest); also accept named presets on older drivers
    if (enc.indexOf('nvenc') !== -1) {
        const nvencMap = {
            ultrafast: 'p1',
            superfast: 'p1',
            veryfast: 'p2',
            faster: 'p3',
            fast: 'p4',
            medium: 'p5',
            slow: 'p6',
            slower: 'p7',
            veryslow: 'p7',
        };
        let p = nvencMap[speed] || 'p4';
        ffmpegArgs.push('-preset', p);
        // "ll" is widely supported for h264_nvenc/hevc_nvenc; "ull" is rejected on many builds
        // (FFmpeg then exits with no usable output — looks like a hung/failed stream).
        if (speed === 'ultrafast' || speed === 'superfast' || speed === 'veryfast' || speed === 'faster') {
            ffmpegArgs.push('-tune', 'll');
        }
        console.log(`dizqueTV: video encoder speed preset=${p} (nvenc from ${speed})`);
        return;
    }

    // Intel Quick Sync — uses similar textual presets on modern ffmpeg
    if (enc.indexOf('qsv') !== -1) {
        // QSV supports: veryfast, faster, fast, medium, slow, slower, veryslow
        // Map ultra/super fast down to veryfast
        let qsv = speed;
        if (speed === 'ultrafast' || speed === 'superfast') {
            qsv = 'veryfast';
        }
        ffmpegArgs.push('-preset', qsv);
        console.log(`dizqueTV: video encoder speed preset=${qsv} (qsv from ${speed})`);
        return;
    }

    // AMF (AMD)
    if (enc.indexOf('amf') !== -1) {
        // quality: speed | balanced | quality
        let amf = 'balanced';
        if (speed === 'ultrafast' || speed === 'superfast' || speed === 'veryfast' || speed === 'faster') {
            amf = 'speed';
        } else if (speed === 'slow' || speed === 'slower' || speed === 'veryslow') {
            amf = 'quality';
        }
        ffmpegArgs.push('-quality', amf);
        console.log(`dizqueTV: video encoder quality=${amf} (amf from ${speed})`);
        return;
    }

    // VideoToolbox — limited realtime toggle for faster modes
    if (enc.indexOf('videotoolbox') !== -1) {
        if (speed === 'ultrafast' || speed === 'superfast' || speed === 'veryfast' || speed === 'faster' || speed === 'fast') {
            ffmpegArgs.push('-realtime', '1');
            console.log(`dizqueTV: video encoder realtime=1 (videotoolbox from ${speed})`);
        }
        return;
    }

    // mpeg2video and unknown encoders: no reliable -preset; skip silently
    if (enc.indexOf('mpeg2') !== -1) {
        return;
    }

    // Best-effort for other encoders that accept x264-style presets
    ffmpegArgs.push('-preset', speed);
    console.log(`dizqueTV: video encoder speed preset=${speed} (${enc || 'unknown'})`);
}

function isDifferentVideoCodec(codec, encoder) {
    if (codec == 'mpeg2video') {
        return ! encoder.includes("mpeg2");
    } else if (codec == 'h264') {
        return ! encoder.includes("264");
    } else if (codec == 'hevc') {
        return !( encoder.includes("265") || encoder.includes("hevc") );
    }
    // if the encoder/codec combinations are unknown, always encode, just in case
    return true;
}

function isDifferentAudioCodec(codec, encoder) {

    if (codec == 'mp3') {
        return !( encoder.includes("mp3") || encoder.includes("lame") );
    } else if (codec == 'aac') {
        return !encoder.includes("aac");
    } else if (codec == 'ac3') {
        return !encoder.includes("ac3");
    } else if (codec == 'flac') {
        return !encoder.includes("flac");
    }
    // if the encoder/codec combinations are unknown, always encode, just in case
    return true;
}

function isLargerResolution( w1,h1, w2,h2) {
    return (w1 > w2) || (h1 > h2) || (w1 % 2 ==1) || (h1 % 2 == 1);
}

function parseResolutionString(s) {
    var i = s.indexOf('x');
    if (i == -1) {
        i = s.indexOf("×");
        if (i == -1) {
           return {w:1920, h:1080}
        }
    }
    return {
        w: parseInt( s.substring(0,i) , 10 ),
        h: parseInt( s.substring(i+1) , 10 ),
    }
}

function gcd(a, b) {
    
    while (b != 0) {
        let c = b;
        b = a % b;
        a = c;
    }
    return a;
}

module.exports = FFMPEG
