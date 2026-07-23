/**
 * Local Jellyfin library cache + full/incremental sync.
 *
 * Persists under DATABASE/cache/jellyfin-cache. Reads are served from an in-memory map
 * loaded at boot and rewritten after every sync/delete.
 *
 * Full sync: pull all movies/series/episodes for a library, plus per-library genres.
 * BoxSet collections are global on Jellyfin — synced once per server (not per library).
 * Incremental: re-list items, upsert by DateModified, remove deletes.
 */
const fs = require('fs');
const path = require('path');
const Jellyfin = require('../jellyfin');

const PAGE_SIZE = 200;
// Metadata for filters + playback. Avoid MediaStreams on bulk pages (huge payloads / timeouts).
const ITEM_FIELDS =
    'Path,Overview,ProductionYear,PremiereDate,' +
    'RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,SeasonName,' +
    'SeriesId,SeasonId,ParentId,DateCreated,DateModified,ChildCount,RecursiveItemCount,' +
    'Genres,Tags,Studios,ProductionLocations,OfficialRating,CommunityRating,' +
    'People,Width,Height,VideoRange,Container,OriginalTitle,SeriesStudio,UserData,MediaSources';
// Fallback if server rejects the full Fields list
const ITEM_FIELDS_MINIMAL =
    'Path,Overview,ProductionYear,PremiereDate,RunTimeTicks,IndexNumber,ParentIndexNumber,' +
    'SeriesName,SeasonName,SeriesId,SeasonId,ParentId,DateCreated,DateModified,' +
    'ChildCount,RecursiveItemCount,Genres,OfficialRating,Width,Height,MediaSources';

