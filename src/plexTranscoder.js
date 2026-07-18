const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');

class PlexTranscoder {
    constructor(clientId, server, settings, channel, lineupItem) {
        this.session = uuidv4()

        this.device = "channel-" + channel.number;
        this.deviceName = this.device;
        this.clientIdentifier = clientId;
        this.product = "dizqueTV";
        
        this.settings = settings

        this.log("Plex transcoder initiated")
        this.log("Debug logging enabled")

        this.key = lineupItem.key
        this.metadataPath = `${server.uri}${lineupItem.key}?X-Plex-Token=${server.accessToken}`
        this.plexFile = `${server.uri}${lineupItem.plexFile}?X-Plex-Token=${server.accessToken}`
        if (typeof(lineupItem.file)!=='undefined') {
            this.file = lineupItem.file.replace(settings.pathReplace, settings.pathReplaceWith)
        }
        this.transcodeUrlBase = `${server.uri}/video/:/transcode/universal/start.m3u8?`
        this.ratingKey = lineupItem.ratingKey
        this.currTimeMs = lineupItem.start
        this.currTimeS = this.currTimeMs / 1000
        this.duration = lineupItem.duration
        this.server = server

        this.transcodingArgs = undefined
        this.decisionJson = undefined

        this.updateInterval = 30000
        this.updatingPlex = undefined
        this.playState = "stopped"
        this.mediaHasNoVideo = false;
        this.albumArt = {
            attempted : false,
            path: null,
        }
        // Resolved preferred tracks (set in resolvePreferredTracks)
        this.preferredAudio = null;
        this.preferredSubtitle = null;
        this._mediaStreamsCache = null;
    }

