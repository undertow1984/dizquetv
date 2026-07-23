/**
 * Export / import dizqueTV configuration as a zip of config/ + images/.
 * Import backs up the current config/ + images/ into backup/backup{timestamp}.zip first.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const archiver = require('archiver');
const unzipper = require('unzipper');
const dbPaths = require('../database-paths');
const constants = require('../constants');

function timestampSlug() {
    let d = new Date();
    let pad = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        '-' +
        pad(d.getHours()) +
        pad(d.getMinutes()) +
        pad(d.getSeconds())
    );
}

/**
 * Zip the given absolute directory into the archive under `zipRootName/`.
 */
function appendDirectory(archive, absDir, zipRootName) {
    if (!fs.existsSync(absDir)) {
        return;
    }
    archive.directory(absDir, zipRootName);
}

/**
 * Create a zip containing config/ and images/ under the archive root.
 * @param {string} outPath absolute path for the .zip file
 * @returns {Promise<{ path: string, bytes: number }>}
 */
function createConfigImagesZip(outPath) {
    return new Promise((resolve, reject) => {
        dbPaths.ensureDir(path.dirname(outPath));
        let output = fs.createWriteStream(outPath);
        let archive = archiver('zip', { zlib: { level: 6 } });

        output.on('close', () => {
            resolve({ path: outPath, bytes: archive.pointer() });
        });
        output.on('error', reject);
        archive.on('error', reject);
        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                console.warn('config-transfer zip warning', err);
            } else {
                reject(err);
            }
        });

        archive.pipe(output);

        // Manifest for humans / future validation
        let manifest = {
            type: 'dizquetv-config-export',
            version: 1,
            dizquetv: constants.VERSION_NAME || '',
            createdAt: new Date().toISOString(),
            includes: ['config', 'images'],
        };
        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

        appendDirectory(archive, dbPaths.configDir(), 'config');
        appendDirectory(archive, dbPaths.imagesDir(), 'images');

        archive.finalize();
    });
}

/**
 * Export current config + images as a zip (stream-friendly path on disk).
 * @returns {Promise<{ path: string, filename: string, bytes: number }>}
 */
async function exportConfigZip() {
    let filename = 'dizquetv-config-' + timestampSlug() + '.zip';
    let outPath = path.join(os.tmpdir(), filename);
    let result = await createConfigImagesZip(outPath);
    return {
        path: result.path,
        filename: filename,
        bytes: result.bytes,
    };
}

/**
 * Backup current config + images into DATABASE/backup/backup{timestamp}.zip
 * @returns {Promise<{ path: string, filename: string, bytes: number }>}
 */
async function backupCurrentConfig() {
    dbPaths.ensureDir(dbPaths.backupDir());
    let filename = 'backup' + timestampSlug() + '.zip';
    let outPath = path.join(dbPaths.backupDir(), filename);
    let result = await createConfigImagesZip(outPath);
    return {
        path: result.path,
        filename: filename,
        bytes: result.bytes,
    };
}

/**
 * Remove everything inside a directory but keep the directory itself.
 */
function emptyDirectory(dir) {
    if (!fs.existsSync(dir)) {
        dbPaths.ensureDir(dir);
        return;
    }
    let entries = fs.readdirSync(dir);
    for (let i = 0; i < entries.length; i++) {
        let full = path.join(dir, entries[i]);
        // Use recursive rm if available (Node 14.14+)
        fs.rmSync(full, { recursive: true, force: true });
    }
}

/**
 * Resolve where config/ and images/ live inside an extracted zip tree.
 * Supports archives with top-level config/ + images/, or a single root folder containing them.
 */
function findConfigAndImagesRoots(extractRoot) {
    let directConfig = path.join(extractRoot, 'config');
    let directImages = path.join(extractRoot, 'images');
    if (fs.existsSync(directConfig) || fs.existsSync(directImages)) {
        return { config: directConfig, images: directImages };
    }
    let entries = fs.readdirSync(extractRoot);
    for (let i = 0; i < entries.length; i++) {
        let sub = path.join(extractRoot, entries[i]);
        if (!fs.statSync(sub).isDirectory()) {
            continue;
        }
        let c = path.join(sub, 'config');
        let img = path.join(sub, 'images');
        if (fs.existsSync(c) || fs.existsSync(img)) {
            return { config: c, images: img };
        }
    }
    return null;
}

