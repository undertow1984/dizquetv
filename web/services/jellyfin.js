/**
 * Client-side Jellyfin library helpers.
 * Maps Jellyfin BaseItemDto into the same program shape the UI expects from Plex.
 */
module.exports = function ($http, dizquetv) {
    function msToTime(duration) {
        if (typeof duration !== 'number' || isNaN(duration) || duration < 0) {
            return '00:00:00.0';
        }
        var milliseconds = parseInt((duration % 1000) / 100),
            seconds = Math.floor((duration / 1000) % 60),
            minutes = Math.floor((duration / (1000 * 60)) % 60),
            hours = Math.floor((duration / (1000 * 60 * 60)) % 24);

        hours = (hours < 10) ? '0' + hours : hours;
        minutes = (minutes < 10) ? '0' + minutes : minutes;
        seconds = (seconds < 10) ? '0' + seconds : seconds;
        return hours + ':' + minutes + ':' + seconds + '.' + milliseconds;
    }

    /** Jellyfin RunTimeTicks are 100-nanosecond units → milliseconds */
    function ticksToMs(ticks) {
        if (typeof ticks !== 'number' || isNaN(ticks) || ticks <= 0) {
            return 0;
        }
        return Math.floor(ticks / 10000);
    }

    /**
     * Hide playlists/collections with no addable content (count 0 or empty children).
     * Items with unknown count (null/undefined) are kept.
     */
    function filterNonEmptyListSources(list) {
        if (!Array.isArray(list)) {
            return [];
        }
        return list.filter(function (item) {
            if (!item) {
                return false;
            }
            if (Array.isArray(item.children) && item.children.length === 0) {
                return false;
            }
            if (item.count === null || typeof item.count === 'undefined' || item.count === '') {
                return true;
            }
            let n = parseInt(item.count, 10);
            if (isNaN(n)) {
                return true;
            }
            return n > 0;
        });
    }

    function collectionTypeToLibType(ct) {
        ct = (ct || '').toLowerCase();
        if (ct === 'movies' || ct === 'movie') return 'movie';
        if (ct === 'tvshows' || ct === 'tvshow' || ct === 'shows') return 'show';
        if (ct === 'music' || ct === 'musicvideos') return 'artist';
        return ct || 'folder';
    }

    function itemTypeToProgramType(type) {
        type = (type || '').toLowerCase();
        if (type === 'movie') return 'movie';
        if (type === 'episode') return 'episode';
        if (type === 'series' || type === 'tvshow') return 'show';
        if (type === 'season') return 'season';
        if (type === 'audio' || type === 'musicalbum') return type === 'audio' ? 'track' : 'album';
        if (type === 'folder' || type === 'collectionfolder') return 'folder';
        return type || 'movie';
    }

    function imageTag(item, prefer) {
        if (!item) return null;
        if (prefer === 'series' && item.SeriesPrimaryImageTag) {
            return { id: item.SeriesId || item.Id, tag: item.SeriesPrimaryImageTag, type: 'Primary' };
        }
        if (item.ImageTags && item.ImageTags.Primary) {
            return { id: item.Id, tag: item.ImageTags.Primary, type: 'Primary' };
        }
        if (item.SeriesPrimaryImageTag) {
            return { id: item.SeriesId || item.Id, tag: item.SeriesPrimaryImageTag, type: 'Primary' };
        }
        return { id: item.Id, tag: null, type: 'Primary' };
    }

    function buildImageUrl(server, itemId, imageType, tag) {
        if (!itemId || !server) return '';
        let q = 'api_key=' + encodeURIComponent(server.apiKey || server.accessToken || '');
        if (tag) q += '&tag=' + encodeURIComponent(tag);
        return server.uri.replace(/\/$/, '') + '/Items/' + itemId + '/Images/' + (imageType || 'Primary') + '?' + q;
    }

    function mapItemToProgram(server, item) {
        let type = itemTypeToProgramType(item.Type);
        let duration = ticksToMs(item.RunTimeTicks);
        let year = item.ProductionYear;
        let date = item.PremiereDate ? String(item.PremiereDate).slice(0, 10) : undefined;
        if (typeof date === 'undefined' && typeof year !== 'undefined') {
            date = year + '-01-01';
        }

        let img = imageTag(item);
        let program = {
            source: 'jellyfin',
            serverType: 'jellyfin',
            title: item.Name,
            key: '/Items/' + item.Id,
            ratingKey: item.Id,
            jellyfinId: item.Id,
            server: server,
            icon: buildImageUrl(server, img.id, img.type, img.tag),
            type: type,
            duration: duration,
            durationStr: msToTime(duration),
            summary: item.Overview || '',
            year: year,
            date: date,
            childCount: item.ChildCount,
            // seasons / episode counts when present
            seasonCount: type === 'show' ? item.ChildCount : undefined,
            episodeCount: type === 'show' ? item.RecursiveItemCount : undefined,
        };

        let mediaSource = (item.MediaSources && item.MediaSources[0]) ? item.MediaSources[0] : null;
        if (type === 'movie' || type === 'episode' || type === 'track') {
            program.plexFile = '/Videos/' + item.Id + '/stream?static=true';
            program.mediaSourceId = mediaSource ? mediaSource.Id : item.Id;
            if (mediaSource && mediaSource.Path) {
                program.file = mediaSource.Path;
            } else if (item.Path) {
                program.file = item.Path;
            }
            // duration required for playable items
            if (!program.duration || program.duration <= 0) {
                return null;
            }
        }

        if (type === 'episode') {
            program.showTitle = item.SeriesName || item.Album || item.Name;
            program.episode = item.IndexNumber;
            program.season = item.ParentIndexNumber;
            program.episodeIcon = program.icon;
            if (item.SeriesId) {
                program.showIcon = buildImageUrl(
                    server,
                    item.SeriesId,
                    'Primary',
                    item.SeriesPrimaryImageTag
                );
                program.icon = program.showIcon;
            }
            if (item.SeasonId) {
                program.seasonIcon = buildImageUrl(server, item.SeasonId, 'Primary', null);
            }
        } else if (type === 'movie') {
            program.showTitle = item.Name;
            program.episode = 1;
            program.season = 1;
        } else if (type === 'season') {
            program.showTitle = item.SeriesName;
            program.season = item.IndexNumber;
        }

        return program;
    }

    async function jfGet(server, path, params) {
        // Always go through dizqueTV backend so browser CORS is not an issue.
        return dizquetv.jellyfinProxy(server.name, path, params || {});
    }

    let exported = {
        check: async (server) => {
            try {
                let r = await dizquetv.checkNewJellyfinServer(server);
                return (r && r.status) ? r.status : -1;
            } catch (err) {
                console.error(err);
                return -1;
            }
        },

        /**
         * Library sections. Cache only unless preferLive (Library Management).
         */
        getLibrary: async (server, options) => {
            options = options || {};
            if (!options.preferLive) {
                try {
                    let cached = await dizquetv.getJellyfinCacheSections(
                        server.name,
                        !!options.includeDisabled,
                        !!options.includeHidden
                    );
                    if (cached && cached.fromCache && Array.isArray(cached.sections)) {
                        return cached.sections;
                    }
                } catch (e) { /* ignore */ }
                return [];
            }
            let views = await jfGet(server, '/Users/{userId}/Views', {});
            let items = (views && views.Items) ? views.Items : (Array.isArray(views) ? views : []);
            let sections = [];
            for (let i = 0; i < items.length; i++) {
                let v = items[i];
                let libType = collectionTypeToLibType(v.CollectionType);
                if (libType !== 'movie' && libType !== 'show' && libType !== 'artist') {
                    // still include generic folders as movie-like if CollectionType missing
                    if (v.CollectionType) {
                        continue;
                    }
                    libType = 'movie';
                }
                sections.push({
                    title: v.Name,
                    key: v.Id,
                    sectionKey: v.Id,
                    jellyfinId: v.Id,
                    ratingKey: v.Id,
                    icon: buildImageUrl(server, v.Id, 'Primary', v.ImageTags && v.ImageTags.Primary),
                    type: libType,
                    genres: [],
                    serverName: server.name,
                    source: 'jellyfin',
                    serverType: 'jellyfin',
                });
            }
            return sections;
        },

        getPlaylists: async (server, options) => {
            options = options || {};
            try {
                let cached = await dizquetv.getJellyfinCachePlaylists(server.name, !!options.includeHidden);
                if (cached && cached.fromCache && Array.isArray(cached.playlists)) {
                    return filterNonEmptyListSources(cached.playlists);
                }
            } catch (e) { /* ignore */ }
            if (!options.preferLive) {
                return [];
            }

            let list = [];
            // Live: real playlists (preferLive only)
            try {
                let res = await jfGet(server, '/Users/{userId}/Items', {
                    Recursive: 'true',
                    IncludeItemTypes: 'Playlist',
                    Fields: 'ChildCount,RecursiveItemCount,Overview',
                    SortBy: 'SortName',
                });
                let items = (res && res.Items) ? res.Items : [];
                for (let i = 0; i < items.length; i++) {
                    let m = items[i];
                    list.push({
                        title: m.Name,
                        key: '/Items/' + m.Id,
                        ratingKey: m.Id,
                        type: 'playlist',
                        playlistKind: 'playlist',
                        icon: buildImageUrl(server, m.Id, 'Primary', m.ImageTags && m.ImageTags.Primary),
                        count: m.ChildCount || m.RecursiveItemCount || null,
                        source: 'jellyfin',
                    });
                }
            } catch (err) {
                console.error('Jellyfin playlists failed', err);
            }

            // Live: per-library favorites virtual playlists
            try {
                let sections = await exported.getLibrary(server, { preferLive: true });
                for (let s = 0; s < sections.length; s++) {
                    let section = sections[s];
                    if (section.type !== 'movie' && section.type !== 'show' && section.type !== 'artist') {
                        continue;
                    }
                    let includeTypes = 'Movie';
                    if (section.type === 'show') includeTypes = 'Series,Episode';
                    else if (section.type === 'artist') includeTypes = 'Audio';
                    try {
                        let fRes = await jfGet(server, '/Users/{userId}/Items', {
                            ParentId: section.sectionKey || section.key,
                            Recursive: 'true',
                            Filters: 'IsFavorite',
                            IncludeItemTypes: includeTypes,
                            Fields: 'ChildCount,RecursiveItemCount,RunTimeTicks',
                            SortBy: 'SortName',
                            Limit: 1, // count via TotalRecordCount when available
                        });
                        let count = (fRes && typeof fRes.TotalRecordCount === 'number')
                            ? fRes.TotalRecordCount
                            : ((fRes && fRes.Items) ? fRes.Items.length : 0);
                        // If Limit=1 hid the real count, do a full lightweight probe without limit
                        if (count === 1 && fRes && fRes.Items && fRes.Items.length === 1 && fRes.TotalRecordCount == null) {
                            let full = await jfGet(server, '/Users/{userId}/Items', {
                                ParentId: section.sectionKey || section.key,
                                Recursive: 'true',
                                Filters: 'IsFavorite',
                                IncludeItemTypes: includeTypes,
                                Fields: 'BasicSyncInfo',
                                SortBy: 'SortName',
                            });
                            count = (full && full.Items) ? full.Items.length : count;
                        }
                        list.push({
                            title: section.title + ' — Favorites',
                            key: '/Favorites/Library/' + (section.sectionKey || section.key),
                            ratingKey: 'favorites-' + (section.sectionKey || section.key),
                            type: 'playlist',
                            playlistKind: 'favorites',
                            libraryTitle: section.title,
                            librarySectionKey: section.sectionKey || section.key,
                            libraryType: section.type,
                            icon: section.icon || '',
                            count: count,
                            source: 'jellyfin',
                        });
                    } catch (fe) {
                        console.error('Jellyfin favorites failed for', section.title, fe);
                    }
                }
            } catch (err) {
                console.error('Jellyfin library favorites failed', err);
            }
            return filterNonEmptyListSources(list);
        },

        getCollections: async (server, options) => {
            options = options || {};
            try {
                let cached = await dizquetv.getJellyfinCacheCollections(server.name, !!options.includeHidden);
                if (cached && cached.fromCache && Array.isArray(cached.collections)) {
                    return filterNonEmptyListSources(cached.collections);
                }
            } catch (e) { /* ignore */ }
            if (!options.preferLive) {
                return [];
            }

            // Live: global BoxSets + genres (preferLive only)
            let list = [];
            try {
                let res = await jfGet(server, '/Users/{userId}/Items', {
                    Recursive: 'true',
                    IncludeItemTypes: 'BoxSet',
                    Fields: 'ChildCount,RecursiveItemCount,Overview',
                    SortBy: 'SortName',
                });
                let items = (res && res.Items) ? res.Items : [];
                for (let i = 0; i < items.length; i++) {
                    let m = items[i];
                    list.push({
                        title: m.Name,
                        key: '/Items/' + m.Id,
                        ratingKey: m.Id,
                        jellyfinId: m.Id,
                        type: 'collection',
                        collectionKind: 'boxset',
                        libraryTitle: 'Collections',
                        icon: buildImageUrl(server, m.Id, 'Primary', m.ImageTags && m.ImageTags.Primary),
                        count: m.ChildCount || m.RecursiveItemCount || null,
                        source: 'jellyfin',
                    });
                }
            } catch (err) {
                console.error('Jellyfin global collections failed', err);
            }

            try {
                let sections = await exported.getLibrary(server, { preferLive: true });
                for (let s = 0; s < sections.length; s++) {
                    let section = sections[s];
                    if (section.type !== 'movie' && section.type !== 'show' && section.type !== 'artist') {
                        continue;
                    }
                    try {
                        let gRes = await jfGet(server, '/Genres', {
                            ParentId: section.sectionKey || section.key,
                            SortBy: 'SortName',
                            SortOrder: 'Ascending',
                        });
                        let genres = (gRes && gRes.Items) ? gRes.Items : (Array.isArray(gRes) ? gRes : []);
                        for (let gi = 0; gi < genres.length; gi++) {
                            let g = genres[gi];
                            if (!g || !g.Id) continue;
                            list.push({
                                title: (g.Name || 'Genre') + ' (Genre)',
                                key: '/Genres/' + g.Id + '/Library/' + (section.sectionKey || section.key),
                                ratingKey: g.Id,
                                jellyfinId: g.Id,
                                genreId: g.Id,
                                type: 'collection',
                                collectionKind: 'genre',
                                collectionType: section.type,
                                libraryTitle: section.title,
                                librarySectionKey: section.sectionKey || section.key,
                                icon: buildImageUrl(server, g.Id, 'Primary', g.ImageTags && g.ImageTags.Primary),
                                count: g.ChildCount || g.MovieCount || g.SeriesCount || null,
                                source: 'jellyfin',
                            });
                        }
                    } catch (ge) {
                        console.error('Jellyfin genres failed for', section.title, ge);
                    }
                }
            } catch (err) {
                console.error('Jellyfin library genres failed', err);
            }
            return filterNonEmptyListSources(list);
        },

        /**
         * Expand a library node. Programming UI: cache only.
         * Live Jellyfin only when options.preferLive === true.
         */
        getNested: async (server, lib, includeCollections, errors, options) => {
            errors = errors || [];
            options = options || {};
            const parentId = lib.jellyfinId || lib.ratingKey || lib.key || lib.sectionKey;
            if (!parentId) {
                return [];
            }
            // Strip leading /Items/ if key form was used
            let pid = String(parentId).replace(/^\/Items\//i, '');

            // Prefer disk/memory cache
            try {
                let cached = await dizquetv.getJellyfinCacheNested(server.name, pid, includeCollections === true);
                if (cached && cached.fromCache && Array.isArray(cached.nested)) {
                    let nested = cached.nested.slice();
                    for (let i = 0; i < nested.length; i++) {
                        if (nested[i] && !nested[i].server) nested[i].server = server;
                    }
                    return nested;
                }
            } catch (e) { /* ignore */ }

            if (!options.preferLive) {
                return [];
            }

            let includeTypes;
            let libType = lib.type;
            if (libType === 'show' && lib.isLibraryNode) {
                includeTypes = 'Series';
            } else if (libType === 'movie' && lib.isLibraryNode) {
                includeTypes = 'Movie';
            } else if (libType === 'show') {
                // expanding a series → seasons
                includeTypes = 'Season';
            } else if (libType === 'season') {
                includeTypes = 'Episode';
            } else if (libType === 'playlist' || libType === 'collection') {
                includeTypes = undefined; // all children
            }

            // Per-library favorites virtual playlist
            let favKeyMatch = String(lib.key || '').match(/^\/Favorites\/Library\/([^/?#]+)/i);
            if (lib.playlistKind === 'favorites' || favKeyMatch) {
                let sectionKey = lib.librarySectionKey || (favKeyMatch && favKeyMatch[1]);
                let libType = lib.libraryType || lib.collectionType || 'movie';
                let itemTypes = 'Movie';
                if (libType === 'show') itemTypes = 'Series,Episode';
                else if (libType === 'artist') itemTypes = 'Audio';
                try {
                    let res = await jfGet(server, '/Users/{userId}/Items', {
                        ParentId: sectionKey,
                        Recursive: 'true',
                        Filters: 'IsFavorite',
                        IncludeItemTypes: itemTypes,
                        Fields: 'BasicSyncInfo,MediaSources,Path,Overview,ProductionYear,PremiereDate,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,SeasonName,ChildCount,RecursiveItemCount',
                        SortBy: 'SortName',
                        SortOrder: 'Ascending',
                    });
                    let items = (res && res.Items) ? res.Items : [];
                    let nested = [];
                    for (let i = 0; i < items.length; i++) {
                        try {
                            let program = mapItemToProgram(server, items[i]);
                            if (program) nested.push(program);
                        } catch (err) {
                            errors.push('Error mapping favorite ' + (items[i] && items[i].Name));
                        }
                    }
                    return nested;
                } catch (err) {
                    errors.push('Unable to load favorites for ' + (lib.title || sectionKey));
                    console.error(err);
                    return [];
                }
            }

            // Genre "collections" expand via GenreIds + library ParentId
            let genreKeyMatch = String(lib.key || '').match(/^\/Genres\/([^/]+)\/Library\/([^/?#]+)/i);
            if (lib.collectionKind === 'genre' || genreKeyMatch) {
                let genreId = lib.genreId || lib.ratingKey || (genreKeyMatch && genreKeyMatch[1]);
                let sectionKey = lib.librarySectionKey || (genreKeyMatch && genreKeyMatch[2]);
                let itemTypes = 'Movie';
                if (lib.collectionType === 'show') itemTypes = 'Series';
                else if (lib.collectionType === 'artist') itemTypes = 'Audio';
                try {
                    let res = await jfGet(server, '/Users/{userId}/Items', {
                        ParentId: sectionKey,
                        Recursive: 'true',
                        GenreIds: genreId,
                        IncludeItemTypes: itemTypes,
                        Fields: 'BasicSyncInfo,MediaSources,Path,Overview,ProductionYear,PremiereDate,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,SeasonName,ChildCount,RecursiveItemCount',
                        SortBy: 'SortName',
                        SortOrder: 'Ascending',
                    });
                    let items = (res && res.Items) ? res.Items : [];
                    let nested = [];
                    for (let i = 0; i < items.length; i++) {
                        try {
                            let program = mapItemToProgram(server, items[i]);
                            if (program) nested.push(program);
                        } catch (err) {
                            errors.push('Error mapping genre item ' + (items[i] && items[i].Name));
                        }
                    }
                    return nested;
                } catch (err) {
                    errors.push('Unable to load genre items for ' + (lib.title || genreId));
                    console.error(err);
                    return [];
                }
            }

            try {
                let qs = {
                    ParentId: pid,
                    Recursive: 'false',
                    Fields: 'BasicSyncInfo,MediaSources,Path,Overview,ProductionYear,PremiereDate,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,SeasonName,ChildCount,RecursiveItemCount',
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                };
                if (includeTypes) {
                    qs.IncludeItemTypes = includeTypes;
                }
                // When expanding a library root, recurse so items under folders still appear
                if (libType === 'show' && lib.isLibraryNode) {
                    qs.IncludeItemTypes = 'Series';
                    qs.Recursive = 'true';
                }
                if (libType === 'movie' && lib.isLibraryNode) {
                    qs.IncludeItemTypes = 'Movie';
                    qs.Recursive = 'true';
                }
                if (libType === 'artist' && lib.isLibraryNode) {
                    qs.IncludeItemTypes = 'MusicAlbum,Audio';
                    qs.Recursive = 'true';
                }

                let res = await jfGet(server, '/Users/{userId}/Items', qs);
                let items = (res && res.Items) ? res.Items : [];
                let nested = [];
                for (let i = 0; i < items.length; i++) {
                    try {
                        let program = mapItemToProgram(server, items[i]);
                        if (program) {
                            nested.push(program);
                        }
                    } catch (err) {
                        let msg = 'Error mapping Jellyfin item ' + (items[i] && items[i].Name);
                        errors.push(msg);
                        console.error(msg, err);
                    }
                }
                void includeCollections;
                return nested;
            } catch (err) {
                let msg = 'Unable to load Jellyfin items for ' + (lib.title || pid);
                errors.push(msg);
                console.error(msg, err);
                return [];
            }
        },

        expandToPrograms: async function expandToPrograms(server, item, errors) {
            if (!item) {
                return [];
            }
            if (item.type === 'movie' || item.type === 'episode' || item.type === 'track') {
                let copy = JSON.parse(JSON.stringify(item));
                delete copy.server;
                delete copy.nested;
                delete copy.collapse;
                delete copy.children;
                copy.source = 'jellyfin';
                copy.serverType = 'jellyfin';
                copy.serverKey = server.name;
                if (typeof copy.commercials === 'undefined') {
                    copy.commercials = [];
                }
                return [copy];
            }

            let nested = [];
            if (Object.prototype.hasOwnProperty.call(item, 'children') && Array.isArray(item.children)) {
                nested = item.children;
            } else {
                try {
                    nested = await exported.getNested(server, item, false, errors || []);
                } catch (err) {
                    let msg = 'Unable to load items for ' + (item.title || item.key);
                    if (errors) errors.push(msg);
                    console.error(msg, err);
                    return [];
                }
            }

            let result = [];
            for (let i = 0; i < nested.length; i++) {
                let more = await expandToPrograms(server, nested[i], errors);
                result = result.concat(more);
            }
            return result;
        },

        getShows: async (server, options) => {
            options = options || {};
            try {
                let cached = await dizquetv.getJellyfinCacheShows(server.name, !!options.includeHidden);
                if (cached && cached.fromCache && Array.isArray(cached.shows)) {
                    return cached.shows;
                }
            } catch (e) { /* ignore */ }
            if (!options.preferLive) {
                return [];
            }

            let sections = await exported.getLibrary(server, { preferLive: true });
            let shows = [];
            let errors = [];
            for (let i = 0; i < sections.length; i++) {
                let section = sections[i];
                if (section.type !== 'show') continue;
                section.isLibraryNode = true;
                try {
                    let nested = await exported.getNested(server, section, false, errors);
                    for (let j = 0; j < (nested || []).length; j++) {
                        let item = nested[j];
                        if (!item || item.type !== 'show') continue;
                        shows.push({
                            title: item.title,
                            key: item.key,
                            type: 'show',
                            libraryTitle: section.title,
                            icon: item.icon || '',
                            ratingKey: item.ratingKey,
                            jellyfinId: item.jellyfinId,
                            source: 'jellyfin',
                            seasonCount: item.seasonCount,
                            episodeCount: item.episodeCount,
                            count: item.episodeCount != null ? item.episodeCount : item.seasonCount,
                        });
                    }
                } catch (err) {
                    console.error('Unable to load shows for library ' + section.title, err);
                }
            }
            return shows;
        },
    };

    return exported;
};
