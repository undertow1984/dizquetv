/**
 * Local Plex library cache + full/incremental sync.
 *
 * Persists movies, shows, episodes, tracks, collections, and playlists under
 * DATABASE/plex-cache. All UI/API reads are served from an in-memory map that is
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
        this.root = path.join(process.env.DATABASE || './.dizquetv', 'plex-cache');
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

    /**
     * Paginated GET of a Plex path, collecting all Metadata entries.
     * @param {function} [onPage] optional (fetched, total, label) => void
     */
    async _fetchAllMetadata(client, basePath, onPage) {
        let all = [];
        let start = 0;
        let total = Infinity;
        while (start < total) {
            let sep = basePath.indexOf('?') >= 0 ? '&' : '?';
            let url =
                basePath +
                sep +
                'X-Plex-Container-Start=' +
                start +
                '&X-Plex-Container-Size=' +
                PAGE_SIZE;
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
     * Convert Plex Metadata entry → dizqueTV program-like object (no nested expansion).
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
            rating: meta.contentRating,
            date: date,
            year: year,
            updatedAt: meta.updatedAt != null ? Number(meta.updatedAt) : null,
            addedAt: meta.addedAt != null ? Number(meta.addedAt) : null,
            serverKey: server.name,
            childCount: meta.childCount,
            leafCount: meta.leafCount,
            index: meta.index,
            parentIndex: meta.parentIndex,
            parentKey: meta.parentKey,
            parentTitle: meta.parentTitle,
            grandparentTitle: meta.grandparentTitle,
            grandparentThumb: meta.grandparentThumb,
            parentThumb: meta.parentThumb,
            librarySectionID: meta.librarySectionID,
            librarySectionTitle: meta.librarySectionTitle,
            parentRatingKey: meta.parentRatingKey != null ? String(meta.parentRatingKey) : null,
            grandparentRatingKey: meta.grandparentRatingKey != null ? String(meta.grandparentRatingKey) : null,
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
        } catch (e) { /* ignore */ }

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
            let title = m.title;
            if (type === 'show') {
                title = m.title + ' Collection';
            }
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
            collections.push({
                title: title,
                key: m.key,
                ratingKey: String(m.ratingKey || ''),
                type: 'collection',
                collectionType: type,
                libraryTitle: section.title,
                icon: m.thumb
                    ? server.uri + m.thumb + '?X-Plex-Token=' + server.accessToken
                    : '',
                count: children.length || this._countHint(m),
                children: children,
                updatedAt: m.updatedAt != null ? Number(m.updatedAt) : null,
            });
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
            list.push({
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
            });
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

    getCachedCollectionsList(serverName) {
        // Only authoritative when at least one movie/show library has been synced
        if (!this.hasLibraryCache(serverName)) {
            return { list: null, fromCache: false };
        }
        let sections = this.getCachedSections(serverName, {});
        let all = [];
        for (let i = 0; i < sections.length; i++) {
            let data = this.getCachedLibraryData(serverName, sections[i].sectionKey);
            if (!data) continue;
            let cols = data.collections || [];
            for (let c = 0; c < cols.length; c++) {
                let col = cols[c];
                all.push({
                    title: col.title,
                    key: col.key,
                    type: 'collection',
                    collectionType: col.collectionType,
                    libraryTitle: col.libraryTitle || data.title,
                    icon: col.icon || '',
                    count: col.count,
                    children: col.children || [],
                });
            }
        }
        return { list: all, fromCache: true };
    }

    getCachedShowsList(serverName) {
        // Only authoritative when at least one TV show library has been synced
        if (!this.hasLibraryCache(serverName, { type: 'show' })) {
            return { list: null, fromCache: false };
        }
        let sections = this.getCachedSections(serverName, {});
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
                all.push({
                    title: s.title,
                    key: s.key,
                    type: 'show',
                    libraryTitle: data.title,
                    icon: s.icon || '',
                    ratingKey: s.ratingKey,
                    seasonCount: seasonCount,
                    episodeCount: episodeCount,
                    // count kept for callers that expect a single number (episodes preferred)
                    count: episodeCount != null ? episodeCount : (seasonCount != null ? seasonCount : null),
                });
            }
        }
        return { list: all, fromCache: true };
    }

    getCachedPlaylistsList(serverName) {
        let pl = this.getCachedPlaylists(serverName);
        if (!pl) {
            return { list: null, fromCache: false };
        }
        return {
            fromCache: true,
            list: (pl.playlists || []).map((p) => ({
                title: p.title,
                key: p.key,
                icon: p.icon,
                duration: p.duration,
                count: p.count,
                type: 'playlist',
                children: p.children || [],
            })),
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
}

module.exports = PlexLibraryCacheService;
