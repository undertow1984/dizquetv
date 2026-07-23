/**
 * Canonical paths under the DATABASE root (.dizquetv by default).
 *
 * Layout:
 *   config/          settings JSON (diskdb) + channels / filler / custom-shows
 *   cache/           play-cache, plex-cache, jellyfin-cache, images, subtitles
 *   images/          static assets, uploads, channel-logos, Plex logo PSD templates
 *   (root)           xmltv.xml, font.ttf, custom.css, client-id.json, db-version.json, vendor CSS
 */
const path = require('path');
const fs = require('fs');

/** diskdb collections stored under config/ */
const DISKDB_CONFIG_COLLECTIONS = [
    'channels',
    'plex-servers',
    'jellyfin-servers',
    'ffmpeg-settings',
    'plex-settings',
    'jellyfin-settings',
    'xmltv-settings',
    'hdhr-settings',
    'imagemagick-settings',
    'cache-images',
    'settings',
    'plex-library-settings',
    'jellyfin-library-settings',
    'external-list-settings',
    'tracked-lists',
];

/** diskdb collections stored at DATABASE root */
const DISKDB_ROOT_COLLECTIONS = [
    'db-version',
    'client-id',
];

/** All diskdb collection names (config + root) */
const DISKDB_COLLECTIONS = DISKDB_CONFIG_COLLECTIONS.concat(DISKDB_ROOT_COLLECTIONS);

/** Config JSON files that live under config/ */
const CONFIG_JSON_FILES = DISKDB_CONFIG_COLLECTIONS.map((c) => c + '.json');

/** Root JSON files (not under config/) */
const ROOT_JSON_FILES = DISKDB_ROOT_COLLECTIONS.map((c) => c + '.json');

/** Channel-logo PSD templates under images/ */
const PLEX_TEMPLATE_FILES = [
    'Plex-Template.psd',
    'Plex-Template-Two.psd',
];

function dbRoot() {
    return path.resolve(process.env.DATABASE || path.join('.', '.dizquetv'));
}

function configDir() {
    return path.join(dbRoot(), 'config');
}

function channelsDir() {
    return path.join(configDir(), 'channels');
}

function fillerDir() {
    return path.join(configDir(), 'filler');
}

function customShowsDir() {
    return path.join(configDir(), 'custom-shows');
}

function cacheDir() {
    return path.join(dbRoot(), 'cache');
}

function cacheImagesDir() {
    return path.join(cacheDir(), 'images');
}

function jellyfinCacheDir() {
    return path.join(cacheDir(), 'jellyfin-cache');
}

function plexCacheDir() {
    return path.join(cacheDir(), 'plex-cache');
}

function playCacheDir() {
    return path.join(cacheDir(), 'play-cache');
}

function subtitlesCacheDir() {
    return path.join(cacheDir(), 'subtitles');
}

function imagesDir() {
    return path.join(dbRoot(), 'images');
}

function channelLogosDir() {
    return path.join(imagesDir(), 'channel-logos');
}

function imagesUploadsDir() {
    return path.join(imagesDir(), 'uploads');
}

/** Zip backups of config + images created before import */
function backupDir() {
    return path.join(dbRoot(), 'backup');
}

function xmltvFile() {
    return path.join(dbRoot(), 'xmltv.xml');
}

function clientIdFile() {
    return path.join(dbRoot(), 'client-id.json');
}

function dbVersionFile() {
    return path.join(dbRoot(), 'db-version.json');
}

