module.exports = function ($timeout, $location, plex, jellyfin, dizquetv, commonProgramTools, libraryCatalogPreload) {
    return {
        restrict: 'E',
        templateUrl: 'templates/bulk-channel-import.html',
        replace: true,
        scope: {
            visible: "=visible",
            channels: "=channels",
            onDone: "=onDone"
        },
        link: function (scope) {
            scope.servers = [];
/** 'all' | 'plex' | 'jellyfin' */
            scope.mediaSourceFilter = 'all';
            /** Merged playlists + collections + custom shows */
            scope.lists = [];
            scope.shows = [];
            /** Movie libraries (same idea as Create Custom Show Movies panel) */
            scope.movies = [];
            /** Full unfiltered catalog (all servers) */
            scope._allLists = [];
            scope._allShows = [];
            scope._allMovies = [];
            scope.listFilter = "";
            scope.showFilter = "";
            scope.movieFilter = "";
            scope.movieSummaryFilter = "";
            scope.movieSearching = false;
            /** When set, movie tree visibility uses server cache search hits */
            scope._movieSearchHits = null; // { movieKeys: {}, libraryKeys: {} }
            scope.loading = false;
            scope.importing = false;
            scope.status = "";
            scope.errors = [];
            scope.progress = { current: 0, total: 0 };

            /** Optional channel name override for content-source import. */
            scope.channelName = "";

            function sortByTitle(items) {
                return (items || []).slice().sort((a, b) => {
                    let ta = (a.title || a.name || "").toString();
                    let tb = (b.title || b.name || "").toString();
                    return ta.localeCompare(tb, undefined, { sensitivity: 'base', numeric: true });
                });
            }

            function mediaApi(mediaSource) {
                return mediaSource === 'jellyfin' ? jellyfin : plex;
            }

            function nextChannelNumber(knownChannels) {
                let max = 0;
                let list = knownChannels || scope.channels || [];
                for (let i = 0; i < list.length; i++) {
                    let n = parseInt(list[i].number, 10);
                    if (!isNaN(n) && n > max) {
                        max = n;
                    }
                }
                if (scope._nextNumber && scope._nextNumber > max) {
                    max = scope._nextNumber - 1;
                }
                return max + 1;
            }

            function defaultStartTime() {
                let startTime = new Date();
                startTime.setMilliseconds(0);
                startTime.setSeconds(0);
                if (startTime.getMinutes() < 30) {
                    startTime.setMinutes(0);
                } else {
                    startTime.setMinutes(30);
                }
                return startTime;
            }

            function normalizeName(s) {
                return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
            }

            function findChannelByName(name, channelList) {
                let n = normalizeName(name);
                for (let i = 0; i < channelList.length; i++) {
                    if (normalizeName(channelList[i].name) === n) {
                        return channelList[i];
                    }
                }
                return null;
            }

            /** Same shape as channel-config content sources */
            function makeContentSource(server, source) {
                let type = source.type || "playlist";
                if (
                    type !== "playlist"
                    && type !== "collection"
                    && type !== "show"
                    && type !== "custom"
                    && type !== "movie"
                    && type !== "external-list"
                ) {
                    type = "playlist";
                }
                let mediaSource = source.mediaSource || source.serverType || source.source
                    || (type === 'custom' ? 'custom' : null)
                    || (type === 'external-list' ? 'list' : null)
                    || (server && server.source) || 'plex';
                return {
                    type: type,
                    key: source.key,
                    title: source.title,
                    serverName: (server && server.name) || source.serverName || "",
                    mediaSource: mediaSource,
                    source: mediaSource,
                    serverType: mediaSource,
                    collectionType: source.collectionType || null,
                    collectionKind: source.collectionKind || null,
                    playlistKind: source.playlistKind || null,
                    libraryTitle: source.libraryTitle || null,
                    librarySectionKey: source.librarySectionKey || null,
                    libraryType: source.libraryType || null,
                    jellyfinId: source.jellyfinId || source.ratingKey || null,
                    ratingKey: source.ratingKey || source.jellyfinId || null,
                    genreId: source.genreId || null,
                    trackedListId: source.trackedListId || null,
                    externalProvider: source.provider || source.externalProvider || null,
                    lastSyncedAt: new Date().toISOString(),
                };
            }

            function contentSourceId(src) {
                let ms = src.mediaSource || src.serverType || src.source || 'plex';
                return String(ms) + "\0" + (src.serverName || "") + "\0" + (src.type || "") + "\0" + (src.key || "");
            }

            /**
             * Merge newly imported sources into existing contentSources.
             */
            function mergeContentSources(existing, incoming) {
                let list = Array.isArray(existing) ? existing.slice() : [];
                for (let i = 0; i < incoming.length; i++) {
                    let src = incoming[i];
                    let id = contentSourceId(src);
                    let idx = -1;
                    for (let j = 0; j < list.length; j++) {
                        if (contentSourceId(list[j]) === id) {
                            idx = j;
                            break;
                        }
                    }
                    if (idx >= 0) {
                        list[idx] = src;
                    } else {
                        list.push(src);
                    }
                }
                return list;
            }

            function preparePrograms(programs) {
                let list = programs.slice();
                if (typeof commonProgramTools.removeDuplicates === 'function') {
                    list = commonProgramTools.removeDuplicates(list);
                }
                list = commonProgramTools.shuffle(list);
                let duration = 0;
                for (let i = 0; i < list.length; i++) {
                    if (typeof list[i].commercials === 'undefined') {
                        list[i].commercials = [];
                    }
                    duration += list[i].duration || 0;
                }
                return { programs: list, duration: duration };
            }

            async function shouldEnableWatermarkByDefault() {
                try {
                    let ffmpegSettings = await dizquetv.getFfmpegSettings();
                    return (
                        ffmpegSettings
                        && ffmpegSettings.enableChannelWatermarkGlobally === true
                        && ffmpegSettings.disableChannelOverlay !== true
                    );
                } catch (err) {
                    console.error("Could not load ffmpeg settings for watermark default.", err);
                    return false;
                }
            }

            function buildNewChannel(name, number, programs, duration, watermarkEnabled, contentSources) {
                return {
                    name: name,
                    number: number,
                    programs: programs,
                    contentSources: contentSources,
                    watermark: {
                        enabled: watermarkEnabled === true,
                        position: "bottom-right",
                        width: 10.00,
                        verticalMargin: 0.00,
                        horizontalMargin: 0.00,
                        duration: 0,
                    },
                    fillerCollections: [],
                    guideFlexPlaceholder: "",
                    fillerRepeatCooldown: 30 * 60 * 1000,
                    fallback: [],
                    guideMinimumDurationSeconds: 5 * 60,
                    icon: `/images/dizquetv.png`,
                    groupTitle: "dizqueTV",
                    disableFillerOverlay: true,
                    iconWidth: 120,
                    iconDuration: 60,
                    iconPosition: "2",
                    startTime: defaultStartTime(),
                    offlineMode: "pic",
                    duration: duration,
                    transcoding: {
                        targetResolution: "",
                    },
                    onDemand: {
                        isOnDemand: false,
                        modulo: 1,
                    },
                };
            }

            scope.$watch('visible', function (v) {
                if (v) {
                    open();
                }
            });

            async function open() {
                scope.lists = [];
                scope.shows = [];
                scope.movies = [];
                scope._allLists = [];
                scope._allShows = [];
                scope._allMovies = [];
                scope.listFilter = "";
                scope.showFilter = "";
                scope.movieFilter = "";
                scope.errors = [];
                scope.status = "";
                scope.progress = { current: 0, total: 0 };
                scope.importing = false;
                scope.loading = true;
                scope._nextNumber = null;
                scope.channelName = "";
                $timeout();
                try {
                    let plexServers = await dizquetv.getPlexServers().catch(() => []);
                    let jfServers = await dizquetv.getJellyfinServers().catch(() => []);
                    let servers = [];
                    (plexServers || []).forEach((s) => {
                        servers.push(Object.assign({}, s, {
                            source: 'plex',
                            displayName: 'Plex - ' + s.name,
                        }));
                    });
                    (jfServers || []).forEach((s) => {
                        servers.push(Object.assign({}, s, {
                            source: 'jellyfin',
                            displayName: 'Jellyfin - ' + s.name,
                        }));
                    });
                    scope.servers = servers;
                    await scope.loadLists();
                } catch (err) {
                    console.error(err);
                    scope.errors.push("Unable to load media servers.");
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            }

            /**
             * Load movies / TV shows / playlists+collections+custom from local
             * library cache (content-sources catalog + media library folders).
             */
            scope.loadLists = async () => {
                scope.listFilter = "";
                scope.showFilter = "";
                scope.movieFilter = "";
                scope.errors = [];
                scope.loading = true;
                $timeout();
                try {
                    // Plex/Jellyfin from session cache; custom shows always live
                    await libraryCatalogPreload.ensureLoaded();
                    let catalog = libraryCatalogPreload.getContentSourceCatalog()
                        || await dizquetv.getContentSourceCatalog();
                    let lists = (catalog.lists || []).map((p) => {
                        return Object.assign({}, p, { selected: false });
                    });
                    let shows = (catalog.shows || []).map((s) => {
                        return Object.assign({}, s, { selected: false });
                    });
                    // Movie libraries (tree roots — same as Create Custom Show → Movies)
                    let media = libraryCatalogPreload.getMedia(
                        scope.mediaSourceFilter === 'plex' || scope.mediaSourceFilter === 'jellyfin'
                            ? scope.mediaSourceFilter
                            : 'all'
                    ) || { movies: [] };
                    let movies = (media.movies || []).map((m) => {
                        let mediaSource = m.source || m.serverType || m.mediaSource || 'plex';
                        let serverName =
                            m.serverName
                            || (m._server && m._server.name)
                            || '';
                        let sectionKey = m.sectionKey || m.librarySectionKey || null;
                        // Preserve _server for getNested
                        let row = Object.assign({}, m, {
                            title: m.title || m.name || 'Movies',
                            type: m.type || 'movie',
                            libraryType: m.type || 'movie',
                            isLibraryNode: true,
                            selected: false,
                            collapse: false,
                            nested: undefined,
                            loadingNested: false,
                            count: m.count != null ? m.count : null,
                            serverName: serverName,
                            mediaSource: mediaSource,
                            source: mediaSource,
                            serverType: mediaSource,
                            sectionKey: sectionKey,
                            librarySectionKey: sectionKey,
                            libraryTitle: m.title || m.name || null,
                        });
                        return row;
                    });
                    // Fold custom shows + tracked lists into Playlists/Lists/Custom/Collections
                    let liveCustoms = await libraryCatalogPreload.fetchCustomShowsLive();
                    let customShows = (liveCustoms || []).map((c) => ({
                        title: c.name,
                        key: c.id,
                        type: 'custom',
                        selected: false,
                        count: c.count,
                        serverName: '',
                        mediaSource: 'custom',
                        source: 'custom',
                        serverType: 'custom',
                    }));
                    let trackedLists = await libraryCatalogPreload.fetchTrackedListsLive();
                    lists = lists.concat(customShows).concat(
                        (trackedLists || []).map((t) => Object.assign({}, t, { selected: false }))
                    );

                    let warnings = catalog.warnings || [];
                    for (let w = 0; w < warnings.length && w < 4; w++) {
                        scope.errors.push(warnings[w]);
                    }

                    scope._allLists = sortByTitle(lists);
                    scope._allShows = sortByTitle(shows);
                    scope._allMovies = sortByTitle(movies);
                    scope.applyMediaSourceFilter();
                } catch (err) {
                    console.error(err);
                    scope.errors.push("Unable to load content sources from cache.");
                    scope._allLists = [];
                    scope._allShows = [];
                    scope._allMovies = [];
                    scope.applyMediaSourceFilter();
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            };

            scope.mediaSourceFilterFn = (item) => {
                if (!item) return false;
                let ms = item.mediaSource || item.serverType || item.source || 'plex';
                if (
                    ms === 'custom'
                    || ms === 'list'
                    || item.type === 'custom'
                    || item.type === 'external-list'
                    || item.trackedListId
                ) {
                    return true;
                }
                if (scope.mediaSourceFilter === 'all') return true;
                return ms === scope.mediaSourceFilter;
            };

            scope.setMediaSourceFilter = (v) => {
                if (v === 'plex' || v === 'jellyfin' || v === 'all') {
                    let prev = scope.mediaSourceFilter;
                    scope.mediaSourceFilter = v;
                    // Reload when switching media type so we don't keep unused server data warm only —
                    // still cheap via cache; ensures empty-server types refresh cleanly.
                    if (prev !== v) {
                        scope.loadLists();
                    } else {
                        scope.applyMediaSourceFilter();
                    }
                }
            };

            scope.applyMediaSourceFilter = () => {
                let f = scope.mediaSourceFilterFn;
                scope.lists = (scope._allLists || []).filter(f);
                scope.shows = (scope._allShows || []).filter(f);
                scope.movies = (scope._allMovies || []).filter(f);
                scope._movieSearchHits = null;
                scope.movieFilter = "";
                scope.movieSummaryFilter = "";
            };

            scope.selectAll = (list, value) => {
                for (let i = 0; i < list.length; i++) {
                    list[i].selected = value;
                }
            };

            scope.selectedCount = (list) => {
                let n = 0;
                for (let i = 0; i < list.length; i++) {
                    if (list[i].selected) {
                        n++;
                    }
                }
                return n;
            };

            // ---- Movies tree (Create Custom Show–style) ----

            function movieIdentityKey(item) {
                if (!item) return '';
                let source = item.mediaSource || item.source || item.serverType || 'plex';
                let server = item.serverName || (item._server && item._server.name) || '';
                let rk =
                    item.ratingKey != null
                        ? String(item.ratingKey)
                        : item.jellyfinId != null
                          ? String(item.jellyfinId)
                          : item.key != null
                            ? String(item.key)
                            : '';
                return source + '|' + server + '|' + rk;
            }

            function movieLibraryKey(lib) {
                if (!lib) return '';
                let source = lib.mediaSource || lib.source || lib.serverType || 'plex';
                let server = lib.serverName || (lib._server && lib._server.name) || '';
                let sk =
                    lib.sectionKey != null
                        ? String(lib.sectionKey)
                        : lib.librarySectionKey != null
                          ? String(lib.librarySectionKey)
                          : '';
                return source + '|' + server + '|' + sk;
            }

            function findServerForItem(item) {
                let ms = item.mediaSource || item.source || item.serverType || 'plex';
                let name = item.serverName || (item._server && item._server.name) || '';
                for (let i = 0; i < scope.servers.length; i++) {
                    let s = scope.servers[i];
                    if ((s.source || 'plex') === ms && s.name === name) {
                        return s;
                    }
                }
                if (item._server) return item._server;
                return null;
            }

            function textMatch(hay, q) {
                if (!q) return true;
                if (hay == null) return false;
                return String(hay).toLowerCase().indexOf(q) >= 0;
            }

            scope.movieDisplayTitle = (item) => {
                if (!item) return '';
                let t = item.title || item.name || '';
                if (item.year != null && item.year !== '') {
                    t += ' (' + item.year + ')';
                }
                return t;
            };

            scope.movieHasFilter = () => {
                return !!(
                    String(scope.movieFilter || '').trim()
                    || String(scope.movieSummaryFilter || '').trim()
                );
            };

            scope.movieLibVisible = (lib) => {
                if (!lib) return false;
                if (!scope.movieHasFilter()) return true;
                if (scope._movieSearchHits) {
                    let lk = movieLibraryKey(lib);
                    if (scope._movieSearchHits.libraryKeys[lk]) return true;
                    // also show if any nested selected movie is a hit
                    if (lib.nested && lib.nested.length) {
                        for (let i = 0; i < lib.nested.length; i++) {
                            if (scope.movieChildVisible(lib.nested[i])) return true;
                        }
                    }
                    return false;
                }
                // Local title-only filter on library name
                let q = String(scope.movieFilter || '').trim().toLowerCase();
                if (q && textMatch(lib.title, q)) return true;
                if (lib.nested && lib.nested.length) {
                    for (let i = 0; i < lib.nested.length; i++) {
                        if (scope.movieChildVisible(lib.nested[i])) return true;
                    }
                }
                return !q; // summary-only without hits yet → hide until search returns
            };

            scope.movieChildVisible = (movie) => {
                if (!movie) return false;
                if (!scope.movieHasFilter()) return true;
                if (scope._movieSearchHits) {
                    return !!scope._movieSearchHits.movieKeys[movieIdentityKey(movie)];
                }
                let q = String(scope.movieFilter || '').trim().toLowerCase();
                let sq = String(scope.movieSummaryFilter || '').trim().toLowerCase();
                let titleOk = !q || textMatch(movie.title, q) || textMatch(movie.originalTitle, q);
                let sumOk = !sq || textMatch(movie.summary, sq);
                return titleOk && sumOk;
            };

            scope.visibleMovieLibCount = () => {
                let n = 0;
                for (let i = 0; i < scope.movies.length; i++) {
                    if (scope.movieLibVisible(scope.movies[i])) n++;
                }
                return n;
            };

            scope.selectedMovieCount = () => {
                let n = 0;
                for (let i = 0; i < scope.movies.length; i++) {
                    let lib = scope.movies[i];
                    if (lib.nested) {
                        for (let j = 0; j < lib.nested.length; j++) {
                            if (lib.nested[j].selected && scope.movieChildVisible(lib.nested[j])) {
                                n++;
                            } else if (lib.nested[j].selected) {
                                n++;
                            }
                        }
                    }
                }
                return n;
            };

            scope.visibleMovieLeafCount = () => {
                let n = 0;
                for (let i = 0; i < scope.movies.length; i++) {
                    let lib = scope.movies[i];
                    if (!scope.movieLibVisible(lib)) continue;
                    if (!lib.nested) continue;
                    for (let j = 0; j < lib.nested.length; j++) {
                        if (scope.movieChildVisible(lib.nested[j])) n++;
                    }
                }
                return n;
            };

            async function ensureMovieLibraryLoaded(lib) {
                if (!lib) return;
                if (typeof lib.nested !== 'undefined') {
                    return;
                }
                lib.loadingNested = true;
                $timeout();
                try {
                    let server = findServerForItem(lib);
                    if (!server) {
                        lib.nested = [];
                    } else {
                        let api = mediaApi(lib.mediaSource || lib.source || 'plex');
                        let nested = await api.getNested(server, lib, false, []);
                        nested = (nested || []).filter((n) => n && n.type === 'movie');
                        for (let i = 0; i < nested.length; i++) {
                            nested[i].selected = false;
                            nested[i].mediaSource = lib.mediaSource || lib.source || 'plex';
                            nested[i].source = nested[i].mediaSource;
                            nested[i].serverType = nested[i].mediaSource;
                            nested[i].serverName = lib.serverName || server.name;
                            nested[i].serverKey = server.name;
                            nested[i]._server = server;
                            if (typeof nested[i].commercials === 'undefined') {
                                nested[i].commercials = [];
                            }
                        }
                        lib.nested = sortByTitle(nested);
                    }
                } catch (err) {
                    console.error(err);
                    lib.nested = [];
                    scope.errors.push(
                        'Failed to load movies for “' + (lib.title || 'library') + '”.'
                    );
                } finally {
                    lib.loadingNested = false;
                    $timeout();
                }
            }

            scope.toggleMovieLibrary = async (lib) => {
                if (!lib || scope.importing) return;
                if (lib.collapse) {
                    lib.collapse = false;
                    $timeout();
                    return;
                }
                await ensureMovieLibraryLoaded(lib);
                lib.collapse = true;
                $timeout();
            };

            let _movieFilterSeq = 0;
            scope.onMovieFilterChange = async () => {
                let q = String(scope.movieFilter || '').trim();
                let sq = String(scope.movieSummaryFilter || '').trim();
                if (!q && !sq) {
                    scope._movieSearchHits = null;
                    $timeout();
                    return;
                }
                // Title-only: filter locally (library name + already-loaded nested titles)
                if (q && !sq) {
                    scope._movieSearchHits = null;
                    // Expand libraries so nested title matches can appear
                    scope.movieSearching = true;
                    $timeout();
                    try {
                        let qLower = q.toLowerCase();
                        for (let i = 0; i < scope.movies.length; i++) {
                            let lib = scope.movies[i];
                            // Load children when library name alone may not match the title query
                            if (typeof lib.nested === 'undefined' && !textMatch(lib.title, qLower)) {
                                await ensureMovieLibraryLoaded(lib);
                            }
                            if (lib.nested && lib.nested.length) {
                                let any = false;
                                for (let j = 0; j < lib.nested.length; j++) {
                                    if (scope.movieChildVisible(lib.nested[j])) {
                                        any = true;
                                        break;
                                    }
                                }
                                if (any || textMatch(lib.title, qLower)) {
                                    lib.collapse = true;
                                }
                            } else if (textMatch(lib.title, qLower)) {
                                lib.collapse = true;
                            }
                        }
                    } finally {
                        scope.movieSearching = false;
                        $timeout();
                    }
                    return;
                }
                // Summary (or title+summary): one server in-memory cache search
                let seq = ++_movieFilterSeq;
                scope.movieSearching = true;
                $timeout();
                try {
                    let result = await dizquetv.searchLibraryCache({
                        title: q,
                        summary: sq,
                        limit: 4000,
                    });
                    if (seq !== _movieFilterSeq) return;
                    let movieKeys = {};
                    let libraryKeys = {};
                    let movies = (result && result.movies) || [];
                    for (let i = 0; i < movies.length; i++) {
                        let m = movies[i];
                        let k =
                            (m.source || '') +
                            '|' +
                            (m.serverName || '') +
                            '|' +
                            String(m.ratingKey || m.jellyfinId || '');
                        movieKeys[k] = true;
                        if (m.librarySectionKey != null) {
                            libraryKeys[
                                (m.source || '') +
                                    '|' +
                                    (m.serverName || '') +
                                    '|' +
                                    String(m.librarySectionKey)
                            ] = true;
                        }
                    }
                    scope._movieSearchHits = {
                        movieKeys: movieKeys,
                        libraryKeys: libraryKeys,
                    };
                    // Expand hit libraries and load nested for leaf checkboxes
                    for (let i = 0; i < scope.movies.length; i++) {
                        let lib = scope.movies[i];
                        if (!scope.movieLibVisible(lib)) {
                            lib.collapse = false;
                            continue;
                        }
                        await ensureMovieLibraryLoaded(lib);
                        lib.collapse = true;
                    }
                } catch (err) {
                    console.error(err);
                    scope._movieSearchHits = null;
                } finally {
                    if (seq === _movieFilterSeq) {
                        scope.movieSearching = false;
                    }
                    $timeout();
                }
            };

            /**
             * Select only currently filtered (visible) movies under one library.
             * Used by the tree + control — never selects the whole unfiltered library.
             */
            scope.addFilteredMoviesInLibrary = async (lib) => {
                if (!lib || scope.importing) return;
                await ensureMovieLibraryLoaded(lib);
                lib.collapse = true;
                lib.selected = false;
                let nested = lib.nested || [];
                let any = false;
                for (let j = 0; j < nested.length; j++) {
                    if (scope.movieChildVisible(nested[j])) {
                        nested[j].selected = true;
                        any = true;
                    }
                }
                if (!any && scope.movieHasFilter()) {
                    // No visible children for current filter
                }
                $timeout();
            };

            /**
             * Add all: select only movies that match the current title/summary filter
             * (across all visible libraries). Never bulk-selects unfiltered whole libraries.
             */
            scope.selectAllVisibleMovies = async () => {
                if (scope.importing) return;
                scope.movieSearching = true;
                $timeout();
                try {
                    for (let i = 0; i < scope.movies.length; i++) {
                        let lib = scope.movies[i];
                        lib.selected = false;
                        if (!scope.movieLibVisible(lib)) {
                            // Clear any prior selection under hidden libraries
                            if (lib.nested) {
                                for (let j = 0; j < lib.nested.length; j++) {
                                    lib.nested[j].selected = false;
                                }
                            }
                            continue;
                        }
                        await ensureMovieLibraryLoaded(lib);
                        lib.collapse = true;
                        let nested = lib.nested || [];
                        for (let j = 0; j < nested.length; j++) {
                            // Only currently filtered / visible items
                            nested[j].selected = scope.movieChildVisible(nested[j]);
                        }
                    }
                } finally {
                    scope.movieSearching = false;
                    $timeout();
                }
            };

            function collectMovieSelections() {
                let out = [];
                let seen = {};
                for (let i = 0; i < scope.movies.length; i++) {
                    let lib = scope.movies[i];
                    // Never import a whole library node from lib.selected —
                    // only individually selected (filtered) movies.
                    if (lib.nested) {
                        for (let j = 0; j < lib.nested.length; j++) {
                            let m = lib.nested[j];
                            if (!m.selected) continue;
                            let k = 'm:' + movieIdentityKey(m);
                            if (seen[k]) continue;
                            seen[k] = true;
                            out.push(m);
                        }
                    }
                }
                return out;
            }

            scope.cancel = () => {
                if (scope.importing) {
                    return;
                }
                scope.visible = false;
                if (typeof scope.onDone === 'function') {
                    scope.onDone(false);
                }
            };

            scope.importSelected = async () => {
                if (scope.importing) {
                    return;
                }
                let selected = collectMovieSelections();
                for (let i = 0; i < scope.lists.length; i++) {
                    if (scope.lists[i].selected) {
                        selected.push(scope.lists[i]);
                    }
                }
                for (let i = 0; i < scope.shows.length; i++) {
                    if (scope.shows[i].selected) {
                        selected.push(scope.shows[i]);
                    }
                }
                if (selected.length === 0) {
                    scope.errors = [
                        "Select at least one movie, movie library, playlist, collection, TV show, or custom show.",
                    ];
                    $timeout();
                    return;
                }

                // If Name is set, all selected sources import into that one channel.
                // Otherwise each content source title becomes the channel name
                // (sources that share a title still merge into one channel).
                let overrideName = (scope.channelName || "").trim();
                let groups = {};
                let groupOrder = [];
                for (let i = 0; i < selected.length; i++) {
                    let src = selected[i];
                    let channelTitle = overrideName || src.title;
                    let key = normalizeName(channelTitle);
                    if (!groups[key]) {
                        groups[key] = {
                            name: channelTitle,
                            sources: [],
                        };
                        groupOrder.push(key);
                    }
                    groups[key].sources.push(src);
                }

                scope.importing = true;
                scope.errors = [];
                scope.progress = { current: 0, total: groupOrder.length };
                scope.status = "Starting import...";
                scope._nextNumber = nextChannelNumber(scope.channels);
                $timeout();

                let watermarkEnabled = await shouldEnableWatermarkByDefault();
                let created = 0;
                let updated = 0;

                // Index servers for expand
                let serverByKey = {};
                for (let i = 0; i < scope.servers.length; i++) {
                    let s = scope.servers[i];
                    let ms = s.source || 'plex';
                    serverByKey[ms + '\0' + s.name] = s;
                }

                let known = (scope.channels || []).map((c) => {
                    return { name: c.name, number: c.number };
                });

                for (let g = 0; g < groupOrder.length; g++) {
                    let group = groups[groupOrder[g]];
                    scope.progress.current = g + 1;
                    scope.status = `Importing "${group.name}" (${g + 1}/${groupOrder.length})...`;
                    $timeout();

                    try {
                        let expandErrors = [];
                        let programs = [];
                        let contentSources = [];

                        for (let s = 0; s < group.sources.length; s++) {
                            let source = group.sources[s];
                            let mediaSource = source.mediaSource || source.source || 'plex';

                            if (source.type === 'custom' || mediaSource === 'custom') {
                                try {
                                    let show = await dizquetv.getShow(source.key);
                                    if (!show || !Array.isArray(show.content) || !show.content.length) {
                                        expandErrors.push(
                                            `Custom programming "${source.title}" has no items.`
                                        );
                                        continue;
                                    }
                                    for (let c = 0; c < show.content.length; c++) {
                                        let item = JSON.parse(JSON.stringify(show.content[c]));
                                        item.customShowId = show.id || source.key;
                                        item.customShowName = show.name || source.title;
                                        item.customOrder = c;
                                        if (typeof item.commercials === 'undefined') {
                                            item.commercials = [];
                                        }
                                        programs.push(item);
                                    }
                                    contentSources.push(makeContentSource(null, source));
                                } catch (err) {
                                    console.error(err);
                                    expandErrors.push(
                                        `Failed custom programming "${source.title}".`
                                    );
                                }
                                continue;
                            }

                            if (
                                source.type === 'external-list'
                                || mediaSource === 'list'
                                || source.trackedListId
                            ) {
                                try {
                                    let listId = source.trackedListId || source.key;
                                    let payload = await dizquetv.getTrackedListPrograms(listId);
                                    let more = (payload && payload.programs) || [];
                                    if (!more.length) {
                                        expandErrors.push(
                                            `Tracked list "${source.title}" has no matched programs.`
                                        );
                                        continue;
                                    }
                                    for (let t = 0; t < more.length; t++) {
                                        let item = JSON.parse(JSON.stringify(more[t]));
                                        if (typeof item.commercials === 'undefined') {
                                            item.commercials = [];
                                        }
                                        item.trackedListId = listId;
                                        item.trackedListName = source.title;
                                        programs.push(item);
                                    }
                                    contentSources.push(makeContentSource(null, source));
                                } catch (err) {
                                    console.error(err);
                                    expandErrors.push(
                                        `Failed tracked list "${source.title}".`
                                    );
                                }
                                continue;
                            }

                            let server = serverByKey[mediaSource + '\0' + source.serverName];
                            if (!server) {
                                expandErrors.push(
                                    "Server not found: " + mediaSource + " / " + source.serverName
                                );
                                continue;
                            }
                            let expandItem = Object.assign({}, source, {
                                mediaSource: mediaSource,
                                source: mediaSource,
                                serverType: mediaSource,
                            });
                            if (mediaSource === 'jellyfin' && !expandItem.jellyfinId && expandItem.key) {
                                let m = String(expandItem.key).match(/\/Items\/([^/?]+)/i)
                                    || String(expandItem.key).match(/\/Genres\/([^/]+)/i)
                                    || String(expandItem.key).match(/\/Favorites\/Library\/([^/?]+)/i);
                                if (m) {
                                    expandItem.jellyfinId = m[1];
                                    expandItem.ratingKey = expandItem.ratingKey || m[1];
                                }
                            }
                            let more = await mediaApi(mediaSource).expandToPrograms(
                                server,
                                expandItem,
                                expandErrors
                            );
                            if (more && more.length) {
                                for (let m = 0; m < more.length; m++) {
                                    if (mediaSource === 'jellyfin') {
                                        more[m].source = 'jellyfin';
                                        more[m].serverType = 'jellyfin';
                                        more[m].serverKey = server.name;
                                    }
                                }
                                programs = programs.concat(more);
                            }
                            contentSources.push(makeContentSource(server, source));
                        }

                        if (expandErrors.length > 0) {
                            scope.errors = scope.errors.concat(expandErrors);
                        }
                        if (!programs.length) {
                            scope.errors.push(`"${group.name}" has no importable items — skipped.`);
                            continue;
                        }
                        let prepared = preparePrograms(programs);
                        let existing = findChannelByName(group.name, known);

                        if (existing) {
                            let full = await dizquetv.getChannel(existing.number);
                            if (!full) {
                                scope.errors.push(
                                    `Could not load channel #${existing.number} "${group.name}".`
                                );
                                continue;
                            }
                            full.programs = prepared.programs;
                            full.duration = prepared.duration;
                            full.startTime = full.startTime ? new Date(full.startTime) : defaultStartTime();
                            full.contentSources = mergeContentSources(
                                full.contentSources,
                                contentSources
                            );
                            await dizquetv.updateChannel(full);
                            updated++;
                        } else {
                            let number = scope._nextNumber;
                            scope._nextNumber = number + 1;
                            let channel = buildNewChannel(
                                group.name,
                                number,
                                prepared.programs,
                                prepared.duration,
                                watermarkEnabled,
                                contentSources
                            );
                            await dizquetv.addChannel(channel);
                            known.push({ name: group.name, number: number });
                            created++;
                        }
                    } catch (err) {
                        console.error(err);
                        scope.errors.push(`Failed to import "${group.name}".`);
                    }
                    $timeout();
                }

                scope.importing = false;
                let parts = [];
                if (created) {
                    parts.push(`created ${created}`);
                }
                if (updated) {
                    parts.push(`updated ${updated}`);
                }
                scope.status = parts.length
                    ? `Done. ${parts.join(", ")} channel(s).`
                    : "Done. No channels changed.";
                $timeout();
                if (created > 0 || updated > 0) {
                    $timeout(() => {
                        scope.visible = false;
                        if (typeof scope.onDone === 'function') {
                            scope.onDone(true);
                        }
                    }, scope.errors.length === 0 ? 600 : 1500);
                }
            };
        }
    };
};