    async getStream(deinterlace) {
        let stream = {directPlay: false}

        this.log("Getting stream")
        this.log(`  deinterlace:     ${deinterlace}`)
        this.log(`  streamPath:      ${this.settings.streamPath}`)
        this.log(`  preferredLanguage: ${this.settings.preferredLanguage || 'eng'}`)

        // Resolve preferred audio/subtitle from metadata BEFORE any Plex decision
        // so audioStreamID is included in every universal-transcode request.
        await this.resolvePreferredTracks();

        this.setTranscodingArgs(stream.directPlay, true, false, false);
        await this.tryToDetectAudioOnly();

        if (this.settings.streamPath === 'direct' || this.settings.forceDirectPlay) {
            if (this.settings.enableSubtitles) {
                this.log("Direct play is forced, so subtitles are forcibly disabled.");
                this.settings.enableSubtitles = false;
            }
            stream = {directPlay: true}
        } else {
            try {
                this.log("Setting transcoding parameters")
                this.setTranscodingArgs(stream.directPlay, true, deinterlace, this.mediaHasNoVideo)
                await this.getDecision(stream.directPlay);
                if (this.isDirectPlay()) {
                    stream.directPlay = true;
                    stream.streamUrl = this.plexFile;
                }
            } catch (err) {
                console.error("Error when getting decision. 1. Check Plex connection. 2. This might also be a sign that plex direct play and transcode settings are too strict and it can't find any allowed action for the selected video.", err)
                stream.directPlay = true;
            }
        }
        if (stream.directPlay || this.isAV1() ) {
            if (! stream.directPlay) {
                this.log("Plex doesn't support av1, so we are forcing direct play, including for audio because otherwise plex breaks the stream.")
            }
            this.log("Direct play forced or native paths enabled")
            stream.directPlay = true
            this.setTranscodingArgs(stream.directPlay, true, false, this.mediaHasNoVideo )
            // Update transcode decision for session
            await this.getDecision(stream.directPlay);
            stream.streamUrl = (this.settings.streamPath === 'direct') ? this.file : this.plexFile;
            if(this.settings.streamPath === 'direct') {
                fs.access(this.file, fs.F_OK, (err) => {
                    if (err) {
                      throw Error("Can't access this file", err);
                      return
                    }
                })
            }
            if (typeof(stream.streamUrl) == 'undefined') {
                throw Error("Direct path playback is not possible for this program because it was registered at a time when the direct path settings were not set. To fix this, you must either revert the direct path setting or rebuild this channel.");
            }
        } else if (this.isVideoDirectStream() === false) {
                this.log("Decision: Should transcode")
                // Change transcoding arguments to be the user chosen transcode parameters
                this.setTranscodingArgs(stream.directPlay, false, deinterlace, this.mediaHasNoVideo)
                // Update transcode decision for session
                await this.getDecision(stream.directPlay);
                stream.streamUrl = `${this.transcodeUrlBase}${this.transcodingArgs}`
        } else {
            //This case sounds complex. Apparently plex is sending us just the audio, so we would need to get the video in a separate stream.
            this.log("Decision: Direct stream. Audio is being transcoded")
            stream.separateVideoStream = (this.settings.streamPath === 'direct') ? this.file : this.plexFile;
            // Rebuild args so audioStreamID is present on the direct-stream URL
            this.setTranscodingArgs(stream.directPlay, true, deinterlace, this.mediaHasNoVideo)
            stream.streamUrl = `${this.transcodeUrlBase}${this.transcodingArgs}`
            this.directInfo = await this.getDirectInfo();
            this.videoIsDirect = true;
        }
        // Tunarr-style: language-aware audio/subtitle selection requires FFmpeg to
        // open the original multi-stream source. Plex universal-transcoder mpegts
        // usually has only one audio and no usable soft subs.
        let subMode = resolveSubtitleMode(this.settings);
        let needSourceTracks = !!(
            this.preferredAudio
            || (subMode !== 'off' && this.preferredSubtitle)
        );

        if (needSourceTracks) {
            let sourceUrl = (this.settings.streamPath === 'direct' && this.file)
                ? this.file
                : this.plexFile;
            if (sourceUrl) {
                if (!stream.directPlay) {
                    console.log(
                        `dizqueTV: using source file for language/subtitle stream mapping ` +
                        `(lang=${this.settings.preferredLanguage || 'eng'}, ` +
                        `audioTracks=${this.preferredAudio ? this.preferredAudio.totalAudioTracks : 0})`
                    );
                }
                stream.directPlay = true;
                stream.streamUrl = sourceUrl;
                try {
                    if (!this.directInfo) {
                        this.directInfo = await this.getDirectInfo();
                    }
                    this.videoIsDirect = true;
                } catch (e) {
                    this.log("Could not refresh direct info for source track mapping: " + e);
                }
            }
        }

        stream.streamStats = this.getVideoStats();
        // Enrich video stats from source streams when decision JSON was incomplete
        this.enrichStreamStatsFromSource(stream.streamStats);

        // Always pin FFmpeg to preferred absolute stream indexes when reading source.
        if (this.preferredAudio && stream.directPlay) {
            // Tunarr maps audio as inputIndex:stream.index (absolute container index)
            stream.streamStats.audioIndex = String(this.preferredAudio.plexIndex);
            stream.streamStats.audioAbsoluteIndex = this.preferredAudio.plexIndex;
            stream.streamStats.audioRelativeIndex = this.preferredAudio.relativeIndex;
            stream.streamStats.audioLanguageCodes = this.preferredAudio.languageCodes || [];
            stream.streamStats.audioStreamId = this.preferredAudio.id;
            stream.streamStats.forceAudioTrack = true;
            if (this.preferredAudio.codec) {
                stream.streamStats.audioCodec = this.preferredAudio.codec;
            }
            if (this.preferredAudio.channels) {
                stream.streamStats.audioChannels = this.preferredAudio.channels;
            }
            console.log(
                `dizqueTV audio: preferred language=${this.settings.preferredLanguage || 'eng'} ` +
                `→ "${this.preferredAudio.label}" ` +
                `ffmpeg -map 0:${this.preferredAudio.plexIndex} ` +
                `(a:${this.preferredAudio.relativeIndex}, id=${this.preferredAudio.id}, ` +
                `matched=${this.preferredAudio.languageMatched})`
            );
        } else if (this.preferredAudio) {
            stream.streamStats.audioIndex = 'a';
            stream.streamStats.forceAudioTrack = false;
            console.log(
                `dizqueTV audio: preferred language=${this.settings.preferredLanguage || 'eng'} ` +
                `→ Plex audioStreamID=${this.preferredAudio.id} ("${this.preferredAudio.label}") [transcode path]`
            );
        } else {
            stream.streamStats.audioIndex = 'a';
            stream.streamStats.forceAudioTrack = false;
            console.log(`dizqueTV audio: no preferred track resolved; using default audio`);
        }

        // Preferred subtitle from embedded MKV tracks (and external if Plex reports them).
        // soft: image soft-map only. soft_burn: image soft-map + text extract/burn.
        // Plex Server "enableSubtitles" burn overrides — leave our soft path off then.
        if (subMode !== 'off' && this.settings.enableSubtitles !== true && this.preferredSubtitle) {
            if (stream.directPlay) {
                let isImage = !!this.preferredSubtitle.imageBased;
                stream.streamStats.subtitleIndex = String(this.preferredSubtitle.plexIndex);
                stream.streamStats.subtitleAbsoluteIndex = this.preferredSubtitle.plexIndex;
                stream.streamStats.subtitleRelativeIndex = this.preferredSubtitle.relativeIndex;
                stream.streamStats.subtitleImageBased = isImage;
                stream.streamStats.subtitleCodec = this.preferredSubtitle.codec || null;
                stream.streamStats.subtitleLanguage =
                    (this.preferredSubtitle.languageCodes && this.preferredSubtitle.languageCodes[0])
                    || this.settings.preferredLanguage
                    || 'eng';
                stream.streamStats.subtitleTitle = this.preferredSubtitle.label || stream.streamStats.subtitleLanguage;
                stream.streamStats.subtitleForced = !!this.preferredSubtitle.forced;
                stream.streamStats.burnSubtitles = false;
                stream.streamStats.subtitleMode = subMode;
                // Soft-map image tracks (PGS/VOBSUB/DVB) for client toggle when possible
                stream.streamStats.forceSubtitleTrack = isImage;
                // Text extract+burn only when mode allows and track is text
                stream.streamStats.needsTextSubtitleExtract = (
                    !isImage && subMode === 'soft_burn'
                );
                if (!isImage && subMode === 'soft') {
                    console.log(
                        `dizqueTV subtitles: soft-only mode — selected text track ` +
                        `0:${this.preferredSubtitle.plexIndex} "${this.preferredSubtitle.label}" ` +
                        `codec=${this.preferredSubtitle.codec || '?'} will not be burned or soft-mapped`
                    );
                } else {
                    console.log(
                        `dizqueTV subtitles: mode=${subMode} selected 0:${this.preferredSubtitle.plexIndex} ` +
                        `(s:${this.preferredSubtitle.relativeIndex}) "${this.preferredSubtitle.label}" ` +
                        `codec=${this.preferredSubtitle.codec || '?'} image=${isImage} ` +
                        (isImage
                            ? '→ soft-map into MPEG-TS'
                            : (subMode === 'soft_burn' ? '→ extract+burn' : '→ skip'))
                    );
                }
            } else {
                // Transcode path: request embedded image sub if soft mode
                stream.streamStats.subtitleIndex = 's:0';
                stream.streamStats.subtitleRelativeIndex = 0;
                stream.streamStats.forceSubtitleTrack = true;
                stream.streamStats.subtitleMode = subMode;
            }
        }

        this.log(stream)

        return stream
    }

