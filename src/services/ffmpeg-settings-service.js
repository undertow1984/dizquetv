const databaseMigration = require('../database-migration');
const DAY_MS = 1000 * 60 * 60 * 24;
const path = require('path');
const fs = require('fs');

/** Allowed values matching the FFmpeg Settings UI */
const ALLOWED_HDR_ALGOS = ['hable', 'reinhard', 'mobius', 'gamma', 'linear', 'clip', 'bt2390'];
const ALLOWED_SPEEDS = ['veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast'];
const ALLOWED_HW_DECODE = [
  'none', 'auto', 'cuda', 'qsv', 'd3d11va', 'dxva2', 'vaapi', 'videotoolbox',
  'opencl', 'vulkan', 'off', 'disabled'
];
const ALLOWED_STREAM_MODES = ['mpegts', 'hls', 'hls_slower', 'hls_direct', 'hls_direct_v2'];
const ALLOWED_CONTAINERS = ['mpegts', 'mkv', 'mp4'];
const ALLOWED_SCALING = ['bicubic', 'fast_bilinear', 'lanczos', 'spline'];
const ALLOWED_DEINTERLACE = ['none', 'bwdif=0', 'bwdif=1', 'w3fdif', 'yadif=0', 'yadif=1'];
const ALLOWED_ERROR_SCREENS = ['pic', 'blank', 'static', 'testsrc', 'text', 'kill'];
const ALLOWED_ERROR_AUDIOS = ['whitenoise', 'sine', 'silent'];
const ALLOWED_MUX_DELAY = ['0', '1', '2', '3', '4', '5', '10'];
// off | soft (image soft-map only) | soft_burn (image soft + text burn)
const ALLOWED_SUBTITLE_MODES = ['off', 'soft', 'soft_burn'];

/**
 * Normalize subtitleMode; migrate legacy includeSubtitles boolean.
 * @returns {'off'|'soft'|'soft_burn'}
 */
function normalizeSubtitleMode(ffmpeg) {
    if (!ffmpeg) {
        return 'off';
    }
    let raw = ffmpeg.subtitleMode;
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
        if (ALLOWED_SUBTITLE_MODES.indexOf(m) !== -1) {
            return m;
        }
    }
    // Legacy checkbox
    return ffmpeg.includeSubtitles === true ? 'soft_burn' : 'off';
}

class FfmpegSettingsService {
    constructor(db, unlock) {
        this.db = db;
        if (unlock) {
            this.unlock();
        }
    }

    get() {
        let ffmpeg = this.getCurrentState();
        if (isLocked(ffmpeg)) {
            ffmpeg.lock = true;
        }
        // Hid this info from the API
        delete ffmpeg.ffmpegPathLockDate;
        applyDefaults(ffmpeg);
        return ffmpeg;
    }

    unlock() {
        let ffmpeg = this.getCurrentState();
        console.log("ffmpeg path UI unlocked for another day...");
        ffmpeg.ffmpegPathLockDate = new Date().getTime() + DAY_MS;
        this.db['ffmpeg-settings'].update({ _id: ffmpeg._id }, ffmpeg)
    }


    update(attempt) {
        let ffmpeg = this.getCurrentState();
        attempt.ffmpegPathLockDate = ffmpeg.ffmpegPathLockDate;
        if (isLocked(ffmpeg)) {
            console.log("Note: ffmpeg path is not being updated since it's been locked for your security.");
            attempt.ffmpegPath = ffmpeg.ffmpegPath;
            if (typeof(ffmpeg.ffmpegPathLockDate) === 'undefined') {
                // make sure to lock it even if it was undefined
                attempt.ffmpegPathLockDate = new Date().getTime() - DAY_MS;
            }
        } else if (attempt.addLock === true) {
            // lock it right now
            attempt.ffmpegPathLockDate = new Date().getTime() - DAY_MS;
        } else {
            attempt.ffmpegPathLockDate = new Date().getTime() + DAY_MS;
        }
        delete attempt.addLock;
        delete attempt.lock;

        let err = fixupFFMPEGSettings(attempt);
        if ( typeof(err) !== "undefined" ) {
            return {
                error: err
            }
        }

        this.db['ffmpeg-settings'].update({ _id: ffmpeg._id }, attempt)
        return {
            ffmpeg: this.get()
        }
    }

    reset() {
        // Even if reseting, it's impossible to unlock the ffmpeg path
        let ffmpeg = databaseMigration.defaultFFMPEG() ;
        this.update(ffmpeg);
        return this.get();
    }

