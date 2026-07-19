/**
 * Dynamic channel logo generation from a Photoshop template (PSD).
 *
 * Pipeline:
 *  1. Deploy / open Plex-Template.psd (or user-supplied PSD)
 *  2. Extract the PLEX branding layer(s) — always retained
 *  3. Create a transparent canvas and composite the PLEX art
 *  4. Draw the channel name BELOW the PLEX logo
 *  5. Export a transparent PNG (RGBA) for FFmpeg watermark overlay
 *
 * Requires ImageMagick 7+ (`magick` on PATH).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/** 1-word channel names */
const TEMPLATE_ONE_FILENAME = 'Plex-Template.psd';
/** 2+ word channel names (multi-line layout under PLEX) */
const TEMPLATE_TWO_FILENAME = 'Plex-Template-Two.psd';
/** @deprecated alias */
const TEMPLATE_FILENAME = TEMPLATE_ONE_FILENAME;
const CACHE_SUBDIR = path.join('cache', 'channel-logos');
/** Bump when generator output format/layout changes (invalidates cache). */
const GENERATOR_VERSION = '4';

let _magickChecked = false;
let _magickPath = null;
let _templateMetaCache = new Map();

function projectRoot() {
    return path.resolve(path.join(__dirname, '..'));
}

function databaseRoot() {
    return process.env.DATABASE
        ? path.resolve(process.env.DATABASE)
        : path.join(projectRoot(), '.dizquetv');
}

function defaultTemplatePath(filename) {
    filename = filename || TEMPLATE_ONE_FILENAME;
    let inDb = path.join(databaseRoot(), filename);
    if (fs.existsSync(inDb)) {
        return inDb;
    }
    let bundled = path.resolve(path.join(projectRoot(), 'resources', filename));
    if (fs.existsSync(bundled)) {
        return bundled;
    }
    return inDb;
}

/**
 * Ensure a named PSD exists under the data folder (copy from resources if needed).
 * @param {string} [filename]
 */
function ensureTemplateDeployed(filename) {
    filename = filename || TEMPLATE_ONE_FILENAME;
    let dest = path.join(databaseRoot(), filename);
    if (fs.existsSync(dest)) {
        return dest;
    }
    let src = path.resolve(path.join(projectRoot(), 'resources', filename));
    if (!fs.existsSync(src)) {
        return null;
    }
    try {
        let dir = path.dirname(dest);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.copyFileSync(src, dest);
        console.log('dizqueTV channel-logo: deployed ' + filename + ' → ' + dest);
        return dest;
    } catch (e) {
        console.error('dizqueTV channel-logo: failed to deploy ' + filename, e.message || e);
        return fs.existsSync(src) ? src : null;
    }
}

/** Deploy both one-word and two-word templates. */
function ensureAllTemplatesDeployed() {
    return {
        one: ensureTemplateDeployed(TEMPLATE_ONE_FILENAME),
        two: ensureTemplateDeployed(TEMPLATE_TWO_FILENAME),
    };
}

/**
 * @param {string} [configured] absolute path override
 * @param {string} [defaultFilename] Plex-Template.psd or Plex-Template-Two.psd
 */
function resolveTemplatePath(configured, defaultFilename) {
    defaultFilename = defaultFilename || TEMPLATE_ONE_FILENAME;
    if (configured && String(configured).trim()) {
        let p = path.resolve(String(configured).trim());
        if (fs.existsSync(p)) {
            return p;
        }
        console.error('dizqueTV channel-logo: configured template not found: ' + p);
    }
    let deployed = ensureTemplateDeployed(defaultFilename);
    if (deployed && fs.existsSync(deployed)) {
        return deployed;
    }
    let def = defaultTemplatePath(defaultFilename);
    return fs.existsSync(def) ? def : null;
}

function countChannelNameWords(name) {
    if (name == null || String(name).trim() === '') {
        return 1;
    }
    return String(name).trim().split(/\s+/).filter(Boolean).length;
}

/**
 * 1 word → Plex-Template.psd; 2+ words → Plex-Template-Two.psd
 */
function pickTemplateForChannelName(opts) {
    opts = opts || {};
    let words = countChannelNameWords(opts.channelName);
    let multi = words >= 2;
    let pathResolved = multi
        ? resolveTemplatePath(opts.templateTwoPath, TEMPLATE_TWO_FILENAME)
        : resolveTemplatePath(opts.templatePath, TEMPLATE_ONE_FILENAME);
    if (!pathResolved && multi) {
        pathResolved = resolveTemplatePath(opts.templatePath, TEMPLATE_ONE_FILENAME);
        console.log('dizqueTV channel-logo: two-word template missing; falling back to one-word PSD');
        multi = false;
    }
    return {
        path: pathResolved,
        multiLine: multi,
        wordCount: words,
        filename: multi ? TEMPLATE_TWO_FILENAME : TEMPLATE_ONE_FILENAME,
    };
}