    /**
     * Fill missing video dimensions / HDR flags from cached source media streams
     * (needed when we force source-file playback after a plex decision).
     */
    enrichStreamStatsFromSource(stats) {
        if (!stats || !this._mediaStreamsCache) {
            return;
        }
        let videoStream = this._mediaStreamsCache.find(function (s) {
            return s.streamType == "1" || s.streamType == 1;
        });
        if (!videoStream) {
            return;
        }
        if (!stats.videoWidth && videoStream.width) {
            stats.videoWidth = videoStream.width;
        }
        if (!stats.videoHeight && videoStream.height) {
            stats.videoHeight = videoStream.height;
        }
        if (!stats.videoCodec && videoStream.codec) {
            stats.videoCodec = videoStream.codec;
        }
        if (!stats.videoFramerate && videoStream.frameRate) {
            stats.videoFramerate = Math.round(videoStream.frameRate);
        }
        if (!stats.pixelP) {
            stats.pixelP = 1;
            stats.pixelQ = 1;
        }
        if (!stats.isHDR && isHdrVideoStream(videoStream)) {
            stats.isHDR = true;
            stats.colorTrc = videoStream.colorTrc || videoStream.colorTransfer || null;
            stats.colorPrimaries = videoStream.colorPrimaries || null;
            stats.colorSpace = videoStream.colorSpace || null;
            stats.bitDepth = videoStream.bitDepth || videoStream.bitsPerRawSample || null;
        } else if (stats.isHDR && !stats.colorTrc) {
            stats.colorTrc = videoStream.colorTrc || videoStream.colorTransfer || null;
            stats.colorPrimaries = stats.colorPrimaries || videoStream.colorPrimaries || null;
        }
    }

    setTranscodingArgs(directPlay, directStream, deinterlace, audioOnly) {
        let resolution = (directStream) ? this.settings.maxPlayableResolution : this.settings.maxTranscodeResolution
        let bitrate = (directStream) ? this.settings.directStreamBitrate : this.settings.transcodeBitrate
        let mediaBufferSize = (directStream) ? this.settings.mediaBufferSize : this.settings.transcodeMediaBufferSize
        // subtitle options: burn, none, embedded, sidecar
        // Plex Server burn wins if enableSubtitles; else request embedded when our mode is on.
        let subModeForPlex = resolveSubtitleMode(this.settings);
        let subtitles = "none";
        let subtitleCodecList = "";
        if (this.settings.enableSubtitles) {
            subtitles = "burn";
        } else if (subModeForPlex !== 'off') {
            subtitles = "embedded";
            // Soft path cares about image codecs; include text only for soft_burn (extract later)
            if (subModeForPlex === 'soft') {
                subtitleCodecList = "pgs,hdmv_pgs_subtitle,vobsub,dvd_subtitle,dvb_subtitle,dvbsub";
            } else {
                subtitleCodecList = "pgs,hdmv_pgs_subtitle,vobsub,dvd_subtitle,dvb_subtitle,dvbsub,srt,ass,ssa,mov_text";
            }
        }
        let streamContainer = "mpegts" // Other option is mkv, mkv has the option of copying it's subs for later processing
        let isDirectPlay = (directPlay) ? '1' : '0';
        let hasMDE = '1';
        
        let videoQuality=`100` // Not sure how this applies, maybe this works if maxVideoBitrate is not set
        let profileName=`Generic` // Blank profile, everything is specified through X-Plex-Client-Profile-Extra
        
        let resolutionArr = resolution.split("x")

        let vc = this.settings.videoCodecs;
        //This codec is not currently supported by plex so requesting it to transcode will always
        // cause an error. If Plex ever supports av1, remove this. I guess.
        if (vc != '') {
            vc += ",av1";
        } else {
            vc = "av1";
        }

        let clientProfile ="";
        if (! audioOnly ) {
            clientProfile=`add-transcode-target(type=videoProfile&protocol=${this.settings.streamProtocol}&container=${streamContainer}&videoCodec=${vc}&audioCodec=${this.settings.audioCodecs}&subtitleCodec=${subtitleCodecList}&context=streaming&replace=true)+\
add-transcode-target-settings(type=videoProfile&context=streaming&protocol=${this.settings.streamProtocol}&CopyMatroskaAttachments=true)+\
add-transcode-target-settings(type=videoProfile&context=streaming&protocol=${this.settings.streamProtocol}&BreakNonKeyframes=true)+\
add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.width&value=${resolutionArr[0]})+\
add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.height&value=${resolutionArr[1]})`
        } else {
            clientProfile=`add-transcode-target(type=musicProfile&protocol=${this.settings.streamProtocol}&container=${streamContainer}&audioCodec=${this.settings.audioCodecs}&subtitleCodec=&context=streaming&replace=true)`
            
        }
        // Set transcode settings per audio codec
        this.settings.audioCodecs.split(",").forEach(function (codec) {
            clientProfile+=`+add-transcode-target-audio-codec(type=videoProfile&context=streaming&protocol=${this.settings.streamProtocol}&audioCodec=${codec})`
            if (codec == "mp3") {
                clientProfile+=`+add-limitation(scope=videoAudioCodec&scopeName=${codec}&type=upperBound&name=audio.channels&value=2)`
            } else {
                clientProfile+=`+add-limitation(scope=videoAudioCodec&scopeName=${codec}&type=upperBound&name=audio.channels&value=${this.settings.maxAudioChannels})`
            }
          }.bind(this));

        // deinterlace video if specified, only useful if overlaying channel logo later
        if (deinterlace == true) {
            clientProfile+=`+add-limitation(scope=videoCodec&scopeName=*&type=notMatch&name=video.scanType&value=interlaced)`
        }

        let clientProfile_enc=encodeURIComponent(clientProfile)

        // Force the preferred audio/subtitle streams by Plex stream id (not just lang=).
        // lang= alone is only a soft preference and often loses to the library-selected track.
        let streamIdArgs = '';
        if (this.preferredAudio && this.preferredAudio.id) {
            streamIdArgs += `&audioStreamID=${encodeURIComponent(this.preferredAudio.id)}`;
        }
        if (
            resolveSubtitleMode(this.settings) !== 'off'
            && this.settings.enableSubtitles !== true
            && this.preferredSubtitle
            && this.preferredSubtitle.id
        ) {
            streamIdArgs += `&subtitleStreamID=${encodeURIComponent(this.preferredSubtitle.id)}`;
        }

        this.transcodingArgs=`X-Plex-Platform=${profileName}&\
X-Plex-Product=${this.product}&\
X-Plex-Client-Platform=${profileName}&\
X-Plex-Client-Profile-Name=${profileName}&\
X-Plex-Device-Name=${this.deviceName}&\
X-Plex-Device=${this.device}&\
X-Plex-Client-Identifier=${this.clientIdentifier}&\
X-Plex-Platform=${profileName}&\
X-Plex-Token=${this.server.accessToken}&\
X-Plex-Client-Profile-Extra=${clientProfile_enc}&\
protocol=${this.settings.streamProtocol}&\
Connection=keep-alive&\
hasMDE=${hasMDE}&\
path=${this.key}&\
mediaIndex=0&\
partIndex=0&\
fastSeek=1&\
directPlay=${isDirectPlay}&\
directStream=1&\
directStreamAudio=1&\
copyts=1&\
audioBoost=${this.settings.audioBoost}&\
mediaBufferSize=${mediaBufferSize}&\
session=${this.session}&\
offset=${this.currTimeS}&\
subtitles=${subtitles}&\
subtitleSize=${this.settings.subtitleSize}&\
maxVideoBitrate=${bitrate}&\
videoQuality=${videoQuality}&\
videoResolution=${resolution}&\
lang=${toPlexLangCode(this.settings.preferredLanguage || 'eng')}${streamIdArgs}`
    }

