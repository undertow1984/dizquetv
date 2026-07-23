/**
 * In-memory session catalog for all programming UI (not Library Management sync).
 *
 * Rules:
 *  - Only Library Management may call live Plex/Jellyfin (preferLive).
 *  - This service loads from dizqueTV's on-disk library cache APIs into browser
 *    memory once per page load (or when memory is missing / after resync).
 *  - ensureLoaded() never re-hits the network if state.ready.
 *  - Custom shows are NOT stored here (always live from /api/shows).
 */
module.exports = function (plex, jellyfin, dizquetv) {
    let state = {
        ready: false,
        loading: false,
        error: null,
        plexServers: [],
        jellyfinServers: [],
        /** @type {{ movies: any[], shows: any[], lists: any[], errors: string[] } | null} */
        mediaAll: null,
        mediaPlex: null,
        mediaJellyfin: null,
        /**
         * Cached /api/content-sources/catalog for Plex/Jellyfin lists only.
         * customShows are intentionally NOT session-cached — always load live.
         */
        contentSourceCatalog: null,
    };

    /** @type {Array<(snap: { ready: boolean, loading: boolean, error: string|null }) => void>} */
    let listeners = [];

    function snapshot() {
        return {
            ready: !!state.ready,
            loading: !!state.loading,
            error: state.error || null,
        };
    }

    function notify() {
        let snap = snapshot();
        for (let i = 0; i < listeners.length; i++) {
            try {
                listeners[i](snap);
            } catch (err) {
                console.error(err);
            }
        }
    }

    function sortByTitle(items) {
        return (items || []).slice().sort((a, b) => {
            let ta = (a.title || a.name || '').toString();
            let tb = (b.title || b.name || '').toString();
            return ta.localeCompare(tb, undefined, { sensitivity: 'base', numeric: true });
        });
    }

    function tagServer(item, server, mediaSource) {
        if (!item) return item;
        item._server = server;
        item.source = mediaSource;
        item.serverName = server.name;
        item.serverType = mediaSource;
        return item;
    }

    /**
     * Cache-only server snapshot for Add Programming.
     * Uses flat cache list APIs (sections / playlists / collections / shows) —
     * never walks each TV library with getNested (that path was the slow "live-like" cost).
     */
    async function fetchPlexServer(server) {
        let loadErrors = [];
        let listItems = [];
        let movies = [];
        let flatShows = [];
        try {
            // Defaults are cache-only (no preferLive) — never call live Plex here
            let parallel = await Promise.all([
                plex.getLibrary(server).catch((err) => {
                    console.error(err);
                    loadErrors.push('Failed libraries from ' + server.name);
                    return [];
                }),
                plex.getPlaylists(server).catch((err) => {
                    console.error(err);
                    loadErrors.push('Failed playlists from ' + server.name);
                    return [];
                }),
                plex.getCollections(server).catch((err) => {
                    console.error(err);
                    loadErrors.push('Failed collections from ' + server.name);
                    return [];
                }),
                plex.getShows(server).catch((err) => {
                    console.error(err);
                    loadErrors.push('Failed shows from ' + server.name);
                    return [];
                }),
            ]);
            let lib = parallel[0] || [];
            let playlists = parallel[1] || [];
            let collections = parallel[2] || [];
            let shows = parallel[3] || [];
            for (let i = 0; i < playlists.length; i++) {
                listItems.push(tagServer(Object.assign({}, playlists[i], {
                    type: 'playlist',
                    isLibraryNode: false,
                }), server, 'plex'));
            }
            for (let i = 0; i < collections.length; i++) {
                let col = Object.assign({}, collections[i], {
                    type: 'collection',
                    isLibraryNode: false,
                });
                if (col.sectionKey == null && col.librarySectionKey != null) {
                    col.sectionKey = String(col.librarySectionKey);
                }
                listItems.push(tagServer(col, server, 'plex'));
            }
            for (let i = 0; i < lib.length; i++) {
                tagServer(lib[i], server, 'plex');
                // Ensure sectionKey is always set for filler filtering
                if (lib[i].sectionKey == null && lib[i].key) {
                    let m = String(lib[i].key).match(/\/library\/sections\/([^/?#]+)/i);
                    if (m) lib[i].sectionKey = m[1];
                }
                if (lib[i].type === 'movie') {
                    lib[i].isLibraryNode = true;
                    movies.push(lib[i]);
                }
            }
            for (let i = 0; i < shows.length; i++) {
                let item = Object.assign({}, shows[i], {
                    type: 'show',
                    isLibraryNode: false,
                });
                if (item.sectionKey == null && item.librarySectionKey != null) {
                    item.sectionKey = String(item.librarySectionKey);
                }
                flatShows.push(tagServer(item, server, 'plex'));
            }
        } catch (err) {
            console.error('Failed to load Plex library ' + server.name, err);
            loadErrors.push('Failed to load Plex ' + server.name);
        }
        return { movies: movies, shows: flatShows, lists: listItems, errors: loadErrors };
    }

    async function fetchJellyfinServer(server) {
        let loadErrors = [];
        let listItems = [];
        let movies = [];
        let flatShows = [];
        try {
            // Defaults are cache-only (no preferLive) — never call live Jellyfin here
            let parallel = await Promise.all([
                jellyfin.getLibrary(server).catch((err) => {
                    console.error(err);
                    loadErrors.push('Failed libraries from ' + server.name);
                    return [];
                }),
                jellyfin.getPlaylists(server).catch((err) => {
                    console.error(err);
                    loadErrors.push('Failed playlists from ' + server.name);
                    return [];
                }),
                jellyfin.getCollections(server).catch((err) => {
                    console.error(err);
                    loadErrors.push('Failed collections from ' + server.name);
                    return [];
                }),
                jellyfin.getShows(server).catch((err) => {
                    console.error(err);
                    loadErrors.push('Failed shows from ' + server.name);
                    return [];
                }),
            ]);
            let lib = sortByTitle(parallel[0] || []);
            let playlists = parallel[1] || [];
            let collections = parallel[2] || [];
            let shows = parallel[3] || [];
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
            for (let i = 0; i < lib.length; i++) {
                tagServer(lib[i], server, 'jellyfin');
                if (lib[i].type === 'movie') {
                    lib[i].isLibraryNode = true;
                    movies.push(lib[i]);
                }
            }
            for (let i = 0; i < shows.length; i++) {
                let item = Object.assign({}, shows[i], {
                    type: 'show',
                    isLibraryNode: false,
                    source: 'jellyfin',
                });
                flatShows.push(tagServer(item, server, 'jellyfin'));
            }
        } catch (err) {
            console.error('Failed to load Jellyfin library ' + server.name, err);
            loadErrors.push('Failed to load Jellyfin ' + server.name);
        }
        return { movies: movies, shows: flatShows, lists: listItems, errors: loadErrors };
    }

    function mergeResults(results) {
        let movies = [];
        let shows = [];
        let lists = [];
        let errors = [];
        for (let r = 0; r < (results || []).length; r++) {
            let part = results[r] || {};
            movies = movies.concat(part.movies || []);
            shows = shows.concat(part.shows || []);
            lists = lists.concat(part.lists || []);
            errors = errors.concat(part.errors || []);
        }
        return {
            movies: sortByTitle(movies),
            shows: sortByTitle(shows),
            lists: sortByTitle(lists),
            errors: errors,
        };
    }

    /**
     * @param {{ soft?: boolean }} [options]
     * soft=true: keep previous media/ready while fetching so open editors do not
     * wipe lists and freeze the tab (esp. after background sync).
     */
    async function load(options) {
        options = options || {};
        let soft = !!options.soft;
        if (state.loading) {
            // Wait for in-flight load
            while (state.loading) {
                await new Promise((r) => setTimeout(r, 50));
            }
            // Hard load already finished with current snapshot
            if (!soft) {
                return state;
            }
            // Soft (post-sync): always re-fetch so we do not keep pre-sync data
        }
        state.loading = true;
        state.error = null;
        if (!soft) {
            state.ready = false;
            notify();
        }
        // soft: do not notify(loading) — avoids section-spinner storms on open modals
        try {
            let plexServers = await dizquetv.getPlexServers().catch(() => []);
            let jfServers = await dizquetv.getJellyfinServers().catch(() => []);
            state.plexServers = plexServers || [];
            state.jellyfinServers = jfServers || [];

            let plexJobs = state.plexServers.map((s) => fetchPlexServer(s));
            let jfJobs = state.jellyfinServers.map((s) => fetchJellyfinServer(s));
            // Content-sources catalog for Plex/Jellyfin only — custom shows are never session-cached
            let contentSourcesJob = dizquetv.getContentSourceCatalog()
                .then((catalog) => catalog || { lists: [], shows: [], customShows: [], warnings: [] })
                .catch((err) => {
                    console.error(err);
                    return {
                        lists: [],
                        shows: [],
                        customShows: [],
                        warnings: ['Unable to load content sources from cache.'],
                    };
                });

            let allJobs = plexJobs.concat(jfJobs).concat([contentSourcesJob]);
            let allResults = await Promise.all(allJobs);
            let contentSourceCatalog = allResults.pop() || { lists: [], shows: [], customShows: [], warnings: [] };
            let plexResults = allResults.slice(0, plexJobs.length);
            let jfResults = allResults.slice(plexJobs.length);

            // Strip custom shows from session cache — callers must load them live
            state.contentSourceCatalog = {
                lists: contentSourceCatalog.lists || [],
                shows: contentSourceCatalog.shows || [],
                customShows: [],
                warnings: contentSourceCatalog.warnings || [],
                servers: contentSourceCatalog.servers,
                fromCache: contentSourceCatalog.fromCache,
            };
            state.mediaPlex = mergeResults(plexResults);
            state.mediaJellyfin = mergeResults(jfResults);
            state.mediaAll = mergeResults(plexResults.concat(jfResults));
            state.ready = true;
        } catch (err) {
            console.error(err);
            state.error = 'Failed to preload programming library.';
            // Soft: keep previous media if any so UI does not blank out
            if (!soft || !state.mediaAll) {
                state.mediaAll = { movies: [], shows: [], lists: [], errors: [state.error] };
                state.mediaPlex = state.mediaAll;
                state.mediaJellyfin = state.mediaAll;
                state.contentSourceCatalog = {
                    lists: [],
                    shows: [],
                    customShows: [],
                    warnings: [state.error],
                };
            }
            state.ready = true; // still unblock editor
        } finally {
            state.loading = false;
            notify();
        }
        return state;
    }

    return {
        /**
         * Force a fresh load (library resync, cache delete, or manual refresh).
         */
        reload: async () => {
            state.ready = false;
            state.contentSourceCatalog = null;
            notify();
            return load({ soft: false });
        },
        /**
         * Mark session cache stale. Next ensureLoaded() will re-fetch.
         * Call after library sync / delete.
         */
        invalidate: () => {
            state.ready = false;
            state.contentSourceCatalog = null;
            state.mediaAll = null;
            state.mediaPlex = null;
            state.mediaJellyfin = null;
            notify();
        },
        /**
         * After invalidate, warm cache again in the background (non-blocking for UI).
         * Prefer softReload after sync — this hard path blanks open editors.
         */
        invalidateAndReload: () => {
            state.ready = false;
            state.contentSourceCatalog = null;
            state.mediaAll = null;
            state.mediaPlex = null;
            state.mediaJellyfin = null;
            notify();
            // Fire and forget
            load({ soft: false }).catch((e) => console.error(e));
        },
        /**
         * Refresh session catalog in the background without blanking open UI.
         * Use after library sync so tab-return does not freeze/restart the page.
         */
        softReload: () => {
            load({ soft: true }).catch((e) => console.error(e));
        },
        /** Return current state; load only if not ready. */
        ensureLoaded: async () => {
            if (state.ready && !state.loading) {
                return state;
            }
            return load({ soft: false });
        },
        /**
         * Subscribe to ready/loading changes. Callback fires immediately with current snapshot.
         * Returns an unsubscribe function.
         */
        subscribe: (fn) => {
            if (typeof fn !== 'function') {
                return () => {};
            }
            listeners.push(fn);
            try {
                fn(snapshot());
            } catch (err) {
                console.error(err);
            }
            return () => {
                listeners = listeners.filter((f) => f !== fn);
            };
        },
        /** Resolves when the session catalog is ready (starts load if needed). */
        whenReady: async () => {
            if (state.ready && !state.loading) {
                return state;
            }
            return load({ soft: false });
        },
        getState: () => state,
        getMedia: (filter) => {
            if (filter === 'plex') return state.mediaPlex;
            if (filter === 'jellyfin') return state.mediaJellyfin;
            return state.mediaAll;
        },
        /**
         * Always fetch custom shows live from the API (never from session cache).
         */
        fetchCustomShowsLive: async () => {
            try {
                let list = await dizquetv.getAllShowsInfo();
                return sortByTitle(list || []);
            } catch (err) {
                console.error(err);
                return [];
            }
        },
        /**
         * Always fetch tracked lists (Library → Lists) live — never session-cached.
         * Returns summary rows suitable for folding into Playlists/Lists/Custom/Collections.
         */
        fetchTrackedListsLive: async () => {
            try {
                let list = await dizquetv.getTrackedLists();
                return sortByTitle(
                    (list || []).map((row) => ({
                        title: row.name || row.listNameFromSource || 'List',
                        name: row.name || row.listNameFromSource || 'List',
                        id: row.id,
                        key: row.id,
                        type: 'external-list',
                        trackedListId: row.id,
                        provider: row.provider || null,
                        count:
                            row.matchedCount != null
                                ? row.matchedCount
                                : row.itemCount != null
                                  ? row.itemCount
                                  : null,
                        mediaSource: 'list',
                        source: 'list',
                        serverType: 'list',
                        serverName: '',
                    }))
                );
            } catch (err) {
                console.error(err);
                return [];
            }
        },
        getContentSourceCatalog: () => state.contentSourceCatalog,
        getServers: () => ({
            plexServers: state.plexServers || [],
            jellyfinServers: state.jellyfinServers || [],
        }),
        isReady: () => !!state.ready,
        isLoading: () => !!state.loading,
        getSnapshot: () => snapshot(),
        clear: () => {
            state.ready = false;
            state.loading = false;
            state.error = null;
            state.mediaAll = null;
            state.mediaPlex = null;
            state.mediaJellyfin = null;
            state.contentSourceCatalog = null;
            state.plexServers = [];
            state.jellyfinServers = [];
            notify();
        },
    };
};