function copyDirOverwrite(src, dest) {
    if (!fs.existsSync(src)) {
        return;
    }
    dbPaths.ensureDir(dest);
    let entries = fs.readdirSync(src);
    for (let i = 0; i < entries.length; i++) {
        let from = path.join(src, entries[i]);
        let to = path.join(dest, entries[i]);
        let st = fs.statSync(from);
        if (st.isDirectory()) {
            copyDirOverwrite(from, to);
        } else {
            dbPaths.ensureDir(path.dirname(to));
            fs.copyFileSync(from, to);
        }
    }
}

/**
 * Import a config zip:
 *  1) Backup current config + images → backup/backup{timestamp}.zip
 *  2) Empty config/ and images/
 *  3) Extract zip and copy config/ + images/ over the live directories
 *
 * @param {string|Buffer} zipSource path to zip file or buffer
 * @returns {Promise<{ backupFilename: string, backupPath: string }>}
 */
async function importConfigZip(zipSource) {
    let tempZip = null;
    let extractRoot = null;
    try {
        // Normalize to a file path for unzipper
        if (Buffer.isBuffer(zipSource)) {
            tempZip = path.join(os.tmpdir(), 'dizquetv-import-' + timestampSlug() + '.zip');
            fs.writeFileSync(tempZip, zipSource);
            zipSource = tempZip;
        }
        if (!zipSource || !fs.existsSync(zipSource)) {
            throw new Error('Import zip file not found.');
        }

        // 1) Backup existing configuration first
        let backup = await backupCurrentConfig();

        // 2) Extract import archive to a temp folder
        extractRoot = path.join(os.tmpdir(), 'dizquetv-import-extract-' + timestampSlug());
        dbPaths.ensureDir(extractRoot);
        await fs.createReadStream(zipSource)
            .pipe(unzipper.Extract({ path: extractRoot }))
            .promise();

        let roots = findConfigAndImagesRoots(extractRoot);
        if (!roots) {
            throw new Error(
                'Invalid config archive: expected top-level config/ and/or images/ folders.'
            );
        }
        if (!fs.existsSync(roots.config) && !fs.existsSync(roots.images)) {
            throw new Error('Import archive did not contain config or images data.');
        }

        // 3) Replace live config + images (remove existing, then copy import)
        if (fs.existsSync(roots.config)) {
            emptyDirectory(dbPaths.configDir());
            copyDirOverwrite(roots.config, dbPaths.configDir());
        }
        if (fs.existsSync(roots.images)) {
            emptyDirectory(dbPaths.imagesDir());
            copyDirOverwrite(roots.images, dbPaths.imagesDir());
        }

        // Ensure layout dirs still exist after replace
        dbPaths.ensureDir(dbPaths.configDir());
        dbPaths.ensureDir(dbPaths.channelsDir());
        dbPaths.ensureDir(dbPaths.fillerDir());
        dbPaths.ensureDir(dbPaths.customShowsDir());
        dbPaths.ensureDir(dbPaths.imagesDir());
        dbPaths.ensureDir(dbPaths.channelLogosDir());
        dbPaths.ensureDir(dbPaths.imagesUploadsDir());

        return {
            backupFilename: backup.filename,
            backupPath: backup.path,
            backupBytes: backup.bytes,
        };
    } finally {
        // Cleanup temp files
        try {
            if (tempZip && fs.existsSync(tempZip)) {
                fs.unlinkSync(tempZip);
            }
        } catch (e) { /* ignore */ }
        try {
            if (extractRoot && fs.existsSync(extractRoot)) {
                fs.rmSync(extractRoot, { recursive: true, force: true });
            }
        } catch (e) { /* ignore */ }
    }
}

module.exports = {
    exportConfigZip,
    backupCurrentConfig,
    importConfigZip,
    timestampSlug,
};