/** Absolute path for a Plex channel-logo PSD template under images/ */
function plexTemplateFile(filename) {
    return path.join(imagesDir(), filename);
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Move src → dest when src exists and dest does not.
 * Returns true if a move happened.
 */
function moveIfNeeded(src, dest) {
    if (!fs.existsSync(src)) {
        return false;
    }
    if (fs.existsSync(dest)) {
        console.log(
            'dizqueTV layout: skip move (destination exists): ' +
            path.basename(src) + ' → ' + dest
        );
        return false;
    }
    ensureDir(path.dirname(dest));
    try {
        fs.renameSync(src, dest);
        console.log('dizqueTV layout: moved ' + src + ' → ' + dest);
        return true;
    } catch (err) {
        // Cross-device rename can fail; fall back to copy+rm
        console.warn(
            'dizqueTV layout: rename failed, trying copy: ' + (err.message || err)
        );
        try {
            copyRecursiveSync(src, dest);
            removeRecursiveSync(src);
            console.log('dizqueTV layout: copied ' + src + ' → ' + dest);
            return true;
        } catch (err2) {
            console.error(
                'dizqueTV layout: failed to move ' + src + ' → ' + dest,
                err2.message || err2
            );
            return false;
        }
    }
}

function copyRecursiveSync(src, dest) {
    let st = fs.statSync(src);
    if (st.isDirectory()) {
        ensureDir(dest);
        let entries = fs.readdirSync(src);
        for (let i = 0; i < entries.length; i++) {
            copyRecursiveSync(
                path.join(src, entries[i]),
                path.join(dest, entries[i])
            );
        }
    } else {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
    }
}

function removeRecursiveSync(target) {
    if (!fs.existsSync(target)) {
        return;
    }
    let st = fs.statSync(target);
    if (st.isDirectory()) {
        let entries = fs.readdirSync(target);
        for (let i = 0; i < entries.length; i++) {
            removeRecursiveSync(path.join(target, entries[i]));
        }
        fs.rmdirSync(target);
    } else {
        fs.unlinkSync(target);
    }
}

/**
 * Connect diskdb with collections split across config/ and DATABASE root.
 * Collection file paths are fixed at load time, so root collections keep
 * pointing at the root even after path is restored to config/.
 *
 * @param {object} db diskdb module instance
 */
function connectDiskDb(db) {
    db.connect(configDir(), DISKDB_CONFIG_COLLECTIONS);
    // Attach root-level collections (client-id, db-version)
    let prevPath = db._db.path;
    db._db.path = dbRoot();
    db.loadCollections(DISKDB_ROOT_COLLECTIONS);
    db._db.path = prevPath;
    return db;
}

/**
 * Idempotent migration from the pre-reorg layout into config/ / cache/ / images/.
 * Must run before diskdb connect and before DAOs open folders.
 */
function migrateLayout() {
    let root = dbRoot();
    ensureDir(root);
    ensureDir(configDir());
    ensureDir(cacheDir());
    ensureDir(imagesDir());

    // --- config folders ---
    moveIfNeeded(path.join(root, 'channels'), channelsDir());
    moveIfNeeded(path.join(root, 'filler'), fillerDir());
    moveIfNeeded(path.join(root, 'custom-shows'), customShowsDir());

    // --- config JSON (diskdb collections under config/) ---
    for (let i = 0; i < CONFIG_JSON_FILES.length; i++) {
        let name = CONFIG_JSON_FILES[i];
        moveIfNeeded(path.join(root, name), path.join(configDir(), name));
    }

    // --- root JSON: move back out of config/ if a prior layout put them there ---
    for (let i = 0; i < ROOT_JSON_FILES.length; i++) {
        let name = ROOT_JSON_FILES[i];
        moveIfNeeded(path.join(configDir(), name), path.join(root, name));
    }

    // --- caches under cache/ ---
    moveIfNeeded(path.join(root, 'jellyfin-cache'), jellyfinCacheDir());
    moveIfNeeded(path.join(root, 'plex-cache'), plexCacheDir());
    moveIfNeeded(path.join(root, 'play-cache'), playCacheDir());

    // --- channel logos: cache/channel-logos → images/channel-logos ---
    moveIfNeeded(
        path.join(cacheDir(), 'channel-logos'),
        channelLogosDir()
    );
    // legacy root-level channel-logos if ever present
    moveIfNeeded(path.join(root, 'channel-logos'), channelLogosDir());

    // --- Plex logo PSD templates → images/ ---
    for (let i = 0; i < PLEX_TEMPLATE_FILES.length; i++) {
        let name = PLEX_TEMPLATE_FILES[i];
        moveIfNeeded(path.join(root, name), plexTemplateFile(name));
    }

    // Ensure required dirs exist for a fresh or partially migrated DB
    ensureDir(channelsDir());
    ensureDir(fillerDir());
    ensureDir(customShowsDir());
    ensureDir(cacheImagesDir());
    ensureDir(jellyfinCacheDir());
    ensureDir(plexCacheDir());
    ensureDir(playCacheDir());
    ensureDir(subtitlesCacheDir());
    ensureDir(channelLogosDir());
    ensureDir(imagesUploadsDir());
    ensureDir(backupDir());
}

/**
 * Resolve a local logo URL path (e.g. /images/channel-logos/ch1-logo.png)
 * to an absolute filesystem path when the file exists.
 * Supports legacy /cache/channel-logos/ URLs after the layout move.
 */
function resolveLocalLogoPath(urlPath) {
    if (!urlPath) {
        return null;
    }
    let pathOnly = String(urlPath).split('?')[0];
    let rel = null;
    if (pathOnly.indexOf('/images/channel-logos/') === 0) {
        rel = pathOnly.replace(/^\//, '');
    } else if (pathOnly.indexOf('/cache/channel-logos/') === 0) {
        // Legacy URL → new on-disk location
        rel = path.join(
            'images',
            'channel-logos',
            path.basename(pathOnly)
        );
    } else {
        return null;
    }
    let abs = path.join(dbRoot(), rel);
    if (fs.existsSync(abs)) {
        return abs;
    }
    return null;
}

module.exports = {
    DISKDB_COLLECTIONS,
    DISKDB_CONFIG_COLLECTIONS,
    DISKDB_ROOT_COLLECTIONS,
    CONFIG_JSON_FILES,
    ROOT_JSON_FILES,
    PLEX_TEMPLATE_FILES,
    dbRoot,
    configDir,
    channelsDir,
    fillerDir,
    customShowsDir,
    cacheDir,
    cacheImagesDir,
    jellyfinCacheDir,
    plexCacheDir,
    playCacheDir,
    subtitlesCacheDir,
    imagesDir,
    channelLogosDir,
    imagesUploadsDir,
    backupDir,
    xmltvFile,
    clientIdFile,
    dbVersionFile,
    plexTemplateFile,
    ensureDir,
    connectDiskDb,
    migrateLayout,
    resolveLocalLogoPath,
};
