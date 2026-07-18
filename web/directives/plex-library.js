module.exports = function (plex, dizquetv, $timeout, commonProgramTools) {
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
        },
        link: function (scope, element, attrs) {
            scope.errors=[];
            if ( typeof(scope.limit) == 'undefined') {
                scope.limit = 1000000000;
            }
            scope.insertPoint = "end";
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
                { title: "Movies", libraries: [], filter: "", emptyText: "No movie libraries found." },
                { title: "TV Shows", libraries: [], filter: "", emptyText: "No TV show libraries found." },
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
            scope.itemMatchesFilter = function (item, filterText, topLevelOnly) {
                // Never show collections in library browsers
                if (item && item.type === 'collection') {
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
                // TV panel: only search top-level show titles
                if (topLevelOnly) {
                    return false;
                }
                if (item && item.nested && item.nested.length) {
                    for (let i = 0; i < item.nested.length; i++) {
                        if (item.nested[i].type === 'collection') {
                            continue;
                        }
                        if (scope.itemMatchesFilter(item.nested[i], filterText, false)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            /** Nested rows under a filtered top-level item (TV: always show children once expanded). */
            scope.nestedMatchesFilter = function (item, panel) {
                if (item && item.type === 'collection') {
                    return false;
                }
                if (panel && panel.topLevelSearchOnly) {
                    return true;
                }
                return scope.itemMatchesFilter(item, panel ? panel.filter : "", false);
            };

            scope.hasVisiblePanelItems = function (panel) {
                if (!panel || !panel.libraries) {
                    return false;
                }
                let topOnly = panel.topLevelSearchOnly === true;
                for (let i = 0; i < panel.libraries.length; i++) {
                    if (scope.itemMatchesFilter(panel.libraries[i], panel.filter, topOnly)) {
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
            scope.selectOrigin = function (origin) {
                scope.contentFilter = "";
                if (scope.contentPanels) {
                    for (let i = 0; i < scope.contentPanels.length; i++) {
                        scope.contentPanels[i].filter = "";
                    }
                }
                if ( origin.type === 'plex' ) {
                    scope.plexServer = origin.server;
                    updateLibrary(scope.plexServer);
                } else {
                    scope.plexServer = undefined;
                    updateCustomShows();
                }
            }
            scope._onFinish = (s, insertPoint) => {
                if (s.length > scope.limit) {
                    if (scope.limit == 1) {
                        scope.error = "Please select only one clip.";
                    } else {
                        scope.error = `Please select at most ${scope.limit} clips.`;
                    }
                } else {
                    scope.onFinish(s, insertPoint)
                    scope.selection = []
                    scope.visible = false
                }
            }
            scope.selectItem = async (item, single) => {
                        await scope.wait(0);
                        scope.pending += 1;
                        try {
                            delete item.server;
                            item.serverKey = scope.plexServer.name;
                            scope.selection.push(JSON.parse(angular.toJson(item)))
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
            scope.selectLibrary = async (library) => {
              await scope.fillNestedIfNecessary(library, true);
              let p = library.nested.length;
              scope.pending += library.nested.length;
              try {
                for (let i = 0; i < library.nested.length; i++) {
                    //await scope.selectItem( library.nested[i] );
                    if (library.nested[i].type !== 'collection' && library.nested[i].type !== 'genre') {
                        await scope.selectShow( library.nested[i] );
                    }
                    scope.pending -= 1;
                    p -= 1;
                }
              } finally {
                scope.pending -= p;
                scope.$apply()
              }
            }

            dizquetv.getPlexServers().then((servers) => {
                if (servers.length === 0) {
                    scope.noServers = true
                    return
                }
                scope.origins = servers.map( (s) => {
                    return {
                        "type" : "plex",
                        "name" : `Plex - ${s.name}`,
                        "server": s,
                    }
                } );
                scope.origins.push( {
                    "type": "dizquetv",
                    "name" : "dizqueTV - Custom Shows",
                } );
                scope.origins.sort( (a, b) => {
                    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                } );
                scope.currentOrigin = scope.origins[0];
                scope.plexServer = scope.currentOrigin.server;
                if (scope.currentOrigin.type === 'plex') {
                    updateLibrary(scope.plexServer)
                } else {
                    updateCustomShows();
                }
            })

            let updateLibrary = async(server) => {
                let lib = await plex.getLibrary(server);
                let loadErrors = [];

                // Sort genres under each library if present
                lib.forEach( (section) => {
                    if (section.genres && section.genres.length) {
                        section.genres = sortByTitle(section.genres);
                    }
                } );
                lib = sortByTitle(lib);

                let movies = [];
                let showLibraries = [];
                for (let i = 0; i < lib.length; i++) {
                    if (lib[i].type === 'movie') {
                        // Movie side still uses library folders
                        lib[i].isLibraryNode = true;
                        movies.push(lib[i]);
                    } else if (lib[i].type === 'show' || lib[i].type === 'artist') {
                        showLibraries.push(lib[i]);
                    } else {
                        showLibraries.push(lib[i]);
                    }
                }

                // TV side: flatten — list shows only (no library folders, no collections)
                let flatShows = [];
                for (let i = 0; i < showLibraries.length; i++) {
                    let section = showLibraries[i];
                    try {
                        // includeCollections=false — collections excluded from browser
                        let nested = await plex.getNested(server, section, false, loadErrors);
                        nested = sortByTitle(nested || []);
                        for (let j = 0; j < nested.length; j++) {
                            let item = nested[j];
                            if (item.type === 'collection') {
                                continue;
                            }
                            item.isLibraryNode = false;
                            if (!item.libraryTitle) {
                                item.libraryTitle = section.title;
                            }
                            flatShows.push(item);
                        }
                    } catch (err) {
                        console.error("Failed to load TV library " + section.title, err);
                        loadErrors.push("Failed to load " + section.title);
                    }
                }
                flatShows = sortByTitle(flatShows);

                if (loadErrors.length) {
                    scope.errors = (scope.errors || []).concat(loadErrors);
                }

                scope.$apply(() => {
                    scope.movieLibraries = movies;
                    scope.showLibraries = flatShows;
                    // Keep legacy combined list for any other references
                    scope.libraries = movies.concat(flatShows);
                    scope.contentPanels = [
                        {
                            title: "Movies",
                            libraries: movies,
                            filter: "",
                            searching: false,
                            topLevelSearchOnly: false,
                            emptyText: "No movie libraries found on this server.",
                        },
                        {
                            title: "TV Shows",
                            libraries: flatShows,
                            filter: "",
                            searching: false,
                            topLevelSearchOnly: true,
                            emptyText: "No TV shows found on this server.",
                        },
                    ];
                })

            }
            scope.fillNestedIfNecessary = async (x, isLibrary) => {
                if (typeof(x.nested) === 'undefined') {
                    // Never pull collections into the library browser
                    x.nested = await plex.getNested(scope.plexServer, x, false, scope.errors);
                    // Strip any collection entries defensively
                    x.nested = (x.nested || []).filter((n) => n && n.type !== 'collection');
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
                if (!scope.plexServer) {
                    return;
                }
                // TV: only filter top-level show titles (already loaded flat)
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

            /** Expand a node; library folders use isLibraryNode, shows/playlists do not. */
            scope.getNested = (list, isLibrary) => {
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
                if (item.type === 'playlist') {
                    return scope.selectPlaylist(item);
                }
                if (item.type === 'movie') {
                    return scope.selectItem(item, true);
                }
                // show, collection, artist, etc.
                return scope.selectShow(item);
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
                            scope.$apply()
                        }
                    }, 0)
                })
            }
            scope.selectShow = (show) => {
                return new Promise((resolve, reject) => {
                    $timeout(async () => {
                        await scope.fillNestedIfNecessary(show);
                        let p = show.nested.length;
                        scope.pending += p;
                        try {
                            for (let i = 0, l = show.nested.length; i < l; i++) {
                                await scope.selectSeason(show.nested[i])
                                scope.pending -= 1;
                                p -= 1;
                            }
                            resolve();
                        } catch (e) {
                            reject(e);
                        } finally {
                            scope.pending -= p;
                            scope.$apply()
                        }
                    }, 0)
                })
            }
            scope.selectPlaylist = async (playlist) => {
                return new Promise((resolve, reject) => {
                    $timeout(async () => {
                        await scope.fillNestedIfNecessary(playlist);
                        for (let i = 0, l = playlist.nested.length; i < l; i++)
                            await scope.selectItem(playlist.nested[i], false)
                        scope.$apply()
                        resolve()
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
                    for (let i = 0; i < show.content.length; i++) {
                        let item = JSON.parse(angular.toJson( show.content[i] ));
                        item.customShowId = show.id;
                        item.customShowName = show.name;
                        item.customOrder = i;
                        scope.selection.push(item);
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
                r += show.title;
                if (
                    (show.type !== 'episode')
                    &&
                    (typeof(show.year) !== 'undefined')
                ) {
                    r += " (" + JSON.stringify(show.year) + ")";
                }
                return r;
            }
        }
    };
}