    isVideoDirectStream() {
        try {
            return this.getVideoStats().videoDecision === "copy";
        } catch (e) {
            console.error("Error at decision:", e);
            return false;
        }
    }

    isAV1() {
        try {
            return this.getVideoStats().videoCodec === 'av1';
        } catch (e) {
            return false;
        }
    }

    isDirectPlay() {
        try {
            if (this.getVideoStats().audioOnly) {
                return this.getVideoStats().audioDecision === "copy";
            }
            return this.getVideoStats().videoDecision === "copy" && this.getVideoStats().audioDecision === "copy";
        } catch (e) {
            console.error("Error at decision:" , e);
            return false;
        }
    }

    getVideoStats() {
        let ret = {}
        try {
            let streams = this.decisionJson.MediaContainer.Metadata[0].Media[0].Part[0].Stream
            ret.duration = parseFloat( this.decisionJson.MediaContainer.Metadata[0].Media[0].Part[0].duration );
            streams.forEach(function (_stream, $index) {
                // Video
                let stream = _stream;
                if (stream["streamType"] == "1") {
                    if ( this.videoIsDirect === true && typeof(this.directInfo) !== 'undefined') {
                        stream = this.directInfo.MediaContainer.Metadata[0].Media[0].Part[0].Stream[$index];
                    }
                    ret.anamorphic = ( (stream.anamorphic === "1") || (stream.anamorphic === true) );
                    if (ret.anamorphic) {
                        let parsed = parsePixelAspectRatio(stream.pixelAspectRatio);
                        if (isNaN(parsed.p) || isNaN(parsed.q) ) {
                            throw Error("isNaN");
                        }
                        ret.pixelP = parsed.p;
                        ret.pixelQ = parsed.q;
                    } else {
                        ret.pixelP= 1;
                        ret.pixelQ = 1;
                    }
                    ret.videoCodec = stream.codec;
                    ret.videoWidth = stream.width;
                    ret.videoHeight = stream.height;
                    ret.videoFramerate = Math.round(stream["frameRate"]);
                    // Rounding framerate avoids scenarios where
                    // 29.9999999 & 30 don't match.
                    ret.videoDecision = (typeof stream.decision === 'undefined') ? 'copy' : stream.decision;
                    ret.videoScanType = stream.scanType;
                    // HDR / wide-color metadata for optional tone mapping
                    ret.colorTrc = stream.colorTrc || stream.colorTransfer || null;
                    ret.colorPrimaries = stream.colorPrimaries || null;
                    ret.colorSpace = stream.colorSpace || null;
                    ret.bitDepth = stream.bitDepth || stream.bitsPerRawSample || null;
                    ret.isHDR = isHdrVideoStream(stream);
                }
                // Audio. Only look at stream being used
                if (stream["streamType"] == "2" && stream["selected"] == "1") {
                    ret.audioChannels = stream["channels"];
                    ret.audioCodec = stream["codec"];
                    ret.audioDecision = (typeof stream.decision === 'undefined') ? 'copy' : stream.decision;
                }
            }.bind(this) )
        } catch (e) {
            console.error("Error at decision:" , e);
        }
        if (typeof(ret.videoCodec) === 'undefined') {
            ret.audioOnly = true;
            ret.placeholderImage = (this.albumArt.path != null) ?
                ret.placeholderImage = this.albumArt.path
                :
                ret.placeholderImage = `http://localhost:${process.env.PORT}/images/generic-music-screen.png`
            ;
        }

        // If decision JSON lacked HDR flags, try source media streams (direct play / cache)
        if (!ret.isHDR && this._mediaStreamsCache) {
            let videoStream = this._mediaStreamsCache.find(function (s) {
                return s.streamType == "1" || s.streamType == 1;
            });
            if (videoStream && isHdrVideoStream(videoStream)) {
                ret.isHDR = true;
                ret.colorTrc = ret.colorTrc || videoStream.colorTrc || videoStream.colorTransfer || null;
                ret.colorPrimaries = ret.colorPrimaries || videoStream.colorPrimaries || null;
                ret.colorSpace = ret.colorSpace || videoStream.colorSpace || null;
                ret.bitDepth = ret.bitDepth || videoStream.bitDepth || videoStream.bitsPerRawSample || null;
            }
        }

        this.log("Current video stats:")
        this.log(ret)
        if (ret.isHDR) {
            console.log(
                `dizqueTV: HDR detected (trc=${ret.colorTrc || '?'}, primaries=${ret.colorPrimaries || '?'}, depth=${ret.bitDepth || '?'})`
            );
        }

        return ret
    }

    async getMediaStreams() {
        if (this._mediaStreamsCache) {
            return this._mediaStreamsCache;
        }
        try {
            let res = await axios.get(`${this.server.uri}${this.key}?X-Plex-Token=${this.server.accessToken}`, {
                headers: { Accept: 'application/json' }
            });
            this.log(res.data);
            this._mediaStreamsCache = res.data.MediaContainer.Metadata[0].Media[0].Part[0].Stream || [];
            return this._mediaStreamsCache;
        } catch (err) {
            console.error("Error getting media streams", err);
            return [];
        }
    }

