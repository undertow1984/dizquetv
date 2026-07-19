module.exports = function (dizquetv, resolutionOptions, $timeout) {
    return {
        restrict: 'E',
        templateUrl: 'templates/ffmpeg-settings.html',
        replace: true,
        scope: {
        },
        link: function (scope, element, attrs) {
            //add validations to ffmpeg settings, speciall commas in codec name
            scope.watermarkApplyPending = false;
            scope.watermarkApplyStatus = "";
            scope.watermarkApplyError = "";

            dizquetv.getFfmpegSettings().then((settings) => {
                if (typeof settings.enableChannelWatermarkGlobally === 'undefined') {
                    settings.enableChannelWatermarkGlobally = false;
                }
                if (typeof settings.preferredLanguage === 'undefined' || settings.preferredLanguage === null || settings.preferredLanguage === '') {
                    settings.preferredLanguage = 'eng';
                }
                if (typeof settings.subtitleMode === 'undefined' || !settings.subtitleMode) {
                    // Migrate legacy checkbox
                    settings.subtitleMode = (settings.includeSubtitles === true) ? 'soft_burn' : 'off';
                }
                if (typeof settings.includeSubtitles === 'undefined') {
                    settings.includeSubtitles = (settings.subtitleMode !== 'off');
                }
                if (typeof settings.enableHdrToneMapping === 'undefined') {
                    settings.enableHdrToneMapping = false;
                }
                if (typeof settings.hdrToneMappingAlgorithm === 'undefined' || !settings.hdrToneMappingAlgorithm) {
                    settings.hdrToneMappingAlgorithm = 'hable';
                }
                if (typeof settings.transcodingSpeed === 'undefined' || !settings.transcodingSpeed) {
                    settings.transcodingSpeed = 'veryfast';
                }
                if (typeof settings.hardwareDecode === 'undefined' || !settings.hardwareDecode) {
                    settings.hardwareDecode = 'none';
                }
                if (typeof settings.hardwareDecodeDevice === 'undefined' || settings.hardwareDecodeDevice === null) {
                    settings.hardwareDecodeDevice = '';
                }
                if (typeof settings.hwAccelExtraFrames === 'undefined' || settings.hwAccelExtraFrames === null) {
                    settings.hwAccelExtraFrames = 8;
                }
                if (typeof settings.streamMode === 'undefined' || !settings.streamMode) {
                    settings.streamMode = 'mpegts';
                }
                if (typeof settings.hlsDirectContainer === 'undefined' || !settings.hlsDirectContainer) {
                    settings.hlsDirectContainer = 'mpegts';
                }
                if (typeof settings.disablePreludes === 'undefined') {
                    settings.disablePreludes = false;
                }
                if (typeof settings.enableDynamicChannelLogos === 'undefined') {
                    settings.enableDynamicChannelLogos = false;
                }
                if (typeof settings.channelLogoTemplatePath === 'undefined' || settings.channelLogoTemplatePath === null) {
                    settings.channelLogoTemplatePath = '';
                }
                if (typeof settings.channelLogoTemplateTwoPath === 'undefined' || settings.channelLogoTemplateTwoPath === null) {
                    settings.channelLogoTemplateTwoPath = '';
                }
                if (typeof settings.logFfmpeg === 'undefined') {
                    settings.logFfmpeg = false;
                }
                scope.settings = settings
            })
            scope.updateSettings = (settings) => {
                delete scope.settingsError;
                scope.watermarkApplyStatus = "";
                scope.watermarkApplyError = "";
                dizquetv.updateFfmpegSettings(settings).then((_settings) => {
                    scope.settings = _settings
                }).catch( (err) => {
                    if ( typeof(err.data) === "string") {
                        scope.settingsError = err.data;
                    }
                })
            }
            scope.resetSettings = (settings) => {
                scope.watermarkApplyStatus = "";
                scope.watermarkApplyError = "";
                dizquetv.resetFfmpegSettings(settings).then((_settings) => {
                    scope.settings = _settings
                })
            }
            scope.enableWatermarksOnAllChannels = async () => {
                if (scope.watermarkApplyPending) {
                    return;
                }
                if (!confirm("Enable the Channel Watermark checkbox on all existing channels?")) {
                    return;
                }
                scope.watermarkApplyPending = true;
                scope.watermarkApplyStatus = "";
                scope.watermarkApplyError = "";
                $timeout();
                try {
                    let result = await dizquetv.enableWatermarksOnAllChannels();
                    let n = (result && typeof result.updated === 'number') ? result.updated : 0;
                    scope.watermarkApplyStatus = "Enabled watermark on " + n + " channel(s).";
                } catch (err) {
                    console.error(err);
                    scope.watermarkApplyError = "Failed to enable watermarks on all channels.";
                } finally {
                    scope.watermarkApplyPending = false;
                    $timeout();
                }
            }
            scope.isTranscodingNotNeeded = () => {
                return (typeof(scope.settings) ==='undefined') || ! (scope.settings.enableFFMPEGTranscoding);
            };
            scope.hideIfNotAutoPlay = () => {
                return scope.settings.enableAutoPlay != true
            };
            scope.resolutionOptions= resolutionOptions.get();
            scope.muxDelayOptions=[
                {id:"0",description:"0 Seconds"},
                {id:"1",description:"1 Seconds"},
                {id:"2",description:"2 Seconds"},
                {id:"3",description:"3 Seconds"},
                {id:"4",description:"4 Seconds"},
                {id:"5",description:"5 Seconds"},
                {id:"10",description:"10 Seconds"},
            ];
            // Tunarr-aligned stream modes (see docs/configure/channels/transcoding.md)
            scope.streamModeOptions = [
                {id: "mpegts", description: "MPEG-TS (classic dizqueTV / HDHR)"},
                {id: "hls", description: "HLS (recommended for IPTV clients)"},
                {id: "hls_slower", description: "HLS alt (stronger normalize, more CPU)"},
                {id: "hls_direct", description: "HLS Direct (remux current program, minimal process)"},
                {id: "hls_direct_v2", description: "HLS Direct v2 (continuous playlist, prefer remux)"},
            ];
            scope.hlsDirectContainerOptions = [
                {id: "mpegts", description: "MPEG-TS"},
                {id: "mkv", description: "Matroska (MKV)"},
                {id: "mp4", description: "MP4"},
            ];
            // FFmpeg libx264-style presets (slow → fast). Also mapped for NVENC/QSV in ffmpeg.js.
            scope.transcodingSpeedOptions = [
                {id: "veryslow", description: "Very Slow (best quality)"},
                {id: "slower", description: "Slower"},
                {id: "slow", description: "Slow"},
                {id: "medium", description: "Medium"},
                {id: "fast", description: "Fast"},
                {id: "faster", description: "Faster"},
                {id: "veryfast", description: "Very Fast (recommended for live)"},
                {id: "superfast", description: "Super Fast"},
                {id: "ultrafast", description: "Ultra Fast (lowest CPU)"},
            ];
            // FFmpeg -hwaccel values (decode only; frames still hit CPU filters)
            scope.hardwareDecodeOptions = [
                {id: "none", description: "None (software decode)"},
                {id: "auto", description: "Auto (from video encoder: cuda/qsv/d3d11/…)"},
                {id: "cuda", description: "CUDA (NVIDIA — recommended with NVENC)"},
                {id: "qsv", description: "Intel Quick Sync (QSV)"},
                {id: "d3d11va", description: "D3D11VA (Windows)"},
                {id: "dxva2", description: "DXVA2 (Windows, older)"},
                {id: "vaapi", description: "VAAPI (Linux)"},
                {id: "videotoolbox", description: "VideoToolbox (macOS)"},
            ];
            scope.errorScreens = [
                {value:"pic", description:"images/generic-error-screen.png"},
                {value:"blank", description:"Blank Screen"},
                {value:"static", description:"Static"},
                {value:"testsrc", description:"Test Pattern (color bars + timer)"},
                {value:"text", description:"Detailed error (requires ffmpeg with drawtext)"},
                {value:"kill", description:"Stop stream, show errors in logs"},
            ]
            scope.errorAudios = [
                {value:"whitenoise", description:"White Noise"},
                {value:"sine", description:"Beep"},
                {value:"silent", description:"No Audio"},
            ]
            scope.fpsOptions = [
                {id: 23.976, description: "23.976 frames per second"},
                {id: 24, description: "24 frames per second"},
                {id: 25, description: "25 frames per second"},
                {id: 29.97, description: "29.97 frames per second"},
                {id: 30, description: "30 frames per second"},
                {id: 50, description: "50 frames per second"},
                {id: 59.94, description: "59.94 frames per second"},
                {id: 60, description: "60 frames per second"},
                {id: 120, description: "120 frames per second"},
            ];
            scope.scalingOptions = [
                {id: "bicubic", description: "bicubic (default)"},
                {id: "fast_bilinear", description: "fast_bilinear"},
                {id: "lanczos", description: "lanczos"},
                {id: "spline", description: "spline"},
            ];
            scope.deinterlaceOptions = [
                {value: "none", description: "do not deinterlace"},
                {value: "bwdif=0", description: "bwdif send frame"},
                {value: "bwdif=1", description: "bwdif send field"},
                {value: "w3fdif", description: "w3fdif"},
                {value: "yadif=0", description: "yadif send frame"},
                {value: "yadif=1", description: "yadif send field"}
            ];
            scope.hdrToneMapOptions = [
                {id: "hable", description: "hable (default, balanced)"},
                {id: "bt2390", description: "bt2390 (HDR10 PQ)"},
                {id: "reinhard", description: "reinhard"},
                {id: "mobius", description: "mobius"},
                {id: "gamma", description: "gamma"},
                {id: "linear", description: "linear"},
                {id: "clip", description: "clip"},
            ];
            scope.subtitleModeOptions = [
                {id: "off", description: "Off (no subtitles)"},
                {id: "soft", description: "Soft only (PGS / image tracks — toggleable when client supports)"},
                {id: "soft_burn", description: "Soft + burn text (image soft-map; SRT/ASS burned always-on)"},
            ];
            scope.languageOptions = [
                {id: "eng", description: "English (eng)"},
                {id: "spa", description: "Spanish (spa)"},
                {id: "fre", description: "French (fre)"},
                {id: "ger", description: "German (ger)"},
                {id: "ita", description: "Italian (ita)"},
                {id: "por", description: "Portuguese (por)"},
                {id: "rus", description: "Russian (rus)"},
                {id: "jpn", description: "Japanese (jpn)"},
                {id: "kor", description: "Korean (kor)"},
                {id: "chi", description: "Chinese (chi)"},
                {id: "zho", description: "Chinese (zho)"},
                {id: "nld", description: "Dutch (nld)"},
                {id: "swe", description: "Swedish (swe)"},
                {id: "nor", description: "Norwegian (nor)"},
                {id: "dan", description: "Danish (dan)"},
                {id: "fin", description: "Finnish (fin)"},
                {id: "pol", description: "Polish (pol)"},
                {id: "tur", description: "Turkish (tur)"},
                {id: "ara", description: "Arabic (ara)"},
                {id: "hin", description: "Hindi (hin)"},
                {id: "heb", description: "Hebrew (heb)"},
                {id: "tha", description: "Thai (tha)"},
                {id: "vie", description: "Vietnamese (vie)"},
                {id: "und", description: "Undefined (und)"},
            ];

        }
    }
}