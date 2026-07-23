module.exports = function (plex, jellyfin, dizquetv, $timeout, commonProgramTools, libraryCatalogPreload) {
    return {
        restrict: 'E',
        templateUrl: 'templates/plex-library.html',
        replace: true,
        scope: {
            onFinish: "=onFinish",
            height: "=height",
            positionChoice: "=positionChoice",
            visible: "=visible",
            limit: "=limit",
            /** When true, render inline (no modal chrome) — used by Create Custom Show */
            embedded: "=?",
            /** When true, hide Custom filter and custom-programming panel */
            hideCustom: "=?",
            /**
             * When true, only show libraries marked "Contains filler" in Library Management.
             * Used by the filler-list editor. Prefer @ (string) or = boolean.
             */
            fillerOnly: "@?",
        },
        link: function (scope, element, attrs) {
            scope.errors=[];
            if ( typeof(scope.limit) == 'undefined') {
                scope.limit = 1000000000;
            }
            if (scope.embedded !== true) {
                scope.embedded = false;
            }
            // Boolean attrs: support hide-custom="true" / filler-only="true" (string or boolean)
            function attrTruthy(val, attrCamel) {
                if (val === true || val === 'true' || val === '') return true;
                let raw = attrs[attrCamel];
                if (raw === 'true' || raw === '') return true;
                return false;
            }
            scope.hideCustom = attrTruthy(scope.hideCustom, 'hideCustom');
            scope.fillerOnly = attrTruthy(scope.fillerOnly, 'fillerOnly');
            // Custom show editor never uses thumbnails; channel Add Programming still can
            scope.displayImages = scope.embedded ? false : !!scope.displayImages;
            scope.insertPoint = "end";
            /** @type {Object.<string, true>|null} serverName|sectionKey → true */
            scope._fillerLibrarySet = null;
            scope._fillerLibraryTitles = null;
            scope._fillerReady = !scope.fillerOnly;
            scope.customShows = [];
            scope.origins = [];
            scope.currentOrigin = undefined;
            scope.pending = 0;
            scope.allowedIndexes = [];
            for (let i = -10; i <= -1; i++) {
                scope.allowedIndexes.push(i);
            }
            scope.selection = []
            scope.contentFilter = ""; // used for custom shows list
            scope.movieLibraries = [];
            scope.showLibraries = [];
            scope.contentPanels = [
                { title: "Movies", libraries: [], filter: "", allowCollections: false, emptyText: "No movie libraries found." },
                { title: "TV Shows", libraries: [], filter: "", allowCollections: false, emptyText: "No TV show libraries found." },
                { title: "Playlists & Collections", libraries: [], filter: "", allowCollections: true, emptyText: "No playlists or collections found." },
            ];

            /** Case-insensitive match against common display fields. */
            function textMatchesFilter(item, q) {
                if (!item || !q) {
                    return true;
                }
                let fields = [item.title, item.name, item.showTitle, item.year, item.type];
                for (let i = 0; i < fields.length; i++) {
                    if (fields[i] != null && String(fields[i]).toLowerCase().indexOf(q) !== -1) {
                        return true;
                    }
                }
                try {
                    let display = scope.displayTitle(item);
                    if (display && display.toLowerCase().indexOf(q) !== -1) {
                        return true;
                    }
                } catch (e) { /* displayTitle may not handle every node */ }
                return false;
            }

            /**
             * Show an item if it matches the filter.
             * @param {*} item
             * @param {string} [filterText] optional panel-specific filter
             * @param {boolean} [topLevelOnly] if true, only match this item's title (no nested search)
             */
            scope.itemMatchesFilter = function (item, filterText, topLevelOnly, allowCollections) {
                // Hide collections in Movies/TV browsers; allow them in Playlists & Collections panel
                if (item && item.type === 'collection' && !allowCollections) {
                    return false;
                }
                let raw = (typeof filterText === 'string' ? filterText : scope.contentFilter) || "";
                raw = raw.trim();
                if (!raw) {
                    return true;
                }
                let q = raw.toLowerCase();
                if (textMatchesFilter(item, q)) {
                    return true;
                }
                // Also match type badge text (playlist / collection)
                if (item && item.type && String(item.type).toLowerCase().indexOf(q) !== -1) {
                    return true;
                }
                // TV / lists panel: only search top-level titles
                if (topLevelOnly) {
                    return false;
                }
                if (item && item.nested && item.nested.length) {
                    for (let i = 0; i < item.nested.length; i++) {
                        if (item.nested[i].type === 'collection' && !allowCollections) {
                            continue;
                        }
                        if (scope.itemMatchesFilter(item.nested[i], filterText, false, allowCollections)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            /** Nested rows under a filtered top-level item (TV: always show children once expanded). */
            scope.nestedMatchesFilter = function (item, panel) {
                let allowCollections = panel && panel.allowCollections === true;
                if (item && item.type === 'collection' && !allowCollections) {
                    return false;
                }
                if (panel && panel.topLevelSearchOnly) {
                    return true;
                }
                return scope.itemMatchesFilter(item, panel ? panel.filter : "", false, allowCollections);
            };

            scope.hasVisiblePanelItems = function (panel) {
                if (!panel || !panel.libraries) {
                    return false;
                }
                let topOnly = panel.topLevelSearchOnly === true;
                let allowCollections = panel.allowCollections === true;
                for (let i = 0; i < panel.libraries.length; i++) {
                    if (scope.itemMatchesFilter(panel.libraries[i], panel.filter, topOnly, allowCollections)) {
                        return true;
                    }
                }
                return false;
            };

            let sortByTitle = (items) => {
                if (!items || !items.length) {
                    return items || [];
                }
                return items.slice().sort( (a, b) => {
                    let ta = (a.title || a.name || "").toString();
                    let tb = (b.title || b.name || "").toString();
                    return ta.localeCompare(tb, undefined, { sensitivity: 'base', numeric: true });
                } );
            }
            scope.wait = (t) => {
                return new Promise((resolve, reject) => {
                    $timeout(resolve,t);
                });
            }
            scope.sourceFilter = 'all'; // all | plex | jellyfin | custom
            // Match channel content-sources: section spinner until session cache is ready + bound
            scope.libraryCatalogReady = libraryCatalogPreload.isReady();
            scope.libraryCatalogLoading = libraryCatalogPreload.isLoading() || !scope.libraryCatalogReady;
            scope.catalogLoading = !scope.libraryCatalogReady;
            scope.contentReady = false;
            scope._sourceFilterApplied = false;
            scope._catalogBoundOnce = false;
            scope.hasPlex = false;
            scope.hasJellyfin = false;
            scope.plexServers = [];
            scope.jellyfinServers = [];

            /**
             * Same rules as channel content sources section loading:
             * show spinner while app preload is running or this section is still binding.
             */
            scope.isLibrarySectionLoading = function () {
                if (scope.catalogLoading) {
                    return true;
                }
                if (!scope.libraryCatalogReady || scope.libraryCatalogLoading) {
                    return true;
                }
                if (scope.visible && !scope._catalogBoundOnce) {
                    return true;
                }
                return false;
            };

            let unsubCatalog = libraryCatalogPreload.subscribe(function (snap) {
                scope.libraryCatalogReady = !!snap.ready;
                scope.libraryCatalogLoading = !!snap.loading || !snap.ready;
                $timeout();
            });
            scope.$on('$destroy', function () {
                if (typeof unsubCatalog === 'function') {
                    unsubCatalog();
                }
            });

            function emptyLoadingPanels() {
                if (scope.fillerOnly) {
                    return [
                        {
                            title: "Fillers",
                            id: "fillers",
                            libraries: [],
                            filter: "",
                            searching: false,
                            topLevelSearchOnly: true,
                            allowCollections: false,
                            allowAddAll: true,
                            emptyText: "Loading fillers...",
                        },
                        {
                            title: "Playlists & Collections",
                            id: "lists",
                            libraries: [],
                            filter: "",
                            searching: false,
                            topLevelSearchOnly: true,
                            allowCollections: true,
                            emptyText: "Loading playlists & collections...",
                        },
                    ];
                }
                return [
                    {
                        title: "Movies",
                        libraries: [],
                        filter: "",
                        searching: false,
                        topLevelSearchOnly: false,
                        allowCollections: false,
                        emptyText: "Loading libraries...",
                    },
                    {
                        title: "TV Shows",
                        libraries: [],
                        filter: "",
                        searching: false,
                        topLevelSearchOnly: true,
                        allowCollections: false,
                        emptyText: "Loading libraries...",
                    },
                    {
                        title: "Playlists & Collections",
                        libraries: [],
                        filter: "",
                        searching: false,
                        topLevelSearchOnly: true,
                        allowCollections: true,
                        emptyText: "Loading playlists & collections...",
                    },
                ];
            }

            /** Tag a tree node with its media server so multi-server "All" works. */
            function tagServer(item, server, mediaSource) {
                if (!item) return item;
                item._server = server;
                item.source = mediaSource;
                item.serverName = server.name;
                item.serverType = mediaSource;
                return item;
            }

            /** Custom shows are always fetched live — never from session catalog cache. */
            async function loadCustomShowsLive() {
                try {
                    let list = await libraryCatalogPreload.fetchCustomShowsLive();
                    scope.customShows = list || [];
                } catch (err) {
                    console.error(err);
                    scope.customShows = [];
                }
            }

            function fillerKey(serverName, sectionKey) {
                return String(serverName || '') + '|' + String(sectionKey || '');
            }

            function itemSectionKey(item) {
                if (!item) return null;
                if (item.sectionKey != null && item.sectionKey !== '') {
                    return String(item.sectionKey);
                }
                if (item.librarySectionKey != null && item.librarySectionKey !== '') {
                    return String(item.librarySectionKey);
                }
                if (item.librarySectionID != null && item.librarySectionID !== '') {
                    return String(item.librarySectionID);
                }
                let key = String(item.key || '');
                let m = key.match(/\/library\/sections\/([^/?#]+)/i);
                if (m) return m[1];
                // Jellyfin genre/favorites keys embed library id
                m = key.match(/\/Library\/([^/?#]+)/i);
                if (m) return m[1];
                return null;
            }

            function itemIsFillerLibrary(item) {
                if (!scope.fillerOnly) {
                    return true;
                }
                // Until settings load, deny (avoid flashing all libraries)
                if (!scope._fillerReady || !scope._fillerLibrarySet) {
                    return false;
                }
                // Empty filler set → show nothing (user must mark libraries)
                if (Object.keys(scope._fillerLibrarySet).length === 0) {
                    return false;
                }
                let serverName = (item && (item.serverName || (item._server && item._server.name))) || '';
                let sk = itemSectionKey(item);
                if (sk != null) {
                    // Match with server, or section key alone (single-server / mismatched name edge cases)
                    if (scope._fillerLibrarySet[fillerKey(serverName, sk)]) {
                        return true;
                    }
                    if (scope._fillerLibrarySet['*|' + sk]) {
                        return true;
                    }
                    // Also try without server if only one filler lib uses this section
                    let keys = Object.keys(scope._fillerLibrarySet);
                    for (let i = 0; i < keys.length; i++) {
                        if (keys[i].endsWith('|' + sk)) {
                            return true;
                        }
                    }
                    return false;
                }
                // Match by library title as fallback
                let title = (item && (item.libraryTitle || item.title)) || '';
                if (scope._fillerLibraryTitles && title) {
                    let t = String(title).toLowerCase();
                    if (scope._fillerLibraryTitles[fillerKey(serverName, t)]) {
                        return true;
                    }
                    if (scope._fillerLibraryTitles['*|' + t]) {
                        return true;
                    }
                }
                // Global playlists / items without section: hide in filler mode
                return false;
            }

            async function ensureFillerLibrarySet() {
                if (!scope.fillerOnly) {
                    scope._fillerLibrarySet = null;
                    scope._fillerLibraryTitles = null;
                    scope._fillerReady = true;
                    return;
                }
                scope._fillerReady = false;
                let set = {};
                let titles = {};
                try {
                    let plexSettings = await dizquetv.getPlexLibrarySettings().catch(() => ({}));
                    let jfSettings = await dizquetv.getJellyfinLibrarySettings().catch(() => ({}));
                    let lists = []
                        .concat((plexSettings && plexSettings.fillerLibraries) || [])
                        .concat((jfSettings && jfSettings.fillerLibraries) || []);
                    for (let i = 0; i < lists.length; i++) {
                        let d = lists[i];
                        if (!d || !d.serverName || d.sectionKey == null || d.sectionKey === '') continue;
                        let sk = String(d.sectionKey);
                        set[fillerKey(d.serverName, sk)] = true;
                        set['*|' + sk] = true;
                        if (d.title) {
                            let t = String(d.title).toLowerCase();
                            titles[fillerKey(d.serverName, t)] = true;
                            titles['*|' + t] = true;
                        }
                    }
                } catch (err) {
                    console.error('Could not load filler library settings', err);
                }
                scope._fillerLibrarySet = set;
                scope._fillerLibraryTitles = titles;
                scope._fillerReady = true;
            }

            function filterMediaForFiller(movies, shows, lists) {
                if (!scope.fillerOnly) {
                    return {
                        movies: movies || [],
                        shows: shows || [],
                        lists: lists || [],
                    };
                }
                // Filler browser: no TV shows section; only movies + playlists/collections from filler libs
                return {
                    movies: (movies || []).filter(itemIsFillerLibrary),
                    shows: [],
                    lists: (lists || []).filter(itemIsFillerLibrary),
                };
            }

            /**
             * Filler mode: expand movie library folders into a flat list of movies
             * (no nesting under library names).
             */
            async function expandFillerMoviesFlat(libraryNodes) {
                let out = [];
                let libs = libraryNodes || [];
                for (let i = 0; i < libs.length; i++) {
                    let lib = libs[i];
                    if (!lib) continue;
                    // Already a movie clip (not a library folder)
                    if (lib.type === 'movie' && lib.isLibraryNode !== true) {
                        out.push(lib);
                        continue;
                    }
                    let server = lib._server
                        || (lib.source === 'jellyfin' ? scope.jellyfinServer : scope.plexServer);
                    let isJf = (lib.source === 'jellyfin') || (lib.serverType === 'jellyfin');
                    let nested = [];
                    try {
                        if (isJf) {
                            nested = await jellyfin.getNested(server, lib, false, scope.errors || []);
                        } else {
                            nested = await plex.getNested(server, lib, false, scope.errors || []);
                        }
                    } catch (err) {
                        console.error('Filler: failed to expand library', lib.title, err);
                        continue;
                    }
                    for (let j = 0; j < (nested || []).length; j++) {
                        let item = nested[j];
                        if (!item || item.type !== 'movie') continue;
                        if (server) {
                            tagServer(item, server, isJf ? 'jellyfin' : 'plex');
                        }
                        item.isLibraryNode = false;
                        // Keep library name only as metadata, not as a nest level
                        if (!item.libraryTitle && lib.title) {
                            item.libraryTitle = lib.title;
                        }
                        out.push(item);
                    }
                }
                return sortByTitle(out);
            }

            /**
             * Filler browser: load sections/collections with includeHidden so libraries
             * marked "Hide content" still appear when they also "Contains filler".
             * Session catalog deliberately excludes hidden libs for programming UI.
             */
            async function fetchFillerMediaIncludingHidden(filter) {
                let movies = [];
                let lists = [];
                let errors = [];
                let wantPlex = filter === 'all' || filter === 'plex';
                let wantJf = filter === 'all' || filter === 'jellyfin';
                let plexServers = scope.plexServers || [];
                let jfServers = scope.jellyfinServers || [];

                async function loadServer(server, isJf) {
                    if (!server) return;
                    let libOpts = { includeHidden: true };
                    let libs = [];
                    let collections = [];
                    let playlists = [];
                    try {
                        if (isJf) {
                            libs = await jellyfin.getLibrary(server, libOpts);
                            collections = await jellyfin.getCollections(server, libOpts);
                            playlists = await jellyfin.getPlaylists(server, libOpts);
                        } else {
                            libs = await plex.getLibrary(server, libOpts);
                            collections = await plex.getCollections(server, libOpts);
                            playlists = await plex.getPlaylists(server, libOpts);
                        }
                    } catch (err) {
                        console.error(err);
                        errors.push('Failed filler libraries from ' + server.name);
                        return;
                    }
                    let src = isJf ? 'jellyfin' : 'plex';
                    for (let i = 0; i < (libs || []).length; i++) {
                        let lib = libs[i];
                        if (!lib) continue;
                        tagServer(lib, server, src);
                        if (lib.sectionKey == null && lib.key) {
                            let m = String(lib.key).match(/\/library\/sections\/([^/?#]+)/i);
                            if (m) lib.sectionKey = m[1];
                        }
                        if (lib.type === 'movie' && itemIsFillerLibrary(lib)) {
                            lib.isLibraryNode = true;
                            movies.push(lib);
                        }
                    }
                    for (let i = 0; i < (playlists || []).length; i++) {
                        let pl = Object.assign({}, playlists[i], {
                            type: playlists[i].type || 'playlist',
                            isLibraryNode: false,
                        });
                        tagServer(pl, server, src);
                        if (itemIsFillerLibrary(pl)) lists.push(pl);
                    }
                    for (let i = 0; i < (collections || []).length; i++) {
                        let col = Object.assign({}, collections[i], {
                            type: collections[i].type || 'collection',
                            isLibraryNode: false,
                        });
                        if (col.sectionKey == null && col.librarySectionKey != null) {
                            col.sectionKey = String(col.librarySectionKey);
                        }
                        tagServer(col, server, src);
                        if (itemIsFillerLibrary(col)) lists.push(col);
                    }
                }

                if (wantPlex) {
                    for (let s = 0; s < plexServers.length; s++) {
                        await loadServer(plexServers[s], false);
                    }
                }
                if (wantJf) {
                    for (let s = 0; s < jfServers.length; s++) {
                        await loadServer(jfServers[s], true);
                    }
                }
                return { movies: movies, lists: lists, errors: errors };
            }

            /**
             * Apply session cache media. Returns a Promise when fillerOnly (async flatten).
             * Returns boolean/Promise<boolean>.
             */
            async function applyPreloadedMedia(filter) {
                let servers = libraryCatalogPreload.getServers();
                scope.plexServers = servers.plexServers || scope.plexServers || [];
                scope.jellyfinServers = servers.jellyfinServers || scope.jellyfinServers || [];
                scope.hasPlex = scope.plexServers.length > 0;
                scope.hasJellyfin = scope.jellyfinServers.length > 0;
                scope.plexServer = scope.plexServers[0];
                scope.jellyfinServer = scope.jellyfinServers[0];

                // Filler: load with includeHidden so hide+filler libs appear only here
                if (scope.fillerOnly) {
                    if (
                        scope._fillerLibrarySet
                        && Object.keys(scope._fillerLibrarySet).length === 0
                    ) {
                        applyLibraryPanels([], [], [], [
                            'No libraries marked “Contains filler”. Enable it under Library → Management.',
                        ]);
                        return true;
                    }
                    let fillerMedia = await fetchFillerMediaIncludingHidden(filter);
                    let movies = await expandFillerMoviesFlat(fillerMedia.movies || []);
                    let lists = fillerMedia.lists || [];
                    for (let i = 0; i < lists.length; i++) {
                        if (lists[i]) lists[i].isLibraryNode = false;
                    }
                    applyLibraryPanels(movies, [], lists, fillerMedia.errors || []);
                    return true;
                }

                let media = libraryCatalogPreload.getMedia(filter);
                if (!media) {
                    return false;
                }
                let filtered = filterMediaForFiller(
                    media.movies || [],
                    media.shows || [],
                    media.lists || []
                );
                let errors = (media.errors || []).slice();
                applyLibraryPanels(filtered.movies, filtered.shows, filtered.lists, errors);
                return true;
            }

            function waitMs(ms) {
                return new Promise((resolve) => {
                    $timeout(resolve, ms);
                });
            }

            /**
             * Keep the section spinner up until Movies / TV Shows / Playlists lists
             * have been digested by Angular and painted. Without this, catalogLoading
             * clears as soon as array refs are assigned while ng-repeat is still building.
             */
            async function waitForSectionListsRendered(opId) {
                // Digests so ng-repeat builds each panel's items under the loading overlay
                await new Promise((resolve) => { $timeout(resolve, 0); });
                if (opId !== sourceFilterOpId) {
                    return;
                }
                await new Promise((resolve) => { $timeout(resolve, 0); });
                if (opId !== sourceFilterOpId) {
                    return;
                }
                // Two animation frames: layout + paint of the (still hidden) lists
                await new Promise((resolve) => {
                    let done = function () { resolve(); };
                    if (typeof requestAnimationFrame === 'function') {
                        requestAnimationFrame(function () {
                            requestAnimationFrame(done);
                        });
                    } else {
                        $timeout(done, 32);
                    }
                });
                if (opId !== sourceFilterOpId) {
                    return;
                }
                // Final tick for any post-paint watchers before we hide the spinner
                await new Promise((resolve) => { $timeout(resolve, 0); });
            }

            /** Monotonic id so a superseded filter load does not clobber a newer one. */
            let sourceFilterOpId = 0;

            /**
             * Switch All / Plex / Jellyfin / Custom.
             * Session cache only after ensureLoaded — never re-walks Plex/Jellyfin live.
             * Warm filter changes are in-memory hide/show (same idea as content-source filters).
             * options.quiet: no section spinner (re-enter / pure filter swap when cache warm).
             */
            scope.setSourceFilter = async function (filter, options) {
                options = options || {};
                if (filter !== 'all' && filter !== 'plex' && filter !== 'jellyfin' && filter !== 'custom') {
                    return;
                }
                if (scope.hideCustom && filter === 'custom') {
                    return;
                }
                if (filter === 'plex' && !scope.hasPlex && libraryCatalogPreload.isReady()) return;
                if (filter === 'jellyfin' && !scope.hasJellyfin && libraryCatalogPreload.isReady()) return;
                if (scope.catalogLoading && !options.force && !options.quiet) {
                    return;
                }
                if (filter === scope.sourceFilter && !options.force && scope._sourceFilterApplied) {
                    return;
                }

                let opId = ++sourceFilterOpId;
                let cacheWarm = libraryCatalogPreload.isReady();
                // Live fetch only for custom shows (never session-cached)
                let needsLiveCustom = filter === 'custom' || (filter === 'all' && !scope.hideCustom);
                // Quiet when cache warm and no live work — matches content-source filter UX
                let quiet = !!options.quiet && cacheWarm && !needsLiveCustom;
                if (!quiet && cacheWarm && scope._catalogBoundOnce && !needsLiveCustom && !options.force) {
                    quiet = true; // pure All/Plex/Jellyfin filter flip
                }

                scope.sourceFilter = filter;
                scope.contentFilter = "";
                scope.errors = [];
                scope.mediaSource = filter === 'custom' ? 'dizquetv' : filter;

                if (!quiet) {
                    scope.catalogLoading = true;
                    scope.contentReady = false;
                    // Always show placeholders so the spinner paints before heavy list bind
                    scope.contentPanels = emptyLoadingPanels();
                    $timeout();
                    // One frame so the loading indicator is visible before list work
                    await waitMs(16);
                    if (opId !== sourceFilterOpId) {
                        return;
                    }
                }

                try {
                    if (!libraryCatalogPreload.isReady()) {
                        await libraryCatalogPreload.ensureLoaded();
                    }
                    if (opId !== sourceFilterOpId) {
                        return;
                    }
                    if (scope.fillerOnly) {
                        await ensureFillerLibrarySet();
                    }
                    if (opId !== sourceFilterOpId) {
                        return;
                    }
                    let servers = libraryCatalogPreload.getServers();
                    scope.plexServers = servers.plexServers || [];
                    scope.jellyfinServers = servers.jellyfinServers || [];
                    scope.hasPlex = scope.plexServers.length > 0;
                    scope.hasJellyfin = scope.jellyfinServers.length > 0;
                    scope.plexServer = scope.plexServers[0];
                    scope.jellyfinServer = scope.jellyfinServers[0];

                    if (filter === 'custom') {
                        // Filler browser never uses custom programming
                        if (scope.fillerOnly) {
                            applyLibraryPanels([], [], [], []);
                        } else {
                            await loadCustomShowsLive();
                        }
                    } else {
                        // Pure in-memory swap for Plex/Jellyfin (session cache)
                        // (filler mode also flattens movie libraries — async)
                        let ok = await applyPreloadedMedia(filter);
                        if (!ok) {
                            applyLibraryPanels([], [], [], [
                                'No cached ' + filter + ' library data. Sync libraries under Library → Management.',
                            ]);
                        }
                        if (filter === 'all' && !scope.hideCustom && !scope.fillerOnly) {
                            await loadCustomShowsLive();
                        }
                    }
                    if (opId !== sourceFilterOpId) {
                        return;
                    }
                    scope._sourceFilterApplied = true;
                    // Spinner stays until Movies / TV / Playlists ng-repeat lists are built + painted
                    if (!quiet) {
                        await waitForSectionListsRendered(opId);
                    }
                    if (opId !== sourceFilterOpId) {
                        return;
                    }
                    scope._catalogBoundOnce = true;
                } catch (err) {
                    console.error(err);
                    if (opId === sourceFilterOpId) {
                        scope.errors = (scope.errors || []).concat(['Failed to load content for this source.']);
                        // Still mark attempted so section is not stuck loading forever
                        scope._catalogBoundOnce = true;
                    }
                } finally {
                    if (opId === sourceFilterOpId) {
                        scope.catalogLoading = false;
                        scope.contentReady = true;
                        $timeout();
                    }
                }
            };

            scope.refreshSource = async function () {
                scope._sourceFilterApplied = false;
                try {
                    // Manual refresh only — normal open uses session cache
                    scope.catalogLoading = true;
                    scope.contentReady = false;
                    $timeout();
                    await libraryCatalogPreload.reload();
                } catch (e) {
                    console.error(e);
                }
                await scope.setSourceFilter(scope.sourceFilter || 'all', { force: true });
            };
            scope._onFinish = (s, insertPoint) => {
                if (s.length > scope.limit) {
                    if (scope.limit == 1) {
                        scope.error = "Please select only one clip.";
                    } else {
                        scope.error = `Please select at most ${scope.limit} clips.`;
                    }
                    return;
                }
                if (typeof scope.onFinish === 'function') {
                    scope.onFinish(s, insertPoint);
                }
                scope.selection = [];
                scope.error = undefined;
                // Embedded mode stays open so more clips can be added; modal mode closes
                if (!scope.embedded) {
                    scope.visible = false;
                }
                $timeout();
            };
            /** Embedded custom-show mode: push clips straight into the show (no staging tray). */
            function commitEmbeddedBatch(items) {
                if (!scope.embedded || !items || !items.length) {
                    return;
                }
                if (typeof scope.onFinish === 'function') {
                    scope.onFinish(items.slice(), scope.insertPoint);
                }
            }

            scope.selectItem = async (item, single) => {
                        await scope.wait(0);
                        scope.pending += 1;
                        try {
                            let srv = item._server || item.server || scope.jellyfinServer || scope.plexServer;
                            delete item.server;
                            delete item._server;
                            if (srv) {
                                item.serverKey = srv.name;
                            }
                            if (item.source === 'jellyfin' || scope.mediaSource === 'jellyfin') {
                                item.source = 'jellyfin';
                                item.serverType = 'jellyfin';
                            } else if (item.source === 'plex' || scope.mediaSource === 'plex') {
                                item.source = item.source || 'plex';
                                item.serverType = item.serverType || 'plex';
                            }
                            let copy = JSON.parse(angular.toJson(item));
                            if (scope.embedded) {
                                // single = one click → add to show immediately
                                // !single = mid multi-add (show/season/library) → stage then flush at end
                                if (single) {
                                    commitEmbeddedBatch([copy]);
                                } else {
                                    scope.selection.push(copy);
                                }
                            } else {
                                scope.selection.push(copy);
                            }
                        } catch (err) {
                            let msg = "Unable to add item: " + item.key + " " + item.title;
                            scope.errors.push(msg);
                            console.error(msg, err);
                        } finally {
                            scope.pending -= 1;
                        }
                        if (single) {
                            scope.$apply()
                        }
            }

            function flushEmbeddedSelection() {
                if (!scope.embedded || scope.selection.length === 0) {
                    return;
                }
                let batch = scope.selection.slice();
                scope.selection = [];
                commitEmbeddedBatch(batch);
            }

            scope.selectLibrary = async (library) => {
              await scope.fillNestedIfNecessary(library, true);
              let p = library.nested.length;
              scope.pending += library.nested.length;
              try {
                for (let i = 0; i < library.nested.length; i++) {
                    let child = library.nested[i];
                    if (child.type === 'collection' || child.type === 'genre') {
                        scope.pending -= 1;
                        p -= 1;
                        continue;
                    }
                    // Leaf playables (movies) must not go through season expansion
                    if (child.type === 'movie' || child.type === 'episode' || child.type === 'track') {
                        await scope.selectItem(child, false);
                    } else {
                        await scope.selectShow(child);
                    }
                    scope.pending -= 1;
                    p -= 1;
                }
              } finally {
                scope.pending -= p;
                flushEmbeddedSelection();
                scope.$apply()
              }
            }

            /**
             * Only load/bind when this browser is shown (same pattern as content sources):
             *  - First bind: section spinner until session cache ready, then apply lists
             *  - Re-enter with cache warm: reset filter to All from memory (quiet, no refetch)
             *  - Filter All/Plex/Jellyfin: in-memory hide (no cache round-trip)
             */
            let enterGeneration = 0;
            async function resetCatalogOnEnter() {
                if (!scope.visible) {
                    return;
                }
                let gen = ++enterGeneration;
                scope.sourceFilter = 'all';
                scope.contentFilter = "";
                scope._sourceFilterApplied = false;
                try {
                    await new Promise((r) => $timeout(r, 0));
                    if (gen !== enterGeneration || !scope.visible) {
                        return;
                    }
                    // Ensure background app preload is running
                    libraryCatalogPreload.ensureLoaded().catch(function (err) {
                        console.error(err);
                    });

                    if (libraryCatalogPreload.isReady() && scope._catalogBoundOnce) {
                        // Same as content sources re-visit: reset UI filter, reapply from memory
                        await scope.setSourceFilter('all', { force: true, quiet: true });
                        return;
                    }

                    // First bind (or cache still warming): section spinner until ready
                    scope.catalogLoading = true;
                    scope.contentReady = false;
                    $timeout();
                    if (!libraryCatalogPreload.isReady()) {
                        await libraryCatalogPreload.whenReady();
                    }
                    if (gen !== enterGeneration || !scope.visible) {
                        return;
                    }
                    await scope.setSourceFilter('all', { force: true });
                } catch (err) {
                    console.error(err);
                    if (gen === enterGeneration) {
                        scope.catalogLoading = false;
                        scope.contentReady = true;
                        scope._catalogBoundOnce = true;
                        $timeout();
                    }
                }
            }

            scope.$watch('visible', (v) => {
                if (v) {
                    resetCatalogOnEnter();
                }
            });
            // Already open at link time (embedded custom-show when created with ng-if)
            if (scope.visible) {
                scope.catalogLoading = true;
                $timeout(() => { resetCatalogOnEnter(); }, 0);
            }

            let applyLibraryPanels = (movies, flatShows, listItems, loadErrors) => {
                if (loadErrors && loadErrors.length) {
                    scope.errors = (scope.errors || []).concat(loadErrors);
                }
                listItems = listItems || [];
                movies = sortByTitle(movies || []);
                flatShows = sortByTitle(flatShows || []);
                listItems = sortByTitle(listItems || []);
                let apply = () => {
                    scope.movieLibraries = movies;
                    scope.showLibraries = flatShows;
                    scope.listLibraries = listItems;
                    scope.libraries = movies.concat(flatShows).concat(listItems);
                    if (scope.fillerOnly) {
                        // Filler: flat movie clips (labeled Fillers) + Playlists & Collections —
                        // no TV Shows, no library-folder nesting.
                        scope.contentPanels = [
                            {
                                title: "Fillers",
                                id: "fillers",
                                libraries: movies,
                                filter: "",
                                searching: false,
                                topLevelSearchOnly: true,
                                allowCollections: false,
                                allowAddAll: true,
                                emptyText: "No fillers in filler libraries.",
                            },
                            {
                                title: "Playlists & Collections",
                                id: "lists",
                                libraries: listItems,
                                filter: "",
                                searching: false,
                                topLevelSearchOnly: true,
                                allowCollections: true,
                                emptyText: "No playlists or collections in filler libraries.",
                            },
                        ];
                    } else {
                        scope.contentPanels = [
                            {
                                title: "Movies",
                                libraries: movies,
                                filter: "",
                                searching: false,
                                topLevelSearchOnly: false,
                                allowCollections: false,
                                emptyText: "No movie libraries found.",
                            },
                            {
                                title: "TV Shows",
                                libraries: flatShows,
                                filter: "",
                                searching: false,
                                topLevelSearchOnly: true,
                                allowCollections: false,
                                emptyText: "No TV shows found.",
                            },
                            {
                                title: "Playlists & Collections",
                                libraries: listItems,
                                filter: "",
                                searching: false,
                                topLevelSearchOnly: true,
                                allowCollections: true,
                                emptyText: "No playlists or collections found.",
                            },
                        ];
                    }
                    // catalogLoading / contentReady are owned by setSourceFilter
                };
                if (scope.$root && scope.$root.$$phase) {
                    apply();
                } else {
                    scope.$apply(apply);
                }
            };

            /** Load one Plex server → { movies, shows, lists, errors } */
            let fetchPlexServer = async (server) => {
                let loadErrors = [];
                let listItems = [];
                let movies = [];
                let flatShows = [];
                try {
                    let parallel = await Promise.all([
                        plex.getLibrary(server),
                        plex.getPlaylists(server).catch((err) => {
                            console.error(err);
                            loadErrors.push("Failed playlists from " + server.name);
                            return [];
                        }),
                        plex.getCollections(server).catch((err) => {
                            console.error(err);
                            loadErrors.push("Failed collections from " + server.name);
                            return [];
                        }),
                    ]);
                    let lib = parallel[0] || [];
                    let playlists = parallel[1] || [];
                    let collections = parallel[2] || [];
                    for (let i = 0; i < playlists.length; i++) {
                        listItems.push(tagServer(Object.assign({}, playlists[i], {
                            type: 'playlist',
                            isLibraryNode: false,
                        }), server, 'plex'));
                    }
                    for (let i = 0; i < collections.length; i++) {
                        listItems.push(tagServer(Object.assign({}, collections[i], {
                            type: 'collection',
                            isLibraryNode: false,
                        }), server, 'plex'));
                    }
                    lib.forEach((section) => {
                        if (section.genres && section.genres.length) {
                            section.genres = sortByTitle(section.genres);
                        }
                    });
                    lib = sortByTitle(lib);
                    let showLibraries = [];
                    for (let i = 0; i < lib.length; i++) {
                        tagServer(lib[i], server, 'plex');
                        if (lib[i].type === 'movie') {
                            lib[i].isLibraryNode = true;
                            movies.push(lib[i]);
                        } else {
                            showLibraries.push(lib[i]);
                        }
                    }
                    for (let i = 0; i < showLibraries.length; i++) {
                        let section = showLibraries[i];
                        try {
                            let nested = await plex.getNested(server, section, false, loadErrors);
                            nested = sortByTitle(nested || []);
                            for (let j = 0; j < nested.length; j++) {
                                let item = nested[j];
                                if (item.type === 'collection') continue;
                                item.isLibraryNode = false;
                                if (!item.libraryTitle) item.libraryTitle = section.title;
                                flatShows.push(tagServer(item, server, 'plex'));
                            }
                        } catch (err) {
                            console.error("Failed to load TV library " + section.title, err);
                            loadErrors.push("Failed to load " + section.title);
                        }
                    }
                } catch (err) {
                    console.error("Failed to load Plex library " + server.name, err);
                    loadErrors.push("Failed to load Plex " + server.name);
                }
                return { movies: movies, shows: flatShows, lists: listItems, errors: loadErrors };
            };

            /** Load one Jellyfin server → { movies, shows, lists, errors } */
            let fetchJellyfinServer = async (server) => {
                let loadErrors = [];
                let listItems = [];
                let movies = [];
                let flatShows = [];
                try {
                    let parallel = await Promise.all([
                        jellyfin.getLibrary(server),
                        jellyfin.getPlaylists(server).catch((err) => {
                            console.error(err);
                            loadErrors.push("Failed playlists from " + server.name);
                            return [];
                        }),
                        jellyfin.getCollections(server).catch((err) => {
                            console.error(err);
                            loadErrors.push("Failed collections from " + server.name);
                            return [];
                        }),
                    ]);
                    let lib = sortByTitle(parallel[0] || []);
                    let playlists = parallel[1] || [];
                    let collections = parallel[2] || [];
                    for (let i = 0; i < playlists.length; i++) {
                        listItems.push(tagServer(Object.assign({}, playlists[i], {
                            type: playlists[i].type || 'playlist',
                            isLibraryNode: false,
                        }), server, 'jellyfin'));
                    }
                    for (let i = 0; i < collections.length; i++) {
                        listItems.push(tagServer(Object.assign({}, collections[i], {
                            type: collections[i].type || 'collection',
                            isLibraryNode: false,
                        }), server, 'jellyfin'));
                    }
                    let showLibraries = [];
                    for (let i = 0; i < lib.length; i++) {
                        tagServer(lib[i], server, 'jellyfin');
                        if (lib[i].type === 'movie') {
                            lib[i].isLibraryNode = true;
                            movies.push(lib[i]);
                        } else {
                            showLibraries.push(lib[i]);
                        }
                    }
                    for (let i = 0; i < showLibraries.length; i++) {
                        let section = showLibraries[i];
                        section.isLibraryNode = true;
                        try {
                            let nested = await jellyfin.getNested(server, section, false, loadErrors);
                            nested = sortByTitle(nested || []);
                            for (let j = 0; j < nested.length; j++) {
                                let item = nested[j];
                                item.isLibraryNode = false;
                                if (!item.libraryTitle) item.libraryTitle = section.title;
                                flatShows.push(tagServer(item, server, 'jellyfin'));
                            }
                        } catch (err) {
                            console.error("Failed to load Jellyfin TV library " + section.title, err);
                            loadErrors.push("Failed to load " + section.title);
                        }
                    }
                } catch (err) {
                    console.error("Failed to load Jellyfin library " + server.name, err);
                    loadErrors.push("Failed to load Jellyfin " + server.name);
                }
                return { movies: movies, shows: flatShows, lists: listItems, errors: loadErrors };
            };

            /** Load media catalog for All / Plex / Jellyfin (merged across servers). */
            let loadMediaCatalog = async (filter) => {
                scope.errors = [];
                try {
                    let jobs = [];
                    if (filter === 'all' || filter === 'plex') {
                        for (let i = 0; i < scope.plexServers.length; i++) {
                            jobs.push(fetchPlexServer(scope.plexServers[i]));
                        }
                    }
                    if (filter === 'all' || filter === 'jellyfin') {
                        for (let i = 0; i < scope.jellyfinServers.length; i++) {
                            jobs.push(fetchJellyfinServer(scope.jellyfinServers[i]));
                        }
                    }
                    let results = await Promise.all(jobs);
                    let movies = [];
                    let shows = [];
                    let lists = [];
                    let loadErrors = [];
                    for (let r = 0; r < results.length; r++) {
                        let part = results[r];
                        movies = movies.concat(part.movies || []);
                        shows = shows.concat(part.shows || []);
                        lists = lists.concat(part.lists || []);
                        loadErrors = loadErrors.concat(part.errors || []);
                    }
                    applyLibraryPanels(movies, shows, lists, loadErrors);
                } catch (err) {
                    console.error(err);
                    applyLibraryPanels([], [], [], ["Failed to load library catalog."]);
                }
            };

            scope.fillNestedIfNecessary = async (x, isLibrary) => {
                if (typeof(x.nested) === 'undefined') {
                    let server = (x && x._server) || scope.jellyfinServer || scope.plexServer;
                    let isJf = (x && x.source === 'jellyfin') || scope.sourceFilter === 'jellyfin';
                    if (isJf) {
                        x.nested = await jellyfin.getNested(server, x, false, scope.errors);
                    } else {
                        x.nested = await plex.getNested(server, x, false, scope.errors);
                    }
                    // When expanding a playlist/collection, keep its children as-is.
                    // For movie/show library browsing, strip nested collection folders.
                    let keepCollections = x && (x.type === 'playlist' || x.type === 'collection');
                    if (!keepCollections) {
                        x.nested = (x.nested || []).filter((n) => n && n.type !== 'collection');
                    } else {
                        x.nested = x.nested || [];
                    }
                    // Propagate server identity for multi-server "All" mode
                    for (let i = 0; i < x.nested.length; i++) {
                        if (x.nested[i] && server) {
                            tagServer(x.nested[i], server, isJf ? 'jellyfin' : 'plex');
                        }
                    }
                    x.nested = sortByTitle(x.nested);
                }
            }
            /**
             * Movies panel: load nested so search can match movies inside libraries.
             * TV panel: top-level only — shows are already flat; do not deep-search seasons/episodes.
             */
            scope.onPanelFilterChange = async function (panel) {
                let q = (panel.filter || "").trim();
                if (!q) {
                    $timeout();
                    return;
                }
                if (!scope.hasPlex && !scope.hasJellyfin) {
                    return;
                }
                // TV / lists: only filter top-level titles (already loaded flat)
                if (panel.topLevelSearchOnly) {
                    $timeout();
                    return;
                }
                panel.searching = true;
                $timeout();
                try {
                    for (let i = 0; i < panel.libraries.length; i++) {
                        let lib = panel.libraries[i];
                        let asLibrary = lib.isLibraryNode === true;
                        await scope.fillNestedIfNecessary(lib, asLibrary);
                        // Auto-expand movie libraries when contents match
                        if (scope.itemMatchesFilter(lib, panel.filter, false)) {
                            let selfMatch = textMatchesFilter(lib, q.toLowerCase());
                            let childMatch = false;
                            if (lib.nested && lib.nested.length) {
                                for (let c = 0; c < lib.nested.length; c++) {
                                    if (lib.nested[c].type === 'collection') {
                                        continue;
                                    }
                                    if (scope.itemMatchesFilter(lib.nested[c], panel.filter, false)) {
                                        childMatch = true;
                                    }
                                }
                            }
                            if (childMatch || selfMatch) {
                                lib.collapse = true;
                            }
                        }
                    }
                } catch (err) {
                    console.error("Filter load failed", err);
                } finally {
                    panel.searching = false;
                    $timeout();
                }
            };

            /**
             * True when a top-level panel row can expand (library folder, show, playlist, etc.).
             * Flat movie clips (Add Filler "Fillers" list) are leaves — no tree chevron.
             */
            scope.isExpandableTopLevel = (item) => {
                if (!item) return false;
                if (item.isLibraryNode === true) return true;
                let t = item.type;
                return t === 'show' || t === 'artist' || t === 'playlist'
                    || t === 'collection' || t === 'genre' || t === 'season' || t === 'album';
            };

            /** Expand a node; library folders use isLibraryNode, shows/playlists do not. */
            scope.getNested = (list, isLibrary) => {
                if (!list) return;
                // Leaf movies at top level (flat fillers) — select, do not expand
                if (!scope.isExpandableTopLevel(list)) {
                    if (list.type === 'movie') {
                        scope.selectItem(list, true);
                    }
                    return;
                }
                if (typeof isLibrary === 'undefined') {
                    isLibrary = list && list.isLibraryNode === true;
                }
                $timeout(async () => {
                    await scope.fillNestedIfNecessary(list, isLibrary);
                    // After load, keep expanded state; filter still applies via ng-if
                    list.collapse = !list.collapse
                    scope.$apply()
                }, 0)
            }

            scope.selectTopLevelItem = async (item) => {
                if (!item) {
                    return;
                }
                if (item.isLibraryNode) {
                    return scope.selectLibrary(item);
                }
                if (item.type === 'playlist' || item.type === 'collection') {
                    return scope.selectPlaylist(item);
                }
                if (item.type === 'movie') {
                    return scope.selectItem(item, true);
                }
                // show, artist, etc.
                return scope.selectShow(item);
            };

            /**
             * Add every currently visible (search-filtered) item in a panel.
             * Used by filler "Add all" so only listed/filtered clips are selected.
             */
            scope.selectAllVisibleInPanel = async (panel) => {
                if (!panel || !panel.libraries || !panel.libraries.length) {
                    return;
                }
                if (panel.addingAll) {
                    return;
                }
                let topOnly = panel.topLevelSearchOnly !== false;
                let allowCollections = panel.allowCollections === true;
                let visible = [];
                for (let i = 0; i < panel.libraries.length; i++) {
                    let item = panel.libraries[i];
                    if (scope.itemMatchesFilter(item, panel.filter, topOnly, allowCollections)) {
                        visible.push(item);
                    }
                }
                if (!visible.length) {
                    return;
                }
                panel.addingAll = true;
                scope.pending += 1;
                $timeout();
                try {
                    for (let i = 0; i < visible.length; i++) {
                        let item = visible[i];
                        // Stage multi-add without per-item $apply spam
                        if (item.type === 'movie' || item.type === 'episode' || item.type === 'track') {
                            await scope.selectItem(item, false);
                        } else {
                            await scope.selectTopLevelItem(item);
                        }
                    }
                    // Modal mode: items sit in selection until Done.
                    // Embedded mode: flush staged batch once.
                    flushEmbeddedSelection();
                } catch (err) {
                    console.error('selectAllVisibleInPanel failed', err);
                } finally {
                    scope.pending = Math.max(0, (scope.pending || 0) - 1);
                    panel.addingAll = false;
                    $timeout();
                }
            };

            scope.visiblePanelCount = function (panel) {
                if (!panel || !panel.libraries) {
                    return 0;
                }
                let topOnly = panel.topLevelSearchOnly !== false;
                let allowCollections = panel.allowCollections === true;
                let n = 0;
                for (let i = 0; i < panel.libraries.length; i++) {
                    if (scope.itemMatchesFilter(panel.libraries[i], panel.filter, topOnly, allowCollections)) {
                        n++;
                    }
                }
                return n;
            };
            
            scope.selectSeason = (season) => {
                return new Promise((resolve, reject) => {
                    $timeout(async () => {
                        await scope.fillNestedIfNecessary(season);
                        let p = season.nested.length;
                        scope.pending += p;
                        try {
                            for (let i = 0, l = season.nested.length; i < l; i++) {
                                await scope.selectItem(season.nested[i], false)
                                scope.pending -= 1;
                                p -= 1;
                            }
                            resolve();
                        } catch (e) {
                            reject(e);
                        } finally {
                            scope.pending -= p;
                            // Do not flush here — parent selectShow/selectPlaylist flushes once
                            scope.$apply()
                        }
                    }, 0)
                })
            }
            scope.selectShow = (show) => {
                return new Promise((resolve, reject) => {
                    $timeout(async () => {
                        // Already a playable leaf
                        if (show && (show.type === 'movie' || show.type === 'episode' || show.type === 'track')) {
                            try {
                                // single=true so embedded mode adds immediately
                                await scope.selectItem(show, true);
                                resolve();
                            } catch (e) {
                                reject(e);
                            } finally {
                                scope.$apply();
                            }
                            return;
                        }
                        await scope.fillNestedIfNecessary(show);
                        let p = show.nested.length;
                        scope.pending += p;
                        try {
                            for (let i = 0, l = show.nested.length; i < l; i++) {
                                let child = show.nested[i];
                                if (child.type === 'movie' || child.type === 'episode' || child.type === 'track') {
                                    await scope.selectItem(child, false);
                                } else if (child.type === 'season') {
                                    await scope.selectSeason(child);
                                } else {
                                    // Nested folders / specials
                                    await scope.selectShow(child);
                                }
                                scope.pending -= 1;
                                p -= 1;
                            }
                            resolve();
                        } catch (e) {
                            reject(e);
                        } finally {
                            scope.pending -= p;
                            flushEmbeddedSelection();
                            scope.$apply()
                        }
                    }, 0)
                })
            }
            scope.selectPlaylist = async (playlist) => {
                return new Promise((resolve, reject) => {
                    $timeout(async () => {
                        try {
                            await scope.fillNestedIfNecessary(playlist);
                            let p = (playlist.nested || []).length;
                            scope.pending += p;
                            try {
                                for (let i = 0, l = (playlist.nested || []).length; i < l; i++) {
                                    let child = playlist.nested[i];
                                    if (child.type === 'movie' || child.type === 'episode' || child.type === 'track') {
                                        await scope.selectItem(child, false);
                                    } else if (child.type === 'season') {
                                        await scope.selectSeason(child);
                                    } else {
                                        // Nested shows/folders inside playlists or collections
                                        await scope.selectShow(child);
                                    }
                                    scope.pending -= 1;
                                    p -= 1;
                                }
                                resolve();
                            } catch (e) {
                                reject(e);
                            } finally {
                                scope.pending -= p;
                                flushEmbeddedSelection();
                                scope.$apply();
                            }
                        } catch (e) {
                            reject(e);
                            scope.$apply();
                        }
                    }, 0)
                })
            }
            scope.createShowIdentifier = (season, ep) => {
                return 'S' + (season.toString().padStart(2, '0')) + 'E' + (ep.toString().padStart(2, '0'))
            }
            scope.addCustomShow = async(show) => {
                scope.pending++;
                try {
                    show = await dizquetv.getShow(show.id);
                    let batch = [];
                    for (let i = 0; i < show.content.length; i++) {
                        let item = JSON.parse(angular.toJson( show.content[i] ));
                        item.customShowId = show.id;
                        item.customShowName = show.name;
                        item.customOrder = i;
                        batch.push(item);
                    }
                    if (scope.embedded) {
                        commitEmbeddedBatch(batch);
                    } else {
                        scope.selection = scope.selection.concat(batch);
                    }
                    scope.$apply();
                } finally {
                    scope.pending--;
                }
            }

            scope.getProgramDisplayTitle = (x) => {
                return commonProgramTools.getProgramDisplayTitle(x);
            }

            let updateCustomShows = async() => {
                let shows = await dizquetv.getAllShowsInfo();
                scope.customShows = sortByTitle(shows);
                scope.$apply();
            }

            scope.displayTitle = (show) => {
                let r = "";
                if (show.type === 'episode') {
                    r += show.showTitle + " - ";
                    if ( typeof(show.season) !== 'undefined' ) {
                        r += "S" + show.season.toString().padStart(2,'0');
                    }
                    if ( typeof(show.episode) !== 'undefined' ) {
                        r += "E" + show.episode.toString().padStart(2,'0');
                    }
                }
                if (r != "") {
                    r = r + " - ";
                }
                let title = show.title || show.name || "";
                // Badge already says "collection" — strip legacy " Collection" suffix from older cache
                if (
                    show.type === 'collection'
                    && typeof title === 'string'
                    && / Collection$/i.test(title)
                ) {
                    title = title.replace(/ Collection$/i, '');
                }
                r += title;
                // Year only for movies / shows / episodes — not playlists, collections, genres, libraries, etc.
                let t = show.type;
                if (
                    (t === 'movie' || t === 'show' || t === 'episode')
                    && show.year != null
                    && typeof show.year !== 'undefined'
                    && String(show.year).length > 0
                ) {
                    r += " (" + show.year + ")";
                }
                return r;
            }
        }
    };
}