    /**
     * Resolve preferred audio + subtitle tracks from Plex metadata once per play.
     * Uses relative FFmpeg indexes (a:0, a:1, s:0, …) because Plex stream.index is
     * not always the absolute container index FFmpeg expects.
     */
    async resolvePreferredTracks() {
        let preferred = (this.settings.preferredLanguage || 'eng').toLowerCase().trim();
        let streams = await this.getMediaStreams();

        let audioStreams = streams.filter(function (s) {
            return s.streamType == "2" || s.streamType == 2;
        });
        let subStreams = streams.filter(function (s) {
            return s.streamType == "3" || s.streamType == 3;
        });

        if (audioStreams.length > 0) {
            let ranked = audioStreams.map(function (s, i) {
                return { stream: s, relativeIndex: i, score: scoreAudioStream(s, preferred) };
            });
            ranked.sort(function (a, b) { return b.score - a.score; });

            // Prefer a language match when one exists; otherwise fall back to best score
            let langHits = ranked.filter(function (r) { return languageMatches(r.stream, preferred); });
            let best = (langHits.length > 0) ? langHits[0] : ranked[0];

            // Plex stream.index is the container stream index (matches FFmpeg 0:N).
            // Prefer that for mapping; also keep relative a:N and language codes.
            let absIndex = best.stream.index;
            if (typeof(absIndex) === 'undefined' || absIndex === null || absIndex === '') {
                // Fall back to counting streams in Part order up to this audio stream
                absIndex = streams.indexOf(best.stream);
                if (absIndex < 0) {
                    absIndex = best.relativeIndex;
                }
            }

            this.preferredAudio = {
                id: best.stream.id,
                relativeIndex: best.relativeIndex,
                // Primary map target for FFmpeg: absolute container stream index
                plexIndex: absIndex,
                ffmpegIndex: String(absIndex),
                languageCodes: collectStreamLanguageCodes(best.stream, preferred),
                codec: best.stream.codec,
                channels: best.stream.channels,
                label: streamLabel(best.stream),
                score: best.score,
                totalAudioTracks: audioStreams.length,
                languageMatched: langHits.length > 0,
            };

            console.log(
                `dizqueTV: audio candidates for "${preferred}": ` +
                ranked.map(function (r) {
                    return `[#${r.stream.index} a:${r.relativeIndex} id=${r.stream.id} score=${r.score} ${streamLabel(r.stream)}]`;
                }).join(' | ')
            );
            console.log(
                `dizqueTV: selected audio stream index=${this.preferredAudio.plexIndex} ` +
                `(a:${this.preferredAudio.relativeIndex}) "${this.preferredAudio.label}" ` +
                `score=${this.preferredAudio.score} langMatch=${this.preferredAudio.languageMatched} ` +
                `for language "${preferred}" (${audioStreams.length} audio tracks)`
            );
            if (!this.preferredAudio.languageMatched && audioStreams.length > 1) {
                console.log(
                    `dizqueTV: WARNING — no audio track matched preferred language "${preferred}"; ` +
                    `using highest-scored track. Check Plex language tags on this media.`
                );
            }
        } else {
            this.preferredAudio = null;
        }

        let subMode = resolveSubtitleMode(this.settings);
        if (subMode === 'off') {
            this.preferredSubtitle = null;
        } else if (subStreams.length > 0) {
            let rankedSubs = subStreams.map(function (s, i) {
                return {
                    stream: s,
                    relativeIndex: i,
                    score: scoreSubtitleStream(s, preferred, subMode),
                    imageBased: isMpegTsFriendlySubtitle(s),
                };
            });
            rankedSubs.sort(function (a, b) { return b.score - a.score; });

            // Soft-only: prefer an image-based track (PGS/VOBSUB/DVB). If none exist,
            // keep best text match so logs are clear, but forceSubtitleTrack stays false.
            let bestSub = rankedSubs[0];
            if (subMode === 'soft') {
                let imageHits = rankedSubs.filter(function (r) { return r.imageBased; });
                let imageLang = imageHits.filter(function (r) {
                    return languageMatches(r.stream, preferred);
                });
                if (imageLang.length > 0) {
                    bestSub = imageLang[0];
                } else if (imageHits.length > 0) {
                    bestSub = imageHits[0];
                }
                // else keep bestSub (text) — will be skipped for soft-map/burn
            }

            let subAbs = bestSub.stream.index;
            if (typeof(subAbs) === 'undefined' || subAbs === null || subAbs === '') {
                subAbs = streams.indexOf(bestSub.stream);
                if (subAbs < 0) {
                    subAbs = bestSub.relativeIndex;
                }
            }
            this.preferredSubtitle = {
                id: bestSub.stream.id,
                relativeIndex: bestSub.relativeIndex,
                plexIndex: subAbs,
                ffmpegIndex: String(subAbs),
                codec: bestSub.stream.codec,
                label: streamLabel(bestSub.stream),
                score: bestSub.score,
                imageBased: !!bestSub.imageBased,
                forced: isForcedSubtitle(bestSub.stream),
                languageCodes: collectStreamLanguageCodes(bestSub.stream, preferred),
            };
            console.log(
                `dizqueTV: subtitle candidates mode=${subMode} for "${preferred}": ` +
                rankedSubs.map(function (r) {
                    return `[#${r.stream.index} s:${r.relativeIndex} id=${r.stream.id} ` +
                        `score=${r.score} image=${r.imageBased} ${streamLabel(r.stream)}]`;
                }).join(' | ')
            );
            console.log(
                `dizqueTV: selected subtitle 0:${this.preferredSubtitle.plexIndex} ` +
                `(s:${this.preferredSubtitle.relativeIndex}) "${this.preferredSubtitle.label}" ` +
                `codec=${this.preferredSubtitle.codec || '?'} image=${this.preferredSubtitle.imageBased}`
            );
        } else {
            this.preferredSubtitle = null;
        }
    }

