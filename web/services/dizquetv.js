module.exports = function ($http, $q) {
    return {
        getVersion: () => {
            return $http.get('/api/version').then((d) => { return d.data })
        },
        getPlexServers: () => {
            return $http.get('/api/plex-servers').then((d) => { return d.data })
        },
        getPlexLibrarySettings: () => {
            return $http.get('/api/plex-library-settings').then((d) => { return d.data })
        },
        updatePlexLibrarySettings: (settings) => {
            return $http({
                method: 'PUT',
                url: '/api/plex-library-settings',
                data: settings,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        getPlexLibraryCacheStatus: () => {
            return $http.get('/api/plex-library-cache/status').then((d) => { return d.data })
        },
        syncAllPlexLibraries: (opts) => {
            return $http({
                method: 'POST',
                url: '/api/plex-library-cache/sync-all',
                data: opts || {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 3600000,
            }).then((d) => { return d.data })
        },
        syncPlexLibrary: (serverName, sectionKey, opts) => {
            return $http({
                method: 'POST',
                url: '/api/plex-library-cache/sync-library',
                data: Object.assign({ serverName: serverName, sectionKey: sectionKey }, opts || {}),
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 3600000,
            }).then((d) => { return d.data })
        },
        deletePlexLibraryCache: (serverName, sectionKey) => {
            return $http({
                method: 'POST',
                url: '/api/plex-library-cache/delete-library',
                data: { serverName: serverName, sectionKey: sectionKey },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((d) => { return d.data })
        },
        deleteAllPlexLibraryCache: () => {
            return $http({
                method: 'POST',
                url: '/api/plex-library-cache/delete-all',
                data: {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((d) => { return d.data })
        },
        getPlexCacheSections: (serverName, includeDisabled, includeHidden) => {
            let qs = [];
            if (includeDisabled) qs.push('includeDisabled=1');
            if (includeHidden) qs.push('includeHidden=1');
            let q = qs.length ? ('?' + qs.join('&')) : '';
            return $http.get('/api/plex-library-cache/sections/' + encodeURIComponent(serverName) + q)
                .then((d) => { return d.data })
        },
        getPlexCachePlaylists: (serverName, includeHidden) => {
            let q = includeHidden ? '?includeHidden=1' : '';
            return $http.get('/api/plex-library-cache/playlists/' + encodeURIComponent(serverName) + q)
                .then((d) => { return d.data })
        },
        getPlexCacheCollections: (serverName, includeHidden) => {
            let q = includeHidden ? '?includeHidden=1' : '';
            return $http.get('/api/plex-library-cache/collections/' + encodeURIComponent(serverName) + q)
                .then((d) => { return d.data })
        },
        getPlexCacheShows: (serverName, includeHidden) => {
            let q = includeHidden ? '?includeHidden=1' : '';
            return $http.get('/api/plex-library-cache/shows/' + encodeURIComponent(serverName) + q)
                .then((d) => { return d.data })
        },
        getPlexCacheNested: (serverName, key, includeCollections) => {
            return $http({
                method: 'POST',
                url: '/api/plex-library-cache/nested',
                data: {
                    serverName: serverName,
                    key: key,
                    // undefined → server default (true); explicit false excludes collections
                    includeCollections: includeCollections,
                },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((d) => { return d.data })
        },
        addPlexServer: (plexServer) => {
            return $http({
                method: 'PUT',
                url: '/api/plex-servers',
                data: plexServer,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        updatePlexServer: (plexServer) => {
            return $http({
                method: 'POST',
                url: '/api/plex-servers',
                data: plexServer,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        checkExistingPlexServer: async (serverName) => {
            let d = await $http({
                method: 'POST',
                url: '/api/plex-servers/status',
                data: { name: serverName },
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            })
            return d.data;
        },
        checkNewPlexServer: async (server) => {
            let d = await $http({
                method: 'POST',
                url: '/api/plex-servers/foreignstatus',
                data: server,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            })
            return d.data;
        },
        removePlexServer: async (serverName) => {
            let d = await $http({
                method: 'DELETE',
                url: '/api/plex-servers',
                data: { name: serverName },
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
            return d.data;
        },

        // ---- Jellyfin servers ----
        getJellyfinSettings: () => {
            return $http.get('/api/jellyfin-settings').then((d) => { return d.data })
        },
        updateJellyfinSettings: (config) => {
            return $http({
                method: 'PUT',
                url: '/api/jellyfin-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        resetJellyfinSettings: (config) => {
            return $http({
                method: 'POST',
                url: '/api/jellyfin-settings',
                data: angular.toJson(config || {}),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        getJellyfinServers: () => {
            return $http.get('/api/jellyfin-servers').then((d) => { return d.data })
        },
        addJellyfinServer: (server) => {
            return $http({
                method: 'PUT',
                url: '/api/jellyfin-servers',
                data: server,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        updateJellyfinServer: (server) => {
            return $http({
                method: 'POST',
                url: '/api/jellyfin-servers',
                data: server,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        checkExistingJellyfinServer: async (serverName) => {
            let d = await $http({
                method: 'POST',
                url: '/api/jellyfin-servers/status',
                data: { name: serverName },
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            })
            return d.data;
        },
        checkNewJellyfinServer: async (server) => {
            let d = await $http({
                method: 'POST',
                url: '/api/jellyfin-servers/foreignstatus',
                data: server,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            })
            return d.data;
        },
        removeJellyfinServer: async (serverName) => {
            let d = await $http({
                method: 'DELETE',
                url: '/api/jellyfin-servers',
                data: { name: serverName },
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
            return d.data;
        },
        /**
         * Proxy a GET to the named Jellyfin server (avoids browser CORS).
         * path may contain {userId} which is filled from the server's resolved user.
         */
        jellyfinProxy: (serverName, path, params) => {
            return $http({
                method: 'POST',
                url: '/api/jellyfin-servers/proxy',
                data: {
                    name: serverName,
                    path: path,
                    params: params || {},
                },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 120000,
            }).then((d) => { return d.data })
        },
        getJellyfinLibrarySettings: () => {
            return $http.get('/api/jellyfin-library-settings').then((d) => { return d.data })
        },
        updateJellyfinLibrarySettings: (settings) => {
            return $http({
                method: 'PUT',
                url: '/api/jellyfin-library-settings',
                data: settings,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        getJellyfinLibraryCacheStatus: () => {
            return $http.get('/api/jellyfin-library-cache/status').then((d) => { return d.data })
        },
        syncAllJellyfinLibraries: (opts) => {
            return $http({
                method: 'POST',
                url: '/api/jellyfin-library-cache/sync-all',
                data: opts || {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 3600000,
            }).then((d) => { return d.data })
        },
        syncJellyfinLibrary: (serverName, sectionKey, opts) => {
            return $http({
                method: 'POST',
                url: '/api/jellyfin-library-cache/sync-library',
                data: Object.assign({ serverName: serverName, sectionKey: sectionKey }, opts || {}),
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 3600000,
            }).then((d) => { return d.data })
        },
        deleteJellyfinLibraryCache: (serverName, sectionKey) => {
            return $http({
                method: 'POST',
                url: '/api/jellyfin-library-cache/delete-library',
                data: { serverName: serverName, sectionKey: sectionKey },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((d) => { return d.data })
        },
        deleteAllJellyfinLibraryCache: () => {
            return $http({
                method: 'POST',
                url: '/api/jellyfin-library-cache/delete-all',
                data: {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((d) => { return d.data })
        },
        getJellyfinCacheSections: (serverName, includeDisabled, includeHidden) => {
            let qs = [];
            if (includeDisabled) qs.push('includeDisabled=1');
            if (includeHidden) qs.push('includeHidden=1');
            let q = qs.length ? ('?' + qs.join('&')) : '';
            return $http.get('/api/jellyfin-library-cache/sections/' + encodeURIComponent(serverName) + q)
                .then((d) => { return d.data })
        },
        getJellyfinCachePlaylists: (serverName, includeHidden) => {
            let q = includeHidden ? '?includeHidden=1' : '';
            return $http.get('/api/jellyfin-library-cache/playlists/' + encodeURIComponent(serverName) + q)
                .then((d) => { return d.data })
        },
        getJellyfinCacheCollections: (serverName, includeHidden) => {
            let q = includeHidden ? '?includeHidden=1' : '';
            return $http.get('/api/jellyfin-library-cache/collections/' + encodeURIComponent(serverName) + q)
                .then((d) => { return d.data })
        },
        getJellyfinCacheShows: (serverName, includeHidden) => {
            let q = includeHidden ? '?includeHidden=1' : '';
            return $http.get('/api/jellyfin-library-cache/shows/' + encodeURIComponent(serverName) + q)
                .then((d) => { return d.data })
        },
        getJellyfinCacheNested: (serverName, key, includeCollections) => {
            return $http({
                method: 'POST',
                url: '/api/jellyfin-library-cache/nested',
                data: {
                    serverName: serverName,
                    key: key,
                    includeCollections: includeCollections,
                },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((d) => { return d.data })
        },

        getPlexSettings: () => {
            return $http.get('/api/plex-settings').then((d) => { return d.data })
        },
        updatePlexSettings: (config) => {
            return $http({
                method: 'PUT',
                url: '/api/plex-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        resetPlexSettings: (config) => {
            return $http({
                method: 'POST',
                url: '/api/plex-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        getFfmpegSettings: () => {
            return $http.get('/api/ffmpeg-settings').then((d) => { return d.data })
        },
        updateFfmpegSettings: (config) => {
            return $http({
                method: 'PUT',
                url: '/api/ffmpeg-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        resetFfmpegSettings: (config) => {
            return $http({
                method: 'POST',
                url: '/api/ffmpeg-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        enableWatermarksOnAllChannels: () => {
            return $http({
                method: 'POST',
                url: '/api/channels/enable-watermarks',
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        getXmltvSettings: () => {
            return $http.get('/api/xmltv-settings').then((d) => { return d.data })
        },
        updateXmltvSettings: (config) => {
            return $http({
                method: 'PUT',
                url: '/api/xmltv-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        resetXmltvSettings: (config) => {
            return $http({
                method: 'POST',
                url: '/api/xmltv-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        getHdhrSettings: () => {
            return $http.get('/api/hdhr-settings').then((d) => { return d.data })
        },
        updateHdhrSettings: (config) => {
            return $http({
                method: 'PUT',
                url: '/api/hdhr-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        resetHdhrSettings: (config) => {
            return $http({
                method: 'POST',
                url: '/api/hdhr-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        getImagemagickSettings: () => {
            return $http.get('/api/imagemagick-settings').then((d) => { return d.data })
        },
        updateImagemagickSettings: (config) => {
            return $http({
                method: 'PUT',
                url: '/api/imagemagick-settings',
                data: angular.toJson(config),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        resetImagemagickSettings: (config) => {
            return $http({
                method: 'POST',
                url: '/api/imagemagick-settings',
                data: angular.toJson(config || {}),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        testImagemagickSettings: (config) => {
            return $http({
                method: 'POST',
                url: '/api/imagemagick-settings/test',
                data: angular.toJson(config || {}),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        getChannels: () => {
            return $http.get('/api/channels').then((d) => { return d.data })
        },

        getChannel: (number) => {
            return $http.get(`/api/channel/${number}`).then( (d) => { return d.data })
        },

        getChannelDescription: (number) => {
            return $http.get(`/api/channel/description/${number}`).then( (d) => { return d.data } )
        },

        getChannelProgramless: (number) => {
            return $http.get(`/api/channel/programless/${number}`).then( (d) => { return d.data })
        },
        getChannelPrograms: (number) => {
            return $http.get(`/api/channel/programs/${number}`).then( (d) => { return d.data } )
        },


        getChannelNumbers: () => {
            return $http.get('/api/channelNumbers').then( (d) => { return d.data } )
        },

        addChannel: (channel) => {
            return $http({
                method: 'POST',
                url: '/api/channel',
                data: angular.toJson(channel),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        uploadImage: (file) => {
            return $http({
                method: 'POST',
                url: '/api/upload/image',
                data: file,
                headers: { 'Content-Type': undefined }
            }).then((d) => { return d.data })
        },

        /**
         * Download config+images zip. Triggers a browser download.
         */
        exportConfigZip: () => {
            return $http({
                method: 'GET',
                url: '/api/config/export',
                responseType: 'arraybuffer',
                timeout: 600000,
            }).then((response) => {
                let disposition = response.headers('content-disposition') || '';
                let filename = 'dizquetv-config.zip';
                let match = /filename="?([^";]+)"?/i.exec(disposition);
                if (match && match[1]) {
                    filename = match[1];
                }
                let blob = new Blob([response.data], { type: 'application/zip' });
                let url = window.URL.createObjectURL(blob);
                let a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                return { filename: filename };
            });
        },

        /**
         * Upload a config zip. Server backs up current config then replaces config+images.
         * @param {File} file
         */
        importConfigZip: (file) => {
            let form = new FormData();
            form.append('file', file);
            return $http({
                method: 'POST',
                url: '/api/config/import',
                data: form,
                headers: { 'Content-Type': undefined },
                timeout: 600000,
            }).then((d) => { return d.data; });
        },
        addChannelWatermark: (file) => {
            return $http({
                method: 'POST',
                url: '/api/channel/watermark',
                data: file,
                headers: { 'Content-Type': undefined }
            }).then((d) => { return d.data })
        },
        updateChannel: (channel, options) => {
            options = options || {};
            let body = Object.assign({}, channel);
            if (typeof options.previousNumber !== 'undefined' && options.previousNumber != null) {
                body.previousNumber = options.previousNumber;
                body.originalNumber = options.previousNumber;
            }
            return $http({
                method: 'PUT',
                url: '/api/channel',
                data: angular.toJson(body),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },
        removeChannel: (channel) => {
            return $http({
                method: 'DELETE',
                url: '/api/channel',
                data: angular.toJson(channel),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }).then((d) => { return d.data })
        },

        /*======================================================================
        * Filler stuff
        */
        getAllFillersInfo: async () => {
            let f = await $http.get('/api/fillers');
            return f.data;
        },

        getFiller: async (id) => {
            let f = await $http.get(`/api/filler/${id}`);
            return f.data;
        },

        updateFiller: async(id, filler) => {
            return (await $http({
                method: "POST",
                url : `/api/filler/${id}`,
                data: angular.toJson(filler),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }) ).data;
        },

        createFiller: async(filler) => {
            return (await $http({
                method: "PUT",
                url : `/api/filler`,
                data: angular.toJson(filler),
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }) ).data;
        },

        deleteFiller: async(id) => {
            return ( await $http({
                method: "DELETE",
                url : `/api/filler/${id}`,
                data: {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }) ).data;
        },

        getChannelsUsingFiller: async(fillerId)  => {
            return (await $http.get( `/api/filler/${fillerId}/channels` )).data;
        },

        /**
         * Full content-sources catalog from local cache only (never hits Plex/Jellyfin live).
         * Used by channel Properties Content Sources and bulk import.
         */
        getContentSourceCatalog: async () => {
            let f = await $http.get('/api/content-sources/catalog');
            return f.data;
        },

        getExternalListSettings: () => {
            return $http.get('/api/external-lists/settings').then((d) => d.data);
        },
        updateExternalListSettings: (settings) => {
            return $http({
                method: 'PUT',
                url: '/api/external-lists/settings',
                data: settings || {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((d) => d.data);
        },
        /**
         * Resolve Trakt / Letterboxd list URL (or pasted CSV) against local library cache.
         * Body: { url?, text?, traktClientId? }
         */
        resolveExternalList: (body) => {
            return $http({
                method: 'POST',
                url: '/api/external-lists/resolve',
                data: body || {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 180000,
            }).then((d) => d.data);
        },

        getTrackedLists: () => {
            return $http.get('/api/tracked-lists').then((d) => d.data);
        },
        getTrackedListPlexLibraries: () => {
            return $http.get('/api/tracked-lists/plex-libraries').then((d) => d.data);
        },
        getTrackedList: (id) => {
            return $http.get('/api/tracked-lists/' + encodeURIComponent(id)).then((d) => d.data);
        },
        createTrackedList: (body) => {
            return $http({
                method: 'POST',
                url: '/api/tracked-lists',
                data: body || {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 180000,
            }).then((d) => d.data);
        },
        updateTrackedList: (id, body) => {
            return $http({
                method: 'PUT',
                url: '/api/tracked-lists/' + encodeURIComponent(id),
                data: body || {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((d) => d.data);
        },
        refreshTrackedList: (id, body) => {
            return $http({
                method: 'POST',
                url: '/api/tracked-lists/' + encodeURIComponent(id) + '/refresh',
                data: body || {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 180000,
            }).then((d) => d.data);
        },
        refreshAllTrackedLists: (body) => {
            return $http({
                method: 'POST',
                url: '/api/tracked-lists/refresh-all',
                data: body || {},
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 600000,
            }).then((d) => d.data);
        },
        deleteTrackedList: (id) => {
            return $http({
                method: 'DELETE',
                url: '/api/tracked-lists/' + encodeURIComponent(id),
            }).then((d) => d.data);
        },

        /*======================================================================
        * Custom Show stuff
        */
        getAllShowsInfo: async () => {
        let f = await $http.get('/api/shows');
            return f.data;
        },

        getShow: async (id) => {
            let f = await $http.get(`/api/show/${id}`);
            return f.data;
        },

        updateShow: async(id, show) => {
        return (await $http({
            method: "POST",
            url : `/api/show/${id}`,
            data: angular.toJson(show),
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }) ).data;
        },

        createShow: async(show) => {
        return (await $http({
            method: "PUT",
            url : `/api/show`,
            data: angular.toJson(show),
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }) ).data;
        },

        deleteShow: async(id) => {
        return ( await $http({
            method: "DELETE",
            url : `/api/show/${id}`,
            data: {},
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }) ).data;
        },


        /*======================================================================
        * TV Guide endpoints
        */
        getGuideStatus: async () => {
            let d = await $http( {
                method: 'GET',
                url : '/api/guide/status',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            } );
            return d.data;
        },

        getChannelLineup: async (channelNumber, dateFrom, dateTo) => {
            let a = dateFrom.toISOString();
            let b = dateTo.toISOString();
            let d = await $http( {
                method: 'GET',
                url : `/api/guide/channels/${channelNumber}?dateFrom=${a}&dateTo=${b}`,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            } );
            return d.data;
        },

        /*======================================================================
        * Channel Tool Services
        */
        calculateTimeSlots: async( programs, schedule) => {
            let d = await $http( {
                method: "POST",
                url : "/api/channel-tools/time-slots",
                data: {
                    programs: programs,
                    schedule: schedule,
                },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            } );
            return d.data;
        },

        calculateRandomSlots: async( programs, schedule) => {
            let d = await $http( {
                method: "POST",
                url : "/api/channel-tools/random-slots",
                data: {
                    programs: programs,
                    schedule: schedule,
                },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            } );
            return d.data;
        },

        /*======================================================================
        * Settings
        */
        getAllSettings: async () => {
            var deferred = $q.defer();
            $http({
                method: "GET",
                url : "/api/settings/cache",
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((response) => {
                if(response.status === 200) {
                    deferred.resolve(response.data);
                } else {
                    deferred.reject();
                }
            });

            return deferred.promise;
        },
        putSetting: async (key, value) => {
            console.warn(key, value);
            var deferred = $q.defer();
            $http({
                method: "PUT",
                url : `/api/settings/cache/${key}`,
                data: {
                    value
                },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }).then((response) => {
                if(response.status === 200) {
                    deferred.resolve(response.data);
                } else {
                    deferred.reject();
                }
            });

            return deferred.promise;
        }

    }
}