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
            /**
             * Legacy: previously hid the Custom filter / separate custom panel.
             * Custom shows now always fold into Playlists & Collections (except filler).
             * Still accepted so older templates (hide-custom="true") keep working.
             */
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
                { title: "Movies", libraries: [], visibleLibraries: [], filter: "", summaryFilter: "", allowCollections: false, allowAddAll: true, emptyText: "No movie libraries found." },
                { title: "TV Shows", libraries: [], visibleLibraries: [], filter: "", summaryFilter: "", allowCollections: false, allowAddAll: true, emptyText: "No TV show libraries found." },
                { title: "Playlists/Lists/Custom/Collections", libraries: [], visibleLibraries: [], filter: "", summaryFilter: "", allowCollections: true, allowAddAll: true, emptyText: "No playlists, lists, custom shows, or collections found." },
            ];

            /** Case-insensitive match against common display fields. */
            function textMatchesFilter(item, q) {
                if (!item || !q) {
                    return true;
                }
                let fields = [
                    item.title,
                    item.name,
                    item.showTitle,
                    item.libraryTitle,
                    item.serverName,
                    item.year,
                    typeLabel(item),
                    item.type,
                ];
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

            function typeLabel(item) {
                if (!item) return '';
                if (item.type === 'custom' || item.customShow === true) return 'custom';
                return item.type || '';
            }

            /** Case-insensitive match against program plot/summary fields. */
            function summaryMatchesFilter(item, q) {
                if (!q) {
                    return true;
                }
                if (!item) {
                    return false;
                }
                let fields = [item.summary, item.Overview, item.overview, item.plot, item.Plot];
                for (let i = 0; i < fields.length; i++) {
                    if (fields[i] != null && String(fields[i]).toLowerCase().indexOf(q) !== -1) {
                        return true;
                    }
                }
                return false;
            }

            /**
             * TV title-only search stays top-level (show names). When a summary
             * filter is set, search nested seasons/episodes too.
             */
            function panelUsesTopLevelOnly(panel) {
                if (!panel || panel.topLevelSearchOnly !== true) {
                    return false;
                }
                // Summary search must look inside shows for episode plots
                if (String(panel.summaryFilter || "").trim()) {
                    return false;
                }
                return true;
            }
            // Expose for template ng-if filters
            scope.panelTopOnly = panelUsesTopLevelOnly;

            function itemIdentityKey(item) {
                if (!item) return '';
                let source = item.source || item.serverType || '';
                let server =
                    item.serverName
                    || item.serverKey
                    || (item._server && item._server.name)
                    || '';
                let rk =
                    item.ratingKey != null
                        ? String(item.ratingKey)
                        : item.jellyfinId != null
                          ? String(item.jellyfinId)
                          : '';
                return source + '|' + server + '|' + rk;
            }

            function libraryIdentityKey(item) {
                if (!item) return '';
                let source = item.source || item.serverType || '';
                let server =
                    item.serverName
                    || item.serverKey
                    || (item._server && item._server.name)
                    || '';
                let sk =
                    item.sectionKey != null
                        ? String(item.sectionKey)
                        : item.librarySectionKey != null
                          ? String(item.librarySectionKey)
                          : item.key != null
                            ? String(item.key)
                            : '';
                return source + '|' + server + '|' + sk;
            }

            function clearPanelServerSearch(panel) {
                if (!panel) return;
                panel._searchActive = false;
                panel._searchHitMovieKeys = null;
                panel._searchHitShowKeys = null;
                panel._searchHitEpisodeKeys = null;
                panel._searchHitSeasonKeys = null;
                panel._searchHitLibraryKeys = null;
            }

            function applyServerSearchHits(panel, result) {
                let movieKeys = {};
                let showKeys = {};
                let episodeKeys = {};
                let seasonKeys = {};
                let libraryKeys = {};
                let movies = (result && result.movies) || [];
                let shows = (result && result.shows) || [];
                let episodes = (result && result.episodes) || [];
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
                for (let i = 0; i < shows.length; i++) {
                    let s = shows[i];
                    let k =
                        (s.source || '') +
                        '|' +
                        (s.serverName || '') +
                        '|' +
                        String(s.ratingKey || s.jellyfinId || '');
                    showKeys[k] = true;
                }
                for (let i = 0; i < episodes.length; i++) {
                    let e = episodes[i];
                    let k =
                        (e.source || '') +
                        '|' +
                        (e.serverName || '') +
                        '|' +
                        String(e.ratingKey || e.jellyfinId || '');
                    episodeKeys[k] = true;
                    if (e.parentRatingKey != null) {
                        seasonKeys[
                            (e.source || '') +
                                '|' +
                                (e.serverName || '') +
                                '|' +
                                String(e.parentRatingKey)
                        ] = true;
                    }
                    if (e.grandparentRatingKey != null) {
                        showKeys[
                            (e.source || '') +
                                '|' +
                                (e.serverName || '') +
                                '|' +
                                String(e.grandparentRatingKey)
                        ] = true;
                    }
                    if (e.librarySectionKey != null) {
                        libraryKeys[
                            (e.source || '') +
                                '|' +
                                (e.serverName || '') +
                                '|' +
                                String(e.librarySectionKey)
                        ] = true;
                    }
                }
                panel._searchActive = true;
                panel._searchHitMovieKeys = movieKeys;
                panel._searchHitShowKeys = showKeys;
                panel._searchHitEpisodeKeys = episodeKeys;
                panel._searchHitSeasonKeys = seasonKeys;
                panel._searchHitLibraryKeys = libraryKeys;
            }

            /**
             * Visibility for a panel row when server search hits are active,
             * else fall back to local title/summary matching.
             */
            scope.panelItemVisible = function (item, panel) {
                if (!panel) {
                    return true;
                }
                if (panel._searchActive) {
                    if (item && item.isLibraryNode) {
                        return !!(
                            panel._searchHitLibraryKeys
                            && panel._searchHitLibraryKeys[libraryIdentityKey(item)]
                        );
                    }
                    let k = itemIdentityKey(item);
                    if (item && item.type === 'show') {
                        return !!(panel._searchHitShowKeys && panel._searchHitShowKeys[k]);
                    }
                    if (item && item.type === 'movie') {
                        return !!(panel._searchHitMovieKeys && panel._searchHitMovieKeys[k]);
                    }
                    if (
                        item
                        && (
                            item.type === 'playlist'
                            || item.type === 'collection'
                            || item.type === 'custom'
                            || item.customShow === true
                            || item.type === 'external-list'
                            || item.trackedList === true
                            || item.trackedListId
                        )
                    ) {
                        // Playlists / collections / custom / tracked lists: local title filter
                        return scope.itemMatchesFilter(
                            item,
                            panel.filter,
                            true,
                            panel.allowCollections === true,
                            panel.summaryFilter
                        );
                    }
                    if (item && item.type === 'artist') {
                        return !!(panel._searchHitShowKeys && panel._searchHitShowKeys[k]);
                    }
                    return !!(
                        (panel._searchHitShowKeys && panel._searchHitShowKeys[k])
                        || (panel._searchHitMovieKeys && panel._searchHitMovieKeys[k])
                    );
                }
                return scope.itemMatchesFilter(
                    item,
                    panel.filter,
                    panelUsesTopLevelOnly(panel),
                    panel.allowCollections === true,
                    panel.summaryFilter
                );
            };

            function panelFilterState(panel) {
                let titleF = panel && panel.filter != null ? String(panel.filter) : "";
                let sumF =
                    panel && panel.summaryFilter != null
                        ? String(panel.summaryFilter)
                        : "";
                return {
                    titleF: titleF,
                    sumF: sumF,
                    allowCollections: !!(panel && panel.allowCollections),
                    hasFilter: !!(titleF.trim() || sumF.trim()),
                };
            }

            /** True if item should be added under the active panel filters (or no filter). */
            function passesPanelFilter(item, panel, asLeaf) {
                let f = panelFilterState(panel);
                if (!f.hasFilter) {
                    return true;
                }
                // Prefer server search hit sets when active (same as UI visibility)
                if (panel && panel._searchActive) {
                    let k = itemIdentityKey(item);
                    if (item && item.type === 'movie') {
                        return !!(panel._searchHitMovieKeys && panel._searchHitMovieKeys[k]);
                    }
                    if (item && item.type === 'episode') {
                        return !!(panel._searchHitEpisodeKeys && panel._searchHitEpisodeKeys[k]);
                    }
                    if (item && item.type === 'season') {
                        return !!(panel._searchHitSeasonKeys && panel._searchHitSeasonKeys[k]);
                    }
                    if (item && (item.type === 'show' || item.type === 'artist')) {
                        return !!(panel._searchHitShowKeys && panel._searchHitShowKeys[k]);
                    }
                    if (item && item.isLibraryNode) {
                        return !!(
                            panel._searchHitLibraryKeys
                            && panel._searchHitLibraryKeys[libraryIdentityKey(item)]
                        );
                    }
                }
                return scope.itemMatchesFilter(
                    item,
                    f.titleF,
                    asLeaf === true,
                    f.allowCollections,
                    f.sumF
                );
            }

            /**
             * When adding a container (+ on show/library/season):
             * - No filter → add everything under it
             * - TV title-only filter → show already matched by name; add whole show
             * - Summary / movie filters → only add nested rows that match the filter
             */
            function shouldFilterChildrenOnAdd(panel) {
                let f = panelFilterState(panel);
                if (!f.hasFilter) {
                    return false;
                }
                if (panelUsesTopLevelOnly(panel)) {
                    return false;
                }
                return true;
            }

            /**
             * Show an item if it matches the title filter and (optional) summary filter.
             * Both filters are AND when set. Nested items may satisfy a filter for parents
             * when topLevelOnly is false (Movies panel, or TV with summary filter).
             * @param {*} item
             * @param {string} [filterText] optional panel title filter
             * @param {boolean} [topLevelOnly] if true, only match this item (no nested search)
             * @param {boolean} [allowCollections]
             * @param {string} [summaryFilterText] optional panel summary filter
             */
            scope.itemMatchesFilter = function (item, filterText, topLevelOnly, allowCollections, summaryFilterText) {
                // Hide collections in Movies/TV browsers; allow them in Playlists & Collections panel
                if (item && item.type === 'collection' && !allowCollections) {
                    return false;
                }
                let titleRaw = (typeof filterText === 'string' ? filterText : scope.contentFilter) || "";
                titleRaw = titleRaw.trim();
                let summaryRaw =
                    typeof summaryFilterText === 'string'
                        ? summaryFilterText
                        : "";
                summaryRaw = String(summaryRaw || "").trim();
                if (!titleRaw && !summaryRaw) {
                    return true;
                }

                let selfTitleOk = true;
                if (titleRaw) {
                    let q = titleRaw.toLowerCase();
                    selfTitleOk = textMatchesFilter(item, q);
                    if (
                        !selfTitleOk
                        && item
                        && item.type
                        && String(item.type).toLowerCase().indexOf(q) !== -1
                    ) {
                        selfTitleOk = true;
                    }
                }
                let selfSummaryOk = true;
                if (summaryRaw) {
                    selfSummaryOk = summaryMatchesFilter(item, summaryRaw.toLowerCase());
                }
                if (selfTitleOk && selfSummaryOk) {
                    return true;
                }
                // Title-only TV list: do not walk seasons/episodes
                if (topLevelOnly) {
                    return false;
                }
                if (item && item.nested && item.nested.length) {
                    for (let i = 0; i < item.nested.length; i++) {
                        if (item.nested[i].type === 'collection' && !allowCollections) {
                            continue;
                        }
                        if (
                            scope.itemMatchesFilter(
                                item.nested[i],
                                filterText,
                                false,
                                allowCollections,
                                summaryFilterText
                            )
                        ) {
                            return true;
                        }
                    }
                }
                return false;
            };

            /** Nested rows under a filtered top-level item. */
            scope.nestedMatchesFilter = function (item, panel) {
                let allowCollections = panel && panel.allowCollections === true;
                if (item && item.type === 'collection' && !allowCollections) {
                    return false;
                }
                // Server search hits: only show matching movies/episodes/seasons
                if (panel && panel._searchActive) {
                    let k = itemIdentityKey(item);
                    if (item && item.type === 'movie') {
                        return !!(panel._searchHitMovieKeys && panel._searchHitMovieKeys[k]);
                    }
                    if (item && item.type === 'episode') {
                        return !!(panel._searchHitEpisodeKeys && panel._searchHitEpisodeKeys[k]);
                    }
                    if (item && item.type === 'season') {
                        return !!(panel._searchHitSeasonKeys && panel._searchHitSeasonKeys[k]);
                    }
                    if (item && item.type === 'show') {
                        return !!(panel._searchHitShowKeys && panel._searchHitShowKeys[k]);
                    }
                    // intermediate nodes: show if any filter text still matches locally
                    return scope.itemMatchesFilter(
                        item,
                        panel.filter,
                        false,
                        allowCollections,
                        panel.summaryFilter
                    );
                }
                // Title-only TV: once a show is expanded, list all its children
                if (panelUsesTopLevelOnly(panel)) {
                    return true;
                }
                // Summary (or Movies) filter: only show nested rows that match
                return scope.itemMatchesFilter(
                    item,
                    panel ? panel.filter : "",
                    false,
                    allowCollections,
                    panel ? panel.summaryFilter : ""
                );
            };

            scope.hasVisiblePanelItems = function (panel) {
                if (!panel) {
                    return false;
                }
                if (panel.visibleLibraries) {
                    return panel.visibleLibraries.length > 0;
                }
                if (!panel.libraries) {
                    return false;
                }
                for (let i = 0; i < panel.libraries.length; i++) {
                    if (scope.panelItemVisible(panel.libraries[i], panel)) {
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
            scope.sourceFilter = 'all'; // all | plex | jellyfin
            scope._customShowsLoaded = false;
            scope._trackedListsLoaded = false;
            scope.trackedLists = [];
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
                            visibleLibraries: [],
                            filter: "",
                            summaryFilter: "",
                            searching: false,
                            topLevelSearchOnly: true,
                            allowCollections: false,
                            allowAddAll: true,
                            emptyText: "Loading fillers...",
                        },
                        {
                            title: "Playlists/Lists/Custom/Collections",
                            id: "lists",
                            libraries: [],
                            visibleLibraries: [],
                            filter: "",
                            summaryFilter: "",
                            searching: false,
                            topLevelSearchOnly: true,
                            allowCollections: true,
                            allowAddAll: true,
                            emptyText: "Loading playlists, lists, custom, collections...",
                        },
                    ];
                }
                return [
                    {
                        title: "Movies",
                        libraries: [],
                        visibleLibraries: [],
                        filter: "",
                        summaryFilter: "",
                        searching: false,
                        topLevelSearchOnly: false,
                        allowCollections: false,
                        allowAddAll: true,
                        emptyText: "Loading libraries...",
                    },
                    {
                        title: "TV Shows",
                        libraries: [],
                        visibleLibraries: [],
                        filter: "",
                        summaryFilter: "",
                        searching: false,
                        topLevelSearchOnly: true,
                        allowCollections: false,
                        allowAddAll: true,
                        emptyText: "Loading libraries...",
                    },
                    {
                        title: "Playlists/Lists/Custom/Collections",
                        libraries: [],
                        visibleLibraries: [],
                        filter: "",
                        summaryFilter: "",
                        searching: false,
                        topLevelSearchOnly: true,
                        allowCollections: true,
                        allowAddAll: true,
                        emptyText: "Loading playlists, lists, custom, collections...",
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

            /** Tracked lists (Library → Lists) — always live. */
            async function loadTrackedListsLive() {
                try {
                    let list = await libraryCatalogPreload.fetchTrackedListsLive();
                    scope.trackedLists = list || [];
                } catch (err) {
                    console.error(err);
                    scope.trackedLists = [];
                }
            }

            /** Map custom shows into Playlists/Lists/Custom/Collections row shape. */
            function customShowsAsListItems() {
                let out = [];
                let list = scope.customShows || [];
                for (let i = 0; i < list.length; i++) {
                    let s = list[i];
                    if (!s) continue;
                    out.push({
                        type: 'custom',
                        customShow: true,
                        id: s.id,
                        title: s.name || s.title || 'Custom show',
                        name: s.name || s.title || 'Custom show',
                        count:
                            s.count != null
                                ? s.count
                                : Array.isArray(s.content)
                                  ? s.content.length
                                  : null,
                        source: 'custom',
                        mediaSource: 'custom',
                        serverType: 'custom',
                        isLibraryNode: false,
                    });
                }
                return out;
            }

            /** Map tracked lists into Playlists/Lists/Custom/Collections row shape. */
            function trackedListsAsListItems() {
                let out = [];
                let list = scope.trackedLists || [];
                for (let i = 0; i < list.length; i++) {
                    let s = list[i];
                    if (!s) continue;
                    out.push({
                        type: 'external-list',
                        trackedList: true,
                        trackedListId: s.id || s.trackedListId || s.key,
                        id: s.id || s.trackedListId || s.key,
                        key: s.id || s.trackedListId || s.key,
                        title: s.title || s.name || 'List',
                        name: s.title || s.name || 'List',
                        count: s.count != null ? s.count : null,
                        provider: s.provider || null,
                        source: 'list',
                        mediaSource: 'list',
                        serverType: 'list',
                        serverName: '',
                        isLibraryNode: false,
                    });
                }
                return out;
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
             * Switch All / Plex / Jellyfin.
             * Session cache only after ensureLoaded — never re-walks Plex/Jellyfin live.
             * Warm filter changes are in-memory hide/show (same idea as content-source filters).
             * Custom shows always live under Playlists & Collections (not a top filter).
             * options.quiet: no section spinner (re-enter / pure filter swap when cache warm).
             */
            scope.setSourceFilter = async function (filter, options) {
                options = options || {};
                // Custom is no longer a top-level source filter — redirect legacy callers
                if (filter === 'custom') {
                    filter = 'all';
                }
                if (filter !== 'all' && filter !== 'plex' && filter !== 'jellyfin') {
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
                // Live fetch for custom shows + tracked lists (never session-cached).
                // Reuse after first load so pure All/Plex/Jellyfin flips stay quiet.
                let needsLiveCustom =
                    !scope.fillerOnly && !scope._customShowsLoaded;
                let needsLiveTracked =
                    !scope.fillerOnly && !scope._trackedListsLoaded;
                let needsLiveExtras = needsLiveCustom || needsLiveTracked;
                // Quiet when cache warm and no live work — matches content-source filter UX
                let quiet = !!options.quiet && cacheWarm && !needsLiveExtras;
                if (!quiet && cacheWarm && scope._catalogBoundOnce && !needsLiveExtras && !options.force) {
                    quiet = true; // pure All/Plex/Jellyfin filter flip
                }

                scope.sourceFilter = filter;
                scope.contentFilter = "";
                scope.errors = [];
                scope.mediaSource = filter;

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

                    // Custom shows + tracked lists fold into Playlists/Lists/Custom/Collections
                    if (needsLiveCustom) {
                        await loadCustomShowsLive();
                        scope._customShowsLoaded = true;
                    }
                    if (needsLiveTracked) {
                        await loadTrackedListsLive();
                        scope._trackedListsLoaded = true;
                    }
                    // Pure in-memory swap for Plex/Jellyfin (session cache)
                    // (filler mode also flattens movie libraries — async)
                    let ok = await applyPreloadedMedia(filter);
                    if (!ok) {
                        applyLibraryPanels([], [], [], [
                            'No cached ' + filter + ' library data. Sync libraries under Library → Management.',
                        ]);
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
                scope._customShowsLoaded = false;
                scope._trackedListsLoaded = false;
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

            scope.selectLibrary = async (library, panel) => {
              await scope.fillNestedIfNecessary(library, true);
              let children = library.nested || [];
              let filterKids = shouldFilterChildrenOnAdd(panel);
              let p = children.length;
              scope.pending += children.length;
              try {
                for (let i = 0; i < children.length; i++) {
                    let child = children[i];
                    if (child.type === 'collection' || child.type === 'genre') {
                        scope.pending -= 1;
                        p -= 1;
                        continue;
                    }
                    // Respect title/summary filters: only add visible/matching items
                    if (filterKids && !passesPanelFilter(child, panel, false)) {
                        scope.pending -= 1;
                        p -= 1;
                        continue;
                    }
                    // Leaf playables (movies) must not go through season expansion
                    if (child.type === 'movie' || child.type === 'episode' || child.type === 'track') {
                        if (!filterKids || passesPanelFilter(child, panel, true)) {
                            await scope.selectItem(child, false);
                        }
                    } else {
                        await scope.selectShow(child, panel);
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
                // Fold custom shows + tracked lists into Playlists/Lists/Custom/Collections
                // (channel Add Programming, custom show editor — not filler browser)
                if (!scope.fillerOnly) {
                    listItems = sortByTitle(
                        listItems
                            .concat(customShowsAsListItems())
                            .concat(trackedListsAsListItems())
                    );
                }
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
                                summaryFilter: "",
                                searching: false,
                                topLevelSearchOnly: true,
                                allowCollections: false,
                                allowAddAll: true,
                                emptyText: "No fillers in filler libraries.",
                            },
                            {
                                title: "Playlists/Lists/Custom/Collections",
                                id: "lists",
                                libraries: listItems,
                                filter: "",
                                summaryFilter: "",
                                searching: false,
                                topLevelSearchOnly: true,
                                allowCollections: true,
                                allowAddAll: true,
                                emptyText: "No playlists or collections in filler libraries.",
                            },
                        ];
                    } else {
                        scope.contentPanels = [
                            {
                                title: "Movies",
                                libraries: movies,
                                filter: "",
                                summaryFilter: "",
                                searching: false,
                                topLevelSearchOnly: false,
                                allowCollections: false,
                                allowAddAll: true,
                                emptyText: "No movie libraries found.",
                            },
                            {
                                title: "TV Shows",
                                libraries: flatShows,
                                filter: "",
                                summaryFilter: "",
                                searching: false,
                                topLevelSearchOnly: true,
                                allowCollections: false,
                                allowAddAll: true,
                                emptyText: "No TV shows found.",
                            },
                            {
                                title: "Playlists/Lists/Custom/Collections",
                                libraries: listItems,
                                filter: "",
                                summaryFilter: "",
                                searching: false,
                                topLevelSearchOnly: true,
                                allowCollections: true,
                                allowAddAll: true,
                                emptyText: "No playlists, lists, custom shows, or collections found.",
                            },
                        ];
                    }
                    // Seed visible lists (full catalog until user types a search)
                    rebuildAllPanelVisible();
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
                if (typeof(x.nested) !== 'undefined') {
                    return;
                }
                // Custom shows: expand to clip list (preserve order)
                if (x && (x.type === 'custom' || x.customShow === true)) {
                    try {
                        let showId = x.id || x.key;
                        let show = await dizquetv.getShow(showId);
                        if (!show || !Array.isArray(show.content)) {
                            x.nested = [];
                            return;
                        }
                        let nested = [];
                        for (let i = 0; i < show.content.length; i++) {
                            let item = JSON.parse(angular.toJson(show.content[i]));
                            item.customShowId = show.id || showId;
                            item.customShowName = show.name || x.title || x.name;
                            item.customOrder = i;
                            if (typeof item.commercials === 'undefined') {
                                item.commercials = [];
                            }
                            nested.push(item);
                        }
                        x.nested = nested;
                        if (x.count == null) {
                            x.count = nested.length;
                        }
                        if (show.name) {
                            x.title = show.name;
                            x.name = show.name;
                        }
                    } catch (err) {
                        console.error(err);
                        x.nested = [];
                        scope.errors = (scope.errors || []).concat([
                            'Failed to load custom show: ' + (x.title || x.name || x.id || ''),
                        ]);
                    }
                    return;
                }
                // Tracked lists (Library → Lists): expand to matched programs
                if (
                    x
                    && (
                        x.type === 'external-list'
                        || x.trackedList === true
                        || x.trackedListId
                    )
                ) {
                    try {
                        let listId = x.trackedListId || x.id || x.key;
                        let payload = await dizquetv.getTrackedListPrograms(listId);
                        let programs = (payload && payload.programs) || [];
                        let nested = [];
                        for (let i = 0; i < programs.length; i++) {
                            let item = JSON.parse(angular.toJson(programs[i]));
                            if (typeof item.commercials === 'undefined') {
                                item.commercials = [];
                            }
                            item.trackedListId = listId;
                            item.trackedListName = x.title || x.name;
                            nested.push(item);
                        }
                        x.nested = nested;
                        x.count = nested.length;
                    } catch (err) {
                        console.error(err);
                        x.nested = [];
                        scope.errors = (scope.errors || []).concat([
                            'Failed to load list: ' + (x.title || x.name || x.id || ''),
                        ]);
                    }
                    return;
                }
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
            /**
             * Load seasons (and their episodes) under a TV show for summary search.
             */
            async function deepLoadShowForSummary(show) {
                if (!show) return;
                await scope.fillNestedIfNecessary(show, false);
                let nested = show.nested || [];
                for (let i = 0; i < nested.length; i++) {
                    let child = nested[i];
                    if (!child) continue;
                    // Seasons (and sometimes nested folders) hold episodes
                    if (
                        child.type === 'season'
                        || child.type === 'show'
                        || child.type === 'folder'
                        || (child.type !== 'episode' && child.type !== 'movie' && child.type !== 'track')
                    ) {
                        await scope.fillNestedIfNecessary(child, false);
                        // One more level if still not episodes (rare)
                        let grand = child.nested || [];
                        for (let g = 0; g < grand.length; g++) {
                            if (
                                grand[g]
                                && grand[g].type === 'season'
                                && typeof grand[g].nested === 'undefined'
                            ) {
                                await scope.fillNestedIfNecessary(grand[g], false);
                            }
                        }
                    }
                }
            }

            /**
             * Rebuild the visible list for a panel from libraries + current filters.
             * Stored on the panel so ng-repeat tracks a real array that changes with search
             * (ng-if alone was not reliably re-filtering playlist/custom rows).
             */
            function rebuildPanelVisible(panel) {
                if (!panel) {
                    return;
                }
                let libs = panel.libraries || [];
                let out = [];
                for (let i = 0; i < libs.length; i++) {
                    if (scope.panelItemVisible(libs[i], panel)) {
                        out.push(libs[i]);
                    }
                }
                panel.visibleLibraries = out;
                panel.filterEpoch = (panel.filterEpoch || 0) + 1;
            }

            function rebuildAllPanelVisible() {
                let panels = scope.contentPanels || [];
                for (let i = 0; i < panels.length; i++) {
                    rebuildPanelVisible(panels[i]);
                }
            }

            /**
             * Title-only TV / Lists filters stay in-browser (flat list of names).
             * Summary / movie nested filters use one server in-memory cache search
             * (no per-show nested HTTP fan-out).
             */
            let _filterSearchSeq = 0;
            scope.onPanelFilterChange = async function (panel) {
                if (!panel) {
                    return;
                }
                let q = (panel.filter || "").trim();
                let sq = (panel.summaryFilter || "").trim();
                if (!q && !sq) {
                    clearPanelServerSearch(panel);
                    rebuildPanelVisible(panel);
                    $timeout();
                    return;
                }
                // TV / lists / fillers title-only: pure in-memory against loaded row names
                // (playlists, collections, custom shows — no server index for these)
                if (panel.topLevelSearchOnly && !sq) {
                    clearPanelServerSearch(panel);
                    rebuildPanelVisible(panel);
                    $timeout();
                    return;
                }
                // No Plex/Jellyfin: still filter whatever is already in the panel (e.g. custom)
                if (!scope.hasPlex && !scope.hasJellyfin) {
                    clearPanelServerSearch(panel);
                    rebuildPanelVisible(panel);
                    $timeout();
                    return;
                }

                let seq = ++_filterSearchSeq;
                panel.searching = true;
                $timeout();
                try {
                    // One round-trip: search server process memory (synced library cache)
                    let result = await dizquetv.searchLibraryCache({
                        title: q,
                        summary: sq,
                        limit: 4000,
                    });
                    if (seq !== _filterSearchSeq) {
                        return; // superseded by a newer keystroke
                    }
                    applyServerSearchHits(panel, result || {});

                    // Expand hit libraries/shows so matching children are visible (lazy, hits only)
                    for (let i = 0; i < panel.libraries.length; i++) {
                        let lib = panel.libraries[i];
                        if (!scope.panelItemVisible(lib, panel)) {
                            lib.collapse = false;
                            continue;
                        }
                        if (lib.isLibraryNode) {
                            await scope.fillNestedIfNecessary(lib, true);
                            lib.collapse = true;
                        } else if (lib.type === 'show' || lib.type === 'artist') {
                            // Only expand when we have episode-level hits to show
                            let hasEpHits =
                                panel._searchHitEpisodeKeys
                                && Object.keys(panel._searchHitEpisodeKeys).length > 0;
                            if (hasEpHits || sq) {
                                await scope.fillNestedIfNecessary(lib, false);
                                let seasons = lib.nested || [];
                                for (let s = 0; s < seasons.length; s++) {
                                    let season = seasons[s];
                                    if (!season || season.type !== 'season') continue;
                                    let seasonKey = itemIdentityKey(season);
                                    if (
                                        panel._searchHitSeasonKeys
                                        && panel._searchHitSeasonKeys[seasonKey]
                                    ) {
                                        await scope.fillNestedIfNecessary(season, false);
                                        season.collapse = true;
                                    }
                                }
                                lib.collapse = true;
                            }
                        }
                    }
                    rebuildPanelVisible(panel);
                } catch (err) {
                    console.error("Filter search failed", err);
                    // Fall back to previous (slower) deep-load path for this panel only
                    clearPanelServerSearch(panel);
                    rebuildPanelVisible(panel);
                } finally {
                    if (seq === _filterSearchSeq) {
                        panel.searching = false;
                    }
                    $timeout();
                }
            };

            /**
             * True when a top-level panel row can expand (library folder, show, playlist, etc.).
             * Flat movie clips (Add Filler "Fillers" list) are leaves — no tree chevron.
             * Custom shows expand to their clip list like playlists/collections.
             */
            scope.isExpandableTopLevel = (item) => {
                if (!item) return false;
                if (item.isLibraryNode === true) return true;
                if (item.type === 'custom' || item.customShow === true) return true;
                if (
                    item.type === 'external-list'
                    || item.trackedList === true
                    || item.trackedListId
                ) {
                    return true;
                }
                let t = item.type;
                return t === 'show' || t === 'artist' || t === 'playlist'
                    || t === 'collection' || t === 'genre' || t === 'season' || t === 'album';
            };

            /** Leaf playables under an expanded row (playlist/custom/show tree). */
            scope.isPlayableLibraryItem = (item) => {
                if (!item) return false;
                let t = item.type;
                return t === 'movie' || t === 'episode' || t === 'track';
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

            scope.selectTopLevelItem = async (item, panel) => {
                if (!item) {
                    return;
                }
                // Custom shows listed under Playlists/Lists/Custom/Collections
                if (item.type === 'custom' || item.customShow === true) {
                    return scope.addCustomShow(item);
                }
                // Tracked lists (Library → Lists)
                if (
                    item.type === 'external-list'
                    || item.trackedList === true
                    || item.trackedListId
                ) {
                    return scope.addTrackedList(item);
                }
                if (item.isLibraryNode) {
                    return scope.selectLibrary(item, panel);
                }
                if (item.type === 'playlist' || item.type === 'collection') {
                    return scope.selectPlaylist(item, panel);
                }
                if (item.type === 'movie') {
                    if (!passesPanelFilter(item, panel, true)) {
                        return;
                    }
                    return scope.selectItem(item, true);
                }
                // show, artist, etc.
                return scope.selectShow(item, panel);
            };

            /**
             * Add contents of every currently visible (filtered) row in a panel.
             * Movies panel: expands library folders and only adds nested items that
             * match the title/summary filters (not the entire unfiltered library).
             * TV / playlists: adds each matching top-level show or list as usual.
             */
            scope.selectAllVisibleInPanel = async (panel) => {
                if (!panel || !panel.libraries || !panel.libraries.length) {
                    return;
                }
                if (panel.addingAll) {
                    return;
                }
                let allowCollections = panel.allowCollections === true;
                let titleF = panel.filter;
                let sumF = panel.summaryFilter;
                // Prefer pre-built visible list (search-aware)
                let visible = (panel.visibleLibraries || []).slice();
                if (!visible.length) {
                    for (let i = 0; i < panel.libraries.length; i++) {
                        let item = panel.libraries[i];
                        if (scope.panelItemVisible(item, panel)) {
                            visible.push(item);
                        }
                    }
                }
                if (!visible.length) {
                    return;
                }

                async function addFilteredItem(item) {
                    if (!item) {
                        return;
                    }
                    if (item.type === 'custom' || item.customShow === true) {
                        await scope.addCustomShow(item);
                        return;
                    }
                    if (
                        item.type === 'external-list'
                        || item.trackedList === true
                        || item.trackedListId
                    ) {
                        await scope.addTrackedList(item);
                        return;
                    }
                    // Leaf playables
                    if (
                        item.type === 'movie'
                        || item.type === 'episode'
                        || item.type === 'track'
                    ) {
                        if (
                            scope.itemMatchesFilter(
                                item,
                                titleF,
                                true,
                                allowCollections,
                                sumF
                            )
                        ) {
                            await scope.selectItem(item, false);
                        }
                        return;
                    }
                    // Containers: always go through filter-aware select helpers
                    if (item.type === 'playlist' || item.type === 'collection') {
                        await scope.selectPlaylist(item, panel);
                        return;
                    }
                    if (item.type === 'show' || item.type === 'artist' || item.type === 'season') {
                        if (item.type === 'season') {
                            await scope.selectSeason(item, panel);
                        } else {
                            await scope.selectShow(item, panel);
                        }
                        return;
                    }
                    if (item.isLibraryNode) {
                        await scope.selectLibrary(item, panel);
                        return;
                    }
                    // Movies (and other deep panels): walk nested, only add matches
                    await scope.fillNestedIfNecessary(
                        item,
                        item.isLibraryNode === true
                    );
                    let nested = item.nested || [];
                    for (let c = 0; c < nested.length; c++) {
                        let child = nested[c];
                        if (child.type === 'collection' && !allowCollections) {
                            continue;
                        }
                        if (
                            !scope.itemMatchesFilter(
                                child,
                                titleF,
                                false,
                                allowCollections,
                                sumF
                            )
                        ) {
                            continue;
                        }
                        if (
                            child.type === 'movie'
                            || child.type === 'episode'
                            || child.type === 'track'
                        ) {
                            await scope.selectItem(child, false);
                        } else if (
                            child.type === 'show'
                            || child.type === 'artist'
                        ) {
                            await scope.selectShow(child, panel);
                        } else if (child.type === 'season') {
                            await scope.selectSeason(child, panel);
                        } else if (child.type === 'playlist' || child.type === 'collection') {
                            await scope.selectPlaylist(child, panel);
                        } else if (child.isLibraryNode || (child.nested && child.nested.length)) {
                            await addFilteredItem(child);
                        } else {
                            await scope.selectTopLevelItem(child, panel);
                        }
                    }
                }

                panel.addingAll = true;
                scope.pending += 1;
                $timeout();
                try {
                    for (let i = 0; i < visible.length; i++) {
                        await addFilteredItem(visible[i]);
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
                if (!panel) {
                    return 0;
                }
                if (panel.visibleLibraries) {
                    return panel.visibleLibraries.length;
                }
                if (!panel.libraries) {
                    return 0;
                }
                let n = 0;
                for (let i = 0; i < panel.libraries.length; i++) {
                    if (scope.panelItemVisible(panel.libraries[i], panel)) {
                        n++;
                    }
                }
                return n;
            };

            scope.libraryTrackKey = function (item) {
                if (!item) return 'x';
                return (
                    (item.mediaSource || item.source || item.serverType || 'plex')
                    + '-'
                    + (item.type || '')
                    + '-'
                    + (item.serverName || '')
                    + '-'
                    + (item.key || item.id || item.ratingKey || '')
                    + '-'
                    + (item.libraryTitle || '')
                );
            };
            
            scope.selectSeason = (season, panel) => {
                return new Promise((resolve, reject) => {
                    $timeout(async () => {
                        await scope.fillNestedIfNecessary(season);
                        let children = season.nested || [];
                        let filterKids = shouldFilterChildrenOnAdd(panel);
                        let p = children.length;
                        scope.pending += p;
                        try {
                            for (let i = 0, l = children.length; i < l; i++) {
                                let child = children[i];
                                if (!filterKids || passesPanelFilter(child, panel, true)) {
                                    await scope.selectItem(child, false);
                                }
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
            scope.selectShow = (show, panel) => {
                return new Promise((resolve, reject) => {
                    $timeout(async () => {
                        // Already a playable leaf
                        if (show && (show.type === 'movie' || show.type === 'episode' || show.type === 'track')) {
                            try {
                                if (passesPanelFilter(show, panel, true)) {
                                    // single=true so embedded mode adds immediately
                                    await scope.selectItem(show, true);
                                }
                                resolve();
                            } catch (e) {
                                reject(e);
                            } finally {
                                scope.$apply();
                            }
                            return;
                        }
                        await scope.fillNestedIfNecessary(show);
                        let filterKids = shouldFilterChildrenOnAdd(panel);
                        // When filtering by summary, load season episodes so nested match works
                        if (filterKids) {
                            let nested0 = show.nested || [];
                            for (let ni = 0; ni < nested0.length; ni++) {
                                let n0 = nested0[ni];
                                if (n0 && (n0.type === 'season' || n0.type === 'show')) {
                                    await scope.fillNestedIfNecessary(n0, false);
                                }
                            }
                        }
                        let children = show.nested || [];
                        let p = children.length;
                        scope.pending += p;
                        try {
                            for (let i = 0, l = children.length; i < l; i++) {
                                let child = children[i];
                                // Skip branches that don't match the active filter
                                if (filterKids && !passesPanelFilter(child, panel, false)) {
                                    scope.pending -= 1;
                                    p -= 1;
                                    continue;
                                }
                                if (child.type === 'movie' || child.type === 'episode' || child.type === 'track') {
                                    if (!filterKids || passesPanelFilter(child, panel, true)) {
                                        await scope.selectItem(child, false);
                                    }
                                } else if (child.type === 'season') {
                                    await scope.selectSeason(child, panel);
                                } else {
                                    // Nested folders / specials
                                    await scope.selectShow(child, panel);
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
            scope.selectPlaylist = async (playlist, panel) => {
                return new Promise((resolve, reject) => {
                    $timeout(async () => {
                        try {
                            await scope.fillNestedIfNecessary(playlist);
                            let children = playlist.nested || [];
                            let filterKids = shouldFilterChildrenOnAdd(panel);
                            let p = children.length;
                            scope.pending += p;
                            try {
                                for (let i = 0, l = children.length; i < l; i++) {
                                    let child = children[i];
                                    if (filterKids && !passesPanelFilter(child, panel, false)) {
                                        scope.pending -= 1;
                                        p -= 1;
                                        continue;
                                    }
                                    if (child.type === 'movie' || child.type === 'episode' || child.type === 'track') {
                                        if (!filterKids || passesPanelFilter(child, panel, true)) {
                                            await scope.selectItem(child, false);
                                        }
                                    } else if (child.type === 'season') {
                                        await scope.selectSeason(child, panel);
                                    } else {
                                        // Nested shows/folders inside playlists or collections
                                        await scope.selectShow(child, panel);
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

            /** Add all matched programs from a tracked list (Library → Lists). */
            scope.addTrackedList = async (listRow) => {
                scope.pending++;
                try {
                    let listId = listRow.trackedListId || listRow.id || listRow.key;
                    let payload = await dizquetv.getTrackedListPrograms(listId);
                    let programs = (payload && payload.programs) || [];
                    let batch = [];
                    for (let i = 0; i < programs.length; i++) {
                        let item = JSON.parse(angular.toJson(programs[i]));
                        if (typeof item.commercials === 'undefined') {
                            item.commercials = [];
                        }
                        item.trackedListId = listId;
                        item.trackedListName = listRow.title || listRow.name;
                        batch.push(item);
                    }
                    if (!batch.length) {
                        scope.errors = (scope.errors || []).concat([
                            'Tracked list has no matched programs: ' + (listRow.title || listId),
                        ]);
                        return;
                    }
                    if (scope.embedded) {
                        commitEmbeddedBatch(batch);
                    } else {
                        scope.selection = scope.selection.concat(batch);
                    }
                    scope.$apply();
                } catch (err) {
                    console.error(err);
                    scope.errors = (scope.errors || []).concat([
                        'Failed to add list: ' + (listRow.title || listRow.name || ''),
                    ]);
                } finally {
                    scope.pending--;
                }
            };

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