    getCurrentState() {
        return this.db['ffmpeg-settings'].find()[0]
    }


}

/**
 * Fill missing keys so the UI and runtime always see a complete options object.
 */
function applyDefaults(ffmpeg) {
    if (!ffmpeg) {
        return;
    }
    // Remember whether subtitleMode was already stored (vs missing → migrate from checkbox)
    let hadSubtitleMode = (
        typeof(ffmpeg.subtitleMode) !== 'undefined'
        && ffmpeg.subtitleMode !== null
        && String(ffmpeg.subtitleMode).trim() !== ''
    );
    const d = databaseMigration.defaultFFMPEG();
    const keys = Object.keys(d);
    for (let i = 0; i < keys.length; i++) {
        let k = keys[i];
        if (k === 'ffmpegPathLockDate' || k === 'configVersion') {
            continue;
        }
        // Do not stamp default subtitleMode:'off' over a legacy includeSubtitles:true row
        if (k === 'subtitleMode' && !hadSubtitleMode) {
            continue;
        }
        if (typeof(ffmpeg[k]) === 'undefined' || ffmpeg[k] === null) {
            ffmpeg[k] = d[k];
        }
    }
    if (!hadSubtitleMode) {
        ffmpeg.subtitleMode = (ffmpeg.includeSubtitles === true) ? 'soft_burn' : 'off';
    }
    // Keep boolean mirror in sync
    ffmpeg.includeSubtitles = (normalizeSubtitleMode(ffmpeg) !== 'off');

    // Legacy / UI-only defaults
    if (typeof(ffmpeg.disablePreludes) === 'undefined') {
        ffmpeg.disablePreludes = false;
    }
    if (typeof(ffmpeg.enableChannelWatermarkGlobally) === 'undefined') {
        ffmpeg.enableChannelWatermarkGlobally = false;
    }
    if (typeof(ffmpeg.disableChannelOverlay) === 'undefined') {
        ffmpeg.disableChannelOverlay = false;
    }
}

function asBool(v, defaultVal) {
    if (typeof(v) === 'undefined' || v === null) {
        return defaultVal === true;
    }
    return v === true || v === 'true' || v === 1 || v === '1';
}

function asNum(v, defaultVal, min, max) {
    if (typeof(v) === 'undefined' || v === null || v === '') {
        return defaultVal;
    }
    let n = Number(v);
    if (isNaN(n)) {
        return null; // signal invalid
    }
    if (typeof min === 'number' && n < min) {
        n = min;
    }
    if (typeof max === 'number' && n > max) {
        n = max;
    }
    return n;
}