/** Split ALL-CAPS name into 1–2 lines for the two-word template. */
function splitNameIntoLines(name, multiLine) {
    let words = String(name || 'CHANNEL').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return ['CHANNEL'];
    }
    if (!multiLine || words.length === 1) {
        return [words.join(' ')];
    }
    if (words.length === 2) {
        return [words[0], words[1]];
    }
    let mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

function cacheDir() {
    let dir = path.join(databaseRoot(), CACHE_SUBDIR);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function workDir() {
    let dir = path.join(cacheDir(), '_work');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function findMagick() {
    if (_magickChecked) {
        return _magickPath;
    }
    _magickChecked = true;
    let candidates = ['magick', 'magick.exe'];
    for (let i = 0; i < candidates.length; i++) {
        try {
            let r = spawnSync(candidates[i], ['-version'], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 5000,
            });
            if (r.status === 0 || (r.stdout && String(r.stdout).indexOf('ImageMagick') !== -1)) {
                _magickPath = candidates[i];
                return _magickPath;
            }
        } catch (e) { /* try next */ }
    }
    _magickPath = null;
    return null;
}

function magickRun(args, timeoutMs) {
    let bin = findMagick();
    if (!bin) {
        return { ok: false, error: 'ImageMagick (magick) not found on PATH' };
    }
    // Allow first arg "identify" as a subcommand for magick identify ...
    let argv = args;
    if (args && args[0] === 'identify') {
        argv = args; // magick identify ...
    }
    let r = spawnSync(bin, argv, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs || 60000,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) {
        return { ok: false, error: r.error.message || String(r.error) };
    }
    if (r.status !== 0) {
        return {
            ok: false,
            error: (r.stderr || r.stdout || 'magick failed status=' + r.status).toString().slice(0, 800),
        };
    }
    return { ok: true, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Forward-slash path for ImageMagick on Windows */
function imPath(p) {
    return path.resolve(p).replace(/\\/g, '/');
}

function isPlexLayerLabel(label) {
    if (!label) {
        return false;
    }
    let l = String(label).toLowerCase().trim();
    if (!l) {
        return false;
    }
    if (l.indexOf('plex') !== -1) {
        return true;
    }
    if (l === 'logo' || l.indexOf('brand') !== -1) {
        return true;
    }
    return false;
}

/**
 * Read PSD layer list: canvas size, PLEX branding layers, preferred text box under logo.
 */
function inspectTemplate(templatePath, forceRefresh) {
    if (!forceRefresh && _templateMetaCache.has(templatePath)) {
        return _templateMetaCache.get(templatePath);
    }

    let meta = {
        canvasW: 1280,
        canvasH: 600,
        plexLayers: [],
        textLayers: [],
        textBox: null,
    };

    let id0 = magickRun([imPath(templatePath) + '[0]', '-format', '%w %h', 'info:']);
    if (id0.ok) {
        let parts = String(id0.stdout).trim().split(/\s+/);
        let w = parseInt(parts[0], 10);
        let h = parseInt(parts[1], 10);
        if (!isNaN(w) && w > 0) meta.canvasW = w;
        if (!isNaN(h) && h > 0) meta.canvasH = h;
    }

    for (let i = 1; i < 32; i++) {
        // identify: file PSD WxH WxH+X+Y  (page offsets are reliable here)
        let id = magickRun(['identify', imPath(templatePath) + '[' + i + ']']);
        if (!id.ok) {
            break;
        }
        let idLine = String(id.stdout).trim();
        let gm = idLine.match(/(\d+)x(\d+)\s+(\d+)x(\d+)([+-]\d+)([+-]\d+)/);
        let labelInfo = magickRun([
            imPath(templatePath) + '[' + i + ']',
            '-format', '%l',
            'info:',
        ]);
        let label = labelInfo.ok ? String(labelInfo.stdout).trim() : '';
        let layer = {
            index: i,
            label: label,
            w: gm ? parseInt(gm[1], 10) : 0,
            h: gm ? parseInt(gm[2], 10) : 0,
            x: gm ? parseInt(gm[5], 10) : 0,
            y: gm ? parseInt(gm[6], 10) : 0,
        };
        if (isPlexLayerLabel(layer.label) || (i === 1 && meta.plexLayers.length === 0)) {
            if (!layer.label) {
                layer.label = 'Plex Logo';
            }
            meta.plexLayers.push(layer);
        } else {
            meta.textLayers.push(layer);
        }
    }

    if (meta.plexLayers.length === 0) {
        meta.plexLayers.push({
            index: 1,
            label: 'Plex Logo',
            x: 0,
            y: 0,
            w: meta.canvasW,
            h: Math.round(meta.canvasH * 0.69),
        });
    }

    // Channel name line boxes: sample text layers sorted top→bottom, else under PLEX
    let plexBottom = 0;
    for (let pi = 0; pi < meta.plexLayers.length; pi++) {
        let L = meta.plexLayers[pi];
        plexBottom = Math.max(plexBottom, (L.y || 0) + (L.h || 0));
    }
    let gap = 20;
    let nameY = Math.min(meta.canvasH - 90, plexBottom + gap);
    meta.textBox = {
        x: 40,
        y: Math.max(0, nameY),
        w: meta.canvasW - 80,
        h: Math.max(90, Math.min(150, meta.canvasH - nameY - 10)),
    };
    // Multi-line positions from sample text layers (e.g. GIGGLE @ mid, ADULTTOON @ bottom)
    meta.textBoxes = meta.textLayers
        .slice()
        .sort(function (a, b) { return (a.y || 0) - (b.y || 0); })
        .map(function (t) {
            return {
                x: Math.max(0, t.x || 40),
                y: Math.max(0, t.y || nameY),
                w: Math.min(meta.canvasW - 40, Math.max(t.w || 200, 200)),
                h: Math.max(t.h || 100, 80),
            };
        });
    if (meta.textBoxes.length === 0) {
        meta.textBoxes = [meta.textBox];
    }

    _templateMetaCache.set(templatePath, meta);
    console.log(
        'dizqueTV channel-logo: PSD ' + templatePath +
        ' ' + meta.canvasW + 'x' + meta.canvasH +
        ' plex=[' + meta.plexLayers.map(function (l) {
            return l.index + ':"' + l.label + '"@' + l.x + ',' + l.y;
        }).join('; ') + ']' +
        ' textLines=' + meta.textBoxes.length +
        ' nameBelowY=' + meta.textBox.y
    );
    return meta;
}

function sanitizeChannelName(name) {
    if (name == null || name === '') {
        return 'CHANNEL';
    }
    // Channel logos always use ALL CAPS (matches PLEX branding style)
    let s = String(name).replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!s) {
        return 'CHANNEL';
    }
    if (s.length > 48) {
        s = s.slice(0, 45) + '...';
    }
    return s;
}

function escapeForMagickAnnotate(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '%%')
        .replace(/@/g, '\\@');
}

/**
 * Read CoolType / font names embedded in a PSD (e.g. FuturaPT-Bold from Plex-Template).
 */
function extractFontNamesFromPsd(templatePath) {
    let names = [];
    try {
        if (!templatePath || !fs.existsSync(templatePath)) {
            return names;
        }
        let buf = fs.readFileSync(templatePath);
        // Search ASCII and UTF-16LE font PostScript names
        let ascii = buf.toString('binary');
        let re = /([A-Za-z][A-Za-z0-9_-]{2,60}(?:Bold|Black|Medium|Regular|Light|Heavy|SemiBold|ExtraBold)?)/g;
        // Prefer known CoolTypeFont payloads: "(xxFontName)" after CoolTypeFont
        let cool = /CoolTypeFont[\s\S]{0,40}\(([^\x00-\x1f]{3,80})\)/g;
        let m;
        while ((m = cool.exec(ascii)) !== null) {
            let n = m[1].replace(/[^\x20-\x7e]/g, '').trim();
            if (n && names.indexOf(n) === -1 && /[A-Za-z]/.test(n)) {
                names.push(n);
            }
        }
        // Direct known brand-font tokens in the file
        let tokens = [
            'FuturaPT-Bold', 'FuturaPT-Heavy', 'FuturaPT-Demi', 'FuturaPT-Medium',
            'Futura-Bold', 'FuturaBold', 'Futura Std Bold', 'FuturaBT-Bold',
            'Montserrat-Bold', 'Montserrat-Black', 'Montserrat-ExtraBold',
        ];
        for (let i = 0; i < tokens.length; i++) {
            if (ascii.indexOf(tokens[i]) !== -1 && names.indexOf(tokens[i]) === -1) {
                names.push(tokens[i]);
            }
        }
    } catch (e) {
        console.error('dizqueTV channel-logo: PSD font scan failed', e.message || e);
    }
    return names;
}

/**
 * Resolve a font path/name for channel name text.
 * Prefer the same family as the PSD (Futura PT Bold in the bundled Plex template),
 * then close geometric sans matches available on the host.
 *
 * @returns {{ font: string, source: string }|null} font = IM -font value (path or name)
 */
function resolveLogoFont(templatePath) {
    let winFonts = process.env.WINDIR
        ? path.join(process.env.WINDIR, 'Fonts')
        : 'C:\\Windows\\Fonts';
    let localFonts = process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')
        : null;

    // Map PostScript / family names → possible filenames and ImageMagick font names
    let preference = [
        // Exact PSD font (Plex-Template.psd embeds FuturaPT-Bold)
        { keys: ['FuturaPT-Bold', 'FuturaPTBold', 'Futura PT Bold'], files: [
            'FuturaPT-Bold.otf', 'FuturaPT-Bold.ttf', 'FuturaPTBold.otf', 'FuturaPTBold.ttf',
            'Futura PT Bold.otf', 'Futura PT Bold.ttf',
        ], imNames: ['FuturaPT-Bold', 'Futura-PT-Bold'] },
        { keys: ['FuturaPT-Heavy', 'FuturaPT-Demi', 'FuturaPT-Medium'], files: [
            'FuturaPT-Heavy.otf', 'FuturaPT-Demi.otf', 'FuturaPT-Medium.otf',
            'FuturaPT-Heavy.ttf', 'FuturaPT-Demi.ttf', 'FuturaPT-Medium.ttf',
        ], imNames: ['FuturaPT-Heavy', 'FuturaPT-Demi', 'FuturaPT-Medium'] },
        { keys: ['Futura-Bold', 'FuturaBold', 'Futura'], files: [
            'Futura Bold.ttf', 'Futura-Bold.ttf', 'FuturaBold.ttf', 'futura bold.ttf',
            'Futura.ttc', 'Futura.ttf',
        ], imNames: ['Futura-Bold', 'Futura'] },
        // Geometric sans close to Futura (often present; good Plex-like look)
        { keys: ['Montserrat-Black', 'Montserrat Black'], files: [
            'Montserrat-Black.ttf', 'MontserratBlack.ttf',
        ], imNames: ['Montserrat-Black'] },
        { keys: ['Montserrat-ExtraBold', 'Montserrat ExtraBold'], files: [
            'Montserrat-ExtraBold.ttf', 'MontserratExtraBold.ttf',
        ], imNames: ['Montserrat-ExtraBold'] },
        { keys: ['Montserrat-Bold', 'Montserrat Bold'], files: [
            'Montserrat-Bold.ttf', 'MontserratBold.ttf',
        ], imNames: ['Montserrat-Bold', 'Montserrat'] },
        { keys: ['Bahnschrift'], files: ['bahnschrift.ttf', 'Bahnschrift.ttf'], imNames: ['Bahnschrift'] },
        { keys: ['Segoe-UI-Black', 'Segoe UI Black'], files: [
            'seguibl.ttf', 'SegoeUI-Black.ttf',
        ], imNames: ['Segoe-UI-Black'] },
        { keys: ['Arial-Bold', 'Arial Bold'], files: ['arialbd.ttf', 'Arial Bold.ttf'], imNames: ['Arial-Bold'] },
        { keys: ['Impact'], files: ['impact.ttf', 'Impact.ttf'], imNames: ['Impact'] },
    ];

    // Promote fonts actually referenced in the PSD to the front of the search
    let psdFonts = extractFontNamesFromPsd(templatePath);
    if (psdFonts.length) {
        console.log('dizqueTV channel-logo: PSD references fonts: ' + psdFonts.join(', '));
        // Sort preference so PSD-named fonts try first
        preference.sort(function (a, b) {
            let sa = 0, sb = 0;
            for (let i = 0; i < psdFonts.length; i++) {
                let pf = String(psdFonts[i]).toLowerCase().replace(/[\s_-]/g, '');
                for (let k = 0; k < a.keys.length; k++) {
                    if (String(a.keys[k]).toLowerCase().replace(/[\s_-]/g, '').indexOf(pf) !== -1
                        || pf.indexOf(String(a.keys[k]).toLowerCase().replace(/[\s_-]/g, '')) !== -1) {
                        sa = 1;
                    }
                }
                for (let k = 0; k < b.keys.length; k++) {
                    if (String(b.keys[k]).toLowerCase().replace(/[\s_-]/g, '').indexOf(pf) !== -1
                        || pf.indexOf(String(b.keys[k]).toLowerCase().replace(/[\s_-]/g, '')) !== -1) {
                        sb = 1;
                    }
                }
            }
            return sb - sa;
        });
    }

    let searchDirs = [
        process.env.DATABASE ? path.join(process.env.DATABASE, 'fonts') : null,
        process.env.DATABASE || null,
        path.join(projectRoot(), 'resources', 'fonts'),
        path.join(projectRoot(), 'resources'),
        localFonts,
        winFonts,
    ].filter(Boolean);

    function fileExists(dir, name) {
        let p = path.join(dir, name);
        return fs.existsSync(p) ? p : null;
    }

    for (let i = 0; i < preference.length; i++) {
        let pref = preference[i];
        // 1) File on disk
        for (let d = 0; d < searchDirs.length; d++) {
            for (let f = 0; f < pref.files.length; f++) {
                let hit = fileExists(searchDirs[d], pref.files[f]);
                if (hit) {
                    return { font: imPath(hit), source: hit + ' (file)' };
                }
            }
        }
        // 2) ImageMagick registered font name
        for (let n = 0; n < pref.imNames.length; n++) {
            let test = magickRun([
                '-size', '10x10', 'xc:none',
                '-font', pref.imNames[n],
                '-pointsize', '12',
                'label:A',
                'null:',
            ], 5000);
            if (test.ok) {
                return { font: pref.imNames[n], source: 'ImageMagick:' + pref.imNames[n] };
            }
        }
    }

    // Last resort: bundled dizqueTV font
    let fallbacks = [
        process.env.DATABASE ? path.join(process.env.DATABASE, 'font.ttf') : null,
        path.join(projectRoot(), 'resources', 'font.ttf'),
    ].filter(Boolean);
    for (let i = 0; i < fallbacks.length; i++) {
        if (fs.existsSync(fallbacks[i])) {
            return { font: imPath(fallbacks[i]), source: fallbacks[i] + ' (fallback)' };
        }
    }
    return null;
}

/** @deprecated use resolveLogoFont — kept for callers expecting a path/name string */
function resolveFontPath(templatePath) {
    let r = resolveLogoFont(templatePath);
    return r ? r.font : null;
}

function measureTextWidth(fontPath, pointSize, text) {
    let args = ['-fill', 'white', '-weight', 'Bold', '-pointsize', String(pointSize)];
    if (fontPath) {
        args.push('-font', fontPath);
    }
    // quote-safe: use caption via stdin is hard; escape label specials
    let safe = String(text).replace(/\\/g, '\\\\').replace(/%/g, '%%');
    args.push('label:' + safe, '-format', '%w', 'info:');
    let r = magickRun(args, 15000);
    if (!r.ok) {
        return null;
    }
    let w = parseInt(String(r.stdout).trim(), 10);
    return isNaN(w) ? null : w;
}

function fitPointSize(fontPath, text, maxWidth, maxSize, minSize) {
    let hi = maxSize || 100;
    let lo = minSize || 28;
    let best = lo;
    while (lo <= hi) {
        let mid = Math.floor((lo + hi) / 2);
        let w = measureTextWidth(fontPath, mid, text);
        if (w == null) {
            return Math.min(64, maxSize || 64);
        }
        if (w <= maxWidth) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

function cacheKey(templatePath, channelName, channelNumber) {
    let h = crypto.createHash('sha1');
    h.update(GENERATOR_VERSION);
    h.update('|');
    h.update(String(templatePath));
    h.update('|');
    h.update(String(channelName));
    h.update('|');
    h.update(String(channelNumber == null ? '' : channelNumber));
    try {
        let st = fs.statSync(templatePath);
        h.update('|');
        h.update(String(st.mtimeMs || st.mtime));
        h.update('|');
        h.update(String(st.size));
    } catch (e) { /* ignore */ }
    return h.digest('hex').slice(0, 16);
}

/**
 * Extract a single PSD layer to a transparent PNG file (no paren/geometry tricks).
 */
function extractLayerPng(templatePath, layerIndex, destPng) {
    // -background none keeps transparency; write PNG32
    let args = [
        imPath(templatePath) + '[' + layerIndex + ']',
        '-background', 'none',
        '-alpha', 'set',
        'PNG32:' + imPath(destPng),
    ];
    let r = magickRun(args, 30000);
    if (!r.ok || !fs.existsSync(destPng)) {
        return { ok: false, error: r.error || 'extract layer failed' };
    }
    return { ok: true };
}

/**
 * Generate transparent PNG: PSD PLEX art + channel name below it (barely smaller than PLEX).
 * Stable path per channel: /cache/channel-logos/ch{N}-logo.png
 */
function generateChannelLogo(opts) {
    opts = opts || {};
    ensureAllTemplatesDeployed();

    let picked = pickTemplateForChannelName({
        channelName: opts.channelName,
        templatePath: opts.templatePath,
        templateTwoPath: opts.templateTwoPath,
    });
    let templatePath = picked.path;
    if (!templatePath) {
        console.error('dizqueTV channel-logo: no template PSD available');
        return null;
    }
    console.log(
        'dizqueTV channel-logo: words=' + picked.wordCount +
        ' → template=' + picked.filename +
        (picked.multiLine ? ' (multi-line)' : ' (single-line)')
    );

    if (!findMagick()) {
        console.error(
            'dizqueTV channel-logo: ImageMagick `magick` not found on PATH. ' +
            'Install ImageMagick 7+ to enable dynamic channel logos.'
        );
        return null;
    }

    let name = sanitizeChannelName(opts.channelName);
    let lines = splitNameIntoLines(name, picked.multiLine);
    let chNum = opts.channelNumber != null ? String(opts.channelNumber) : 'x';
    // Stable filename so the channel.icon field stays predictable after Update
    let outName = 'ch' + chNum + '-logo.png';
    let outPath = path.join(cacheDir(), outName);
    let urlPath = '/cache/channel-logos/' + outName;

    if (!opts.force && fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
        return { path: outPath, urlPath: urlPath };
    }

    let meta = inspectTemplate(templatePath, true);
    let fontResolved = resolveLogoFont(templatePath);
    let fontPath = fontResolved ? fontResolved.font : null;
    if (fontResolved) {
        console.log('dizqueTV channel-logo: using font ' + fontResolved.source);
    } else {
        console.log('dizqueTV channel-logo: WARNING no Futura/geometric font found; ImageMagick default will be used');
    }
    let wd = workDir();
    let stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // --- Step 1: extract each PLEX branding layer to PNG ---
    let extracted = [];
    let plexBottom = 0;
    let plexMaxH = 0;
    for (let i = 0; i < meta.plexLayers.length; i++) {
        let L = meta.plexLayers[i];
        let layerPng = path.join(wd, 'plex-layer-' + L.index + '-' + stamp + '.png');
        let ex = extractLayerPng(templatePath, L.index, layerPng);
        if (!ex.ok) {
            console.error(
                'dizqueTV channel-logo: failed to extract PSD layer ' + L.index +
                ' ("' + L.label + '"): ' + (ex.error || '')
            );
            continue;
        }
        // Measure actual pixel bounds of the branding art for font sizing
        let trimInfo = magickRun([
            imPath(layerPng), '-trim', '+repage', '-format', '%w %h', 'info:',
        ], 10000);
        let artH = L.h;
        if (trimInfo.ok) {
            let th = parseInt(String(trimInfo.stdout).trim().split(/\s+/)[1], 10);
            if (!isNaN(th) && th > 0) {
                artH = th;
            }
        }
        extracted.push({ file: layerPng, x: L.x, y: L.y, w: L.w, h: L.h, label: L.label, artH: artH });
        plexBottom = Math.max(plexBottom, (L.y || 0) + (L.h || 0));
        plexMaxH = Math.max(plexMaxH, artH);
        console.log(
            'dizqueTV channel-logo: extracted PSD layer ' + L.index +
            ' "' + L.label + '" ' + L.w + 'x' + L.h + ' artH≈' + artH + ' @' + L.x + ',' + L.y
        );
    }

    if (extracted.length === 0) {
        console.error('dizqueTV channel-logo: no PLEX branding layers could be extracted from PSD');
        return null;
    }

    // Target size: barely smaller than PLEX letter height
    let plexLetterH = plexMaxH > 0 ? plexMaxH : 360;
    let targetPointSize = Math.max(48, Math.round(plexLetterH * 0.92));
    // Multi-line: use sample text-layer height when present (Template-Two)
    if (picked.multiLine && meta.textBoxes && meta.textBoxes.length >= 2) {
        let layerH = Math.min.apply(null, meta.textBoxes.map(function (b) { return b.h || 120; }));
        // Barely smaller than PLEX, but also fit the sample text row height
        targetPointSize = Math.max(48, Math.min(
            Math.round(plexLetterH * 0.92),
            Math.round(layerH * 0.92)
        ));
    }
    let maxTextW = Math.max(200, Math.round(meta.canvasW * 0.92));
    let pointSize = fitPointSize(
        fontPath,
        lines.reduce(function (a, b) { return a.length >= b.length ? a : b; }, ''),
        maxTextW,
        targetPointSize,
        Math.round(targetPointSize * 0.55)
    );
    let minNearPlex = Math.round(Math.min(plexLetterH, targetPointSize / 0.92) * 0.85);
    if (pointSize < minNearPlex) {
        let longest = lines.reduce(function (a, b) { return a.length >= b.length ? a : b; }, '');
        let wAtMin = measureTextWidth(fontPath, minNearPlex, longest);
        if (wAtMin != null && wAtMin <= maxTextW) {
            pointSize = minNearPlex;
        }
    }

    // Line boxes for annotate
    let lineBoxes = [];
    if (picked.multiLine && lines.length >= 2 && meta.textBoxes && meta.textBoxes.length >= 2) {
        // Use PSD sample text layer positions (top line then bottom line)
        for (let li = 0; li < lines.length; li++) {
            let box = meta.textBoxes[Math.min(li, meta.textBoxes.length - 1)];
            lineBoxes.push({
                text: lines[li],
                x: 40,
                y: box.y,
                w: meta.canvasW - 80,
                h: box.h,
            });
        }
    } else {
        let gap = Math.max(12, Math.round(plexLetterH * 0.06));
        lineBoxes.push({
            text: lines.join(' '),
            x: 40,
            y: plexBottom + gap,
            w: meta.canvasW - 80,
            h: Math.round(pointSize * 1.25),
        });
    }

    let lastBox = lineBoxes[lineBoxes.length - 1];
    let canvasW = meta.canvasW;
    let canvasH = Math.max(
        meta.canvasH,
        lastBox.y + Math.max(lastBox.h, Math.round(pointSize * 1.3)) + 40
    );
    console.log(
        'dizqueTV channel-logo: PLEX artH≈' + plexLetterH +
        ' → name pointsize=' + pointSize + ' lines=' + JSON.stringify(lines) +
        ' canvasH=' + canvasH
    );

    // --- Step 2: transparent canvas ---
    let canvasPng = path.join(wd, 'canvas-' + stamp + '.png');
    let cArgs = [
        '-size', canvasW + 'x' + canvasH,
        'xc:none',
        '-alpha', 'set',
        'PNG32:' + imPath(canvasPng),
    ];
    let cRes = magickRun(cArgs, 15000);
    if (!cRes.ok || !fs.existsSync(canvasPng)) {
        console.error('dizqueTV channel-logo: canvas create failed', cRes.error);
        return null;
    }

    // --- Step 3: composite PLEX layers ---
    let composed = canvasPng;
    for (let i = 0; i < extracted.length; i++) {
        let L = extracted[i];
        let next = path.join(wd, 'comp-' + i + '-' + stamp + '.png');
        let geo =
            (L.x >= 0 ? '+' + L.x : String(L.x)) +
            (L.y >= 0 ? '+' + L.y : String(L.y));
        let args = [
            imPath(composed),
            imPath(L.file),
            '-geometry', geo,
            '-compose', 'over',
            '-composite',
            'PNG32:' + imPath(next),
        ];
        let r = magickRun(args, 30000);
        if (!r.ok || !fs.existsSync(next)) {
            console.error('dizqueTV channel-logo: composite failed for ' + L.label, r.error);
            continue;
        }
        composed = next;
    }

    // --- Step 4: draw channel name line(s) BELOW PLEX (centered, ALL CAPS BOLD) ---
    let withText = composed;
    for (let li = 0; li < lineBoxes.length; li++) {
        let lb = lineBoxes[li];
        let lineText = lb.text;
        let linePs = fitPointSize(fontPath, lineText, maxTextW, pointSize, Math.round(pointSize * 0.55));
        // Keep multi-line sizes consistent when possible
        if (linePs > pointSize * 0.9) {
            linePs = pointSize;
        }
        let tw = measureTextWidth(fontPath, linePs, lineText);
        let textX = tw != null
            ? Math.max(0, Math.round((canvasW - tw) / 2))
            : 40;
        let textY = Math.max(0, Math.round(lb.y + Math.max(0, (lb.h - linePs) / 2)));
        let nextNamed = path.join(wd, 'named-' + li + '-' + stamp + '.png');
        let tArgs = [imPath(withText)];
        if (fontPath) {
            tArgs.push('-font', fontPath);
        }
        tArgs.push(
            '-fill', 'white',
            '-gravity', 'NorthWest',
            '-weight', 'Bold',
            '-pointsize', String(linePs),
            '-annotate', '+' + textX + '+' + textY, escapeForMagickAnnotate(lineText),
            'PNG32:' + imPath(nextNamed)
        );
        let tRes = magickRun(tArgs, 30000);
        if (!tRes.ok || !fs.existsSync(nextNamed)) {
            console.error('dizqueTV channel-logo: annotate line failed', lineText, tRes.error);
        } else {
            withText = nextNamed;
            console.log(
                'dizqueTV channel-logo: line ' + (li + 1) + ' "' + lineText +
                '" at +' + textX + '+' + textY + ' pt=' + linePs
            );
        }
    }

    // --- Step 5: trim transparent margin ---
    let finalTmp = path.join(wd, 'final-' + stamp + '.png');
    let trimArgs = [
        imPath(withText),
        '-trim',
        '+repage',
        '-bordercolor', 'none',
        '-border', '20',
        'PNG32:' + imPath(finalTmp),
    ];
    let trimRes = magickRun(trimArgs, 15000);
    let sourceFinal = (trimRes.ok && fs.existsSync(finalTmp)) ? finalTmp : withText;

    // --- Step 6: write stable output path ---
    try {
        if (fs.existsSync(outPath)) {
            fs.unlinkSync(outPath);
        }
        fs.copyFileSync(sourceFinal, outPath);
    } catch (e) {
        console.error('dizqueTV channel-logo: failed to write output', e.message || e);
        return null;
    }

    try {
        let files = fs.readdirSync(wd);
        for (let i = 0; i < files.length; i++) {
            if (files[i].indexOf(stamp) !== -1) {
                try { fs.unlinkSync(path.join(wd, files[i])); } catch (e2) { /* ignore */ }
            }
        }
    } catch (e) { /* ignore */ }

    let sz = 0;
    try { sz = fs.statSync(outPath).size; } catch (e) { /* ignore */ }
    console.log(
        'dizqueTV channel-logo: GENERATED from PSD "' + name + '" → ' + outPath +
        ' (' + sz + ' bytes) url=' + urlPath
    );

    if (sz < 500) {
        console.error('dizqueTV channel-logo: output suspiciously small — PSD composite may have failed');
    }

    return { path: outPath, urlPath: urlPath };
}

/**
 * True if the icon path is empty, default stock, or a previously generated dynamic logo
 * (so we may regenerate on channel Update).
 */
function shouldGenerateForIcon(icon) {
    if (icon === undefined || icon === null || String(icon).trim() === '') {
        return true;
    }
    let s = String(icon).trim();
    if (/\/images\/dizquetv\.png/i.test(s)) {
        return true;
    }
    if (/\/cache\/channel-logos\//i.test(s)) {
        return true;
    }
    return false;
}

/**
 * On channel save: if dynamic logos enabled and icon is empty/default/generated,
 * render PSD → PNG and set channel.icon (and watermark when empty).
 *
 * @param {object} channel - mutable channel object
 * @param {object} ffmpegSettings
 * @returns {object} channel
 */
function applyDynamicLogoOnChannelSave(channel, ffmpegSettings) {
    if (!channel || !ffmpegSettings || ffmpegSettings.enableDynamicChannelLogos !== true) {
        return channel;
    }
    if (!shouldGenerateForIcon(channel.icon)) {
        // User supplied a custom icon — leave it; still fill watermark if empty
        if (
            channel.watermark
            && channel.watermark.enabled === true
            && shouldGenerateForIcon(channel.watermark.url)
            && channel.icon
        ) {
            // Prefer using the custom channel icon for watermark when watermark url empty
            if (!channel.watermark.url || String(channel.watermark.url).trim() === '') {
                channel.watermark.url = channel.icon;
            }
        }
        return channel;
    }

    let generated = generateChannelLogo({
        channelName: channel.name || ('Channel ' + channel.number),
        channelNumber: channel.number,
        templatePath: ffmpegSettings.channelLogoTemplatePath || '',
        templateTwoPath: ffmpegSettings.channelLogoTemplateTwoPath || '',
        force: true,
    });
    if (!generated || !generated.urlPath) {
        console.error(
            'dizqueTV channel-logo: failed to generate on save for ch' + channel.number
        );
        return channel;
    }

    // Cache-bust query so the channel settings preview reloads after Update
    let iconUrl = generated.urlPath + '?v=' + Date.now();
    channel.icon = iconUrl;
    console.log(
        'dizqueTV channel-logo: set channel.icon for ch' + channel.number + ' → ' + iconUrl
    );

    // Watermark: if empty / default / old dynamic, point at the same logo
    if (!channel.watermark || typeof channel.watermark !== 'object') {
        channel.watermark = {
            enabled: false,
            url: '',
            width: 15,
            verticalMargin: 1,
            horizontalMargin: 1,
            duration: 0,
            position: 'bottom-right',
            fixedSize: false,
            animated: false,
        };
    }
    if (shouldGenerateForIcon(channel.watermark.url) || !channel.watermark.url) {
        // Leave url empty so getWatermark falls through to channel.icon,
        // OR set explicitly so overlay always has the path
        channel.watermark.url = iconUrl;
    }

    return channel;
}

/**
 * Path FFmpeg can open reliably on Windows (forward slashes).
 */
function toFfmpegInputPath(absPath) {
    return path.resolve(absPath).replace(/\\/g, '/');
}

function toHttpUrl(urlPath) {
    let port = process.env.PORT || 8000;
    if (!urlPath) {
        return null;
    }
    if (/^https?:\/\//i.test(urlPath)) {
        return urlPath;
    }
    if (urlPath.charAt(0) !== '/') {
        urlPath = '/' + urlPath;
    }
    return 'http://127.0.0.1:' + port + urlPath;
}

/**
 * Resolve a dynamic logo for a channel when settings allow.
 * Returns a filesystem path FFmpeg can read (preferred) via HTTP URL for consistency
 * with other watermark assets, falling back to absolute path.
 *
 * @returns {string|null}
 */
function resolveDynamicLogoUrl(ffmpegSettings, channel) {
    if (!ffmpegSettings || ffmpegSettings.enableDynamicChannelLogos !== true) {
        return null;
    }
    if (!channel) {
        return null;
    }
    let name = channel.name || ('Channel ' + (channel.number != null ? channel.number : ''));
    let generated = generateChannelLogo({
        channelName: name,
        channelNumber: channel.number,
        templatePath: ffmpegSettings.channelLogoTemplatePath || '',
        templateTwoPath: ffmpegSettings.channelLogoTemplateTwoPath || '',
        force: false,
    });
    if (!generated) {
        return null;
    }
    // Prefer absolute file path so FFmpeg does not depend on HTTP serving
    if (generated.path && fs.existsSync(generated.path)) {
        return toFfmpegInputPath(generated.path);
    }
    return toHttpUrl(generated.urlPath);
}

function isImagePathEmpty(url) {
    return (typeof url === 'undefined' || url === null || String(url).trim() === '');
}

module.exports = {
    generateChannelLogo,
    resolveDynamicLogoUrl,
    applyDynamicLogoOnChannelSave,
    shouldGenerateForIcon,
    resolveTemplatePath,
    pickTemplateForChannelName,
    countChannelNameWords,
    defaultTemplatePath,
    ensureTemplateDeployed,
    ensureAllTemplatesDeployed,
    isImagePathEmpty,
    cacheDir,
    findMagick,
    inspectTemplate,
    TEMPLATE_ONE_FILENAME,
    TEMPLATE_TWO_FILENAME,
};
