/**
 * Local Plex library cache + full/incremental sync.
 *
 * Persists movies, shows, episodes, tracks, collections, and playlists under
 * DATABASE/cache/plex-cache. All UI/API reads are served from an in-memory map that is
 * loaded once at startup and rewritten whenever a sync or delete completes.
 *
 * Full sync: download everything for a library (or all enabled libraries).
 * Incremental: re-list keys, upsert changed items (by updatedAt), remove deletes.
 */
const fs = require('fs');
const path = require('path');
const Plex = require('../plex');

const PAGE_SIZE = 200;

class PlexLibraryCacheService {
    constructor(db) {
        this.db = db;
        const dbPaths = require('../database-paths');
        this.root = dbPaths.plexCacheDir();
        this._ensureDir(this.root);
        this._syncing = {}; // key -> true while sync in progress
        this._autoTimer = null;
        /**
         * In-memory cache: { [serverName]: { playlists: obj|null, libraries: { [sectionKey]: data } } }
         * Populated from disk on boot; updated after every sync/delete.
         */
        this._mem = {};
        this._loadMemoryFromDisk();
        this._bootAutoSchedule();
    }

    _ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    _safeName(s) {
        return String(s || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    }

    _serverDir(serverName) {
        let d = path.join(this.root, this._safeName(serverName));
        this._ensureDir(d);
        return d;
    }

    _libDir(serverName, sectionKey) {
        let d = path.join(this._serverDir(serverName), 'lib-' + this._safeName(sectionKey));
        this._ensureDir(d);
        return d;
    }

    _readJson(file, fallback) {
        try {
            if (!fs.existsSync(file)) {
                return fallback;
            }
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            console.error('plex-cache: read failed', file, e.message || e);
            return fallback;
        }
    }

    _writeJson(file, data) {
        let tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
    }

    // ---------- In-memory cache ----------

    _ensureMemServer(serverName) {
        let name = String(serverName || '');
        if (!this._mem[name]) {
            this._mem[name] = { playlists: null, libraries: {} };
        }
        return this._mem[name];
    }

    /**
     * Load entire plex-cache tree from disk into memory (boot / full reload).
     */
    _loadMemoryFromDisk() {
        this._mem = {};
        let loadedLibs = 0;
        let loadedPlaylists = 0;
        try {
            if (!fs.existsSync(this.root)) {
                return;
            }
            let serverDirs = fs.readdirSync(this.root);
            for (let s = 0; s < serverDirs.length; s++) {
                let serverFolder = serverDirs[s];
                let serverPath = path.join(this.root, serverFolder);
                let st;
                try {
                    st = fs.statSync(serverPath);
                } catch (e) {
                    continue;
                }
                if (!st.isDirectory()) continue;

                // Discover serverName from data files when possible
                let playlistsFile = path.join(serverPath, 'playlists.json');
                let playlists = this._readJson(playlistsFile, null);
                let serverName = (playlists && playlists.serverName) ? playlists.serverName : serverFolder;

                let entries = [];
                try {
                    entries = fs.readdirSync(serverPath);
                } catch (e) {
                    continue;
                }

                // Prefer serverName from first library data.json
                for (let i = 0; i < entries.length; i++) {
                    if (entries[i].indexOf('lib-') !== 0) continue;
                    let data = this._readJson(path.join(serverPath, entries[i], 'data.json'), null);
                    if (data && data.serverName) {
                        serverName = data.serverName;
                        break;
                    }
                }

                let mem = this._ensureMemServer(serverName);
                if (playlists) {
                    mem.playlists = playlists;
                    loadedPlaylists++;
                }
                for (let i = 0; i < entries.length; i++) {
                    if (entries[i].indexOf('lib-') !== 0) continue;
                    let data = this._readJson(path.join(serverPath, entries[i], 'data.json'), null);
                    if (!data || data.sectionKey == null) continue;
                    if (data.serverName) {
                        serverName = data.serverName;
                        mem = this._ensureMemServer(serverName);
                    }
                    mem.libraries[String(data.sectionKey)] = data;
                    loadedLibs++;
                }
            }
        } catch (e) {
            console.error('plex-cache: memory load failed', e.message || e);
        }
        console.log(
            'dizqueTV plex-cache: loaded ' + loadedLibs + ' library(ies) and ' +
            loadedPlaylists + ' playlist file(s) into memory'
        );
    }

    /** Persist library data to disk and refresh memory entry. */
    _saveLibraryData(serverName, sectionKey, data) {
        let libDir = this._libDir(serverName, sectionKey);
        this._writeJson(path.join(libDir, 'data.json'), data);
        let mem = this._ensureMemServer(serverName);
        mem.libraries[String(sectionKey)] = data;
    }

    /** Persist playlists to disk and refresh memory entry. */
    _savePlaylistsData(serverName, data) {
        let file = path.join(this._serverDir(serverName), 'playlists.json');
        this._writeJson(file, data);
        let mem = this._ensureMemServer(serverName);
        mem.playlists = data;
    }

    _removeLibraryFromMemory(serverName, sectionKey) {
        let mem = this._mem[String(serverName || '')];
        if (mem && mem.libraries) {
            delete mem.libraries[String(sectionKey)];
        }
    }

    _clearMemory() {
        this._mem = {};
    }

    /** List section keys currently held in memory for a server. */
    _memLibraryKeys(serverName) {
        let mem = this._mem[String(serverName || '')];
        if (!mem || !mem.libraries) return [];
        return Object.keys(mem.libraries);
    }

    getSettingsDoc() {
        let rows = this.db['plex-library-settings'].find();
        if (!rows || rows.length === 0) {
            let doc = {
                disabledLibraries: [],
                /** Libraries marked "Contains filler" — only these appear in Add Filler */
                fillerLibraries: [],
                /**
                 * Libraries with "Hide content" — excluded from programming UI everywhere,
                 * except Add Filler when also marked as filler.
                 */
                hiddenLibraries: [],
                autoSyncHours: 0,
                lastGlobalSyncAt: null,
                librarySync: {},
            };
            this.db['plex-library-settings'].save(doc);
            rows = this.db['plex-library-settings'].find();
        }
        let doc = rows[0];
        if (!Array.isArray(doc.disabledLibraries)) {
            doc.disabledLibraries = [];
        }
        if (!Array.isArray(doc.fillerLibraries)) {
            doc.fillerLibraries = [];
        }
        if (!Array.isArray(doc.hiddenLibraries)) {
            doc.hiddenLibraries = [];
        }
        if (typeof doc.autoSyncHours !== 'number' || isNaN(doc.autoSyncHours)) {
            doc.autoSyncHours = 0;
        }
        if (!doc.librarySync || typeof doc.librarySync !== 'object') {
            doc.librarySync = {};
        }
        if (typeof doc.lastGlobalSyncAt === 'undefined') {
            doc.lastGlobalSyncAt = null;
        }
        return doc;
    }

    saveSettingsDoc(doc, options) {
        options = options || {};
        let prevHours = null;
        try {
            let rows = this.db['plex-library-settings'].find();
            if (rows && rows[0]) {
                prevHours = rows[0].autoSyncHours;
            }
        } catch (e) { /* ignore */ }
        this.db['plex-library-settings'].update({ _id: doc._id }, doc);
        this._invalidateHiddenIndex();
        // Only reschedule auto-sync when the interval itself changes
        if (options.forceReschedule || prevHours !== doc.autoSyncHours) {
            this._bootAutoSchedule();
        }
        return doc;
    }

    libSyncKey(serverName, sectionKey) {
        return String(serverName) + '|' + String(sectionKey);
    }

    getSyncStatus() {
        let doc = this.getSettingsDoc();
        return {
            autoSyncHours: doc.autoSyncHours || 0,
            lastGlobalSyncAt: doc.lastGlobalSyncAt || null,
            librarySync: doc.librarySync || {},
            syncing: Object.keys(this._syncing).filter((k) => this._syncing[k]),
        };
    }

    updateAutoSyncHours(hours) {
        let doc = this.getSettingsDoc();
        let n = parseFloat(hours);
        if (isNaN(n) || n < 0) {
            n = 0;
        }
        if (n > 168) {
            n = 168; // cap 1 week
        }
        doc.autoSyncHours = n;
        this.saveSettingsDoc(doc, { forceReschedule: true });
        return this.getSyncStatus();
    }

    _bootAutoSchedule() {
        if (this._autoTimer) {
            clearInterval(this._autoTimer);
            this._autoTimer = null;
        }
        let doc = this.getSettingsDoc();
        let hours = doc.autoSyncHours || 0;
        if (hours <= 0) {
            return;
        }
        let ms = Math.max(1, hours) * 60 * 60 * 1000;
        console.log('dizqueTV plex-cache: auto-sync every ' + hours + ' hour(s)');
        this._autoTimer = setInterval(() => {
            this.syncAll({ reason: 'auto' }).catch((err) => {
                console.error('dizqueTV plex-cache: auto-sync failed', err.message || err);
            });
        }, ms);
        // Optional catch-up if overdue
        if (doc.lastGlobalSyncAt) {
            let age = Date.now() - Number(doc.lastGlobalSyncAt);
            if (age > ms) {
                setTimeout(() => {
                    this.syncAll({ reason: 'auto-catchup' }).catch(() => {});
                }, 15000);
            }
        }
    }

    _getServer(serverName) {
        let servers = this.db['plex-servers'].find();
        for (let i = 0; i < (servers || []).length; i++) {
            if (servers[i].name === serverName) {
                return servers[i];
            }
        }
        return null;
    }

    _isDisabled(serverName, sectionKey) {
        let doc = this.getSettingsDoc();
        let list = doc.disabledLibraries || [];
        for (let i = 0; i < list.length; i++) {
            if (list[i].serverName === serverName && String(list[i].sectionKey) === String(sectionKey)) {
                return true;
            }
        }
        return false;
    }

    _isHidden(serverName, sectionKey) {
        let list = this.getSettingsDoc().hiddenLibraries || [];
        for (let i = 0; i < list.length; i++) {
            if (list[i].serverName === serverName && String(list[i].sectionKey) === String(sectionKey)) {
                return true;
            }
        }
        return false;
    }

    _isFiller(serverName, sectionKey) {
        let list = this.getSettingsDoc().fillerLibraries || [];
        for (let i = 0; i < list.length; i++) {
            if (list[i].serverName === serverName && String(list[i].sectionKey) === String(sectionKey)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Index of item ids + section keys for libraries marked "Hide content".
     * Used to filter global playlists/collections that belong to those libraries.
     */
    _getHiddenContentIndex(serverName) {
        let name = String(serverName || '');
        if (!this._hiddenIndexCache) this._hiddenIndexCache = {};
        let cached = this._hiddenIndexCache[name];
        if (cached && cached.at && (Date.now() - cached.at) < 5000) {
            return cached;
        }
        let sectionKeys = {};
        let titles = {};
        let itemIds = {};
        let hiddenList = this.getSettingsDoc().hiddenLibraries || [];
        for (let i = 0; i < hiddenList.length; i++) {
            let h = hiddenList[i];
            if (!h || h.serverName !== serverName) continue;
            let sk = String(h.sectionKey);
            sectionKeys[sk] = true;
            if (h.title) titles[String(h.title).toLowerCase()] = true;
            let data = this.getCachedLibraryData(serverName, sk);
            if (!data) continue;
            if (data.title) titles[String(data.title).toLowerCase()] = true;
            let maps = [data.items, data.shows, data.seasons, data.episodes, data.tracks];
            for (let m = 0; m < maps.length; m++) {
                let map = maps[m];
                if (!map) continue;
                let keys = Object.keys(map);
                for (let k = 0; k < keys.length; k++) {
                    let it = map[keys[k]];
                    let id = it && (it.ratingKey != null ? it.ratingKey : keys[k]);
                    if (id != null && id !== '') itemIds[String(id)] = true;
                }
            }
        }
        let idx = { sectionKeys: sectionKeys, titles: titles, itemIds: itemIds, at: Date.now() };
        this._hiddenIndexCache[name] = idx;
        return idx;
    }

    _invalidateHiddenIndex(serverName) {
        if (!this._hiddenIndexCache) return;
        if (serverName) delete this._hiddenIndexCache[String(serverName)];
        else this._hiddenIndexCache = {};
    }

    /**
     * True when a playlist/collection should be omitted because it belongs to
     * a "Hide content" library (by section key, library title, or children).
     */
    _isListSourceHidden(serverName, item) {
        if (!item) return false;
        let idx = this._getHiddenContentIndex(serverName);
        if (!idx || !Object.keys(idx.sectionKeys).length) return false;

        let sk =
            item.sectionKey != null ? String(item.sectionKey)
            : (item.librarySectionKey != null ? String(item.librarySectionKey)
            : (item.librarySectionID != null ? String(item.librarySectionID) : null));
        if (sk != null && idx.sectionKeys[sk]) return true;

        let libTitle = item.libraryTitle || item.librarySectionTitle || '';
        if (libTitle && idx.titles[String(libTitle).toLowerCase()]) return true;

        let children = Array.isArray(item.children) ? item.children : null;
        if (!children || !children.length) return false;

        let inHidden = 0;
        let inOther = 0;
        for (let c = 0; c < children.length; c++) {
            let ch = children[c];
            if (!ch) continue;
            let csk =
                ch.librarySectionID != null ? String(ch.librarySectionID)
                : (ch.sectionKey != null ? String(ch.sectionKey)
                : (ch.librarySectionKey != null ? String(ch.librarySectionKey) : null));
            if (csk != null) {
                if (idx.sectionKeys[csk]) inHidden++;
                else inOther++;
                continue;
            }
            let id = ch.ratingKey != null ? String(ch.ratingKey) : '';
            if (id && idx.itemIds[id]) inHidden++;
            else if (id) inOther++;
        }
        // Hide when every mappable child is from a hidden library
        return inHidden > 0 && inOther === 0;
    }

    /**
     * Paginated GET of a Plex path, collecting all Metadata entries.
     * @param {function} [onPage] optional (fetched, total, label) => void
     */
    async _fetchAllMetadata(client, basePath, onPage) {
        let all = [];
        let start = 0;
        let total = Infinity;
        // Request guids + full metadata so Genre/Director/Role/Media/etc. are present when Plex provides them
        let enrich = 'includeGuids=1&includeMarkers=0&includePreferences=0';
        while (start < total) {
            let sep = basePath.indexOf('?') >= 0 ? '&' : '?';
            let url =
                basePath +
                sep +
                'X-Plex-Container-Start=' +
                start +
                '&X-Plex-Container-Size=' +
                PAGE_SIZE +
                '&' +
                enrich;
            let res = await client.Get(url);
            let page = res.Metadata || [];
            let totalSize = typeof res.totalSize !== 'undefined' ? parseInt(res.totalSize, 10) : null;
            if (totalSize != null && !isNaN(totalSize)) {
                total = totalSize;
            } else if (page.length < PAGE_SIZE) {
                total = start + page.length;
            } else {
                total = start + page.length + PAGE_SIZE; // keep going until short page
            }
            all = all.concat(page);
            start += page.length;
            if (typeof onPage === 'function') {
                try {
                    onPage(start, total === Infinity ? start : total);
                } catch (e) { /* ignore */ }
            }
            if (page.length === 0) {
                break;
            }
            // safety
            if (start > 500000) {
                break;
            }
        }
        return all;
    }

    _setLibProgress(key, patch) {
        try {
            let doc = this.getSettingsDoc();
            let cur = Object.assign({}, doc.librarySync[key] || {});
            Object.assign(cur, patch);
            doc.librarySync[key] = cur;
            this.saveSettingsDoc(doc);
        } catch (e) {
            console.error('plex-cache: progress update failed', e.message || e);
        }
    }

    /**
     * Extract string tags from Plex metadata arrays (Genre, Director, Role, …).
     * @param {any} arr
     * @returns {string[]}
     */
    _plexTags(arr) {
        if (!arr) {
            return [];
        }
        if (!Array.isArray(arr)) {
            if (typeof arr === 'string') {
                return arr ? [arr] : [];
            }
            let single = arr.tag || arr.Tag || arr.title || arr.name;
            return single ? [String(single)] : [];
        }
        let out = [];
        for (let i = 0; i < arr.length; i++) {
            let x = arr[i];
            if (x == null) continue;
            if (typeof x === 'string') {
                out.push(x);
            } else {
                let t = x.tag || x.Tag || x.title || x.name || x.displayTitle;
                if (t) out.push(String(t));
            }
        }
        return out;
    }

    /**
     * Compact filter-related fields for catalog list rows (no large payloads).
     */
    _filterFieldsFromProgram(p) {
        if (!p) return {};
        return {
            year: p.year != null ? p.year : null,
            date: p.date || null,
            genres: Array.isArray(p.genres) ? p.genres.slice() : [],
            contentRating: p.contentRating || p.rating || null,
            rating: p.rating || p.contentRating || null,
            studio: p.studio || null,
            network: p.network || null,
            country: p.country || null,
            countries: Array.isArray(p.countries) ? p.countries.slice() : [],
            actors: Array.isArray(p.actors) ? p.actors.slice(0, 40) : [],
            directors: Array.isArray(p.directors) ? p.directors.slice(0, 20) : [],
            writers: Array.isArray(p.writers) ? p.writers.slice(0, 20) : [],
            labels: Array.isArray(p.labels) ? p.labels.slice() : [],
            collections: Array.isArray(p.collections) ? p.collections.slice() : [],
            videoResolution: p.videoResolution || null,
            height: p.height != null ? p.height : null,
            width: p.width != null ? p.width : null,
            hdr: p.hdr === true,
            videoRange: p.videoRange || null,
            audioLanguage: p.audioLanguage || null,
            subtitleLanguage: p.subtitleLanguage || null,
            audioLanguages: Array.isArray(p.audioLanguages) ? p.audioLanguages.slice() : [],
            subtitleLanguages: Array.isArray(p.subtitleLanguages) ? p.subtitleLanguages.slice() : [],
            viewCount: p.viewCount != null ? p.viewCount : null,
            viewOffset: p.viewOffset != null ? p.viewOffset : null,
            libraryType: p.libraryType || null,
        };
    }

    /**
     * Aggregate filter fields from collection/playlist children for list-row filtering.
     */
    _aggregateFilterFields(children) {
        let genres = {};
        let ratings = {};
        let studios = {};
        let countries = {};
        let labels = {};
        let years = [];
        let hasHdr = false;
        let maxHeight = 0;
        let kids = children || [];
        for (let i = 0; i < kids.length; i++) {
            let c = kids[i];
            if (!c) continue;
            (c.genres || []).forEach((g) => { if (g) genres[String(g)] = true; });
            let r = c.contentRating || c.rating;
            if (r) ratings[String(r)] = true;
            if (c.studio) studios[String(c.studio)] = true;
            (c.countries || []).forEach((x) => { if (x) countries[String(x)] = true; });
            if (c.country) countries[String(c.country)] = true;
            (c.labels || []).forEach((x) => { if (x) labels[String(x)] = true; });
            if (c.year != null && !isNaN(Number(c.year))) years.push(Number(c.year));
            if (c.hdr) hasHdr = true;
            let h = Number(c.height) || 0;
            if (h > maxHeight) maxHeight = h;
        }
        let yearMin = years.length ? Math.min.apply(null, years) : null;
        let yearMax = years.length ? Math.max.apply(null, years) : null;
        return {
            genres: Object.keys(genres),
            contentRatings: Object.keys(ratings),
            studios: Object.keys(studios),
            countries: Object.keys(countries),
            labels: Object.keys(labels),
            year: yearMin != null && yearMin === yearMax ? yearMin : null,
            yearMin: yearMin,
            yearMax: yearMax,
            hdr: hasHdr,
            height: maxHeight || null,
            videoResolution: maxHeight >= 2000 ? '4k' : (maxHeight >= 1080 ? '1080' : (maxHeight >= 720 ? '720' : (maxHeight > 0 ? 'sd' : null))),
        };
    }

    /**
     * Convert Plex Metadata entry → dizqueTV program-like object (no nested expansion).
     * Stores filter-relevant metadata (genre, studio, people, media/resolution, watch state, …).
     */
    _metaToProgram(server, meta) {
        if (!meta || !meta.ratingKey) {
            return null;
        }
        let year = meta.year;
        let date = meta.originallyAvailableAt;
        if (typeof date === 'undefined' && typeof year !== 'undefined') {
            date = year + '-01-01';
        }
        let genres = this._plexTags(meta.Genre);
        let directors = this._plexTags(meta.Director);
        let writers = this._plexTags(meta.Writer);
        let producers = this._plexTags(meta.Producer);
        let actors = this._plexTags(meta.Role);
        let countries = this._plexTags(meta.Country);
        let labels = this._plexTags(meta.Label);
        let collections = this._plexTags(meta.Collection);
        let contentRating = meta.contentRating || null;

        let program = {
            title: meta.title,
            key: meta.key,
            ratingKey: String(meta.ratingKey),
            icon: meta.thumb
                ? server.uri + meta.thumb + '?X-Plex-Token=' + server.accessToken
                : '',
            type: meta.type,
            duration: meta.duration,
            durationStr: undefined,
            subtitle: meta.subtitle,
            summary: meta.summary,
            rating: contentRating,
            contentRating: contentRating,
            audienceRating: meta.audienceRating != null ? meta.audienceRating : null,
            date: date,
            year: year,
            studio: meta.studio || null,
            network: meta.studio || null, // TV often uses studio as network in Plex
            country: countries.length ? countries[0] : null,
            countries: countries,
            genres: genres,
            directors: directors,
            writers: writers,
            producers: producers,
            actors: actors,
            labels: labels,
            collections: collections,
            originalTitle: meta.originalTitle || null,
            contentRatingAge: meta.contentRatingAge != null ? meta.contentRatingAge : null,
            updatedAt: meta.updatedAt != null ? Number(meta.updatedAt) : null,
            addedAt: meta.addedAt != null ? Number(meta.addedAt) : null,
            viewCount: meta.viewCount != null ? Number(meta.viewCount) : 0,
            viewOffset: meta.viewOffset != null ? Number(meta.viewOffset) : 0,
            lastViewedAt: meta.lastViewedAt != null ? Number(meta.lastViewedAt) : null,
            serverKey: server.name,
            childCount: meta.childCount,
            leafCount: meta.leafCount,
            viewedLeafCount: meta.viewedLeafCount != null ? Number(meta.viewedLeafCount) : null,
            index: meta.index,
            parentIndex: meta.parentIndex,
            parentKey: meta.parentKey,
            parentTitle: meta.parentTitle,
            grandparentTitle: meta.grandparentTitle,
            grandparentThumb: meta.grandparentThumb,
            parentThumb: meta.parentThumb,
            librarySectionID: meta.librarySectionID,
            librarySectionTitle: meta.librarySectionTitle,
            libraryType: meta.librarySectionID != null ? meta.type : null,
            parentRatingKey: meta.parentRatingKey != null ? String(meta.parentRatingKey) : null,
            grandparentRatingKey: meta.grandparentRatingKey != null ? String(meta.grandparentRatingKey) : null,
            // media / tech (filled below)
            videoResolution: null,
            height: null,
            width: null,
            videoCodec: null,
            audioCodec: null,
            container: null,
            videoFrameRate: null,
            videoRange: null,
            hdr: false,
            audioLanguage: null,
            subtitleLanguage: null,
            audioLanguages: [],
            subtitleLanguages: [],
        };
        try {
            if (
                (meta.type === 'episode' || meta.type === 'movie' || meta.type === 'track') &&
                meta.Media &&
                meta.Media[0] &&
                meta.Media[0].Part &&
                meta.Media[0].Part[0]
            ) {
                program.plexFile = meta.Media[0].Part[0].key;
                program.file = meta.Media[0].Part[0].file;
            }
            if (meta.Media && meta.Media[0]) {
                let m0 = meta.Media[0];
                program.videoResolution = m0.videoResolution || null;
                program.height = m0.height != null ? Number(m0.height) : null;
                program.width = m0.width != null ? Number(m0.width) : null;
                program.videoCodec = m0.videoCodec || null;
                program.audioCodec = m0.audioCodec || null;
                program.container = m0.container || null;
                program.videoFrameRate = m0.videoFrameRate || null;
                program.videoRange = m0.videoDynamicRangeType || m0.videoRange || null;
                let audioLangs = [];
                let subLangs = [];
                let hdr = false;
                let parts = m0.Part || [];
                for (let pi = 0; pi < parts.length; pi++) {
                    let streams = parts[pi].Stream || [];
                    for (let si = 0; si < streams.length; si++) {
                        let st = streams[si];
                        if (!st) continue;
                        let stype = Number(st.streamType);
                        let lang = st.languageCode || st.language || st.displayTitle || '';
                        if (stype === 1) {
                            // video
                            let blob = [
                                st.displayTitle, st.extendedDisplayTitle, st.title,
                                st.DOVIPresent, st.hdr, m0.videoDynamicRangeType,
                            ].filter(Boolean).join(' ').toLowerCase();
                            if (
                                blob.indexOf('hdr') >= 0
                                || blob.indexOf('dolby vision') >= 0
                                || blob.indexOf('dovi') >= 0
                                || st.DOVIPresent === true
                                || st.DOVIPresent === 1
                            ) {
                                hdr = true;
                            }
                            if (!program.videoRange && st.colorTrc) {
                                program.videoRange = st.colorTrc;
                            }
                        } else if (stype === 2 && lang) {
                            audioLangs.push(String(lang));
                        } else if (stype === 3 && lang) {
                            subLangs.push(String(lang));
                        }
                    }
                }
                if (
                    program.videoRange
                    && String(program.videoRange).toLowerCase().indexOf('sdr') < 0
                ) {
                    let vr = String(program.videoRange).toLowerCase();
                    if (vr.indexOf('hdr') >= 0 || vr.indexOf('dolby') >= 0 || vr.indexOf('hlg') >= 0) {
                        hdr = true;
                    }
                }
                program.hdr = hdr;
                program.audioLanguages = audioLangs;
                program.subtitleLanguages = subLangs;
                program.audioLanguage = audioLangs.length ? audioLangs[0] : null;
                program.subtitleLanguage = subLangs.length ? subLangs[0] : null;
            }
        } catch (e) { /* ignore media parse */ }

        if (meta.type === 'episode') {
            program.showTitle = meta.grandparentTitle;
            program.episode = meta.index;
            program.season = meta.parentIndex;
            if (meta.grandparentThumb) {
                program.icon = server.uri + meta.grandparentThumb + '?X-Plex-Token=' + server.accessToken;
            }
            if (meta.thumb) {
                program.episodeIcon = server.uri + meta.thumb + '?X-Plex-Token=' + server.accessToken;
            }
            if (meta.parentThumb) {
                program.seasonIcon = server.uri + meta.parentThumb + '?X-Plex-Token=' + server.accessToken;
            }
            program.showIcon = program.icon;
        } else if (meta.type === 'movie') {
            program.showTitle = meta.title;
            program.episode = 1;
            program.season = 1;
        } else if (meta.type === 'track') {
            program.showTitle = meta.parentTitle || meta.title;
            program.episode = meta.index;
            program.season = meta.parentIndex;
        } else if (meta.type === 'show') {
            program.showTitle = meta.title;
            // Shows: network sometimes in studio
            program.network = meta.studio || program.network;
        }
        return program;
    }

    async _syncLibraryFull(server, section, progressKey) {
        let client = new Plex(server);
        let sectionKey = String(section.key);
        let type = section.type; // movie | show | artist
        let key = progressKey || this.libSyncKey(server.name, sectionKey);

        let report = (pct, phase, detail) => {
            this._setLibProgress(key, {
                status: 'syncing',
                progress: Math.max(0, Math.min(100, Math.round(pct))),
                progressPhase: phase || '',
                progressDetail: detail || '',
            });
        };

        let items = {};
        let shows = {};
        let episodes = {};
        let tracks = {};

        if (type === 'movie') {
            report(5, 'movies', 'Fetching movies…');
            let metas = await this._fetchAllMetadata(
                client,
                '/library/sections/' + sectionKey + '/all?type=1',
                (fetched, total) => {
                    let p = total > 0 ? 5 + (fetched / total) * 55 : 30;
                    report(p, 'movies', 'Movies ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < metas.length; i++) {
                let p = this._metaToProgram(server, metas[i]);
                if (p && p.duration > 0) {
                    items[p.ratingKey] = p;
                }
            }
        } else if (type === 'show') {
            report(5, 'shows', 'Fetching shows…');
            let showMetas = await this._fetchAllMetadata(
                client,
                '/library/sections/' + sectionKey + '/all?type=2',
                (fetched, total) => {
                    let p = total > 0 ? 5 + (fetched / total) * 25 : 20;
                    report(p, 'shows', 'Shows ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < showMetas.length; i++) {
                let p = this._metaToProgram(server, showMetas[i]);
                if (p) {
                    shows[p.ratingKey] = p;
                }
            }
            report(35, 'episodes', 'Fetching episodes…');
            let epMetas = await this._fetchAllMetadata(
                client,
                '/library/sections/' + sectionKey + '/all?type=4',
                (fetched, total) => {
                    let p = total > 0 ? 35 + (fetched / total) * 35 : 50;
                    report(p, 'episodes', 'Episodes ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < epMetas.length; i++) {
                let p = this._metaToProgram(server, epMetas[i]);
                if (p && p.duration > 0) {
                    episodes[p.ratingKey] = p;
                }
            }
        } else if (type === 'artist') {
            report(5, 'tracks', 'Fetching tracks…');
            let trackMetas = await this._fetchAllMetadata(
                client,
                '/library/sections/' + sectionKey + '/all?type=10',
                (fetched, total) => {
                    let p = total > 0 ? 5 + (fetched / total) * 70 : 40;
                    report(p, 'tracks', 'Tracks ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < trackMetas.length; i++) {
                let p = this._metaToProgram(server, trackMetas[i]);
                if (p && p.duration > 0) {
                    tracks[p.ratingKey] = p;
                }
            }
        }

        let collections = [];
        if (type === 'movie' || type === 'show') {
            report(75, 'collections', 'Fetching collections…');
            try {
                collections = await this._fetchCollections(server, client, section, (ci, ct) => {
                    let p = ct > 0 ? 75 + (ci / ct) * 20 : 85;
                    report(p, 'collections', 'Collections ' + ci + '/' + ct);
                });
            } catch (e) {
                console.error('plex-cache: collections failed for', section.title, e.message || e);
            }
        }

        report(98, 'saving', 'Writing cache…');
        let now = Date.now();
        let payload = {
            serverName: server.name,
            sectionKey: sectionKey,
            title: section.title,
            type: type,
            lastFullSyncAt: now,
            lastSyncAt: now,
            items: items,
            shows: shows,
            episodes: episodes,
            tracks: tracks,
            collections: collections,
        };
        this._saveLibraryData(server.name, sectionKey, payload);
        return {
            itemCount:
                Object.keys(items).length +
                Object.keys(shows).length +
                Object.keys(episodes).length +
                Object.keys(tracks).length,
            collectionCount: collections.length,
            lastFullSyncAt: now,
            lastSyncAt: now,
        };
    }

    _countHint(m) {
        if (typeof m.childCount !== 'undefined') return m.childCount;
        if (typeof m.leafCount !== 'undefined') return m.leafCount;
        return null;
    }

    async _fetchCollections(server, client, section, onProgress) {
        let sectionKey = String(section.key);
        let type = section.type;
        let collections = [];
        let colRes = await client.Get('/library/sections/' + sectionKey + '/collections');
        let meta = colRes.Metadata || [];
        for (let i = 0; i < meta.length; i++) {
            let m = meta[i];
            // Badge already indicates "collection" — do not append the word to the title
            let title = m.title;
            let children = [];
            try {
                let childMetas = await this._fetchAllMetadata(client, m.key);
                for (let c = 0; c < childMetas.length; c++) {
                    let cp = this._metaToProgram(server, childMetas[c]);
                    if (cp) {
                        children.push(cp);
                    }
                }
            } catch (e) {
                console.error('plex-cache: collection children failed', m.title, e.message || e);
            }
            let agg = this._aggregateFilterFields(children);
            collections.push(Object.assign({
                title: title,
                key: m.key,
                ratingKey: String(m.ratingKey || ''),
                type: 'collection',
                collectionType: type,
                libraryTitle: section.title,
                libraryType: type,
                sectionKey: String(sectionKey),
                librarySectionKey: String(sectionKey),
                icon: m.thumb
                    ? server.uri + m.thumb + '?X-Plex-Token=' + server.accessToken
                    : '',
                count: children.length || this._countHint(m),
                children: children,
                updatedAt: m.updatedAt != null ? Number(m.updatedAt) : null,
            }, agg));
            if (typeof onProgress === 'function') {
                try {
                    onProgress(i + 1, meta.length);
                } catch (e2) { /* ignore */ }
            }
        }
        return collections;
    }

    /**
     * Incremental library sync: re-list keys, upsert changed, delete missing.
     * Falls back to full if no prior cache.
     */
    async _syncLibraryIncremental(server, section, progressKey) {
        let sectionKey = String(section.key);
        let existing = this.getCachedLibraryData(server.name, sectionKey);
        let key = progressKey || this.libSyncKey(server.name, sectionKey);
        if (!existing || !existing.lastFullSyncAt) {
            return await this._syncLibraryFull(server, section, key);
        }

        // For reliability on first incremental after schema changes, full resync if missing maps
        if (!existing.items) existing.items = {};
        if (!existing.shows) existing.shows = {};
        if (!existing.episodes) existing.episodes = {};
        if (!existing.tracks) existing.tracks = {};
        if (!existing.collections) existing.collections = [];

        let client = new Plex(server);
        let type = section.type;
        let added = 0;
        let updated = 0;
        let removed = 0;

        let report = (pct, phase, detail) => {
            this._setLibProgress(key, {
                status: 'syncing',
                progress: Math.max(0, Math.min(100, Math.round(pct))),
                progressPhase: phase || '',
                progressDetail: detail || '',
            });
        };

        const upsertMap = async (mapName, plexType, basePct, spanPct, phase) => {
            let remote = await this._fetchAllMetadata(
                client,
                '/library/sections/' + sectionKey + '/all?type=' + plexType,
                (fetched, total) => {
                    let p = total > 0 ? basePct + (fetched / total) * spanPct : basePct + spanPct / 2;
                    report(p, phase, phase + ' ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            let seen = {};
            for (let i = 0; i < remote.length; i++) {
                let p = this._metaToProgram(server, remote[i]);
                if (!p) continue;
                if ((p.type === 'movie' || p.type === 'episode' || p.type === 'track') && !(p.duration > 0)) {
                    continue;
                }
                seen[p.ratingKey] = true;
                let prev = existing[mapName][p.ratingKey];
                if (!prev) {
                    existing[mapName][p.ratingKey] = p;
                    added++;
                } else if (
                    (p.updatedAt && prev.updatedAt && p.updatedAt > prev.updatedAt) ||
                    (p.updatedAt && !prev.updatedAt) ||
                    prev.duration !== p.duration ||
                    prev.title !== p.title
                ) {
                    existing[mapName][p.ratingKey] = p;
                    updated++;
                }
            }
            let keys = Object.keys(existing[mapName]);
            for (let i = 0; i < keys.length; i++) {
                if (!seen[keys[i]]) {
                    delete existing[mapName][keys[i]];
                    removed++;
                }
            }
        };

        if (type === 'movie') {
            await upsertMap('items', 1, 5, 55, 'movies');
        } else if (type === 'show') {
            await upsertMap('shows', 2, 5, 25, 'shows');
            await upsertMap('episodes', 4, 35, 35, 'episodes');
        } else if (type === 'artist') {
            await upsertMap('tracks', 10, 5, 70, 'tracks');
        }

        // Collections: always refresh (includes children) so they stay in cache
        if (type === 'movie' || type === 'show') {
            report(75, 'collections', 'Refreshing collections…');
            try {
                existing.collections = await this._fetchCollections(server, client, section, (ci, ct) => {
                    let p = ct > 0 ? 75 + (ci / ct) * 20 : 85;
                    report(p, 'collections', 'Collections ' + ci + '/' + ct);
                });
            } catch (e) {
                console.error('plex-cache: incremental collections refresh failed', e.message || e);
            }
        }

        report(98, 'saving', 'Writing cache…');
        let now = Date.now();
        existing.lastSyncAt = now;
        existing.serverName = server.name;
        existing.sectionKey = sectionKey;
        existing.title = section.title;
        existing.type = type;
        this._saveLibraryData(server.name, sectionKey, existing);

        return {
            itemCount:
                Object.keys(existing.items || {}).length +
                Object.keys(existing.shows || {}).length +
                Object.keys(existing.episodes || {}).length +
                Object.keys(existing.tracks || {}).length,
            collectionCount: (existing.collections || []).length,
            lastFullSyncAt: existing.lastFullSyncAt,
            lastSyncAt: now,
            added: added,
            updated: updated,
            removed: removed,
            mode: 'incremental',
        };
    }

    async _syncPlaylists(server) {
        let client = new Plex(server);
        let res = await client.Get('/playlists');
        let list = [];
        let meta = res.Metadata || [];
        for (let i = 0; i < meta.length; i++) {
            let m = meta[i];
            if (m.playlistType !== 'video' && m.playlistType !== 'audio') {
                continue;
            }
            let children = [];
            try {
                let childMetas = await this._fetchAllMetadata(client, m.key);
                for (let c = 0; c < childMetas.length; c++) {
                    let cp = this._metaToProgram(server, childMetas[c]);
                    if (cp && (cp.type === 'movie' || cp.type === 'episode' || cp.type === 'track') && cp.duration > 0) {
                        children.push(cp);
                    } else if (cp && (cp.type === 'show' || cp.type === 'season' || cp.type === 'album' || cp.type === 'artist')) {
                        // expand one level not fully — store as container for later expand
                        children.push(cp);
                    }
                }
            } catch (e) {
                console.error('plex-cache: playlist items failed', m.title, e.message || e);
            }
            let agg = this._aggregateFilterFields(children);
            list.push(Object.assign({
                title: m.title,
                key: m.key,
                ratingKey: String(m.ratingKey || ''),
                icon: m.composite
                    ? server.uri + m.composite + '?X-Plex-Token=' + server.accessToken
                    : '',
                duration: m.duration,
                count: children.length || this._countHint(m),
                playlistType: m.playlistType,
                children: children,
                updatedAt: m.updatedAt != null ? Number(m.updatedAt) : null,
            }, agg));
        }
        let now = Date.now();
        this._savePlaylistsData(server.name, {
            serverName: server.name,
            lastSyncAt: now,
            playlists: list,
        });
        return { count: list.length, lastSyncAt: now };
    }

    /**
     * Sync one library section (enabled libraries only unless force).
     */
    async syncLibrary(serverName, sectionKey, options) {
        options = options || {};
        let key = this.libSyncKey(serverName, sectionKey);
        if (this._syncing[key]) {
            return { ok: false, error: 'Sync already in progress for this library', key: key };
        }
        this._syncing[key] = true;
        let doc = this.getSettingsDoc();
        try {
            if (!options.includeDisabled && this._isDisabled(serverName, sectionKey)) {
                return { ok: false, error: 'Library is disabled', key: key };
            }
            let server = this._getServer(serverName);
            if (!server) {
                return { ok: false, error: 'Server not found: ' + serverName, key: key };
            }
            let client = new Plex(server);
            let sections = await client.Get('/library/sections');
            let dirs = sections.Directory || [];
            let section = null;
            for (let i = 0; i < dirs.length; i++) {
                if (String(dirs[i].key) === String(sectionKey)) {
                    section = dirs[i];
                    break;
                }
            }
            if (!section) {
                return { ok: false, error: 'Library section not found on Plex', key: key };
            }
            if (section.type !== 'movie' && section.type !== 'show' && section.type !== 'artist') {
                return { ok: false, error: 'Unsupported library type: ' + section.type, key: key };
            }

            doc.librarySync[key] = Object.assign({}, doc.librarySync[key] || {}, {
                serverName: serverName,
                sectionKey: String(sectionKey),
                title: section.title,
                type: section.type,
                status: 'syncing',
                error: null,
            });
            this.saveSettingsDoc(doc);

            console.log(
                'dizqueTV plex-cache: syncing ' + serverName + ' / ' + section.title +
                (options.full ? ' (full)' : ' (incremental)')
            );
            this._setLibProgress(key, {
                status: 'syncing',
                progress: 1,
                progressPhase: 'starting',
                progressDetail: options.full ? 'Full sync…' : 'Incremental sync…',
                error: null,
            });

            let result;
            if (options.full) {
                result = await this._syncLibraryFull(server, section, key);
                result.mode = 'full';
            } else {
                result = await this._syncLibraryIncremental(server, section, key);
            }

            doc = this.getSettingsDoc();
            doc.librarySync[key] = Object.assign({}, doc.librarySync[key] || {}, {
                serverName: serverName,
                sectionKey: String(sectionKey),
                title: section.title,
                type: section.type,
                status: 'idle',
                error: null,
                progress: 100,
                progressPhase: 'done',
                progressDetail: '',
                lastFullSyncAt: result.lastFullSyncAt || (doc.librarySync[key] && doc.librarySync[key].lastFullSyncAt) || null,
                lastSyncAt: result.lastSyncAt || Date.now(),
                itemCount: result.itemCount || 0,
                collectionCount: result.collectionCount || 0,
                lastMode: result.mode || (options.full ? 'full' : 'incremental'),
                lastAdded: result.added || 0,
                lastUpdated: result.updated || 0,
                lastRemoved: result.removed || 0,
            });
            this.saveSettingsDoc(doc);

            return { ok: true, key: key, result: result, status: doc.librarySync[key] };
        } catch (err) {
            console.error('dizqueTV plex-cache: sync library failed', err);
            try {
                doc = this.getSettingsDoc();
                doc.librarySync[key] = Object.assign({}, doc.librarySync[key] || {}, {
                    status: 'error',
                    error: err.message || String(err),
                });
                this.saveSettingsDoc(doc);
            } catch (e2) { /* ignore */ }
            return { ok: false, error: err.message || String(err), key: key };
        } finally {
            delete this._syncing[key];
        }
    }

    /**
     * Sync all enabled libraries + playlists for all servers.
     */
    async syncAll(options) {
        options = options || {};
        let servers = this.db['plex-servers'].find() || [];
        let results = [];
        let doc = this.getSettingsDoc();

        for (let s = 0; s < servers.length; s++) {
            let server = servers[s];
            try {
                let client = new Plex(server);
                let sections = await client.Get('/library/sections');
                let dirs = sections.Directory || [];
                for (let i = 0; i < dirs.length; i++) {
                    let d = dirs[i];
                    if (d.type !== 'movie' && d.type !== 'show' && d.type !== 'artist') {
                        continue;
                    }
                    if (this._isDisabled(server.name, d.key)) {
                        continue;
                    }
                    let existing = this.getCachedLibraryData(server.name, d.key);
                    let full = options.full === true || !existing || !existing.lastFullSyncAt;
                    let r = await this.syncLibrary(server.name, d.key, { full: full });
                    results.push(r);
                }
                let pl = await this._syncPlaylists(server);
                results.push({ ok: true, playlists: pl, serverName: server.name });
            } catch (err) {
                console.error('dizqueTV plex-cache: syncAll server failed', server.name, err);
                results.push({ ok: false, serverName: server.name, error: err.message || String(err) });
            }
        }

        doc = this.getSettingsDoc();
        doc.lastGlobalSyncAt = Date.now();
        this.saveSettingsDoc(doc);

        return {
            ok: true,
            lastGlobalSyncAt: doc.lastGlobalSyncAt,
            results: results,
            status: this.getSyncStatus(),
        };
    }

    // ---------- Cache reads (for API / clients) — all from memory ----------

    getCachedLibraryData(serverName, sectionKey) {
        let mem = this._mem[String(serverName || '')];
        if (!mem || !mem.libraries) return null;
        return mem.libraries[String(sectionKey)] || null;
    }

    getCachedPlaylists(serverName) {
        let mem = this._mem[String(serverName || '')];
        if (!mem) return null;
        return mem.playlists || null;
    }

    /** True if this server has any synced library and/or playlists in memory. */
    hasServerCache(serverName) {
        return this.hasPlaylistCache(serverName) || this.hasLibraryCache(serverName);
    }

    /** True if playlists are loaded in memory for this server. */
    hasPlaylistCache(serverName) {
        let mem = this._mem[String(serverName || '')];
        return !!(mem && mem.playlists);
    }

    /**
     * True if at least one library section is in memory.
     * @param {string} serverName
     * @param {{ type?: string }} [options] if type set, only count libraries of that type
     */
    hasLibraryCache(serverName, options) {
        options = options || {};
        let mem = this._mem[String(serverName || '')];
        if (!mem || !mem.libraries) return false;
        let keys = Object.keys(mem.libraries);
        if (!keys.length) return false;
        if (!options.type) return true;
        for (let i = 0; i < keys.length; i++) {
            let data = mem.libraries[keys[i]];
            if (data && data.type === options.type) return true;
        }
        return false;
    }

    /**
     * Library sections list shaped like web plex.getLibrary()
     * @param {string} serverName
     * @param {{ includeDisabled?: boolean, includeHidden?: boolean }} [options]
     *   includeHidden: include "Hide content" libraries (Add Filler needs this + client filler filter).
     *   Default excludes hidden so they do not appear in programming / content sources.
     */
    getCachedSections(serverName, options) {
        options = options || {};
        let server = this._getServer(serverName);
        if (!server) {
            return [];
        }
        let mem = this._mem[String(serverName || '')];
        if (!mem || !mem.libraries) {
            return [];
        }
        let sections = [];
        let keys = Object.keys(mem.libraries);
        for (let i = 0; i < keys.length; i++) {
            let data = mem.libraries[keys[i]];
            if (!data) continue;
            if (!options.includeDisabled && this._isDisabled(serverName, data.sectionKey)) {
                continue;
            }
            if (!options.includeHidden && this._isHidden(serverName, data.sectionKey)) {
                continue;
            }
            sections.push({
                title: data.title,
                key: '/library/sections/' + data.sectionKey + '/all',
                sectionKey: String(data.sectionKey),
                type: data.type,
                serverName: serverName,
                icon: '',
                genres: [],
                fromCache: true,
                lastSyncAt: data.lastSyncAt || null,
                itemCount:
                    Object.keys(data.items || {}).length +
                    Object.keys(data.shows || {}).length +
                    Object.keys(data.episodes || {}).length +
                    Object.keys(data.tracks || {}).length,
            });
        }
        return sections;
    }

    /**
     * Nested children for a library "all" key, collection, playlist, or show key from memory.
     * @param {string} serverName
     * @param {string} key
     * @param {{ includeCollections?: boolean }} [options]
     */
    getCachedNested(serverName, key, options) {
        options = options || {};
        let includeCollections = options.includeCollections !== false;
        let mem = this._mem[String(serverName || '')];
        if (!mem) return null;

        // Library all: /library/sections/{id}/all
        let m = String(key || '').match(/\/library\/sections\/([^/?#]+)\/all/);
        if (m) {
            let data = this.getCachedLibraryData(serverName, m[1]);
            if (!data || !data.lastSyncAt) return null;
            let nested = [];
            if (data.type === 'movie') {
                nested = Object.keys(data.items || {}).map((k) => Object.assign({}, data.items[k]));
            } else if (data.type === 'show') {
                nested = Object.keys(data.shows || {}).map((k) => Object.assign({}, data.shows[k]));
            } else if (data.type === 'artist') {
                nested = Object.keys(data.tracks || {}).map((k) => Object.assign({}, data.tracks[k]));
            }
            if (includeCollections) {
                let cols = (data.collections || []).map((c) => ({
                    key: c.key,
                    title: c.title,
                    type: 'collection',
                    collectionType: c.collectionType,
                    icon: c.icon,
                    count: c.count,
                    // Keep children for expandToPrograms without another lookup
                    children: c.children || [],
                }));
                nested = cols.concat(nested);
            }
            return { nested: nested, fromCache: true };
        }

        // Collection children by exact key (scan in-memory libraries)
        let libKeys = mem.libraries ? Object.keys(mem.libraries) : [];
        for (let i = 0; i < libKeys.length; i++) {
            let data = mem.libraries[libKeys[i]];
            if (!data || !data.collections) continue;
            for (let c = 0; c < data.collections.length; c++) {
                let col = data.collections[c];
                if (col.key === key || (col.ratingKey && String(key).indexOf('/' + col.ratingKey) !== -1)) {
                    let children = (col.children || []).map((ch) => Object.assign({}, ch));
                    return { nested: children, fromCache: true, kind: 'collection' };
                }
            }
        }
        let pl = this.getCachedPlaylists(serverName);
        if (pl && pl.playlists) {
            for (let i = 0; i < pl.playlists.length; i++) {
                let playlist = pl.playlists[i];
                if (playlist.key === key || (playlist.ratingKey && String(key).indexOf('/' + playlist.ratingKey) !== -1)) {
                    let children = (playlist.children || []).map((ch) => Object.assign({}, ch));
                    return { nested: children, fromCache: true, kind: 'playlist' };
                }
            }
        }

        // Show / season metadata children → episodes from memory
        // Keys look like /library/metadata/{id} or /library/metadata/{id}/children
        let showMatch = String(key || '').match(/\/library\/metadata\/(\d+)/);
        if (showMatch) {
            let rk = String(showMatch[1]);
            for (let i = 0; i < libKeys.length; i++) {
                let data = mem.libraries[libKeys[i]];
                if (!data) continue;
                if (data.episodes) {
                    let keys = Object.keys(data.episodes);
                    let eps = keys.map((k) => data.episodes[k]).filter((ep) => {
                        let g = ep.grandparentRatingKey != null ? String(ep.grandparentRatingKey) : '';
                        let p = ep.parentRatingKey != null ? String(ep.parentRatingKey) : '';
                        return (
                            g === rk ||
                            p === rk ||
                            (ep.key && String(ep.key).indexOf('/' + rk + '/') !== -1)
                        );
                    });
                    if (eps.length) {
                        eps.sort((a, b) => {
                            let sa = Number(a.season) || 0;
                            let sb = Number(b.season) || 0;
                            if (sa !== sb) return sa - sb;
                            return (Number(a.episode) || 0) - (Number(b.episode) || 0);
                        });
                        return {
                            nested: eps.map((ep) => Object.assign({}, ep)),
                            fromCache: true,
                            note: 'episodes',
                        };
                    }
                }
                // Show with zero episodes still a cache hit if show exists
                if (data.shows && (data.shows[rk] || Object.keys(data.shows || {}).some((k) => String(k) === rk))) {
                    return { nested: [], fromCache: true, note: 'empty-show' };
                }
            }
        }

        return null;
    }

    getCachedCollectionsList(serverName, options) {
        // Only authoritative when at least one movie/show library has been synced
        options = options || {};
        if (!this.hasLibraryCache(serverName)) {
            return { list: null, fromCache: false };
        }
        let sections = this.getCachedSections(serverName, options);
        let all = [];
        for (let i = 0; i < sections.length; i++) {
            let data = this.getCachedLibraryData(serverName, sections[i].sectionKey);
            if (!data) continue;
            let cols = data.collections || [];
            for (let c = 0; c < cols.length; c++) {
                let col = cols[c];
                let count = col.count;
                if ((count == null || count === '') && Array.isArray(col.children)) {
                    count = col.children.length;
                }
                // Skip empty collections (no addable content)
                if (count != null && count !== '' && !isNaN(parseInt(count, 10)) && parseInt(count, 10) <= 0) {
                    continue;
                }
                if (Array.isArray(col.children) && col.children.length === 0) {
                    continue;
                }
                let secKey = String(
                    col.librarySectionKey
                    || col.sectionKey
                    || data.sectionKey
                    || sections[i].sectionKey
                    || ''
                );
                // Belt-and-suspenders: skip hidden library collections
                if (!options.includeHidden && this._isListSourceHidden(serverName, Object.assign({}, col, {
                    sectionKey: secKey,
                    librarySectionKey: secKey,
                    libraryTitle: col.libraryTitle || data.title,
                }))) {
                    continue;
                }
                // Omit children — nested endpoint still expands via cache; embedding
                // full child trees made catalog list responses multi‑MB / multi‑second.
                let colTitle = col.title || '';
                if (typeof colTitle === 'string' && / Collection$/i.test(colTitle)) {
                    colTitle = colTitle.replace(/ Collection$/i, '');
                }
                let row = Object.assign({
                    title: colTitle,
                    key: col.key,
                    type: 'collection',
                    collectionType: col.collectionType,
                    libraryTitle: col.libraryTitle || data.title,
                    libraryType: col.libraryType || col.collectionType || data.type,
                    sectionKey: secKey,
                    librarySectionKey: secKey,
                    icon: col.icon || '',
                    count: count,
                }, this._filterFieldsFromProgram(col));
                // Prefer pre-aggregated fields stored on the collection during sync
                if (Array.isArray(col.genres) && col.genres.length) row.genres = col.genres;
                if (col.yearMin != null) row.yearMin = col.yearMin;
                if (col.yearMax != null) row.yearMax = col.yearMax;
                if (col.year != null) row.year = col.year;
                all.push(row);
            }
        }
        return { list: all, fromCache: true };
    }

    getCachedShowsList(serverName, options) {
        // Only authoritative when at least one TV show library has been synced
        if (!this.hasLibraryCache(serverName, { type: 'show' })) {
            return { list: null, fromCache: false };
        }
        let sections = this.getCachedSections(serverName, options || {});
        let all = [];
        for (let i = 0; i < sections.length; i++) {
            if (sections[i].type !== 'show') continue;
            let data = this.getCachedLibraryData(serverName, sections[i].sectionKey);
            if (!data || !data.shows) continue;
            let keys = Object.keys(data.shows);
            // Index episodes by show ratingKey once per library for season/episode counts
            let epsByShow = {};
            let seasonsByShow = {};
            if (data.episodes) {
                let epKeys = Object.keys(data.episodes);
                for (let e = 0; e < epKeys.length; e++) {
                    let ep = data.episodes[epKeys[e]];
                    if (!ep) continue;
                    let showRk = ep.grandparentRatingKey != null
                        ? String(ep.grandparentRatingKey)
                        : null;
                    if (!showRk) continue;
                    if (!epsByShow[showRk]) {
                        epsByShow[showRk] = 0;
                        seasonsByShow[showRk] = {};
                    }
                    epsByShow[showRk]++;
                    let seasonId = ep.parentRatingKey != null
                        ? String(ep.parentRatingKey)
                        : (ep.season != null ? 's' + String(ep.season) : null);
                    if (seasonId != null) {
                        seasonsByShow[showRk][seasonId] = true;
                    }
                }
            }
            for (let k = 0; k < keys.length; k++) {
                let s = data.shows[keys[k]];
                let rk = s.ratingKey != null ? String(s.ratingKey) : String(keys[k]);
                let seasonCount = null;
                let episodeCount = null;
                if (epsByShow[rk] != null) {
                    episodeCount = epsByShow[rk];
                    seasonCount = Object.keys(seasonsByShow[rk] || {}).length;
                } else {
                    // Fallback to Plex metadata hints when episodes were not cached
                    if (typeof s.childCount !== 'undefined' && s.childCount !== null) {
                        seasonCount = parseInt(s.childCount, 10);
                        if (isNaN(seasonCount)) seasonCount = null;
                    }
                    if (typeof s.leafCount !== 'undefined' && s.leafCount !== null) {
                        episodeCount = parseInt(s.leafCount, 10);
                        if (isNaN(episodeCount)) episodeCount = null;
                    }
                }
                all.push(Object.assign({
                    title: s.title,
                    key: s.key,
                    type: 'show',
                    libraryTitle: data.title,
                    libraryType: 'show',
                    sectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                    librarySectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                    icon: s.icon || '',
                    ratingKey: s.ratingKey,
                    seasonCount: seasonCount,
                    episodeCount: episodeCount,
                    // count kept for callers that expect a single number (episodes preferred)
                    count: episodeCount != null ? episodeCount : (seasonCount != null ? seasonCount : null),
                }, this._filterFieldsFromProgram(s)));
            }
        }
        return { list: all, fromCache: true };
    }

    getCachedPlaylistsList(serverName, options) {
        options = options || {};
        let pl = this.getCachedPlaylists(serverName);
        if (!pl) {
            return { list: null, fromCache: false };
        }
        let list = [];
        let src = pl.playlists || [];
        for (let i = 0; i < src.length; i++) {
            let p = src[i];
            let count = p.count;
            if ((count == null || count === '') && Array.isArray(p.children)) {
                count = p.children.length;
            }
            // Skip empty playlists (no addable content)
            if (count != null && count !== '' && !isNaN(parseInt(count, 10)) && parseInt(count, 10) <= 0) {
                continue;
            }
            if (Array.isArray(p.children) && p.children.length === 0) {
                continue;
            }
            // Global playlists: hide when all content is from "Hide content" libraries
            if (!options.includeHidden && this._isListSourceHidden(serverName, p)) {
                continue;
            }
            // Omit children — nested/expand paths load them from cache by key.
            let row = Object.assign({
                title: p.title,
                key: p.key,
                icon: p.icon,
                duration: p.duration,
                count: count,
                type: 'playlist',
            }, this._filterFieldsFromProgram(p));
            if (Array.isArray(p.genres) && p.genres.length) row.genres = p.genres;
            if (p.yearMin != null) row.yearMin = p.yearMin;
            if (p.yearMax != null) row.yearMax = p.yearMax;
            list.push(row);
        }
        return {
            fromCache: true,
            list: list,
        };
    }

    /**
     * Delete cached data for one library section (disk + memory).
     */
    deleteLibraryCache(serverName, sectionKey) {
        let key = this.libSyncKey(serverName, sectionKey);
        let libDir = this._libDir(serverName, sectionKey);
        try {
            if (fs.existsSync(libDir)) {
                let files = fs.readdirSync(libDir);
                for (let i = 0; i < files.length; i++) {
                    try {
                        fs.unlinkSync(path.join(libDir, files[i]));
                    } catch (e) { /* ignore */ }
                }
                try {
                    fs.rmdirSync(libDir);
                } catch (e) { /* ignore */ }
            }
            this._removeLibraryFromMemory(serverName, sectionKey);
            let doc = this.getSettingsDoc();
            if (doc.librarySync && doc.librarySync[key]) {
                delete doc.librarySync[key];
                this.saveSettingsDoc(doc);
            }
            console.log('dizqueTV plex-cache: deleted cache for ' + key);
            return { ok: true, key: key, status: this.getSyncStatus() };
        } catch (err) {
            console.error('dizqueTV plex-cache: delete library failed', err);
            return { ok: false, error: err.message || String(err), key: key };
        }
    }

    /**
     * Delete entire plex-cache folder + clear memory + librarySync / lastGlobalSyncAt.
     */
    deleteAllCache() {
        try {
            const wipeDir = (dir) => {
                if (!fs.existsSync(dir)) {
                    return;
                }
                let entries = fs.readdirSync(dir);
                for (let i = 0; i < entries.length; i++) {
                    let p = path.join(dir, entries[i]);
                    let st = fs.statSync(p);
                    if (st.isDirectory()) {
                        wipeDir(p);
                        try { fs.rmdirSync(p); } catch (e) { /* ignore */ }
                    } else {
                        try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
                    }
                }
            };
            wipeDir(this.root);
            this._ensureDir(this.root);
            this._clearMemory();
            let doc = this.getSettingsDoc();
            doc.librarySync = {};
            doc.lastGlobalSyncAt = null;
            this.saveSettingsDoc(doc);
            console.log('dizqueTV plex-cache: deleted ALL cache under ' + this.root);
            return { ok: true, status: this.getSyncStatus() };
        } catch (err) {
            console.error('dizqueTV plex-cache: delete all failed', err);
            return { ok: false, error: err.message || String(err) };
        }
    }

    /**
     * Fast in-process search of the Plex library cache (no live Plex HTTP).
     * Used by programming UI title/summary filters.
     *
     * @param {{ title?: string, summary?: string, limit?: number }} opts
     * @returns {{ movies: object[], shows: object[], episodes: object[], fromCache: boolean }}
     */
    searchCached(opts) {
        opts = opts || {};
        let titleQ = String(opts.title || '').trim().toLowerCase();
        let summaryQ = String(opts.summary || '').trim().toLowerCase();
        if (!titleQ && !summaryQ) {
            return { movies: [], shows: [], episodes: [], fromCache: true };
        }
        let limit = parseInt(opts.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 2500;
        if (limit > 8000) limit = 8000;

        let movies = [];
        let showsByKey = {};
        let episodes = [];

        const has = (hay, q) => {
            if (!q) return true;
            if (hay == null || hay === '') return false;
            return String(hay).toLowerCase().indexOf(q) >= 0;
        };
        const matches = (obj) => {
            if (!obj) return false;
            let titleOk =
                !titleQ
                || has(obj.title, titleQ)
                || has(obj.originalTitle, titleQ)
                || has(obj.showTitle, titleQ)
                || has(obj.grandparentTitle, titleQ)
                || has(obj.parentTitle, titleQ);
            let sumOk = !summaryQ || has(obj.summary, summaryQ);
            return titleOk && sumOk;
        };
        const ensureShow = (serverName, rk, title, year) => {
            if (rk == null || rk === '') return null;
            let k = serverName + '|' + String(rk);
            if (!showsByKey[k]) {
                showsByKey[k] = {
                    source: 'plex',
                    serverName: serverName,
                    ratingKey: String(rk),
                    title: title || '',
                    year: year != null ? year : null,
                    matchedVia: 'show',
                };
            }
            return showsByKey[k];
        };

        let serverNames = Object.keys(this._mem || {});
        for (let s = 0; s < serverNames.length; s++) {
            let serverName = serverNames[s];
            let mem = this._mem[serverName];
            if (!mem || !mem.libraries) continue;
            let libKeys = Object.keys(mem.libraries);
            for (let li = 0; li < libKeys.length; li++) {
                let data = mem.libraries[libKeys[li]];
                if (!data) continue;
                let sectionKey = data.sectionKey != null ? String(data.sectionKey) : String(libKeys[li]);
                if (this._isDisabled && this._isDisabled(serverName, sectionKey)) continue;
                if (this._isHidden && this._isHidden(serverName, sectionKey)) continue;

                // Movies
                let items = data.items || {};
                let ikeys = Object.keys(items);
                for (let i = 0; i < ikeys.length; i++) {
                    let p = items[ikeys[i]];
                    if (!p || (p.type && p.type !== 'movie')) continue;
                    if (!matches(p)) continue;
                    if (movies.length < limit) {
                        movies.push({
                            source: 'plex',
                            serverName: serverName,
                            ratingKey: p.ratingKey != null ? String(p.ratingKey) : String(ikeys[i]),
                            title: p.title || '',
                            year: p.year != null ? p.year : null,
                            librarySectionKey: sectionKey,
                        });
                    }
                }

                // Show shells
                let shows = data.shows || {};
                let skeys = Object.keys(shows);
                for (let i = 0; i < skeys.length; i++) {
                    let sh = shows[skeys[i]];
                    if (!sh) continue;
                    if (!matches(sh)) continue;
                    let entry = ensureShow(
                        serverName,
                        sh.ratingKey != null ? sh.ratingKey : skeys[i],
                        sh.title,
                        sh.year
                    );
                    if (entry) entry.matchedVia = 'show';
                }

                // Episodes (title/summary) → attach parent show
                let eps = data.episodes || {};
                let ekeys = Object.keys(eps);
                for (let i = 0; i < ekeys.length; i++) {
                    let ep = eps[ekeys[i]];
                    if (!ep || ep.type === 'movie') continue;
                    if (ep.type && ep.type !== 'episode') continue;
                    if (!matches(ep)) continue;
                    let epRk = ep.ratingKey != null ? String(ep.ratingKey) : String(ekeys[i]);
                    let showRk =
                        ep.grandparentRatingKey != null
                            ? String(ep.grandparentRatingKey)
                            : null;
                    if (showRk) {
                        let entry = ensureShow(
                            serverName,
                            showRk,
                            ep.showTitle || ep.grandparentTitle || '',
                            null
                        );
                        if (entry && entry.matchedVia !== 'show') {
                            entry.matchedVia = 'episode';
                        }
                    }
                    if (episodes.length < limit) {
                        episodes.push({
                            source: 'plex',
                            serverName: serverName,
                            ratingKey: epRk,
                            title: ep.title || '',
                            showTitle: ep.showTitle || ep.grandparentTitle || '',
                            year: ep.year != null ? ep.year : null,
                            season: ep.season != null ? ep.season : ep.parentIndex,
                            episode: ep.episode != null ? ep.episode : ep.index,
                            grandparentRatingKey: showRk,
                            parentRatingKey:
                                ep.parentRatingKey != null
                                    ? String(ep.parentRatingKey)
                                    : null,
                            librarySectionKey: sectionKey,
                        });
                    }
                }
            }
        }

        return {
            movies: movies,
            shows: Object.keys(showsByKey).map((k) => showsByKey[k]),
            episodes: episodes,
            fromCache: true,
        };
    }
}

module.exports = PlexLibraryCacheService;