function fixupFFMPEGSettings(ffmpeg) {
    applyDefaults(ffmpeg);

    if (typeof(ffmpeg.ffmpegPath) !== 'string') {
        return "ffmpeg path is required."
    }
    if (! isValidFilePath(ffmpeg.ffmpegPath)) {
        return "ffmpeg path must be a valid file path."
    }

    // Booleans from UI checkboxes
    ffmpeg.enableFFMPEGTranscoding = asBool(ffmpeg.enableFFMPEGTranscoding, true);
    ffmpeg.logFfmpeg = asBool(ffmpeg.logFfmpeg, false);
    ffmpeg.normalizeVideoCodec = asBool(ffmpeg.normalizeVideoCodec, true);
    ffmpeg.normalizeAudioCodec = asBool(ffmpeg.normalizeAudioCodec, true);
    ffmpeg.normalizeResolution = asBool(ffmpeg.normalizeResolution, true);
    ffmpeg.normalizeAudio = asBool(ffmpeg.normalizeAudio, true);
    ffmpeg.enableChannelWatermarkGlobally = asBool(ffmpeg.enableChannelWatermarkGlobally, false);
    ffmpeg.disableChannelOverlay = asBool(ffmpeg.disableChannelOverlay, false);
    ffmpeg.disablePreludes = asBool(ffmpeg.disablePreludes, false);
    // Subtitle mode (UI); keep includeSubtitles boolean in sync for older callers
    let subMode = normalizeSubtitleMode(ffmpeg);
    if (ffmpeg.subtitleMode != null && String(ffmpeg.subtitleMode).trim() !== '') {
        let m = String(ffmpeg.subtitleMode).trim().toLowerCase().replace(/-/g, '_').replace(/\+/g, '_');
        if (m === 'none' || m === 'disabled') m = 'off';
        if (m === 'soft_only' || m === 'softonly') m = 'soft';
        if (m === 'soft_and_burn' || m === 'burn') m = 'soft_burn';
        if (ALLOWED_SUBTITLE_MODES.indexOf(m) === -1) {
            return "subtitleMode must be one of: off, soft, soft_burn";
        }
        subMode = m;
    }
    ffmpeg.subtitleMode = subMode;
    ffmpeg.includeSubtitles = (subMode !== 'off');
    ffmpeg.enableHdrToneMapping = asBool(ffmpeg.enableHdrToneMapping, false);

    // Numbers
    let threads = asNum(ffmpeg.threads, 4, 0, 128);
    if (threads === null) {
        return "threads must be a number";
    }
    ffmpeg.threads = threads;

    let maxFPS = asNum(ffmpeg.maxFPS, 60, 1, 240);
    if (maxFPS === null) {
        return "maxFPS should be a number";
    }
    ffmpeg.maxFPS = maxFPS;

    let videoBitrate = asNum(ffmpeg.videoBitrate, 2000, 1, 200000);
    if (videoBitrate === null) {
        return "videoBitrate must be a number";
    }
    ffmpeg.videoBitrate = videoBitrate;

    let videoBufSize = asNum(ffmpeg.videoBufSize, videoBitrate, 1, 400000);
    if (videoBufSize === null) {
        return "videoBufSize must be a number";
    }
    ffmpeg.videoBufSize = videoBufSize;

    let audioBitrate = asNum(ffmpeg.audioBitrate, 192, 8, 2048);
    if (audioBitrate === null) {
        return "audioBitrate must be a number";
    }
    ffmpeg.audioBitrate = audioBitrate;

    let audioBufSize = asNum(ffmpeg.audioBufSize, audioBitrate, 8, 4096);
    if (audioBufSize === null) {
        return "audioBufSize must be a number";
    }
    ffmpeg.audioBufSize = audioBufSize;

    let audioVolumePercent = asNum(ffmpeg.audioVolumePercent, 100, 0, 500);
    if (audioVolumePercent === null) {
        return "audioVolumePercent must be a number";
    }
    ffmpeg.audioVolumePercent = audioVolumePercent;

    let audioChannels = asNum(ffmpeg.audioChannels, 2, 1, 16);
    if (audioChannels === null) {
        return "audioChannels must be a number";
    }
    ffmpeg.audioChannels = audioChannels;

    let audioSampleRate = asNum(ffmpeg.audioSampleRate, 48, 8, 192);
    if (audioSampleRate === null) {
        return "audioSampleRate must be a number";
    }
    ffmpeg.audioSampleRate = audioSampleRate;

    let hwFrames = asNum(ffmpeg.hwAccelExtraFrames, 8, 0, 64);
    if (hwFrames === null) {
        return "hwAccelExtraFrames must be a number (0–64)";
    }
    ffmpeg.hwAccelExtraFrames = hwFrames;

    // Strings / enums
    if (typeof(ffmpeg.videoEncoder) !== 'string' || !String(ffmpeg.videoEncoder).trim()) {
        return "videoEncoder is required";
    }
    ffmpeg.videoEncoder = String(ffmpeg.videoEncoder).trim();

    if (typeof(ffmpeg.audioEncoder) !== 'string' || !String(ffmpeg.audioEncoder).trim()) {
        return "audioEncoder is required";
    }
    ffmpeg.audioEncoder = String(ffmpeg.audioEncoder).trim();

    if (typeof(ffmpeg.targetResolution) !== 'string' || !String(ffmpeg.targetResolution).trim()) {
        ffmpeg.targetResolution = '1920x1080';
    } else {
        ffmpeg.targetResolution = String(ffmpeg.targetResolution).trim();
    }

    // Video buffer (muxdelay) — stored as string id "0"…"10"
    let mux = (ffmpeg.concatMuxDelay == null) ? '0' : String(ffmpeg.concatMuxDelay);
    if (ALLOWED_MUX_DELAY.indexOf(mux) === -1) {
        // allow numeric 0-10
        let mn = parseFloat(mux);
        if (isNaN(mn) || mn < 0 || mn > 30) {
            mux = '0';
        } else {
            mux = String(mn);
        }
    }
    ffmpeg.concatMuxDelay = mux;

    if (typeof(ffmpeg.preferredLanguage) === 'undefined' || ffmpeg.preferredLanguage === null || ffmpeg.preferredLanguage === '') {
        ffmpeg.preferredLanguage = 'eng';
    } else {
        ffmpeg.preferredLanguage = String(ffmpeg.preferredLanguage).trim().toLowerCase();
    }

    let algo = String(ffmpeg.hdrToneMappingAlgorithm || 'hable').trim().toLowerCase();
    if (ALLOWED_HDR_ALGOS.indexOf(algo) === -1) {
        return "hdrToneMappingAlgorithm must be one of: " + ALLOWED_HDR_ALGOS.join(', ');
    }
    ffmpeg.hdrToneMappingAlgorithm = algo;

    let speed = String(ffmpeg.transcodingSpeed || 'veryfast').trim().toLowerCase();
    if (ALLOWED_SPEEDS.indexOf(speed) === -1) {
        return "transcodingSpeed must be one of: " + ALLOWED_SPEEDS.join(', ');
    }
    ffmpeg.transcodingSpeed = speed;

    let hw = String(ffmpeg.hardwareDecode || 'none').trim().toLowerCase();
    if (ALLOWED_HW_DECODE.indexOf(hw) === -1) {
        return "hardwareDecode must be one of: none, auto, cuda, qsv, d3d11va, dxva2, vaapi, videotoolbox";
    }
    if (hw === 'off' || hw === 'disabled') {
        hw = 'none';
    }
    ffmpeg.hardwareDecode = hw;
    ffmpeg.hardwareDecodeDevice = (ffmpeg.hardwareDecodeDevice == null)
        ? ''
        : String(ffmpeg.hardwareDecodeDevice).trim();

    let mode = String(ffmpeg.streamMode || 'mpegts').trim().toLowerCase();
    if (ALLOWED_STREAM_MODES.indexOf(mode) === -1) {
        return "streamMode must be one of: " + ALLOWED_STREAM_MODES.join(', ');
    }
    ffmpeg.streamMode = mode;

    let c = String(ffmpeg.hlsDirectContainer || 'mpegts').trim().toLowerCase();
    if (ALLOWED_CONTAINERS.indexOf(c) === -1) {
        return "hlsDirectContainer must be one of: " + ALLOWED_CONTAINERS.join(', ');
    }
    ffmpeg.hlsDirectContainer = c;

    let scale = String(ffmpeg.scalingAlgorithm || 'bicubic').trim().toLowerCase();
    if (ALLOWED_SCALING.indexOf(scale) === -1) {
        // allow free-form flags= values FFmpeg understands
        if (!scale) {
            scale = 'bicubic';
        }
    }
    ffmpeg.scalingAlgorithm = scale;

    let deint = String(ffmpeg.deinterlaceFilter || 'none').trim();
    if (ALLOWED_DEINTERLACE.indexOf(deint) === -1 && deint !== '') {
        // allow custom filter strings
    }
    if (!deint) {
        deint = 'none';
    }
    ffmpeg.deinterlaceFilter = deint;

    let errScreen = String(ffmpeg.errorScreen || 'pic').trim().toLowerCase();
    if (ALLOWED_ERROR_SCREENS.indexOf(errScreen) === -1) {
        return "errorScreen must be one of: " + ALLOWED_ERROR_SCREENS.join(', ');
    }
    ffmpeg.errorScreen = errScreen;

    let errAudio = String(ffmpeg.errorAudio || 'silent').trim().toLowerCase();
    if (ALLOWED_ERROR_AUDIOS.indexOf(errAudio) === -1) {
        return "errorAudio must be one of: " + ALLOWED_ERROR_AUDIOS.join(', ');
    }
    ffmpeg.errorAudio = errAudio;
}

//These checks are good but might not be enough, as long as we are letting the
//user choose any path and we are making dizqueTV execute, it is too risky,
//hence why we are also adding the lock feature on top of these checks.
function isValidFilePath(filePath) {
    const normalizedPath = path.normalize(filePath);
  
    if (!path.isAbsolute(normalizedPath)) {
      return false;
    }
  
    try {
      const stats = fs.statSync(normalizedPath);
      return stats.isFile();
    } catch (err) {
      // Handle potential errors (e.g., file not found, permission issues)
      if (err.code === 'ENOENT') {
        return false; // File does not exist
      } else {
        throw err; // Re-throw other errors for debugging
      }
    }
}

function isLocked(ffmpeg) {
    return isNaN(ffmpeg.ffmpegPathLockDate) || ffmpeg.ffmpegPathLockDate < new Date().getTime();
}



module.exports = FfmpegSettingsService;
module.exports.normalizeSubtitleMode = normalizeSubtitleMode;
module.exports.ALLOWED_SUBTITLE_MODES = ALLOWED_SUBTITLE_MODES;
