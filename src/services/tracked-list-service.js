/**
 * Persistent external movie lists (Letterboxd / Trakt / paste) with refresh,
 * similar to Radarr/Sonarr list sync. Matched programs come from local library cache.
 */
const { v4: uuidv4 } = require('uuid');

class TrackedListService {
    constructor(db, externalListService, channelService, customShowDB) {
        this.db = db;
        this.externalListService = externalListService;
        this.channelService = channelService;
        this.customShowDB = customShowDB || null;
    }

    _all() {
        try {
            return this.db['tracked-lists'].find() || [];
        } catch (e) {
            return [];
        }
    }

    _save(doc) {
        if (doc._id) {
            this.db['tracked-lists'].update({ _id: doc._id }, doc);
        } else {
            this.db['tracked-lists'].save(doc);
            // re-read to get _id
            let rows = this.db['tracked-lists'].find({ id: doc.id }) || [];
            if (rows[0]) return rows[0];
        }
        return doc;
    }

    _findById(id) {
        let rows = this._all();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].id === id || String(rows[i]._id) === String(id)) {
                return rows[i];
            }
        }
        return null;
    }

    listSummaries() {
        return this._all()
            .map((d) => this._toSummary(d))
            .sort((a, b) => {
                let na = (a.name || '').toLowerCase();
                let nb = (b.name || '').toLowerCase();
                if (na < nb) return -1;
                if (na > nb) return 1;
                return 0;
            });
    }

    get(id) {
        let doc = this._findById(id);
        if (!doc) return null;
        return this._toPublic(doc);
    }

    _toSummary(doc) {
        return {
            id: doc.id,
            name: doc.name,
            url: doc.url || null,
            provider: doc.provider || null,
            channelNumber: doc.channelNumber != null ? doc.channelNumber : null,
            /** When true, create/update a dizqueTV channel from matched programs */
            createChannel: doc.createChannel === true || doc.channelNumber != null,
            /** When true, create/update a custom show from matched programs */
            saveAsCustomShow: !!doc.saveAsCustomShow,
            customShowId: doc.customShowId || null,
            pushToPlex: !!doc.pushToPlex,
            pushToJellyfin: !!doc.pushToJellyfin,
            plexServerName: doc.plexServerName || null,
            plexSectionKey: doc.plexSectionKey != null ? String(doc.plexSectionKey) : null,
            plexLibraryTitle: doc.plexLibraryTitle || null,
            plexPlaylistId: doc.plexPlaylistId || null,
            jellyfinPlaylistId: doc.jellyfinPlaylistId || null,
            lastPlaylistPushAt: doc.lastPlaylistPushAt || null,
            lastPlaylistPushError: doc.lastPlaylistPushError || null,
            lastRefreshAt: doc.lastRefreshAt || null,
            lastRefreshOk: doc.lastRefreshOk !== false,
            lastError: doc.lastError || null,
            itemCount: doc.itemCount || 0,
            matchedCount: doc.matchedCount || 0,
            unmatchedCount: doc.unmatchedCount || 0,
            listNameFromSource: doc.listNameFromSource || null,
            createdAt: doc.createdAt || null,
            updatedAt: doc.updatedAt || null,
        };
    }

    _toPublic(doc) {
        return Object.assign({}, this._toSummary(doc), {
            text: doc.text || '',
            unmatchedSample: Array.isArray(doc.unmatchedSample) ? doc.unmatchedSample : [],
            // Slim program list for UI (title + year + source)
            programs: (doc.programs || []).map((p) => ({
                title: p.title,
                year: p.year,
                source: p.source || p.serverType,
                serverKey: p.serverKey || p.serverName,
                ratingKey: p.ratingKey || p.key,
                duration: p.duration,
            })),
        });
    }

    _hasPlexServer() {
        try {
            let servers = this.db['plex-servers'].find() || [];
            return servers.length > 0;
        } catch (e) {
            return false;
        }
    }

    _hasJellyfinServer() {
        try {
            let servers = this.db['jellyfin-servers'].find() || [];
            return servers.length > 0;
        } catch (e) {
            return false;
        }
    }

    _firstPlexServer() {
        let servers = this.db['plex-servers'].find() || [];
        if (!servers.length) return null;
        servers = servers.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
        return servers[0];
    }

    _firstJellyfinServer() {
        let servers = this.db['jellyfin-servers'].find() || [];
        if (!servers.length) return null;
        return servers[0];
    }

    _getPlexServerByName(serverName) {
        let servers = this.db['plex-servers'].find() || [];
        if (!servers.length) return null;
        if (serverName) {
            for (let i = 0; i < servers.length; i++) {
                if (servers[i].name === serverName) return servers[i];
            }
        }
        return this._firstPlexServer();
    }

    /**
     * Libraries available for Plex playlist save (from cache when possible).
     */
    listPlexLibrariesForPlaylists() {
        let out = [];
        let servers = this.db['plex-servers'].find() || [];
        servers = servers.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
        const plexCache = this.externalListService && this.externalListService.plexCache;
        for (let s = 0; s < servers.length; s++) {
            let server = servers[s];
            let sections = [];
            if (plexCache && typeof plexCache.getCachedSections === 'function') {
                try {
                    sections = plexCache.getCachedSections(server.name, { includeDisabled: false }) || [];
                } catch (e) {
                    sections = [];
                }
            }
            // Fallback: scan memory libraries
            if (!sections.length && plexCache && plexCache._mem && plexCache._mem[server.name]) {
                let libs = plexCache._mem[server.name].libraries || {};
                let keys = Object.keys(libs);
                for (let k = 0; k < keys.length; k++) {
                    let data = libs[keys[k]];
                    if (!data) continue;
                    if (typeof plexCache._isDisabled === 'function' && plexCache._isDisabled(server.name, data.sectionKey)) {
                        continue;
                    }
                    sections.push({
                        title: data.title,
                        sectionKey: String(data.sectionKey),
                        type: data.type,
                        serverName: server.name,
                    });
                }
            }
            for (let i = 0; i < sections.length; i++) {
                let sec = sections[i];
                // Video playlists: prefer movie (and show) libraries
                let t = sec.type || '';
                if (t && t !== 'movie' && t !== 'show') continue;
                out.push({
                    serverName: server.name,
                    sectionKey: String(sec.sectionKey != null ? sec.sectionKey : sec.key || ''),
                    title: sec.title || ('Section ' + sec.sectionKey),
                    type: t || 'movie',
                    label: server.name + ' · ' + (sec.title || sec.sectionKey),
                });
            }
        }
        return out;
    }

    _normalizePlexLibraryRef(input) {
        input = input || {};
        let serverName = input.plexServerName ? String(input.plexServerName).trim() : '';
        let sectionKey =
            input.plexSectionKey != null && input.plexSectionKey !== ''
                ? String(input.plexSectionKey).trim()
                : '';
        let libraryTitle = input.plexLibraryTitle ? String(input.plexLibraryTitle).trim() : '';
        // Combined value from UI: "serverName|sectionKey"
        if ((!serverName || !sectionKey) && input.plexLibraryRef) {
            let parts = String(input.plexLibraryRef).split('|');
            if (parts.length >= 2) {
                serverName = parts[0];
                sectionKey = parts.slice(1).join('|');
            }
        }
        if (serverName && sectionKey && !libraryTitle) {
            let libs = this.listPlexLibrariesForPlaylists();
            for (let i = 0; i < libs.length; i++) {
                if (libs[i].serverName === serverName && String(libs[i].sectionKey) === sectionKey) {
                    libraryTitle = libs[i].title;
                    break;
                }
            }
        }
        return {
            plexServerName: serverName || null,
            plexSectionKey: sectionKey || null,
            plexLibraryTitle: libraryTitle || null,
        };
    }

    /**
     * Create a tracked list, resolve/match once, optionally create/update a channel.
     */
    async create(input) {
        input = input || {};
        let name = String(input.name || '').trim();
        if (!name) {
            throw new Error('Name is required.');
        }
        let url = String(input.url || '').trim();
        let text = String(input.text || '').trim();
        if (!url && !text) {
            throw new Error('Provide a Letterboxd/Trakt list URL and/or paste list text.');
        }

        let id = uuidv4();
        let now = Date.now();
        let pushToPlex = !!input.pushToPlex && this._hasPlexServer();
        let pushToJellyfin = !!input.pushToJellyfin && this._hasJellyfinServer();
        let plexLib = this._normalizePlexLibraryRef(input);
        if (pushToPlex && !plexLib.plexSectionKey) {
            throw new Error('Select a Plex library for the playlist.');
        }
        if (!pushToPlex) {
            plexLib = { plexServerName: null, plexSectionKey: null, plexLibraryTitle: null };
        }
        let doc = {
            id: id,
            name: name,
            url: url || null,
            text: text || null,
            provider: null,
            channelNumber: null,
            createChannel: input.createChannel === true,
            saveAsCustomShow: input.saveAsCustomShow === true,
            customShowId: null,
            pushToPlex: pushToPlex,
            pushToJellyfin: pushToJellyfin,
            plexServerName: plexLib.plexServerName,
            plexSectionKey: plexLib.plexSectionKey,
            plexLibraryTitle: plexLib.plexLibraryTitle,
            plexPlaylistId: null,
            jellyfinPlaylistId: null,
            lastPlaylistPushAt: null,
            lastPlaylistPushError: null,
            lastRefreshAt: null,
            lastRefreshOk: true,
            lastError: null,
            itemCount: 0,
            matchedCount: 0,
            unmatchedCount: 0,
            unmatchedSample: [],
            programs: [],
            listNameFromSource: null,
            createdAt: now,
            updatedAt: now,
        };
        doc = this._save(doc);

        // First refresh resolves + matches (+ optional channel / custom show / media playlists)
        let refreshed = await this.refresh(id, {
            createChannel: doc.createChannel === true,
            saveAsCustomShow: doc.saveAsCustomShow === true,
            traktClientId: input.traktClientId,
        });
        return refreshed;
    }

    /**
     * Update list metadata. When linked to a channel, name/number stay in sync
     * (rename and/or renumber the channel to match).
     */
    async updateMeta(id, patch) {
        let doc = this._findById(id);
        if (!doc) throw new Error('List not found.');
        patch = patch || {};

        let prevName = doc.name;
        let prevChannelNumber =
            doc.channelNumber != null ? parseInt(doc.channelNumber, 10) : null;

        if (typeof patch.name === 'string' && patch.name.trim()) {
            doc.name = patch.name.trim();
        }
        if (typeof patch.url === 'string') {
            doc.url = patch.url.trim() || null;
        }
        if (typeof patch.text === 'string') {
            doc.text = patch.text.trim() || null;
        }
        if (typeof patch.createChannel !== 'undefined') {
            doc.createChannel = !!patch.createChannel;
        }
        if (typeof patch.saveAsCustomShow !== 'undefined') {
            doc.saveAsCustomShow = !!patch.saveAsCustomShow;
            if (!doc.saveAsCustomShow) {
                // Keep customShowId so user can re-enable without orphaning, but stop updating
            }
        }
        if (typeof patch.pushToPlex !== 'undefined') {
            doc.pushToPlex = !!patch.pushToPlex && this._hasPlexServer();
            if (!doc.pushToPlex) {
                doc.plexPlaylistId = null;
                doc.plexServerName = null;
                doc.plexSectionKey = null;
                doc.plexLibraryTitle = null;
            }
        }
        if (typeof patch.pushToJellyfin !== 'undefined') {
            doc.pushToJellyfin = !!patch.pushToJellyfin && this._hasJellyfinServer();
            if (!doc.pushToJellyfin) {
                doc.jellyfinPlaylistId = null;
            }
        }
        // Plex library target for playlist (required when pushToPlex)
        if (
            typeof patch.plexServerName !== 'undefined'
            || typeof patch.plexSectionKey !== 'undefined'
            || typeof patch.plexLibraryRef !== 'undefined'
            || typeof patch.plexLibraryTitle !== 'undefined'
        ) {
            let plexLib = this._normalizePlexLibraryRef(Object.assign({}, doc, patch));
            if (doc.pushToPlex) {
                if (!plexLib.plexSectionKey) {
                    throw new Error('Select a Plex library for the playlist.');
                }
                doc.plexServerName = plexLib.plexServerName;
                doc.plexSectionKey = plexLib.plexSectionKey;
                doc.plexLibraryTitle = plexLib.plexLibraryTitle;
            }
        }
        if (doc.pushToPlex && !doc.plexSectionKey) {
            throw new Error('Select a Plex library for the playlist.');
        }

        let newChannelNumber = prevChannelNumber;
        let clearChannel = false;
        if (typeof patch.channelNumber !== 'undefined') {
            let n = patch.channelNumber;
            if (n === null || n === '' || typeof n === 'undefined') {
                clearChannel = true;
                newChannelNumber = null;
            } else {
                n = parseInt(n, 10);
                if (isNaN(n) || n < 1) throw new Error('Invalid channel number.');
                newChannelNumber = n;
            }
        }

        // Apply channel identity sync (name + number) when a channel is linked
        if (this.channelService && prevChannelNumber != null && !clearChannel) {
            await this._syncChannelIdentityFromList(doc, {
                previousNumber: prevChannelNumber,
                nextNumber: newChannelNumber != null ? newChannelNumber : prevChannelNumber,
                nextName: doc.name,
            });
            doc.channelNumber =
                newChannelNumber != null ? newChannelNumber : prevChannelNumber;
        } else if (clearChannel) {
            doc.channelNumber = null;
        } else if (
            this.channelService
            && prevChannelNumber == null
            && newChannelNumber != null
        ) {
            // Link to an existing channel number — rename that channel to list name
            let ch = await this.channelService.getChannel(newChannelNumber);
            if (!ch) {
                throw new Error('Channel #' + newChannelNumber + ' does not exist.');
            }
            // Ensure no other list already claims this channel
            let other = this._findByChannelNumber(newChannelNumber, doc.id);
            if (other) {
                throw new Error(
                    'Channel #' + newChannelNumber + ' is already linked to list “' +
                    other.name + '”.'
                );
            }
            ch.name = doc.name;
            ch.number = newChannelNumber;
            ch.contentSources = this._mergeContentSources(ch.contentSources, {
                type: 'external-list',
                key: doc.url || ('tracked:' + doc.id),
                title: doc.name,
                serverName: '',
                mediaSource: doc.provider || 'external',
                source: doc.provider || 'external',
                serverType: doc.provider || 'external',
                lastSyncedAt: new Date().toISOString(),
                externalProvider: doc.provider || null,
                externalUrl: doc.url || null,
                trackedListId: doc.id,
            });
            await this.channelService.saveChannel(newChannelNumber, ch);
            doc.channelNumber = newChannelNumber;
        } else if (newChannelNumber != null) {
            doc.channelNumber = newChannelNumber;
        }

        // If only name changed and still on same channel number, channel already updated above
        // when prevChannelNumber != null
        if (
            this.channelService
            && prevChannelNumber != null
            && !clearChannel
            && doc.name !== prevName
            && (newChannelNumber == null || newChannelNumber === prevChannelNumber)
        ) {
            // _syncChannelIdentityFromList already applied name when nextNumber === previousNumber
        }

        doc.updatedAt = Date.now();
        this._save(doc);
        return this._toPublic(doc);
    }

    _findByChannelNumber(channelNumber, exceptId) {
        let n = parseInt(channelNumber, 10);
        if (isNaN(n)) return null;
        let rows = this._all();
        for (let i = 0; i < rows.length; i++) {
            if (exceptId && rows[i].id === exceptId) continue;
            if (rows[i].channelNumber != null && parseInt(rows[i].channelNumber, 10) === n) {
                return rows[i];
            }
        }
        return null;
    }

    _findByTrackedListId(trackedListId) {
        if (!trackedListId) return null;
        return this._findById(trackedListId);
    }

    /**
     * Rename/renumber the linked channel to match list settings.
     */
    async _syncChannelIdentityFromList(doc, opts) {
        opts = opts || {};
        let previousNumber = parseInt(opts.previousNumber, 10);
        let nextNumber = parseInt(opts.nextNumber, 10);
        let nextName = String(opts.nextName || doc.name || '').trim();
        if (isNaN(previousNumber)) return;
        if (isNaN(nextNumber) || nextNumber < 1) {
            throw new Error('Invalid channel number.');
        }

        let ch = await this.channelService.getChannel(previousNumber);
        if (!ch) {
            // Channel gone — clear link unless we're only changing stored number
            if (nextNumber !== previousNumber) {
                // try load at next number
                ch = await this.channelService.getChannel(nextNumber);
            }
            if (!ch) {
                throw new Error(
                    'Linked channel #' + previousNumber + ' was not found. ' +
                    'Clear the channel number or create a new channel.'
                );
            }
        }

        if (nextNumber !== previousNumber) {
            let existing = await this.channelService.getChannel(nextNumber);
            if (existing) {
                throw new Error('Channel #' + nextNumber + ' is already in use.');
            }
            let other = this._findByChannelNumber(nextNumber, doc.id);
            if (other) {
                throw new Error(
                    'Channel #' + nextNumber + ' is already linked to list “' + other.name + '”.'
                );
            }
            ch.number = nextNumber;
            ch.name = nextName || ch.name;
            ch.contentSources = this._mergeContentSources(ch.contentSources, {
                type: 'external-list',
                key: doc.url || ('tracked:' + doc.id),
                title: nextName || doc.name,
                trackedListId: doc.id,
                mediaSource: doc.provider || 'external',
                source: doc.provider || 'external',
                serverType: doc.provider || 'external',
                externalProvider: doc.provider || null,
                externalUrl: doc.url || null,
                lastSyncedAt: new Date().toISOString(),
            });
            await this.channelService.saveChannel(nextNumber, ch);
            await this.channelService.deleteChannel(previousNumber);
        } else {
            if (nextName) {
                ch.name = nextName;
            }
            ch.contentSources = this._mergeContentSources(ch.contentSources, {
                type: 'external-list',
                key: doc.url || ('tracked:' + doc.id),
                title: nextName || doc.name,
                trackedListId: doc.id,
                mediaSource: doc.provider || 'external',
                source: doc.provider || 'external',
                serverType: doc.provider || 'external',
                externalProvider: doc.provider || null,
                externalUrl: doc.url || null,
                lastSyncedAt: new Date().toISOString(),
            });
            await this.channelService.saveChannel(previousNumber, ch);
        }
    }

    /**
     * Called when a channel is saved in Channels UI.
     * Keeps tracked list name + channelNumber in sync.
     * @param {object} channel - saved channel
     * @param {{ previousNumber?: number|null }} [options]
     */
    async applyChannelSave(channel, options) {
        options = options || {};
        if (!channel) return null;
        let number = parseInt(channel.number, 10);
        if (isNaN(number)) return null;
        let prev =
            options.previousNumber != null
                ? parseInt(options.previousNumber, 10)
                : number;
        if (isNaN(prev)) prev = number;

        // Prefer contentSources.trackedListId
        let trackedId = null;
        let sources = channel.contentSources || [];
        for (let i = 0; i < sources.length; i++) {
            if (sources[i] && sources[i].trackedListId) {
                trackedId = sources[i].trackedListId;
                break;
            }
        }

        let doc = trackedId ? this._findById(trackedId) : null;
        if (!doc) {
            doc = this._findByChannelNumber(prev) || this._findByChannelNumber(number);
        }
        if (!doc) return null;

        let name = String(channel.name || '').trim();
        if (name) doc.name = name;
        doc.channelNumber = number;
        doc.updatedAt = Date.now();
        this._save(doc);
        return this._toSummary(doc);
    }

    /**
     * Clear channel link when a channel is deleted.
     */
    async applyChannelDelete(channelNumber) {
        let n = parseInt(channelNumber, 10);
        if (isNaN(n)) return;
        let doc = this._findByChannelNumber(n);
        if (!doc) return;
        doc.channelNumber = null;
        doc.updatedAt = Date.now();
        this._save(doc);
    }

    async delete(id) {
        let doc = this._findById(id);
        if (!doc) return { ok: true };
        try {
            if (doc._id) {
                this.db['tracked-lists'].remove({ _id: doc._id });
            } else {
                this.db['tracked-lists'].remove({ id: doc.id });
            }
        } catch (e) {
            console.error('tracked-list delete failed', e.message || e);
            throw new Error('Failed to delete list.');
        }
        return { ok: true };
    }

    /**
     * Re-fetch list (URL/text), re-match against library cache, update stored programs.
     * If linked to a channel (or createChannel), push programs to that channel.
     */
    async refresh(id, options) {
        options = options || {};
        let doc = this._findById(id);
        if (!doc) throw new Error('List not found.');

        let resolveInput = {
            url: doc.url || '',
            text: doc.text || '',
            traktClientId: options.traktClientId,
        };

        let result;
        try {
            result = await this.externalListService.resolve(resolveInput);
        } catch (err) {
            doc.lastRefreshAt = Date.now();
            doc.lastRefreshOk = false;
            doc.lastError = err.message || String(err);
            doc.updatedAt = Date.now();
            this._save(doc);
            throw err;
        }

        let programs = [];
        let seen = {};
        for (let i = 0; i < (result.matched || []).length; i++) {
            let row = result.matched[i];
            let p = row.program;
            if (!p) continue;
            let item = Object.assign({}, p);
            if (typeof item.commercials === 'undefined') item.commercials = [];
            let key =
                (item.source || '') +
                '|' +
                (item.serverKey || item.serverName || '') +
                '|' +
                (item.ratingKey || item.key || item.title);
            if (seen[key]) continue;
            seen[key] = true;
            programs.push(item);
        }

        doc.provider = result.provider || doc.provider;
        doc.listNameFromSource = result.listName || doc.listNameFromSource;
        doc.itemCount = result.itemCount || 0;
        doc.matchedCount = programs.length;
        doc.unmatchedCount = result.unmatchedCount || 0;
        doc.unmatchedSample = (result.unmatched || []).slice(0, 40);
        doc.programs = programs;
        doc.lastRefreshAt = Date.now();
        doc.lastRefreshOk = true;
        doc.lastError = null;
        doc.updatedAt = Date.now();
        if (result.warnings && result.warnings.length) {
            // non-fatal
            doc.lastError = result.warnings.join(' ');
        }

        // Channel sync: update linked channel, or create one if requested
        let wantChannel =
            options.createChannel === true
            || doc.createChannel === true
            || (doc.channelNumber != null && options.syncChannel !== false);
        let shouldSync =
            this.channelService
            && wantChannel
            && (
                options.createChannel === true
                || doc.createChannel === true
                || doc.channelNumber != null
            );

        if (shouldSync) {
            try {
                await this._syncChannel(doc, programs, Object.assign({}, options, {
                    createChannel:
                        options.createChannel === true
                        || (doc.createChannel === true && doc.channelNumber == null),
                }));
            } catch (chErr) {
                console.error('tracked-list channel sync failed', chErr);
                doc.lastRefreshOk = false;
                doc.lastError =
                    (doc.lastError ? doc.lastError + ' · ' : '') +
                    'Channel update failed: ' + (chErr.message || chErr);
            }
        }

        // Custom show sync
        let wantCustom =
            options.saveAsCustomShow === true
            || doc.saveAsCustomShow === true;
        if (wantCustom && this.customShowDB) {
            try {
                await this._syncCustomShow(doc, programs);
            } catch (csErr) {
                console.error('tracked-list custom show sync failed', csErr);
                doc.lastRefreshOk = false;
                doc.lastError =
                    (doc.lastError ? doc.lastError + ' · ' : '') +
                    'Custom show failed: ' + (csErr.message || csErr);
            }
        }

        // Optional: write/update playlist on Plex and/or Jellyfin
        if (doc.pushToPlex || doc.pushToJellyfin) {
            try {
                await this._pushMediaPlaylists(doc, programs);
            } catch (plErr) {
                console.error('tracked-list playlist push failed', plErr);
                doc.lastPlaylistPushError = plErr.message || String(plErr);
                doc.lastError =
                    (doc.lastError ? doc.lastError + ' · ' : '') +
                    'Playlist push: ' + doc.lastPlaylistPushError;
            }
        }

        this._save(doc);
        return this._toPublic(doc);
    }

    /**
     * Create or replace a video playlist on Plex/Jellyfin from matched programs.
     */
    async _pushMediaPlaylists(doc, programs) {
        let errors = [];
        let pushed = false;

        if (doc.pushToPlex && this._hasPlexServer()) {
            try {
                if (!doc.plexSectionKey) {
                    throw new Error('no Plex library selected');
                }
                let plexIds = this._collectPlexRatingKeys(programs, doc);
                if (!plexIds.length) {
                    errors.push(
                        'Plex: no matched titles found in library “' +
                        (doc.plexLibraryTitle || doc.plexSectionKey) + '”'
                    );
                } else {
                    let id = await this._upsertPlexPlaylist(doc, plexIds);
                    doc.plexPlaylistId = id;
                    pushed = true;
                }
            } catch (e) {
                errors.push('Plex: ' + (e.message || e));
            }
        }

        if (doc.pushToJellyfin && this._hasJellyfinServer()) {
            try {
                let jfIds = this._collectJellyfinIds(programs);
                if (!jfIds.length) {
                    errors.push(
                        'Jellyfin: none of the ' + (programs || []).length +
                        ' matched titles were found in Jellyfin libraries ' +
                        '(they may only exist on Plex — sync Jellyfin libraries if needed)'
                    );
                } else {
                    let id = await this._upsertJellyfinPlaylist(doc, jfIds);
                    doc.jellyfinPlaylistId = id;
                    pushed = true;
                    if (jfIds.length < (programs || []).length) {
                        // Partial success — not a hard failure
                        errors.push(
                            'Jellyfin: added ' + jfIds.length + ' of ' +
                            (programs || []).length +
                            ' titles (others not in Jellyfin library)'
                        );
                    }
                }
            } catch (e) {
                errors.push('Jellyfin: ' + (e.message || e));
            }
        }

        doc.lastPlaylistPushAt = Date.now();
        // Keep notes even on partial success; only throw when nothing was pushed
        doc.lastPlaylistPushError = errors.length ? errors.join(' · ') : null;
        if (errors.length && !pushed) {
            throw new Error(doc.lastPlaylistPushError);
        }
    }

    /**
     * Plex rating keys for playlist, limited to the selected library section when set.
     */
    _collectPlexRatingKeys(programs, doc) {
        doc = doc || {};
        let keys = [];
        let seen = {};
        let sectionKey = doc.plexSectionKey != null ? String(doc.plexSectionKey) : null;
        let serverName = doc.plexServerName || null;

        // Preferred: membership in selected library cache
        let libItems = null;
        if (sectionKey) {
            let plexCache = this.externalListService && this.externalListService.plexCache;
            let server = this._getPlexServerByName(serverName);
            let sName = (server && server.name) || serverName;
            if (plexCache && sName && typeof plexCache.getCachedLibraryData === 'function') {
                let data = plexCache.getCachedLibraryData(sName, sectionKey);
                if (data && data.items) {
                    libItems = data.items;
                }
            }
        }

        for (let i = 0; i < (programs || []).length; i++) {
            let p = programs[i];
            if (!p) continue;
            if (p.source === 'jellyfin' || p.serverType === 'jellyfin') continue;
            let src = p.source || p.serverType;
            if (src && src !== 'plex') continue;

            let rk = p.ratingKey != null ? String(p.ratingKey) : null;
            if (!rk && p.key) {
                let m = String(p.key).match(/\/library\/metadata\/(\d+)/);
                if (m) rk = m[1];
            }
            if (!rk || seen[rk]) continue;
            if (!/^\d+$/.test(rk)) continue;

            if (libItems) {
                if (!libItems[rk]) continue;
            } else if (sectionKey) {
                // Fallback: match librarySectionID on program when present
                let ps =
                    p.librarySectionID != null
                        ? String(p.librarySectionID)
                        : (p.sectionKey != null ? String(p.sectionKey) : null);
                if (ps != null && ps !== sectionKey) continue;
            }

            if (serverName && p.serverKey && String(p.serverKey) !== String(serverName)) {
                continue;
            }

            seen[rk] = true;
            keys.push(rk);
        }
        return keys;
    }

    /**
     * Jellyfin item IDs for playlist. Matched list programs may be Plex-sourced
     * when the same title exists on both — re-resolve by title/year against the
     * Jellyfin library cache so playlist push still works.
     */
    _collectJellyfinIds(programs) {
        let ids = [];
        let seen = {};
        let els = this.externalListService;
        let jfIndex = this._buildJellyfinTitleIndex();

        const addId = (id) => {
            if (!id) return;
            id = String(id);
            if (seen[id]) return;
            seen[id] = true;
            ids.push(id);
        };

        const idFromProgram = (p) => {
            if (!p) return null;
            if (p.source === 'plex' || p.serverType === 'plex') return null;
            let id = p.jellyfinId || null;
            if (!id && p.ratingKey && !/^\d+$/.test(String(p.ratingKey))) {
                id = p.ratingKey; // GUID
            }
            if (!id && p.key) {
                let m = String(p.key).match(/\/Items\/([^/?#]+)/i);
                if (m) id = m[1];
            }
            return id;
        };

        for (let i = 0; i < (programs || []).length; i++) {
            let p = programs[i];
            if (!p) continue;

            // Direct jellyfin program
            let direct = idFromProgram(p);
            if (direct) {
                addId(direct);
                continue;
            }

            // Cross-match: title/year → jellyfin cache (even if p came from Plex)
            let year =
                p.year != null
                    ? parseInt(p.year, 10)
                    : (p.date ? parseInt(String(p.date).slice(0, 4), 10) : null);
            if (isNaN(year)) year = null;
            let found = this._lookupTitleInIndex(p.title, year, jfIndex);
            if (!found && p.originalTitle) {
                found = this._lookupTitleInIndex(p.originalTitle, year, jfIndex);
            }
            if (found) {
                addId(found.jellyfinId || found.ratingKey || null);
            }
        }
        return ids;
    }

    /**
     * Index of Jellyfin movies by normalized title for cross-source playlist fill.
     */
    _buildJellyfinTitleIndex() {
        let byNorm = {}; // norm -> [{ year, program }]
        let jfCache = this.externalListService && this.externalListService.jellyfinCache;
        if (!jfCache || !jfCache._mem) return byNorm;
        let servers = jfCache._mem;
        let names = Object.keys(servers);
        let els = this.externalListService;
        for (let s = 0; s < names.length; s++) {
            let serverName = names[s];
            let mem = servers[serverName];
            if (!mem || !mem.libraries) continue;
            let libKeys = Object.keys(mem.libraries);
            for (let k = 0; k < libKeys.length; k++) {
                let data = mem.libraries[libKeys[k]];
                if (!data || !data.items) continue;
                if (jfCache._isDisabled && jfCache._isDisabled(serverName, data.sectionKey)) continue;
                if (jfCache._isHidden && jfCache._isHidden(serverName, data.sectionKey)) continue;
                let items = data.items;
                let ikeys = Object.keys(items);
                for (let i = 0; i < ikeys.length; i++) {
                    let p = items[ikeys[i]];
                    if (!p || p.type !== 'movie') continue;
                    let year =
                        p.year != null
                            ? parseInt(p.year, 10)
                            : (p.date ? parseInt(String(p.date).slice(0, 4), 10) : null);
                    if (isNaN(year)) year = null;
                    let titles = [p.title, p.originalTitle].filter(Boolean);
                    for (let t = 0; t < titles.length; t++) {
                        let norm = els
                            ? els.normalizeTitle(titles[t])
                            : String(titles[t]).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                        if (!norm) continue;
                        if (!byNorm[norm]) byNorm[norm] = [];
                        byNorm[norm].push({
                            year: year,
                            program: Object.assign({}, p, {
                                source: 'jellyfin',
                                serverType: 'jellyfin',
                                serverKey: p.serverKey || serverName,
                                jellyfinId: p.jellyfinId || p.ratingKey,
                            }),
                        });
                    }
                }
            }
        }
        return byNorm;
    }

    _lookupTitleInIndex(title, year, byNorm) {
        if (!title || !byNorm) return null;
        let els = this.externalListService;
        let norm = els
            ? els.normalizeTitle(title)
            : String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        let cands = byNorm[norm] || [];
        if (!cands.length) return null;
        let best = null;
        let bestScore = -1;
        for (let i = 0; i < cands.length; i++) {
            let c = cands[i];
            let score = 50;
            if (year != null && c.year != null) {
                if (c.year === year) score = 100;
                else if (Math.abs(c.year - year) === 1) score = 80;
                else score = 20;
            } else {
                score = 70; // no year info — accept
            }
            if (score > bestScore) {
                bestScore = score;
                best = c.program;
            }
        }
        return bestScore >= 50 ? best : null;
    }

    async _upsertPlexPlaylist(doc, ratingKeys) {
        const Plex = require('../plex');
        let server = this._getPlexServerByName(doc.plexServerName) || this._firstPlexServer();
        if (!server) throw new Error('No Plex server configured');
        let client = new Plex(server);
        let root = await client.Get('/');
        let machineId = root.machineIdentifier;
        if (!machineId) throw new Error('Could not read Plex machineIdentifier');

        let title = doc.name || 'dizqueTV list';
        // Drop existing playlist if we have an id (replace contents cleanly)
        if (doc.plexPlaylistId) {
            try {
                await client.Delete('/playlists/' + doc.plexPlaylistId);
            } catch (e) {
                console.error('plex playlist delete (may be ok)', e.message || e);
            }
            doc.plexPlaylistId = null;
        }

        // Create with first item, then append batches
        let first = ratingKeys[0];
        let uri =
            'server://' + machineId +
            '/com.plexapp.plugins.library/library/metadata/' + first;
        let created = await client.PostJson('/playlists', {
            type: 'video',
            title: title,
            smart: 0,
            uri: uri,
        });
        let pl =
            (created && created.Metadata && created.Metadata[0]) ||
            (created && created.Playlist) ||
            null;
        // Sometimes Metadata is at top level array
        if (!pl && created && Array.isArray(created.Metadata)) {
            pl = created.Metadata[0];
        }
        let playlistId = pl && (pl.ratingKey || pl.key);
        if (playlistId && String(playlistId).indexOf('/') >= 0) {
            let m = String(playlistId).match(/(\d+)\s*$/);
            if (m) playlistId = m[1];
        }
        if (!playlistId) {
            // Fallback: find by title
            let list = await client.Get('/playlists');
            let metas = (list && list.Metadata) || [];
            for (let i = metas.length - 1; i >= 0; i--) {
                if (metas[i].title === title && metas[i].playlistType === 'video') {
                    playlistId = metas[i].ratingKey;
                    break;
                }
            }
        }
        if (!playlistId) {
            throw new Error('Plex playlist created but id not returned');
        }

        const batchSize = 40;
        for (let i = 1; i < ratingKeys.length; i += batchSize) {
            let batch = ratingKeys.slice(i, i + batchSize);
            let batchUri =
                'server://' + machineId +
                '/com.plexapp.plugins.library/library/metadata/' + batch.join(',');
            await client.Put('/playlists/' + playlistId + '/items', { uri: batchUri });
        }
        return String(playlistId);
    }

    async _upsertJellyfinPlaylist(doc, itemIds) {
        const Jellyfin = require('../jellyfin');
        let server = this._firstJellyfinServer();
        if (!server) throw new Error('No Jellyfin server configured');
        let client = new Jellyfin(server);
        if (server.userId) client._userId = server.userId;
        let userId = await client.ensureUserId();
        if (!userId) {
            throw new Error('Could not resolve Jellyfin user id (needed to create playlists)');
        }
        let title = doc.name || 'dizqueTV list';

        // Replace existing playlist when refreshing (clean set of items)
        if (doc.jellyfinPlaylistId) {
            try {
                await client.Delete('/Items/' + doc.jellyfinPlaylistId);
            } catch (e) {
                console.error('jellyfin playlist delete (may be ok)', e.message || e);
            }
            doc.jellyfinPlaylistId = null;
        }

        // Create playlist — try body first, then query-string form used by some servers
        let firstBatch = itemIds.slice(0, 200);
        let created = null;
        let playlistId = null;
        try {
            created = await client.Post('/Playlists', {
                Name: title,
                Ids: firstBatch,
                UserId: userId,
                MediaType: 'Video',
            });
        } catch (e1) {
            console.error('jellyfin POST /Playlists body failed, trying qs', e1.message || e1);
            created = await client.Post('/Playlists', null, {
                Name: title,
                Ids: firstBatch.join(','),
                UserId: userId,
                MediaType: 'Video',
            });
        }
        playlistId =
            (created && (created.Id || created.id || created.PlaylistId)) ||
            null;
        if (!playlistId && created && created.ItemId) {
            playlistId = created.ItemId;
        }
        if (!playlistId) {
            // Some builds return empty body — look up by name under user playlists
            try {
                let found = await client.Get('/Users/' + userId + '/Items', {
                    IncludeItemTypes: 'Playlist',
                    Recursive: 'true',
                    SearchTerm: title,
                    Limit: 20,
                });
                let items = (found && found.Items) || [];
                for (let i = items.length - 1; i >= 0; i--) {
                    if (items[i] && items[i].Name === title) {
                        playlistId = items[i].Id;
                        break;
                    }
                }
            } catch (e2) {
                console.error('jellyfin playlist lookup failed', e2.message || e2);
            }
        }
        if (!playlistId) {
            throw new Error(
                'Jellyfin playlist create returned no id' +
                (created ? ' (response: ' + JSON.stringify(created).slice(0, 200) + ')' : '')
            );
        }

        for (let i = 200; i < itemIds.length; i += 200) {
            let batch = itemIds.slice(i, i + 200);
            await client.Post('/Playlists/' + playlistId + '/Items', null, {
                ids: batch.join(','),
                userId: userId,
            });
        }
        return String(playlistId);
    }

    /**
     * Create or update a custom show with the matched programs (list order).
     */
    async _syncCustomShow(doc, programs) {
        if (!this.customShowDB) {
            throw new Error('Custom show service unavailable');
        }
        let content = [];
        for (let i = 0; i < (programs || []).length; i++) {
            let p = programs[i];
            if (!p) continue;
            let item = Object.assign({}, p);
            if (typeof item.commercials === 'undefined') {
                item.commercials = [];
            }
            content.push(item);
        }
        let show = {
            name: doc.name || 'Tracked list',
            content: content,
        };
        if (doc.customShowId) {
            let existing = await this.customShowDB.getShow(doc.customShowId);
            if (existing) {
                existing.name = show.name;
                existing.content = content;
                await this.customShowDB.saveShow(doc.customShowId, existing);
                return doc.customShowId;
            }
            // id missing on disk — create new
            doc.customShowId = null;
        }
        let id = await this.customShowDB.createShow(show);
        doc.customShowId = id;
        doc.saveAsCustomShow = true;
        return id;
    }

    async _syncChannel(doc, programs, options) {
        options = options || {};
        let duration = 0;
        for (let i = 0; i < programs.length; i++) {
            duration += programs[i].duration || 0;
        }

        let contentSource = {
            type: 'external-list',
            key: doc.url || ('tracked:' + doc.id),
            title: doc.name,
            serverName: '',
            mediaSource: doc.provider || 'external',
            source: doc.provider || 'external',
            serverType: doc.provider || 'external',
            lastSyncedAt: new Date().toISOString(),
            externalProvider: doc.provider || null,
            externalUrl: doc.url || null,
            trackedListId: doc.id,
        };

        if (doc.channelNumber != null) {
            let full = await this.channelService.getChannel(doc.channelNumber);
            if (!full) {
                // Channel was deleted — clear link; recreate only if asked
                doc.channelNumber = null;
                if (options.createChannel !== true) {
                    throw new Error('Linked channel was deleted. Enable “Create channel” to make a new one.');
                }
            } else {
                full.programs = programs;
                full.duration = duration;
                if (full.startTime) full.startTime = new Date(full.startTime);
                // Keep channel name aligned with list name (unless caller disables)
                if (options.renameChannel !== false && doc.name) {
                    full.name = doc.name;
                    full.number = doc.channelNumber;
                }
                full.contentSources = this._mergeContentSources(full.contentSources, contentSource);
                await this.channelService.saveChannel(doc.channelNumber, full);
                return;
            }
        }

        if (options.createChannel === true) {
            let numbers = await this.channelService.getAllChannelNumbers();
            let max = 0;
            for (let i = 0; i < (numbers || []).length; i++) {
                let n = parseInt(numbers[i], 10);
                if (!isNaN(n) && n > max) max = n;
            }
            let number = max + 1;
            let startTime = new Date();
            startTime.setMilliseconds(0);
            startTime.setSeconds(0);
            if (startTime.getMinutes() < 30) startTime.setMinutes(0);
            else startTime.setMinutes(30);

            let channel = {
                name: doc.name,
                number: number,
                programs: programs,
                contentSources: [contentSource],
                watermark: {
                    enabled: false,
                    position: 'bottom-right',
                    width: 10.0,
                    verticalMargin: 0,
                    horizontalMargin: 0,
                    duration: 0,
                },
                fillerCollections: [],
                guideFlexPlaceholder: '',
                fillerRepeatCooldown: 30 * 60 * 1000,
                fallback: [],
                guideMinimumDurationSeconds: 5 * 60,
                icon: '/images/dizquetv.png',
                groupTitle: 'dizqueTV',
                disableFillerOverlay: true,
                iconWidth: 120,
                iconDuration: 60,
                iconPosition: '2',
                startTime: startTime,
                offlineMode: 'pic',
                duration: duration,
                transcoding: { targetResolution: '' },
                onDemand: { isOnDemand: false, modulo: 1 },
            };
            await this.channelService.saveChannel(number, channel);
            doc.channelNumber = number;
        }
    }

    _mergeContentSources(existing, incoming) {
        let list = Array.isArray(existing) ? existing.slice() : [];
        let id = (incoming.trackedListId || '') + '|' + (incoming.key || '');
        let found = false;
        for (let i = 0; i < list.length; i++) {
            let cur = list[i];
            let cid = (cur.trackedListId || '') + '|' + (cur.key || '');
            if (
                (incoming.trackedListId && cur.trackedListId === incoming.trackedListId)
                || cid === id
            ) {
                list[i] = Object.assign({}, cur, incoming);
                found = true;
                break;
            }
        }
        if (!found) list.push(incoming);
        return list;
    }

    async refreshAll(options) {
        let all = this._all();
        let results = [];
        for (let i = 0; i < all.length; i++) {
            try {
                let r = await this.refresh(all[i].id, options || {});
                results.push({ id: all[i].id, ok: true, matchedCount: r.matchedCount });
            } catch (err) {
                results.push({
                    id: all[i].id,
                    ok: false,
                    error: err.message || String(err),
                });
            }
        }
        return { results: results };
    }
}

module.exports = TrackedListService;