    async getAudioIndex() {
        if (!this.preferredAudio) {
            await this.resolvePreferredTracks();
        }
        return this.preferredAudio ? this.preferredAudio.ffmpegIndex : 'a';
    }

    async getAudioStreamInfo() {
        if (!this.preferredAudio) {
            await this.resolvePreferredTracks();
        }
        if (!this.preferredAudio) {
            return { index: 'a', codec: undefined, channels: undefined };
        }
        return {
            index: this.preferredAudio.ffmpegIndex,
            codec: this.preferredAudio.codec,
            channels: this.preferredAudio.channels,
        };
    }

    async getSubtitleIndex() {
        if (!this.preferredSubtitle) {
            await this.resolvePreferredTracks();
        }
        return this.preferredSubtitle ? this.preferredSubtitle.ffmpegIndex : null;
    }

    async getDirectInfo() {
        return (await axios.get(this.metadataPath) ).data;

    }

    async getDecisionUnmanaged(directPlay) {
        let url = `${this.server.uri}/video/:/transcode/universal/decision?${this.transcodingArgs}`;
        let res = await axios.get(url, {
            headers: { Accept: 'application/json' }
        })
            this.decisionJson = res.data;

            this.log("Received transcode decision:");
            this.log(res.data)

            // Print error message if transcode not possible
            // TODO: handle failure better
            if (res.data.MediaContainer.mdeDecisionCode === 1000) {
                this.log("mde decision code 1000, so it's all right?");
                return;
            }

            let transcodeDecisionCode = res.data.MediaContainer.transcodeDecisionCode;
            if (
                ( typeof(transcodeDecisionCode) === 'undefined' )
            ) {
                this.decisionJson.MediaContainer.transcodeDecisionCode = 'novideo';
                this.log("Strange case, attempt direct play");
            } else  if (!(directPlay || transcodeDecisionCode == "1001")) {
                this.log(`IMPORTANT: Recieved transcode decision code ${transcodeDecisionCode}! Expected code 1001.`)
                this.log(`Error message: '${res.data.MediaContainer.transcodeDecisionText}'`)
            }
    }
    
    async tryToDetectAudioOnly() {
        try {
            this.log("Try to detect audio only:");
            let url = `${this.server.uri}${this.key}?${this.transcodingArgs}`;
            let res = await axios.get(url, {
                headers: { Accept: 'application/json' }
            });

            let mediaContainer = res.data.MediaContainer;
            let metadata = getOneOrUndefined( mediaContainer, "Metadata");
            if (typeof(metadata) !== 'undefined') {
                this.albumArt.path = `${this.server.uri}${metadata.thumb}?X-Plex-Token=${this.server.accessToken}`;

                let media = getOneOrUndefined( metadata, "Media");
                if (typeof(media) !== 'undefined') {
                    if (typeof(media.videoCodec)==='undefined') {
                        this.log("Audio-only file detected");
                        this.mediaHasNoVideo = true;
                    }
                }
            }
        } catch (err) {
            console.error("Error when getting album art", err);
        }


    }

    async getDecision(directPlay) {
        try {
            await this.getDecisionUnmanaged(directPlay);
        } catch (err) {
            console.error(err);
        }
    }

    getStatusUrl() {
        let profileName=`Generic`;

        let containerKey=`/video/:/transcode/universal/decision?${this.transcodingArgs}`;
        let containerKey_enc=encodeURIComponent(containerKey);

        let statusUrl=`${this.server.uri}/:/timeline?\
containerKey=${containerKey_enc}&\
ratingKey=${this.ratingKey}&\
state=${this.playState}&\
key=${this.key}&\
time=${this.currTimeMs}&\
duration=${this.duration}&\
X-Plex-Product=${this.product}&\
X-Plex-Platform=${profileName}&\
X-Plex-Client-Platform=${profileName}&\
X-Plex-Client-Profile-Name=${profileName}&\
X-Plex-Device-Name=${this.deviceName}&\
X-Plex-Device=${this.device}&\
X-Plex-Client-Identifier=${this.clientIdentifier}&\
X-Plex-Platform=${profileName}&\
X-Plex-Token=${this.server.accessToken}`;

        return statusUrl;
    }

    startUpdatingPlex() {
        if (this.settings.updatePlayStatus == true) {
            this.playState = "playing";
            this.updatePlex(); // do initial update
            this.updatingPlex = setInterval(this.updatePlex.bind(this), this.updateInterval);
        }
    }

    stopUpdatingPlex() {
        if (this.settings.updatePlayStatus == true) {
            clearInterval(this.updatingPlex);
            this.playState = "stopped";
            this.updatePlex();
        }
    }

    updatePlex() {
        this.log("Updating plex status");
        const statusUrl = this.getStatusUrl();
        try {
            axios.post(statusUrl);
        } catch (error) {
            this.log(`Problem updating Plex status using status URL ${statusUrl}:`);
            this.log(error);
            return false;
        }
        this.currTimeMs += this.updateInterval;
        if (this.currTimeMs > this.duration) {
            this.currTimeMs = this.duration;
        }
        this.currTimeS = this.duration / 1000;
    }

    log(message) {
        if (this.settings.debugLogging) {
            console.log(message)
        }
    }
}


function parsePixelAspectRatio(s) {
    let x = s.split(":");
    return {
        p: parseInt(x[0], 10),
        q: parseInt(x[1], 10),
    }
}

function getOneOrUndefined(object, field) {
    if (typeof(object) === 'undefined') {
        return undefined;
    }
    if ( typeof(object[field]) === "undefined") {
        return undefined;
    }
    let x = object[field];
    if (x.length < 1) {
        return undefined;
    }
    return x[0];
}

function streamLabel(stream) {
    if (!stream) {
        return '?';
    }
    let lang = stream.languageCode || stream.languageTag || stream.language || 'und';
    let title = stream.title || stream.displayTitle || '';
    let codec = stream.codec || '';
    let ch = stream.channels ? `${stream.channels}ch` : '';
    return [lang, title, codec, ch].filter(Boolean).join(' / ');
}

