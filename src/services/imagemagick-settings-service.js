const logoGen = require('../channel-logo-generator');

const DEFAULTS = {
    // Empty = auto-detect `magick` / `magick.exe` on PATH
    magickPath: '',
};

class ImageMagickSettingsService {
    constructor(db) {
        this.db = db;
        this.ensureExists();
        this.applyToLogoGenerator();
    }

    ensureExists() {
        let rows = this.db['imagemagick-settings'].find();
        if (!rows || rows.length === 0) {
            this.db['imagemagick-settings'].save(Object.assign({}, DEFAULTS));
            return this.db['imagemagick-settings'].find()[0];
        }
        let doc = rows[0];
        let changed = false;
        if (typeof doc.magickPath === 'undefined' || doc.magickPath === null) {
            doc.magickPath = '';
            changed = true;
        }
        if (changed) {
            this.db['imagemagick-settings'].update({ _id: doc._id }, doc);
        }
        return doc;
    }

    getCurrentState() {
        return this.ensureExists();
    }

    get() {
        let doc = this.getCurrentState();
        return {
            _id: doc._id,
            magickPath: typeof doc.magickPath === 'string' ? doc.magickPath : '',
        };
    }

    applyToLogoGenerator() {
        let doc = this.getCurrentState();
        logoGen.configureMagick(doc.magickPath || '');
    }

    update(attempt) {
        let current = this.getCurrentState();
        let path = '';
        if (attempt && typeof attempt.magickPath === 'string') {
            path = attempt.magickPath.trim();
        } else if (attempt && attempt.magickPath != null) {
            path = String(attempt.magickPath).trim();
        }
        let next = {
            _id: current._id,
            magickPath: path,
        };
        this.db['imagemagick-settings'].update({ _id: current._id }, next);
        this.applyToLogoGenerator();
        return this.get();
    }

    reset() {
        let current = this.getCurrentState();
        let next = {
            _id: current._id,
            magickPath: DEFAULTS.magickPath,
        };
        this.db['imagemagick-settings'].update({ _id: current._id }, next);
        this.applyToLogoGenerator();
        return this.get();
    }

    /**
     * Probe current saved path (or optional override) with magick -version.
     * @param {{ magickPath?: string }} [body]
     */
    test(body) {
        body = body || {};
        let pathToTest;
        if (typeof body.magickPath === 'string') {
            pathToTest = body.magickPath.trim();
        } else {
            pathToTest = this.get().magickPath;
        }
        return logoGen.testMagickPath(pathToTest);
    }
}

module.exports = ImageMagickSettingsService;