class JellyfinLibraryCacheService {
    constructor(db) {
        this.db = db;
        const dbPaths = require('../database-paths');
        this.root = dbPaths.jellyfinCacheDir();
        this._ensureDir(this.root);
        this._syncing = {};
        this._autoTimer = null;
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
            if (!fs.existsSync(file)) return fallback;
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            console.error('jellyfin-cache: read failed', file, e.message || e);
            return fallback;
        }
    }

    _writeJson(file, data) {
        let tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
    }

    _ensureMemServer(serverName) {
        let name = String(serverName || '');
        if (!this._mem[name]) {
            this._mem[name] = { playlists: null, collections: null, libraries: {} };
        }
        if (typeof this._mem[name].collections === 'undefined') {
            this._mem[name].collections = null;
        }
        return this._mem[name];
    }

    _loadMemoryFromDisk() {
        this._mem = {};
        let loadedLibs = 0;
        let loadedPlaylists = 0;
        let loadedCollections = 0;
        try {
            if (!fs.existsSync(this.root)) return;
            let serverDirs = fs.readdirSync(this.root);
            for (let s = 0; s < serverDirs.length; s++) {
                let serverPath = path.join(this.root, serverDirs[s]);
                let st;
                try { st = fs.statSync(serverPath); } catch (e) { continue; }
                if (!st.isDirectory()) continue;

                let playlistsFile = path.join(serverPath, 'playlists.json');
                let collectionsFile = path.join(serverPath, 'collections.json');
                let playlists = this._readJson(playlistsFile, null);
                let collections = this._readJson(collectionsFile, null);
                let serverName =
                    (playlists && playlists.serverName) ? playlists.serverName
                    : (collections && collections.serverName) ? collections.serverName
                    : serverDirs[s];

                let entries = [];
                try { entries = fs.readdirSync(serverPath); } catch (e) { continue; }

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
                if (collections) {
                    mem.collections = collections;
                    loadedCollections++;
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
            console.error('jellyfin-cache: memory load failed', e.message || e);
        }
        console.log(
            'dizqueTV jellyfin-cache: loaded ' + loadedLibs + ' library(ies), ' +
            loadedPlaylists + ' playlist file(s), ' + loadedCollections + ' global collection file(s) into memory'
        );
    }

    _saveLibraryData(serverName, sectionKey, data) {
        let libDir = this._libDir(serverName, sectionKey);
        this._writeJson(path.join(libDir, 'data.json'), data);
        let mem = this._ensureMemServer(serverName);
        mem.libraries[String(sectionKey)] = data;
    }

    _savePlaylistsData(serverName, data) {
        let file = path.join(this._serverDir(serverName), 'playlists.json');
        this._writeJson(file, data);
        let mem = this._ensureMemServer(serverName);
        mem.playlists = data;
    }

    _saveCollectionsData(serverName, data) {
        let file = path.join(this._serverDir(serverName), 'collections.json');
        this._writeJson(file, data);
        let mem = this._ensureMemServer(serverName);
        mem.collections = data;
    }

    getCachedGlobalCollections(serverName) {
        let mem = this._mem[String(serverName || '')];
        if (!mem) return null;
        return mem.collections || null;
    }

    hasCollectionsCache(serverName) {
        let c = this.getCachedGlobalCollections(serverName);
        return !!(c && Array.isArray(c.collections));
    }

    /** Stable key for a per-library genre "collection" entry. */
    genreCollectionKey(sectionKey, genreId) {
        return '/Genres/' + String(genreId) + '/Library/' + String(sectionKey);
    }

    /** Stable key for a per-library favorites virtual playlist. */
    favoritesPlaylistKey(sectionKey) {
        return '/Favorites/Library/' + String(sectionKey);
    }

    getSettingsDoc() {
        let rows = this.db['jellyfin-library-settings'].find();
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
            this.db['jellyfin-library-settings'].save(doc);
            rows = this.db['jellyfin-library-settings'].find();
        }
        let doc = rows[0];
        if (!Array.isArray(doc.disabledLibraries)) doc.disabledLibraries = [];
        if (!Array.isArray(doc.fillerLibraries)) doc.fillerLibraries = [];
        if (!Array.isArray(doc.hiddenLibraries)) doc.hiddenLibraries = [];
        if (typeof doc.autoSyncHours !== 'number' || isNaN(doc.autoSyncHours)) doc.autoSyncHours = 0;
        if (!doc.librarySync || typeof doc.librarySync !== 'object') doc.librarySync = {};
        if (typeof doc.lastGlobalSyncAt === 'undefined') doc.lastGlobalSyncAt = null;
        return doc;
    }

    saveSettingsDoc(doc, options) {
        options = options || {};
        let prevHours = null;
        try {
            let rows = this.db['jellyfin-library-settings'].find();
            if (rows && rows[0]) prevHours = rows[0].autoSyncHours;
        } catch (e) { /* ignore */ }
        this.db['jellyfin-library-settings'].update({ _id: doc._id }, doc);
        this._invalidateHiddenIndex();
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
        let librarySync = Object.assign({}, doc.librarySync || {});
        // Overlay latest in-memory progress only while that library is actively syncing
        if (this._progressMem) {
            let pkeys = Object.keys(this._progressMem);
            for (let i = 0; i < pkeys.length; i++) {
                let k = pkeys[i];
                if (!this._syncing[k]) {
                    delete this._progressMem[k];
                    continue;
                }
                librarySync[k] = Object.assign({}, librarySync[k] || {}, this._progressMem[k]);
            }
        }
        return {
            autoSyncHours: doc.autoSyncHours || 0,
            lastGlobalSyncAt: doc.lastGlobalSyncAt || null,
            librarySync: librarySync,
            syncing: Object.keys(this._syncing).filter((k) => this._syncing[k]),
        };
    }

    updateAutoSyncHours(hours) {
        let doc = this.getSettingsDoc();
        let n = parseFloat(hours);
        if (isNaN(n) || n < 0) n = 0;
        if (n > 168) n = 168;
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
        if (hours <= 0) return;
        let ms = Math.max(1, hours) * 60 * 60 * 1000;
        console.log('dizqueTV jellyfin-cache: auto-sync every ' + hours + ' hour(s)');
        this._autoTimer = setInterval(() => {
            this.syncAll({ reason: 'auto' }).catch((err) => {
                console.error('dizqueTV jellyfin-cache: auto-sync failed', err.message || err);
            });
        }, ms);
        if (doc.lastGlobalSyncAt) {
            let age = Date.now() - Number(doc.lastGlobalSyncAt);
            if (age > ms) {
                setTimeout(() => {
                    this.syncAll({ reason: 'auto-catchup' }).catch(() => {});
                }, 20000);
            }
        }
    }

    _getServer(serverName) {
        let servers = this.db['jellyfin-servers'].find() || [];
        for (let i = 0; i < servers.length; i++) {
            if (servers[i].name === serverName) return servers[i];
        }
        return null;
    }

    _client(server) {
        let jf = new Jellyfin(server);
        if (server.userId) jf._userId = server.userId;
        return jf;
    }

    _isDisabled(serverName, sectionKey) {
        let list = this.getSettingsDoc().disabledLibraries || [];
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
     * Used to filter global playlists / BoxSets that belong to those libraries.
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
                    let id = it && (it.ratingKey != null ? it.ratingKey : (it.jellyfinId != null ? it.jellyfinId : keys[k]));
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
            : (item.librarySectionKey != null ? String(item.librarySectionKey) : null);
        if (sk != null && idx.sectionKeys[sk]) return true;

        // Genre keys embed library id: /Genres/{id}/Library/{sectionKey}
        let key = String(item.key || '');
        let gm = key.match(/\/Library\/([^/?#]+)/i);
        if (gm && idx.sectionKeys[String(gm[1])]) return true;

        let libTitle = item.libraryTitle || '';
        if (libTitle && libTitle !== 'Collections' && idx.titles[String(libTitle).toLowerCase()]) {
            return true;
        }

        let children = Array.isArray(item.children) ? item.children : null;
        if (!children || !children.length) return false;

        let inHidden = 0;
        let inOther = 0;
        for (let c = 0; c < children.length; c++) {
            let ch = children[c];
            if (!ch) continue;
            let id =
                ch.ratingKey != null ? String(ch.ratingKey)
                : (ch.jellyfinId != null ? String(ch.jellyfinId) : '');
            if (!id) continue;
            if (idx.itemIds[id]) inHidden++;
            else inOther++;
        }
        return inHidden > 0 && inOther === 0;
    }

    _setLibProgress(key, patch) {
        try {
            // Throttle disk writes — progress is called every page and was freezing the process
            let now = Date.now();
            if (!this._progressThrottle) this._progressThrottle = {};
            let last = this._progressThrottle[key] || 0;
            let isTerminal = patch && (patch.status === 'idle' || patch.status === 'error');
            // Keep an in-memory progress map for status API between throttled disk writes
            if (!this._progressMem) this._progressMem = {};
            let curMem = Object.assign({}, this._progressMem[key] || {});
            Object.assign(curMem, patch);
            this._progressMem[key] = curMem;

            if (!isTerminal && now - last < 750) {
                // Update settings doc in memory for getSyncStatus without thrashing disk
                let doc = this.getSettingsDoc();
                let cur = Object.assign({}, doc.librarySync[key] || {}, curMem);
                doc.librarySync[key] = cur;
                return;
            }
            this._progressThrottle[key] = now;
            let doc = this.getSettingsDoc();
            let cur = Object.assign({}, doc.librarySync[key] || {}, curMem);
            doc.librarySync[key] = cur;
            this.saveSettingsDoc(doc);
            if (isTerminal) {
                delete this._progressThrottle[key];
                if (this._progressMem) delete this._progressMem[key];
            }
        } catch (e) {
            console.error('jellyfin-cache: progress update failed', e.message || e);
        }
    }

    _ticksToMs(ticks) {
        if (typeof ticks !== 'number' || isNaN(ticks) || ticks <= 0) return 0;
        return Math.floor(ticks / 10000);
    }

    _collectionTypeToLibType(ct) {
        ct = (ct || '').toLowerCase();
        if (ct === 'movies' || ct === 'movie') return 'movie';
        if (ct === 'tvshows' || ct === 'tvshow' || ct === 'shows') return 'show';
        if (ct === 'music') return 'artist';
        return null;
    }

    _imageUrl(server, itemId, tag) {
        if (!itemId || !server) return '';
        let q = 'api_key=' + encodeURIComponent(server.apiKey || '');
        if (tag) q += '&tag=' + encodeURIComponent(tag);
        return server.uri.replace(/\/$/, '') + '/Items/' + itemId + '/Images/Primary?' + q;
    }

    _modifiedMs(item) {
        // Jellyfin returns ISO strings for DateModified / DateCreated
        let raw = item.DateModified || item.DateCreated || null;
        if (!raw) return null;
        let t = Date.parse(raw);
        return isNaN(t) ? null : t;
    }

    _jfNames(arr) {
        if (!arr) return [];
        if (!Array.isArray(arr)) {
            if (typeof arr === 'string') return arr ? [arr] : [];
            let n = arr.Name || arr.name || arr.tag;
            return n ? [String(n)] : [];
        }
        let out = [];
        for (let i = 0; i < arr.length; i++) {
            let x = arr[i];
            if (x == null) continue;
            if (typeof x === 'string') out.push(x);
            else if (x.Name || x.name) out.push(String(x.Name || x.name));
        }
        return out;
    }

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

    _itemToProgram(server, item) {
        if (!item || !item.Id) return null;
        let type = (item.Type || '').toLowerCase();
        let programType = type;
        if (type === 'series') programType = 'show';
        else if (type === 'boxset') programType = 'collection';
        else if (type === 'audio') programType = 'track';
        else if (type === 'musicalbum') programType = 'album';

        let duration = this._ticksToMs(item.RunTimeTicks);
        let year = item.ProductionYear;
        let date = item.PremiereDate ? String(item.PremiereDate).slice(0, 10) : undefined;
        if (typeof date === 'undefined' && typeof year !== 'undefined') {
            date = year + '-01-01';
        }
        let primaryTag = item.ImageTags && item.ImageTags.Primary ? item.ImageTags.Primary : null;

        let genres = this._jfNames(item.Genres);
        let studios = this._jfNames(item.Studios);
        let countries = this._jfNames(item.ProductionLocations);
        let tags = this._jfNames(item.Tags);
        let people = Array.isArray(item.People) ? item.People : [];
        let actors = [];
        let directors = [];
        let writers = [];
        let producers = [];
        for (let pi = 0; pi < people.length; pi++) {
            let pe = people[pi];
            if (!pe || !pe.Name) continue;
            let role = String(pe.Type || pe.Role || '').toLowerCase();
            if (role === 'director') directors.push(pe.Name);
            else if (role === 'writer') writers.push(pe.Name);
            else if (role === 'producer') producers.push(pe.Name);
            else if (role === 'actor' || role === 'gueststar' || !role) actors.push(pe.Name);
        }

        let contentRating = item.OfficialRating || null;
        let userData = item.UserData || {};
        let viewCount = userData.PlayCount != null ? Number(userData.PlayCount) : 0;
        let viewOffset = 0;
        if (userData.PlaybackPositionTicks != null) {
            viewOffset = Math.round(Number(userData.PlaybackPositionTicks) / 10000);
        }

        let program = {
            source: 'jellyfin',
            serverType: 'jellyfin',
            title: item.Name,
            key: '/Items/' + item.Id,
            ratingKey: item.Id,
            jellyfinId: item.Id,
            icon: this._imageUrl(server, item.Id, primaryTag),
            type: programType,
            duration: duration,
            summary: item.Overview || '',
            year: year,
            date: date,
            rating: contentRating,
            contentRating: contentRating,
            audienceRating: item.CommunityRating != null ? item.CommunityRating : null,
            studio: studios.length ? studios[0] : null,
            network: item.SeriesStudio || (studios.length ? studios[0] : null),
            country: countries.length ? countries[0] : null,
            countries: countries,
            genres: genres,
            directors: directors,
            writers: writers,
            producers: producers,
            actors: actors,
            labels: tags,
            collections: [],
            originalTitle: item.OriginalTitle || null,
            serverKey: server.name,
            childCount: item.ChildCount,
            leafCount: item.RecursiveItemCount,
            updatedAt: this._modifiedMs(item),
            viewCount: viewCount,
            viewOffset: viewOffset,
            seriesId: item.SeriesId || null,
            seasonId: item.SeasonId || null,
            parentId: item.ParentId || null,
            parentRatingKey: item.SeasonId || item.ParentId || null,
            grandparentRatingKey: item.SeriesId || null,
            index: item.IndexNumber,
            parentIndex: item.ParentIndexNumber,
            videoResolution: null,
            height: item.Height != null ? Number(item.Height) : null,
            width: item.Width != null ? Number(item.Width) : null,
            videoCodec: null,
            audioCodec: null,
            container: item.Container || null,
            videoRange: item.VideoRange || null,
            hdr: false,
            audioLanguage: null,
            subtitleLanguage: null,
            audioLanguages: [],
            subtitleLanguages: [],
            libraryType: programType,
        };

        let mediaSource = (item.MediaSources && item.MediaSources[0]) ? item.MediaSources[0] : null;
        if (programType === 'movie' || programType === 'episode' || programType === 'track') {
            program.plexFile = '/Videos/' + item.Id + '/stream?static=true';
            program.mediaSourceId = mediaSource ? mediaSource.Id : item.Id;
            if (mediaSource && mediaSource.Path) program.file = mediaSource.Path;
            else if (item.Path) program.file = item.Path;
            // Tracks without duration are useless; movies/episodes still cache even if runtime missing
            if (programType === 'track' && !(program.duration > 0)) return null;
            if ((programType === 'movie' || programType === 'episode') && !(program.duration > 0)) {
                program.duration = 0;
            }
        }

        // Media streams → resolution, languages, HDR
        try {
            let streams = [];
            if (mediaSource && Array.isArray(mediaSource.MediaStreams)) {
                streams = mediaSource.MediaStreams;
            } else if (Array.isArray(item.MediaStreams)) {
                streams = item.MediaStreams;
            }
            let audioLangs = [];
            let subLangs = [];
            let hdr = false;
            for (let si = 0; si < streams.length; si++) {
                let st = streams[si];
                if (!st) continue;
                let stype = String(st.Type || '').toLowerCase();
                if (stype === 'video') {
                    if (st.Height != null && !program.height) program.height = Number(st.Height);
                    if (st.Width != null && !program.width) program.width = Number(st.Width);
                    if (st.Codec) program.videoCodec = st.Codec;
                    let vr = st.VideoRange || st.VideoRangeType || item.VideoRange || '';
                    if (vr) program.videoRange = vr;
                    let blob = [vr, st.DisplayTitle, st.Title, st.Profile].filter(Boolean).join(' ').toLowerCase();
                    if (
                        blob.indexOf('hdr') >= 0
                        || blob.indexOf('dolby') >= 0
                        || blob.indexOf('hlg') >= 0
                        || String(vr).toLowerCase().indexOf('hdr') >= 0
                    ) {
                        hdr = true;
                    }
                } else if (stype === 'audio') {
                    if (st.Codec && !program.audioCodec) program.audioCodec = st.Codec;
                    let lang = st.Language || st.DisplayLanguage || st.DisplayTitle || '';
                    if (lang) audioLangs.push(String(lang));
                } else if (stype === 'subtitle') {
                    let lang = st.Language || st.DisplayLanguage || st.DisplayTitle || '';
                    if (lang) subLangs.push(String(lang));
                }
            }
            program.hdr = hdr;
            program.audioLanguages = audioLangs;
            program.subtitleLanguages = subLangs;
            program.audioLanguage = audioLangs.length ? audioLangs[0] : null;
            program.subtitleLanguage = subLangs.length ? subLangs[0] : null;
            if (program.height != null) {
                let h = Number(program.height);
                if (h >= 2000) program.videoResolution = '4k';
                else if (h >= 1080) program.videoResolution = '1080';
                else if (h >= 720) program.videoResolution = '720';
                else if (h > 0) program.videoResolution = 'sd';
            }
        } catch (e) { /* ignore stream parse */ }

        if (programType === 'episode') {
            program.showTitle = item.SeriesName || item.Name;
            program.episode = item.IndexNumber;
            program.season = item.ParentIndexNumber;
            program.episodeIcon = program.icon;
            if (item.SeriesId) {
                program.showIcon = this._imageUrl(server, item.SeriesId, item.SeriesPrimaryImageTag);
                program.icon = program.showIcon;
            }
            if (item.SeasonId) {
                program.seasonIcon = this._imageUrl(server, item.SeasonId, null);
            }
        } else if (programType === 'movie') {
            program.showTitle = item.Name;
            program.episode = 1;
            program.season = 1;
        } else if (programType === 'show') {
            program.showTitle = item.Name;
            program.seasonCount = item.ChildCount;
            program.episodeCount = item.RecursiveItemCount;
            program.network = item.SeriesStudio || program.network;
        } else if (programType === 'season') {
            program.showTitle = item.SeriesName;
            program.season = item.IndexNumber;
        }

        return program;
    }

    async _fetchAllItems(client, qsBase, onPage) {
        let all = [];
        let start = 0;
        let total = Infinity;
        let fields = (qsBase && qsBase.Fields) || ITEM_FIELDS;
        let triedMinimal = false;
        while (start < total) {
            let qs = Object.assign({}, qsBase, {
                StartIndex: start,
                Limit: PAGE_SIZE,
                Fields: fields,
                EnableUserData: 'true',
                EnableImages: 'false',
            });
            let userId = await client.ensureUserId();
            let res;
            try {
                res = await client.Get('/Users/' + userId + '/Items', qs);
            } catch (err) {
                // Some Jellyfin builds reject long Fields lists — retry once with minimal fields
                if (!triedMinimal && fields !== ITEM_FIELDS_MINIMAL) {
                    console.error(
                        'jellyfin-cache: Items query failed, retrying with minimal fields:',
                        err.message || err
                    );
                    fields = ITEM_FIELDS_MINIMAL;
                    triedMinimal = true;
                    continue;
                }
                throw err;
            }
            let page = (res && res.Items) ? res.Items : [];
            let totalRecordCount = res && typeof res.TotalRecordCount === 'number'
                ? res.TotalRecordCount
                : null;
            if (totalRecordCount != null) {
                total = totalRecordCount;
            } else if (page.length < PAGE_SIZE) {
                total = start + page.length;
            } else {
                total = start + page.length + PAGE_SIZE;
            }
            all = all.concat(page);
            start += page.length;
            if (typeof onPage === 'function') {
                try { onPage(start, total === Infinity ? start : total); } catch (e) { /* ignore */ }
            }
            if (page.length === 0) break;
            if (start > 500000) break;
        }
        return all;
    }

    async _listViews(client) {
        let views = await client.getViews();
        let out = [];
        for (let i = 0; i < views.length; i++) {
            let v = views[i];
            let libType = this._collectionTypeToLibType(v.CollectionType);
            if (!libType) continue;
            out.push({
                key: v.Id,
                title: v.Name,
                type: libType,
                collectionType: v.CollectionType,
            });
        }
        return out;
    }

    async _syncLibraryFull(server, section, progressKey) {
        let client = this._client(server);
        let sectionKey = String(section.key);
        let type = section.type;
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
        let seasons = {};
        let episodes = {};
        let tracks = {};

        let baseQs = {
            ParentId: sectionKey,
            Recursive: 'true',
            Fields: ITEM_FIELDS,
            SortBy: 'SortName',
            SortOrder: 'Ascending',
        };

        if (type === 'movie') {
            report(5, 'movies', 'Fetching movies…');
            let metas = await this._fetchAllItems(
                client,
                Object.assign({}, baseQs, { IncludeItemTypes: 'Movie' }),
                (fetched, total) => {
                    let p = total > 0 ? 5 + (fetched / total) * 70 : 40;
                    report(p, 'movies', 'Movies ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < metas.length; i++) {
                let p = this._itemToProgram(server, metas[i]);
                if (p) items[p.ratingKey] = p;
            }
        } else if (type === 'show') {
            report(5, 'shows', 'Fetching series…');
            let showMetas = await this._fetchAllItems(
                client,
                Object.assign({}, baseQs, { IncludeItemTypes: 'Series' }),
                (fetched, total) => {
                    let p = total > 0 ? 5 + (fetched / total) * 20 : 15;
                    report(p, 'shows', 'Shows ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < showMetas.length; i++) {
                let p = this._itemToProgram(server, showMetas[i]);
                if (p) shows[p.ratingKey] = p;
            }
            report(28, 'seasons', 'Fetching seasons…');
            let seasonMetas = await this._fetchAllItems(
                client,
                Object.assign({}, baseQs, { IncludeItemTypes: 'Season' }),
                (fetched, total) => {
                    let p = total > 0 ? 28 + (fetched / total) * 15 : 35;
                    report(p, 'seasons', 'Seasons ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < seasonMetas.length; i++) {
                let p = this._itemToProgram(server, seasonMetas[i]);
                if (p) seasons[p.ratingKey] = p;
            }
            report(45, 'episodes', 'Fetching episodes…');
            let epMetas = await this._fetchAllItems(
                client,
                Object.assign({}, baseQs, { IncludeItemTypes: 'Episode' }),
                (fetched, total) => {
                    let p = total > 0 ? 45 + (fetched / total) * 30 : 60;
                    report(p, 'episodes', 'Episodes ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < epMetas.length; i++) {
                let p = this._itemToProgram(server, epMetas[i]);
                if (p) episodes[p.ratingKey] = p;
            }
        } else if (type === 'artist') {
            report(5, 'tracks', 'Fetching tracks…');
            let trackMetas = await this._fetchAllItems(
                client,
                Object.assign({}, baseQs, { IncludeItemTypes: 'Audio' }),
                (fetched, total) => {
                    let p = total > 0 ? 5 + (fetched / total) * 70 : 40;
                    report(p, 'tracks', 'Tracks ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            for (let i = 0; i < trackMetas.length; i++) {
                let p = this._itemToProgram(server, trackMetas[i]);
                if (p && p.duration > 0) tracks[p.ratingKey] = p;
            }
        }

        // Per-library genres (BoxSets are global — synced separately once per server)
        let genres = [];
        let favorites = null;
        if (type === 'movie' || type === 'show' || type === 'artist') {
            report(80, 'genres', 'Fetching genres…');
            try {
                genres = await this._fetchLibraryGenres(server, client, section, (ci, ct) => {
                    let p = ct > 0 ? 80 + (ci / ct) * 12 : 88;
                    report(p, 'genres', 'Genres ' + ci + '/' + ct);
                });
            } catch (e) {
                console.error('jellyfin-cache: genres failed for', section.title, e.message || e);
            }
            report(93, 'favorites', 'Fetching favorites…');
            try {
                favorites = await this._fetchLibraryFavorites(server, client, section);
            } catch (e) {
                console.error('jellyfin-cache: favorites failed for', section.title, e.message || e);
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
            seasons: seasons,
            episodes: episodes,
            tracks: tracks,
            genres: genres,
            favorites: favorites,
            // legacy field kept empty; global boxsets live in server collections.json
            collections: [],
        };
        this._saveLibraryData(server.name, sectionKey, payload);
        return {
            itemCount:
                Object.keys(items).length +
                Object.keys(shows).length +
                Object.keys(seasons).length +
                Object.keys(episodes).length +
                Object.keys(tracks).length,
            collectionCount: genres.length,
            genreCount: genres.length,
            lastFullSyncAt: now,
            lastSyncAt: now,
        };
    }

    /**
     * Global BoxSet collections (not scoped to a single library view).
     */
    async _syncGlobalCollections(server) {
        let client = this._client(server);
        let metas = await this._fetchAllItems(client, {
            Recursive: 'true',
            IncludeItemTypes: 'BoxSet',
            Fields: ITEM_FIELDS,
            SortBy: 'SortName',
            SortOrder: 'Ascending',
        });
        let list = [];
        for (let i = 0; i < metas.length; i++) {
            let m = metas[i];
            let children = [];
            try {
                let childMetas = await this._fetchAllItems(client, {
                    ParentId: m.Id,
                    Recursive: 'true',
                    Fields: ITEM_FIELDS,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                });
                for (let c = 0; c < childMetas.length; c++) {
                    let cp = this._itemToProgram(server, childMetas[c]);
                    if (cp && (cp.type === 'movie' || cp.type === 'episode' || cp.type === 'show' || cp.type === 'track')) {
                        children.push(cp);
                    }
                }
            } catch (e) {
                console.error('jellyfin-cache: global collection children failed', m.Name, e.message || e);
            }
            let agg = this._aggregateFilterFields(children);
            list.push(Object.assign({
                title: m.Name,
                key: '/Items/' + m.Id,
                ratingKey: m.Id,
                jellyfinId: m.Id,
                type: 'collection',
                collectionKind: 'boxset',
                collectionType: 'mixed',
                libraryTitle: 'Collections',
                icon: this._imageUrl(server, m.Id, m.ImageTags && m.ImageTags.Primary),
                count: children.length,
                children: children,
                updatedAt: this._modifiedMs(m),
                source: 'jellyfin',
            }, agg));
        }
        let now = Date.now();
        this._saveCollectionsData(server.name, {
            serverName: server.name,
            lastSyncAt: now,
            collections: list,
        });
        return { count: list.length, lastSyncAt: now };
    }

    /**
     * Genres scoped to a library view; stored as collection-like rows for UI.
     */
    async _fetchLibraryGenres(server, client, section, onProgress) {
        let sectionKey = String(section.key);
        let userId = await client.ensureUserId();
        let genres = [];
        let genreList = [];
        try {
            // Primary: /Genres?ParentId=library
            let res = await client.Get('/Genres', {
                UserId: userId,
                ParentId: sectionKey,
                SortBy: 'SortName',
                SortOrder: 'Ascending',
            });
            genreList = (res && res.Items) ? res.Items : (Array.isArray(res) ? res : []);
        } catch (e) {
            console.error('jellyfin-cache: GET /Genres failed, trying Items Genre', e.message || e);
            try {
                genreList = await this._fetchAllItems(client, {
                    ParentId: sectionKey,
                    Recursive: 'false',
                    IncludeItemTypes: 'Genre,MusicGenre',
                    Fields: 'ChildCount,RecursiveItemCount',
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                });
            } catch (e2) {
                console.error('jellyfin-cache: genre list failed', section.title, e2.message || e2);
                return [];
            }
        }

        let includeTypes = 'Movie';
        if (section.type === 'show') includeTypes = 'Series';
        else if (section.type === 'artist') includeTypes = 'Audio,MusicAlbum';

        for (let i = 0; i < genreList.length; i++) {
            let g = genreList[i];
            if (!g || !g.Id) continue;
            let children = [];
            try {
                let childMetas = await this._fetchAllItems(client, {
                    ParentId: sectionKey,
                    Recursive: 'true',
                    GenreIds: g.Id,
                    IncludeItemTypes: includeTypes,
                    Fields: ITEM_FIELDS,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                });
                for (let c = 0; c < childMetas.length; c++) {
                    let cp = this._itemToProgram(server, childMetas[c]);
                    if (!cp) continue;
                    if (section.type === 'movie' && cp.type === 'movie' && cp.duration > 0) {
                        children.push(cp);
                    } else if (section.type === 'show' && cp.type === 'show') {
                        children.push(cp);
                    } else if (section.type === 'artist' && (cp.type === 'track' || cp.type === 'album') && (cp.duration > 0 || cp.type === 'album')) {
                        children.push(cp);
                    }
                }
            } catch (e) {
                console.error('jellyfin-cache: genre children failed', g.Name, e.message || e);
            }
            // Skip empty genres
            if (!children.length) {
                if (typeof onProgress === 'function') {
                    try { onProgress(i + 1, genreList.length); } catch (e2) { /* ignore */ }
                }
                continue;
            }
            let agg = this._aggregateFilterFields(children);
            // Genre row itself is named by genre — ensure genres array includes the name for live filters
            let genreNames = [g.Name].concat(agg.genres || []);
            let seenG = {};
            let genresUniq = [];
            for (let gi = 0; gi < genreNames.length; gi++) {
                let gn = String(genreNames[gi] || '');
                if (!gn || seenG[gn]) continue;
                seenG[gn] = true;
                genresUniq.push(gn);
            }
            genres.push(Object.assign({
                title: g.Name + ' (Genre)',
                key: this.genreCollectionKey(sectionKey, g.Id),
                ratingKey: g.Id,
                jellyfinId: g.Id,
                genreId: g.Id,
                type: 'collection',
                collectionKind: 'genre',
                collectionType: section.type,
                libraryTitle: section.title,
                librarySectionKey: sectionKey,
                libraryType: section.type,
                icon: this._imageUrl(server, g.Id, g.ImageTags && g.ImageTags.Primary),
                count: children.length,
                children: children,
                source: 'jellyfin',
            }, agg, { genres: genresUniq }));
            if (typeof onProgress === 'function') {
                try { onProgress(i + 1, genreList.length); } catch (e2) { /* ignore */ }
            }
        }
        return genres;
    }

    /**
     * Per-library favorites (user favorites scoped to this view).
     * Returned as a playlist-shaped object for the playlists UI section.
     */
    async _fetchLibraryFavorites(server, client, section) {
        let sectionKey = String(section.key);
        let includeTypes = 'Movie';
        if (section.type === 'show') includeTypes = 'Series,Episode';
        else if (section.type === 'artist') includeTypes = 'Audio,MusicAlbum';

        let childMetas = [];
        try {
            childMetas = await this._fetchAllItems(client, {
                ParentId: sectionKey,
                Recursive: 'true',
                Filters: 'IsFavorite',
                IncludeItemTypes: includeTypes,
                Fields: ITEM_FIELDS,
                SortBy: 'SortName',
                SortOrder: 'Ascending',
            });
        } catch (e) {
            // Some versions prefer IsFavorite=true instead of Filters
            try {
                childMetas = await this._fetchAllItems(client, {
                    ParentId: sectionKey,
                    Recursive: 'true',
                    IsFavorite: 'true',
                    IncludeItemTypes: includeTypes,
                    Fields: ITEM_FIELDS,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                });
            } catch (e2) {
                console.error('jellyfin-cache: favorites query failed', section.title, e2.message || e2);
                return null;
            }
        }

        let children = [];
        for (let c = 0; c < childMetas.length; c++) {
            let cp = this._itemToProgram(server, childMetas[c]);
            if (!cp) continue;
            if (cp.type === 'movie' || cp.type === 'episode' || cp.type === 'track') {
                if (cp.duration > 0) children.push(cp);
            } else if (cp.type === 'show' || cp.type === 'season' || cp.type === 'album') {
                children.push(cp);
            }
        }

        let agg = this._aggregateFilterFields(children);
        return Object.assign({
            title: section.title + ' — Favorites',
            key: this.favoritesPlaylistKey(sectionKey),
            ratingKey: 'favorites-' + sectionKey,
            type: 'playlist',
            playlistKind: 'favorites',
            libraryTitle: section.title,
            librarySectionKey: sectionKey,
            libraryType: section.type,
            icon: '',
            count: children.length,
            children: children,
            source: 'jellyfin',
        }, agg);
    }

    async _syncLibraryIncremental(server, section, progressKey) {
        let sectionKey = String(section.key);
        let existing = this.getCachedLibraryData(server.name, sectionKey);
        let key = progressKey || this.libSyncKey(server.name, sectionKey);
        if (!existing || !existing.lastFullSyncAt) {
            return await this._syncLibraryFull(server, section, key);
        }
        if (!existing.items) existing.items = {};
        if (!existing.shows) existing.shows = {};
        if (!existing.seasons) existing.seasons = {};
        if (!existing.episodes) existing.episodes = {};
        if (!existing.tracks) existing.tracks = {};
        if (!existing.genres) existing.genres = [];
        existing.collections = []; // boxsets are global now

        let client = this._client(server);
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

        const upsertMap = async (mapName, includeTypes, basePct, spanPct, phase, requireDuration) => {
            let remote = await this._fetchAllItems(
                client,
                {
                    ParentId: sectionKey,
                    Recursive: 'true',
                    IncludeItemTypes: includeTypes,
                    Fields: ITEM_FIELDS,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                },
                (fetched, total) => {
                    let p = total > 0 ? basePct + (fetched / total) * spanPct : basePct + spanPct / 2;
                    report(p, phase, phase + ' ' + fetched + (total < Infinity ? '/' + total : ''));
                }
            );
            let seen = {};
            for (let i = 0; i < remote.length; i++) {
                let p = this._itemToProgram(server, remote[i]);
                if (!p) continue;
                if (requireDuration && !(p.duration > 0)) continue;
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

        // Only tracks require duration > 0 (unplayable otherwise). Movies/episodes
        // with missing RunTimeTicks must still upsert — skipping them also removed
        // them from cache (not in `seen`), which looked like "sync did nothing".
        if (type === 'movie') {
            await upsertMap('items', 'Movie', 5, 70, 'movies', false);
        } else if (type === 'show') {
            await upsertMap('shows', 'Series', 5, 20, 'shows', false);
            await upsertMap('seasons', 'Season', 28, 15, 'seasons', false);
            await upsertMap('episodes', 'Episode', 45, 30, 'episodes', false);
        } else if (type === 'artist') {
            await upsertMap('tracks', 'Audio', 5, 70, 'tracks', true);
        }

        if (type === 'movie' || type === 'show' || type === 'artist') {
            report(80, 'genres', 'Refreshing genres…');
            try {
                existing.genres = await this._fetchLibraryGenres(server, client, section, (ci, ct) => {
                    let p = ct > 0 ? 80 + (ci / ct) * 12 : 88;
                    report(p, 'genres', 'Genres ' + ci + '/' + ct);
                });
            } catch (e) {
                console.error('jellyfin-cache: incremental genres failed', e.message || e);
            }
            report(93, 'favorites', 'Refreshing favorites…');
            try {
                existing.favorites = await this._fetchLibraryFavorites(server, client, section);
            } catch (e) {
                console.error('jellyfin-cache: incremental favorites failed', e.message || e);
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
                Object.keys(existing.seasons || {}).length +
                Object.keys(existing.episodes || {}).length +
                Object.keys(existing.tracks || {}).length,
            collectionCount: (existing.genres || []).length,
            genreCount: (existing.genres || []).length,
            lastFullSyncAt: existing.lastFullSyncAt,
            lastSyncAt: now,
            added: added,
            updated: updated,
            removed: removed,
            mode: 'incremental',
        };
    }

    async _syncPlaylists(server) {
        let client = this._client(server);
        let metas = await this._fetchAllItems(client, {
            Recursive: 'true',
            IncludeItemTypes: 'Playlist',
            Fields: ITEM_FIELDS,
            SortBy: 'SortName',
            SortOrder: 'Ascending',
        });
        let list = [];
        for (let i = 0; i < metas.length; i++) {
            let m = metas[i];
            let children = [];
            try {
                let childMetas = await this._fetchAllItems(client, {
                    ParentId: m.Id,
                    Recursive: 'true',
                    Fields: ITEM_FIELDS,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                });
                for (let c = 0; c < childMetas.length; c++) {
                    let cp = this._itemToProgram(server, childMetas[c]);
                    if (cp && (cp.type === 'movie' || cp.type === 'episode' || cp.type === 'track') && cp.duration > 0) {
                        children.push(cp);
                    } else if (cp && (cp.type === 'show' || cp.type === 'season')) {
                        children.push(cp);
                    }
                }
            } catch (e) {
                console.error('jellyfin-cache: playlist items failed', m.Name, e.message || e);
            }
            let agg = this._aggregateFilterFields(children);
            list.push(Object.assign({
                title: m.Name,
                key: '/Items/' + m.Id,
                ratingKey: m.Id,
                icon: this._imageUrl(server, m.Id, m.ImageTags && m.ImageTags.Primary),
                count: children.length,
                children: children,
                updatedAt: this._modifiedMs(m),
                type: 'playlist',
                source: 'jellyfin',
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
            let client = this._client(server);
            let views = await this._listViews(client);
            let section = null;
            for (let i = 0; i < views.length; i++) {
                if (String(views[i].key) === String(sectionKey)) {
                    section = views[i];
                    break;
                }
            }
            if (!section) {
                return { ok: false, error: 'Library view not found on Jellyfin', key: key };
            }

            doc.librarySync[key] = Object.assign({}, doc.librarySync[key] || {}, {
                serverName: serverName,
                sectionKey: String(sectionKey),
                title: section.title,
                type: section.type,
                status: 'syncing',
                error: null,
                source: 'jellyfin',
            });
            this.saveSettingsDoc(doc);

            console.log(
                'dizqueTV jellyfin-cache: syncing ' + serverName + ' / ' + section.title +
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

            // Keep global BoxSet list fresh when missing or full sync
            try {
                if (options.full || !this.hasCollectionsCache(serverName)) {
                    await this._syncGlobalCollections(server);
                }
            } catch (colErr) {
                console.error('jellyfin-cache: global collections refresh failed', colErr.message || colErr);
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
                source: 'jellyfin',
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
            if (this._progressMem) delete this._progressMem[key];
            if (this._progressThrottle) delete this._progressThrottle[key];

            return { ok: true, key: key, result: result, status: doc.librarySync[key] };
        } catch (err) {
            console.error('dizqueTV jellyfin-cache: sync library failed', err);
            try {
                doc = this.getSettingsDoc();
                doc.librarySync[key] = Object.assign({}, doc.librarySync[key] || {}, {
                    status: 'error',
                    error: err.message || String(err),
                });
                this.saveSettingsDoc(doc);
            } catch (e2) { /* ignore */ }
            if (this._progressMem) delete this._progressMem[key];
            if (this._progressThrottle) delete this._progressThrottle[key];
            return { ok: false, error: err.message || String(err), key: key };
        } finally {
            delete this._syncing[key];
        }
    }

    async syncAll(options) {
        options = options || {};
        let servers = this.db['jellyfin-servers'].find() || [];
        let results = [];
        let doc = this.getSettingsDoc();

        for (let s = 0; s < servers.length; s++) {
            let server = servers[s];
            try {
                let client = this._client(server);
                let views = await this._listViews(client);
                for (let i = 0; i < views.length; i++) {
                    let d = views[i];
                    if (this._isDisabled(server.name, d.key)) continue;
                    let existing = this.getCachedLibraryData(server.name, d.key);
                    let full = options.full === true || !existing || !existing.lastFullSyncAt;
                    let r = await this.syncLibrary(server.name, d.key, { full: full });
                    results.push(r);
                }
                let pl = await this._syncPlaylists(server);
                results.push({ ok: true, playlists: pl, serverName: server.name });
                // Global BoxSets once per server (not per library)
                let cols = await this._syncGlobalCollections(server);
                results.push({ ok: true, collections: cols, serverName: server.name });
            } catch (err) {
                console.error('dizqueTV jellyfin-cache: syncAll server failed', server.name, err);
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

    deleteLibraryCache(serverName, sectionKey) {
        let libDir = this._libDir(serverName, sectionKey);
        try {
            if (fs.existsSync(libDir)) {
                let files = fs.readdirSync(libDir);
                for (let i = 0; i < files.length; i++) {
                    fs.unlinkSync(path.join(libDir, files[i]));
                }
                fs.rmdirSync(libDir);
            }
        } catch (e) {
            console.error('jellyfin-cache: delete library failed', e.message || e);
        }
        let mem = this._mem[String(serverName || '')];
        if (mem && mem.libraries) delete mem.libraries[String(sectionKey)];
        let doc = this.getSettingsDoc();
        let key = this.libSyncKey(serverName, sectionKey);
        if (doc.librarySync[key]) {
            delete doc.librarySync[key];
            this.saveSettingsDoc(doc);
        }
        return { ok: true, key: key };
    }

    deleteAllCache() {
        try {
            if (fs.existsSync(this.root)) {
                const rm = (dir) => {
                    let entries = fs.readdirSync(dir);
                    for (let i = 0; i < entries.length; i++) {
                        let p = path.join(dir, entries[i]);
                        let st = fs.statSync(p);
                        if (st.isDirectory()) rm(p);
                        else fs.unlinkSync(p);
                    }
                    try { fs.rmdirSync(dir); } catch (e) { /* ignore */ }
                };
                rm(this.root);
                this._ensureDir(this.root);
            }
        } catch (e) {
            console.error('jellyfin-cache: delete all failed', e.message || e);
        }
        this._mem = {};
        let doc = this.getSettingsDoc();
        doc.librarySync = {};
        doc.lastGlobalSyncAt = null;
        this.saveSettingsDoc(doc);
        return { ok: true };
    }

    // ---------- Cache reads ----------

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

    hasServerCache(serverName) {
        return this.hasPlaylistCache(serverName) || this.hasLibraryCache(serverName);
    }

    hasPlaylistCache(serverName) {
        let mem = this._mem[String(serverName || '')];
        return !!(mem && mem.playlists);
    }

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
     * @param {string} serverName
     * @param {{ includeDisabled?: boolean, includeHidden?: boolean }} [options]
     */
    getCachedSections(serverName, options) {
        options = options || {};
        let mem = this._mem[String(serverName || '')];
        if (!mem || !mem.libraries) return [];
        let sections = [];
        let keys = Object.keys(mem.libraries);
        for (let i = 0; i < keys.length; i++) {
            let data = mem.libraries[keys[i]];
            if (!data) continue;
            if (!options.includeDisabled && this._isDisabled(serverName, data.sectionKey)) continue;
            if (!options.includeHidden && this._isHidden(serverName, data.sectionKey)) continue;
            sections.push({
                title: data.title,
                key: data.sectionKey,
                sectionKey: String(data.sectionKey),
                type: data.type,
                serverName: serverName,
                icon: '',
                genres: [],
                fromCache: true,
                source: 'jellyfin',
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
     * Nested children for library section id, /Items/{id} (show/season/collection/playlist).
     */
    getCachedNested(serverName, key, options) {
        options = options || {};
        let includeCollections = options.includeCollections !== false;
        let mem = this._mem[String(serverName || '')];
        if (!mem) return null;

        let raw = String(key || '');
        let itemId = raw;
        let mItems = raw.match(/\/Items\/([^/?#]+)/i);
        if (mItems) itemId = mItems[1];

        // Library section by id
        let data = this.getCachedLibraryData(serverName, itemId);
        if (data && data.lastSyncAt) {
            let nested = [];
            if (data.type === 'movie') {
                nested = Object.keys(data.items || {}).map((k) => Object.assign({}, data.items[k]));
            } else if (data.type === 'show') {
                nested = Object.keys(data.shows || {}).map((k) => Object.assign({}, data.shows[k]));
            } else if (data.type === 'artist') {
                nested = Object.keys(data.tracks || {}).map((k) => Object.assign({}, data.tracks[k]));
            }
            if (includeCollections) {
                // Per-library genres only (global BoxSets appear in the collections list, not under each lib)
                let gens = (data.genres || []).map((c) => Object.assign({}, c, {
                    type: 'collection',
                    source: 'jellyfin',
                }));
                nested = gens.concat(nested);
            }
            return { nested: nested, fromCache: true };
        }

        // Genre key: /Genres/{id}/Library/{sectionKey}
        let genreMatch = raw.match(/^\/Genres\/([^/]+)\/Library\/([^/?#]+)/i);
        if (genreMatch) {
            let gId = genreMatch[1];
            let sec = genreMatch[2];
            let libData = this.getCachedLibraryData(serverName, sec);
            if (libData && Array.isArray(libData.genres)) {
                for (let c = 0; c < libData.genres.length; c++) {
                    let col = libData.genres[c];
                    if (String(col.genreId || col.ratingKey) === String(gId) || col.key === raw) {
                        return {
                            nested: (col.children || []).map((ch) => Object.assign({}, ch)),
                            fromCache: true,
                            kind: 'genre',
                        };
                    }
                }
            }
        }

        // Global BoxSet collections
        let gcols = this.getCachedGlobalCollections(serverName);
        if (gcols && gcols.collections) {
            for (let c = 0; c < gcols.collections.length; c++) {
                let col = gcols.collections[c];
                if (col.ratingKey === itemId || col.key === raw || col.jellyfinId === itemId) {
                    return {
                        nested: (col.children || []).map((ch) => Object.assign({}, ch)),
                        fromCache: true,
                        kind: 'collection',
                    };
                }
            }
        }

        // Per-library genres (match by genre id or full key)
        let libKeys = mem.libraries ? Object.keys(mem.libraries) : [];
        for (let i = 0; i < libKeys.length; i++) {
            let lib = mem.libraries[libKeys[i]];
            if (!lib || !lib.genres) continue;
            for (let c = 0; c < lib.genres.length; c++) {
                let col = lib.genres[c];
                if (col.key === raw || String(col.genreId || col.ratingKey) === String(itemId)) {
                    return {
                        nested: (col.children || []).map((ch) => Object.assign({}, ch)),
                        fromCache: true,
                        kind: 'genre',
                    };
                }
            }
        }

        // Per-library favorites virtual playlists
        let favMatch = raw.match(/^\/Favorites\/Library\/([^/?#]+)/i);
        if (favMatch) {
            let sec = favMatch[1];
            let libData = this.getCachedLibraryData(serverName, sec);
            if (libData && libData.favorites) {
                return {
                    nested: (libData.favorites.children || []).map((ch) => Object.assign({}, ch)),
                    fromCache: true,
                    kind: 'favorites',
                };
            }
        }

        let pl = this.getCachedPlaylists(serverName);
        if (pl && pl.playlists) {
            for (let i = 0; i < pl.playlists.length; i++) {
                let playlist = pl.playlists[i];
                if (playlist.ratingKey === itemId || playlist.key === raw) {
                    return {
                        nested: (playlist.children || []).map((ch) => Object.assign({}, ch)),
                        fromCache: true,
                        kind: 'playlist',
                    };
                }
            }
        }

        // Show → seasons, season → episodes
        for (let i = 0; i < libKeys.length; i++) {
            let lib = mem.libraries[libKeys[i]];
            if (!lib) continue;

            if (lib.shows && lib.shows[itemId]) {
                let seasons = Object.keys(lib.seasons || {})
                    .map((k) => lib.seasons[k])
                    .filter((s) => String(s.seriesId || s.grandparentRatingKey || s.parentId) === String(itemId));
                seasons.sort((a, b) => (Number(a.season) || 0) - (Number(b.season) || 0));
                if (seasons.length) {
                    return { nested: seasons.map((s) => Object.assign({}, s)), fromCache: true, note: 'seasons' };
                }
                // Fallback: group episodes by season if seasons map empty
                let eps = Object.keys(lib.episodes || {})
                    .map((k) => lib.episodes[k])
                    .filter((ep) => String(ep.seriesId || ep.grandparentRatingKey) === String(itemId));
                if (eps.length) {
                    eps.sort((a, b) => {
                        let sa = Number(a.season) || 0;
                        let sb = Number(b.season) || 0;
                        if (sa !== sb) return sa - sb;
                        return (Number(a.episode) || 0) - (Number(b.episode) || 0);
                    });
                    return { nested: eps.map((ep) => Object.assign({}, ep)), fromCache: true, note: 'episodes-flat' };
                }
                return { nested: [], fromCache: true, note: 'empty-show' };
            }

            if (lib.seasons && lib.seasons[itemId]) {
                let eps = Object.keys(lib.episodes || {})
                    .map((k) => lib.episodes[k])
                    .filter((ep) => String(ep.seasonId || ep.parentRatingKey || ep.parentId) === String(itemId));
                eps.sort((a, b) => (Number(a.episode) || 0) - (Number(b.episode) || 0));
                return { nested: eps.map((ep) => Object.assign({}, ep)), fromCache: true, note: 'episodes' };
            }
        }

        return null;
    }

    getCachedCollectionsList(serverName, options) {
        // Authoritative when we have global collections and/or any library genres
        options = options || {};
        let hasGlobal = this.hasCollectionsCache(serverName);
        let hasLibs = this.hasLibraryCache(serverName);
        if (!hasGlobal && !hasLibs) {
            return { list: null, fromCache: false };
        }
        // List entries only — omit children (nested endpoint expands from cache by key).
        let self = this;
        function listRow(col, extra) {
            let row = Object.assign({}, self._filterFieldsFromProgram(col), col, extra || {});
            // Prefer explicit count; fall back to children length
            if ((row.count == null || row.count === '') && Array.isArray(col.children)) {
                row.count = col.children.length;
            }
            delete row.children;
            return row;
        }
        function isEmptyListSource(src) {
            if (!src) return true;
            if (Array.isArray(src.children) && src.children.length === 0) return true;
            let c = src.count;
            if (c == null || c === '') {
                if (Array.isArray(src.children)) return src.children.length === 0;
                return false; // unknown — keep
            }
            let n = parseInt(c, 10);
            return !isNaN(n) && n <= 0;
        }
        let all = [];
        // 1) Global BoxSets once — hide when all members are from "Hide content" libraries
        let gcols = this.getCachedGlobalCollections(serverName);
        if (gcols && Array.isArray(gcols.collections)) {
            for (let c = 0; c < gcols.collections.length; c++) {
                let col = gcols.collections[c];
                if (isEmptyListSource(col)) continue;
                if (!options.includeHidden && this._isListSourceHidden(serverName, col)) continue;
                all.push(listRow(col, {
                    type: 'collection',
                    collectionKind: col.collectionKind || 'boxset',
                    libraryTitle: col.libraryTitle || 'Collections',
                    source: 'jellyfin',
                }));
            }
        }
        // 2) Per-library genres (respect hidden libraries unless includeHidden)
        let sections = this.getCachedSections(serverName, options);
        for (let i = 0; i < sections.length; i++) {
            let data = this.getCachedLibraryData(serverName, sections[i].sectionKey);
            if (!data) continue;
            let gens = data.genres || [];
            for (let c = 0; c < gens.length; c++) {
                let col = gens[c];
                if (isEmptyListSource(col)) continue;
                if (!options.includeHidden && this._isListSourceHidden(serverName, Object.assign({}, col, {
                    libraryTitle: col.libraryTitle || data.title,
                    sectionKey: data.sectionKey || sections[i].sectionKey,
                    librarySectionKey: data.sectionKey || sections[i].sectionKey,
                }))) continue;
                all.push(listRow(col, {
                    type: 'collection',
                    collectionKind: 'genre',
                    libraryTitle: col.libraryTitle || data.title,
                    sectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                    librarySectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                    source: 'jellyfin',
                }));
            }
            // Legacy: old per-library collections caches (pre-global)
            let legacy = data.collections || [];
            for (let c = 0; c < legacy.length; c++) {
                let col = legacy[c];
                if (isEmptyListSource(col)) continue;
                // Skip if already present as global boxset
                if (all.some((a) => a.ratingKey && a.ratingKey === col.ratingKey && a.collectionKind !== 'genre')) {
                    continue;
                }
                if (!options.includeHidden && this._isListSourceHidden(serverName, Object.assign({}, col, {
                    libraryTitle: col.libraryTitle || data.title,
                    sectionKey: data.sectionKey || sections[i].sectionKey,
                    librarySectionKey: data.sectionKey || sections[i].sectionKey,
                }))) continue;
                all.push(listRow(col, {
                    type: 'collection',
                    collectionKind: col.collectionKind || 'boxset',
                    libraryTitle: col.libraryTitle || data.title || 'Collections',
                    sectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                    librarySectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                    source: 'jellyfin',
                }));
            }
        }
        return { list: all, fromCache: true };
    }

    getCachedShowsList(serverName, options) {
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
            for (let k = 0; k < keys.length; k++) {
                let show = data.shows[keys[k]];
                let seasonCount = 0;
                let episodeCount = 0;
                if (data.seasons) {
                    Object.keys(data.seasons).forEach((sk) => {
                        let s = data.seasons[sk];
                        if (String(s.seriesId || s.grandparentRatingKey) === String(show.ratingKey)) {
                            seasonCount++;
                        }
                    });
                }
                if (data.episodes) {
                    Object.keys(data.episodes).forEach((ek) => {
                        let ep = data.episodes[ek];
                        if (String(ep.seriesId || ep.grandparentRatingKey) === String(show.ratingKey)) {
                            episodeCount++;
                        }
                    });
                }
                all.push(Object.assign({
                    title: show.title,
                    key: show.key,
                    type: 'show',
                    libraryTitle: data.title,
                    libraryType: 'show',
                    sectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                    librarySectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                    icon: show.icon || '',
                    ratingKey: show.ratingKey,
                    jellyfinId: show.jellyfinId,
                    source: 'jellyfin',
                    seasonCount: seasonCount || show.seasonCount || null,
                    episodeCount: episodeCount || show.episodeCount || null,
                    count: episodeCount || show.episodeCount || seasonCount || null,
                }, this._filterFieldsFromProgram(show)));
            }
        }
        return { list: all, fromCache: true };
    }

    getCachedPlaylistsList(serverName, options) {
        options = options || {};
        let pl = this.getCachedPlaylists(serverName);
        let hasPlaylists = !!(pl && Array.isArray(pl.playlists));
        let hasLibs = this.hasLibraryCache(serverName);
        // Authoritative when playlists file exists and/or libraries (for favorites) are cached
        if (!hasPlaylists && !hasLibs) {
            return { list: null, fromCache: false };
        }
        // List entries only — omit children (nested/expand loads them from cache by key).
        let self = this;
        function listRow(src, extra) {
            let row = Object.assign({}, self._filterFieldsFromProgram(src), src, extra || {});
            if ((row.count == null || row.count === '') && Array.isArray(src.children)) {
                row.count = src.children.length;
            }
            delete row.children;
            return row;
        }
        function isEmptyListSource(src) {
            if (!src) return true;
            if (Array.isArray(src.children) && src.children.length === 0) return true;
            let c = src.count;
            if (c == null || c === '') {
                if (Array.isArray(src.children)) return src.children.length === 0;
                return false;
            }
            let n = parseInt(c, 10);
            return !isNaN(n) && n <= 0;
        }
        let list = [];
        if (hasPlaylists) {
            for (let i = 0; i < pl.playlists.length; i++) {
                if (isEmptyListSource(pl.playlists[i])) continue;
                // Global playlists: hide when all content is from "Hide content" libraries
                if (!options.includeHidden && this._isListSourceHidden(serverName, pl.playlists[i])) {
                    continue;
                }
                list.push(listRow(pl.playlists[i], {
                    source: 'jellyfin',
                    type: 'playlist',
                    playlistKind: 'playlist',
                }));
            }
        }
        // Append per-library favorites virtual playlists (skip empty / hidden libs)
        let sections = this.getCachedSections(serverName, options);
        for (let i = 0; i < sections.length; i++) {
            let data = this.getCachedLibraryData(serverName, sections[i].sectionKey);
            if (!data || !data.favorites) continue;
            let fav = data.favorites;
            if (isEmptyListSource(fav)) continue;
            list.push(listRow(fav, {
                source: 'jellyfin',
                type: 'playlist',
                playlistKind: 'favorites',
                title: fav.title || ((data.title || sections[i].title) + ' — Favorites'),
                libraryTitle: fav.libraryTitle || data.title || sections[i].title,
                sectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
                librarySectionKey: String(data.sectionKey || sections[i].sectionKey || ''),
            }));
        }
        return { list: list, fromCache: true };
    }
}

module.exports = JellyfinLibraryCacheService;