/** ISO codes FFmpeg may have on the stream for -map 0:a:m:language:XX */
function collectStreamLanguageCodes(stream, preferred) {
    let codes = [];
    let seen = {};
    let add = function (c) {
        if (!c) return;
        c = String(c).toLowerCase().trim().split(/[-_]/)[0];
        if (!c || seen[c]) return;
        seen[c] = true;
        codes.push(c);
    };
    if (stream) {
        add(stream.languageCode);
        add(stream.languageTag);
        // Prefer short + long forms from preferred language aliases
        let aliases = languageAliases(preferred || '');
        for (let i = 0; i < aliases.length; i++) {
            if (isLangCode(aliases[i])) {
                add(aliases[i]);
            }
        }
    }
    return codes;
}

/**
 * Tunarr-style language match: exact equality on ISO-639-2, ISO-639-1 base,
 * language name, or title tokens — against the preferred code and its aliases.
 * (No loose prefix matching that can confuse similar codes.)
 */
function languageMatches(stream, preferred) {
    if (!preferred || !stream) {
        return false;
    }
    let pref = String(preferred).toLowerCase().trim();
    if (!pref) {
        return false;
    }
    let aliases = languageAliases(pref);

    let candidates = [];
    let pushCand = function (v) {
        if (typeof(v) === 'undefined' || v === null || v === '') {
            return;
        }
        let s = String(v).toLowerCase().trim();
        candidates.push(s);
        // en-US → en
        let base = s.split(/[-_]/)[0];
        if (base && base !== s) {
            candidates.push(base);
        }
    };
    pushCand(stream.languageCode);
    pushCand(stream.languageTag);
    pushCand(stream.language);

    for (let i = 0; i < candidates.length; i++) {
        if (aliases.indexOf(candidates[i]) !== -1) {
            return true;
        }
    }

    // Title / displayTitle token match (e.g. "English", "English (AC3 5.1)")
    let title = String(stream.title || stream.displayTitle || stream.extendedDisplayTitle || '').toLowerCase();
    if (title) {
        let tokens = title.split(/[^a-z\u00c0-\u024f]+/i).filter(Boolean);
        for (let j = 0; j < aliases.length; j++) {
            let a = aliases[j];
            if (a.length >= 2 && tokens.indexOf(a) !== -1) {
                return true;
            }
        }
    }
    return false;
}

function isLangCode(s) {
    return typeof(s) === 'string' && /^[a-z]{2,3}$/i.test(s);
}

/**
 * Higher score = better match for preferred language audio.
 * Tunarr: by_language → prefer most channels among matches; fallback selected → default → first.
 */
function scoreAudioStream(stream, preferred) {
    let score = 0;
    if (languageMatches(stream, preferred)) {
        score += 1000;
        let code = String(stream.languageCode || '').toLowerCase();
        if (code && languageAliases(preferred).indexOf(code) !== -1) {
            score += 50;
        }
    }
    // Prefer non-commentary / non-description tracks
    let title = String(stream.title || stream.displayTitle || stream.extendedDisplayTitle || '').toLowerCase();
    if (title.indexOf('commentary') !== -1 || title.indexOf('director') !== -1) {
        score -= 500;
    }
    if (title.indexOf('description') !== -1 || title.indexOf('audio description') !== -1) {
        score -= 500;
    }
    // Prefer more channels among language matches (Tunarr preferChannels: most)
    let ch = parseInt(stream.channels, 10);
    if (!isNaN(ch)) {
        score += Math.min(ch, 16);
    }
    // Selected/default only as weak fallback when no language match
    if (stream.selected == "1" || stream.selected === true || stream.selected === 1) {
        score += 5;
    }
    if (stream.default == "1" || stream.default === true || stream.default === 1) {
        score += 3;
    }
    return score;
}

/**
 * Normalize FFmpeg settings subtitle mode: off | soft | soft_burn
 */
function resolveSubtitleMode(settings) {
    if (!settings) {
        return 'off';
    }
    let raw = settings.subtitleMode;
    if (raw != null && String(raw).trim() !== '') {
        let m = String(raw).trim().toLowerCase().replace(/-/g, '_').replace(/\+/g, '_');
        if (m === 'none' || m === 'disabled' || m === 'false') {
            return 'off';
        }
        if (m === 'soft_only' || m === 'softonly' || m === 'image' || m === 'pgs') {
            return 'soft';
        }
        if (m === 'soft_and_burn' || m === 'burn' || m === 'full' || m === 'on' || m === 'true') {
            return 'soft_burn';
        }
        if (m === 'off' || m === 'soft' || m === 'soft_burn') {
            return m;
        }
    }
    return settings.includeSubtitles === true ? 'soft_burn' : 'off';
}

/** Higher score = better match for preferred language subtitle. */
function scoreSubtitleStream(stream, preferred, subMode) {
    let score = 0;
    if (languageMatches(stream, preferred)) {
        score += 1000;
    }
    if (!isForcedSubtitle(stream)) {
        score += 20;
    } else {
        score -= 10;
    }
    // Image-based tracks can soft-map into MPEG-TS — boost strongly for soft modes
    if (isMpegTsFriendlySubtitle(stream)) {
        score += (subMode === 'soft') ? 200 : 50;
    } else if (subMode === 'soft') {
        // Soft-only cannot deliver text; deprioritize so image tracks win when present
        score -= 100;
    }
    let title = String(stream.title || stream.displayTitle || '').toLowerCase();
    if (title.indexOf('sdh') !== -1 || title.indexOf('cc') !== -1 || title.indexOf('caption') !== -1) {
        score -= 5; // slight deprioritize SDH unless it's the only match
    }
    return score;
}

function languageAliases(code) {
    let c = String(code).toLowerCase();
    let map = {
        eng: ['eng', 'en', 'english'],
        en: ['eng', 'en', 'english'],
        spa: ['spa', 'es', 'spanish', 'castilian', 'español', 'espanol'],
        es: ['spa', 'es', 'spanish', 'castilian', 'español', 'espanol'],
        fre: ['fre', 'fra', 'fr', 'french', 'français', 'francais'],
        fra: ['fre', 'fra', 'fr', 'french', 'français', 'francais'],
        fr: ['fre', 'fra', 'fr', 'french', 'français', 'francais'],
        ger: ['ger', 'deu', 'de', 'german', 'deutsch'],
        deu: ['ger', 'deu', 'de', 'german', 'deutsch'],
        de: ['ger', 'deu', 'de', 'german', 'deutsch'],
        ita: ['ita', 'it', 'italian', 'italiano'],
        it: ['ita', 'it', 'italian', 'italiano'],
        por: ['por', 'pt', 'portuguese', 'português', 'portugues'],
        pt: ['por', 'pt', 'portuguese', 'português', 'portugues'],
        rus: ['rus', 'ru', 'russian'],
        ru: ['rus', 'ru', 'russian'],
        jpn: ['jpn', 'ja', 'japanese'],
        ja: ['jpn', 'ja', 'japanese'],
        kor: ['kor', 'ko', 'korean'],
        ko: ['kor', 'ko', 'korean'],
        chi: ['chi', 'zho', 'zh', 'chinese', 'cmn'],
        zho: ['chi', 'zho', 'zh', 'chinese', 'cmn'],
        zh: ['chi', 'zho', 'zh', 'chinese', 'cmn'],
        nld: ['nld', 'dut', 'nl', 'dutch'],
        dut: ['nld', 'dut', 'nl', 'dutch'],
        nl: ['nld', 'dut', 'nl', 'dutch'],
    };
    if (map[c]) {
        return map[c];
    }
    return [c];
}

/** Plex / client-facing 2-letter (or short) language for the lang= query param. */
function toPlexLangCode(preferred) {
    if (!preferred) {
        return 'en';
    }
    let c = String(preferred).toLowerCase().trim();
    let map = {
        eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
        ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko',
        chi: 'zh', zho: 'zh', nld: 'nl', dut: 'nl', swe: 'sv', nor: 'no',
        dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr', ara: 'ar', hin: 'hi',
        heb: 'he', tha: 'th', vie: 'vi', und: 'en',
    };
    if (map[c]) {
        return map[c];
    }
    if (c.length >= 2) {
        return c.slice(0, 2);
    }
    return 'en';
}

function isForcedSubtitle(stream) {
    if (!stream) {
        return false;
    }
    if (stream.forced == "1" || stream.forced === true || stream.forced === 1) {
        return true;
    }
    let title = (stream.title || stream.displayTitle || "").toLowerCase();
    if (title.indexOf("forced") !== -1) {
        return true;
    }
    return false;
}

/** Codecs that generally remux into MPEG-TS without re-encoding (soft-map candidates). */
function isMpegTsFriendlySubtitle(stream) {
    if (!stream) {
        return false;
    }
    let c = String(stream.codec || stream.codecID || '').toLowerCase();
    // Plex often reports short names (pgs) or long FFmpeg names (hdmv_pgs_subtitle)
    if (
        c === 'pgs' ||
        c === 'pgssub' ||
        c === 'hdmv_pgs_subtitle' ||
        c === 'dvd_subtitle' ||
        c === 'vobsub' ||
        c === 'dvb_subtitle' ||
        c === 'dvbsub' ||
        c === 'dvdsub' ||
        c === 'dvb_teletext' ||
        c === 'xsub'
    ) {
        return true;
    }
    // Display title fallbacks (Plex sometimes omits codec string)
    let title = String(stream.title || stream.displayTitle || stream.extendedDisplayTitle || '').toLowerCase();
    if (
        title.indexOf('pgs') !== -1 ||
        title.indexOf('vobsub') !== -1 ||
        (title.indexOf('dvd') !== -1 && title.indexOf('sub') !== -1) ||
        title.indexOf('dvb') !== -1
    ) {
        return true;
    }
    return false;
}

/**
 * Detect HDR / Dolby Vision / HLG / HDR10 from a Plex video Stream object.
 * Aligned with Tunarr isHdr() / isDolbyVision() / color transfer checks.
 */
function isHdrVideoStream(stream) {
    if (!stream) {
        return false;
    }
    // Explicit flags
    if (
        stream.HDR === true || stream.hdr === true || stream.HDR === 1 || stream.HDR === '1' ||
        stream.DOVIPresent === true || stream.DOVIPresent === 1 || stream.DOVIPresent === '1' ||
        stream.doviPresent === true || stream.doviPresent === 1 || stream.doviPresent === '1'
    ) {
        return true;
    }
    if (stream.DOVILevel || stream.doviLevel || stream.DOVIProfile || stream.doviProfile) {
        return true;
    }
    // Dolby Vision codec profiles (Tunarr)
    let codec = String(stream.codec || '').toLowerCase();
    let profile = String(stream.profile || '').toLowerCase();
    if (codec === 'dvhe' || codec === 'dvh1' || profile.indexOf('dolby vision') !== -1) {
        return true;
    }

    let trc = String(stream.colorTrc || stream.colorTransfer || '').toLowerCase();
    // PQ (HDR10/HDR10+) and HLG — Tunarr ColorFormat.isHdr
    if (
        trc === 'smpte2084' ||
        trc === 'smpte2086' ||
        trc === 'arib-std-b67' ||
        trc.indexOf('pq') !== -1 ||
        trc.indexOf('hlg') !== -1 ||
        trc.indexOf('2084') !== -1
    ) {
        return true;
    }

    let primaries = String(stream.colorPrimaries || '').toLowerCase();
    let space = String(stream.colorSpace || '').toLowerCase();
    let bitDepth = parseInt(stream.bitDepth || stream.bitsPerRawSample || 0, 10);
    // BT.2020 + 10-bit is almost always HDR in practice for modern encodes
    if (
        (primaries.indexOf('bt2020') !== -1 || space.indexOf('bt2020') !== -1) &&
        !isNaN(bitDepth) &&
        bitDepth >= 10
    ) {
        return true;
    }

    return false;
}

module.exports = PlexTranscoder
