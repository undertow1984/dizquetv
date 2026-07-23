module.exports = function ($scope, $timeout, dizquetv, plex, jellyfin, libraryCatalogPreload) {
    $scope.showManagement = false;
    $scope.managementLoading = false;
    $scope.managementSaving = false;
    $scope.managementError = "";
    $scope.managementStatus = "";
    $scope.managementLibraries = []; // { source, serverName, sectionKey, title, type, enabled, ... }

    $scope.autoSyncHours = 0;
    $scope.jellyfinAutoSyncHours = 0;
    $scope.lastGlobalSyncAt = null;
    $scope.jellyfinLastGlobalSyncAt = null;
    $scope.librarySync = {}; // merged plex+jellyfin keyed by libKey()
    $scope.syncingKeys = [];
    $scope.syncBusy = false;
    $scope.syncAllRunning = false;

    $scope.formatSyncTime = (ts) => {
        if (!ts) {
            return 'Never';
        }
        try {
            let d = new Date(Number(ts));
            if (isNaN(d.getTime())) {
                return String(ts);
            }
            return d.toLocaleString();
        } catch (e) {
            return String(ts);
        }
    };

    function libKey(lib) {
        return String(lib.source || 'plex') + '|' + String(lib.serverName) + '|' + String(lib.sectionKey);
    }

    function rawSyncKey(lib) {
        // Backend uses serverName|sectionKey without source prefix
        return String(lib.serverName) + '|' + String(lib.sectionKey);
    }

    function applySyncMetaToRows() {
        let syncMap = $scope.librarySync || {};
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            let lib = $scope.managementLibraries[i];
            // Prefer source-prefixed key only (avoids Plex status showing on Jellyfin rows)
            let meta = syncMap[libKey(lib)] || {};
            lib.lastFullSyncAt = meta.lastFullSyncAt || null;
            lib.lastSyncAt = meta.lastSyncAt || null;
            lib.itemCount = typeof meta.itemCount === 'number' ? meta.itemCount : null;
            lib.collectionCount = typeof meta.collectionCount === 'number' ? meta.collectionCount : null;
            lib.syncStatus = meta.status || 'idle';
            lib.syncError = meta.error || null;
            lib.lastMode = meta.lastMode || null;
            lib.progress = typeof meta.progress === 'number' ? meta.progress : (meta.status === 'syncing' ? 0 : null);
            lib.progressPhase = meta.progressPhase || '';
            lib.progressDetail = meta.progressDetail || '';
        }
    }

    function mergeSyncMaps(plexMap, jfMap) {
        let out = {};
        plexMap = plexMap || {};
        jfMap = jfMap || {};
        // Always prefix by source so Plex/Jellyfin never clobber each other
        // (raw server|section keys collide when both have similarly keyed libs).
        Object.keys(plexMap).forEach((k) => {
            out['plex|' + k] = Object.assign({ source: 'plex' }, plexMap[k]);
        });
        Object.keys(jfMap).forEach((k) => {
            out['jellyfin|' + k] = Object.assign({ source: 'jellyfin' }, jfMap[k]);
        });
        return out;
    }

    async function refreshBothStatuses() {
        let plexSt = null;
        let jfSt = null;
        try { plexSt = await dizquetv.getPlexLibraryCacheStatus(); } catch (e) { /* ignore */ }
        try { jfSt = await dizquetv.getJellyfinLibraryCacheStatus(); } catch (e) { /* ignore */ }
        if (plexSt) {
            $scope.autoSyncHours = plexSt.autoSyncHours || 0;
            $scope.lastGlobalSyncAt = plexSt.lastGlobalSyncAt || null;
        }
        if (jfSt) {
            $scope.jellyfinAutoSyncHours = jfSt.autoSyncHours || 0;
            $scope.jellyfinLastGlobalSyncAt = jfSt.lastGlobalSyncAt || null;
        }
        $scope.librarySync = mergeSyncMaps(
            plexSt && plexSt.librarySync,
            jfSt && jfSt.librarySync
        );
        let syncing = [];
        if (plexSt && plexSt.syncing) {
            for (let i = 0; i < plexSt.syncing.length; i++) syncing.push('plex|' + plexSt.syncing[i]);
        }
        if (jfSt && jfSt.syncing) {
            for (let i = 0; i < jfSt.syncing.length; i++) syncing.push('jellyfin|' + jfSt.syncing[i]);
        }
        $scope.syncingKeys = syncing;
        applySyncMetaToRows();
    }

    let _progressPoll = null;
    let _progressVisHandler = null;
    function startProgressPoll() {
        stopProgressPoll();
        let tick = async () => {
            // Background tabs throttle timers heavily; skip work until visible to avoid a
            // stampede of digests / freezes when the user returns to the tab.
            if (typeof document !== 'undefined' && document.hidden) {
                return;
            }
            try {
                await refreshBothStatuses();
                $timeout();
            } catch (e) { /* ignore */ }
        };
        _progressPoll = setInterval(tick, 1500);
        // One immediate refresh when the tab becomes visible again (catch up after throttle)
        if (typeof document !== 'undefined') {
            _progressVisHandler = () => {
                if (!document.hidden) {
                    tick();
                }
            };
            document.addEventListener('visibilitychange', _progressVisHandler);
        }
    }
    function stopProgressPoll() {
        if (_progressPoll) {
            clearInterval(_progressPoll);
            _progressPoll = null;
        }
        if (_progressVisHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', _progressVisHandler);
            _progressVisHandler = null;
        }
    }

    /**
     * After a library sync, refresh the in-browser catalog without freezing the UI.
     * Waits until the tab is visible, then soft-reloads once (debounced).
     */
    let _catalogRefreshTimer = null;
    let _catalogVisHandler = null;
    function scheduleCatalogRefresh() {
        if (
            typeof libraryCatalogPreload.softReload !== 'function'
            && typeof libraryCatalogPreload.invalidateAndReload !== 'function'
        ) {
            return;
        }
        if (_catalogRefreshTimer) {
            clearTimeout(_catalogRefreshTimer);
            _catalogRefreshTimer = null;
        }
        if (_catalogVisHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', _catalogVisHandler);
            _catalogVisHandler = null;
        }
        let run = () => {
            _catalogRefreshTimer = null;
            try {
                // Soft reload keeps previous data until new data is ready (no ready=false storm)
                if (typeof libraryCatalogPreload.softReload === 'function') {
                    libraryCatalogPreload.softReload();
                } else {
                    libraryCatalogPreload.invalidateAndReload();
                }
            } catch (e) {
                console.error(e);
            }
        };
        if (typeof document !== 'undefined' && document.hidden) {
            _catalogVisHandler = () => {
                if (!document.hidden) {
                    document.removeEventListener('visibilitychange', _catalogVisHandler);
                    _catalogVisHandler = null;
                    _catalogRefreshTimer = setTimeout(run, 800);
                }
            };
            document.addEventListener('visibilitychange', _catalogVisHandler);
        } else {
            _catalogRefreshTimer = setTimeout(run, 400);
        }
    }

    $scope.openManagement = () => {
        $scope.showManagement = true;
        $scope.loadManagementLibraries();
    };

    $scope.closeManagement = () => {
        $scope.showManagement = false;
        $scope.managementStatus = "";
        $scope.managementError = "";
        stopProgressPoll();
    };

    $scope.loadManagementLibraries = async () => {
        $scope.managementLoading = true;
        $scope.managementError = "";
        $scope.managementStatus = "";
        $scope.managementLibraries = [];
        $timeout();
        try {
            let plexServers = await dizquetv.getPlexServers().catch(() => []);
            let jfServers = await dizquetv.getJellyfinServers().catch(() => []);
            if ((!plexServers || plexServers.length === 0) && (!jfServers || jfServers.length === 0)) {
                $scope.managementError = "No Plex or Jellyfin servers configured. Add one under Settings.";
                return;
            }

            let plexSettings = await dizquetv.getPlexLibrarySettings().catch(() => ({}));
            let jfSettings = await dizquetv.getJellyfinLibrarySettings().catch(() => ({}));

            $scope.autoSyncHours = (plexSettings && typeof plexSettings.autoSyncHours === 'number')
                ? plexSettings.autoSyncHours : 0;
            $scope.jellyfinAutoSyncHours = (jfSettings && typeof jfSettings.autoSyncHours === 'number')
                ? jfSettings.autoSyncHours : 0;
            $scope.lastGlobalSyncAt = (plexSettings && plexSettings.lastGlobalSyncAt) || null;
            $scope.jellyfinLastGlobalSyncAt = (jfSettings && jfSettings.lastGlobalSyncAt) || null;

            $scope.librarySync = mergeSyncMaps(
                plexSettings && plexSettings.librarySync,
                jfSettings && jfSettings.librarySync
            );

            function refSet(settings, field) {
                let set = {};
                let list = (settings && settings[field]) ? settings[field] : [];
                for (let i = 0; i < list.length; i++) {
                    if (list[i].serverName && list[i].sectionKey) {
                        set[list[i].serverName + "|" + list[i].sectionKey] = true;
                    }
                }
                return set;
            }
            let plexDisabled = refSet(plexSettings, 'disabledLibraries');
            let jfDisabled = refSet(jfSettings, 'disabledLibraries');
            let plexFiller = refSet(plexSettings, 'fillerLibraries');
            let jfFiller = refSet(jfSettings, 'fillerLibraries');
            let plexHidden = refSet(plexSettings, 'hiddenLibraries');
            let jfHidden = refSet(jfSettings, 'hiddenLibraries');

            let rows = [];

            for (let s = 0; s < (plexServers || []).length; s++) {
                let server = plexServers[s];
                try {
                    let libs = await plex.getLibrary(server, { includeDisabled: true, preferLive: true });
                    for (let i = 0; i < libs.length; i++) {
                        let lib = libs[i];
                        let id = server.name + "|" + lib.sectionKey;
                        rows.push({
                            source: 'plex',
                            serverName: server.name,
                            sectionKey: lib.sectionKey,
                            title: lib.title,
                            type: lib.type,
                            icon: lib.icon,
                            enabled: !plexDisabled[id],
                            containsFiller: !!plexFiller[id],
                            hideContent: !!plexHidden[id],
                        });
                    }
                } catch (err) {
                    console.error(err);
                    $scope.managementError =
                        ($scope.managementError ? $scope.managementError + " " : "") +
                        "Failed to load Plex libraries from " + server.name + ".";
                }
            }

            for (let s = 0; s < (jfServers || []).length; s++) {
                let server = jfServers[s];
                try {
                    let libs = await jellyfin.getLibrary(server, { includeDisabled: true, preferLive: true });
                    for (let i = 0; i < libs.length; i++) {
                        let lib = libs[i];
                        let id = server.name + "|" + lib.sectionKey;
                        rows.push({
                            source: 'jellyfin',
                            serverName: server.name,
                            sectionKey: lib.sectionKey,
                            title: lib.title,
                            type: lib.type,
                            icon: lib.icon,
                            enabled: !jfDisabled[id],
                            containsFiller: !!jfFiller[id],
                            hideContent: !!jfHidden[id],
                        });
                    }
                } catch (err) {
                    console.error(err);
                    $scope.managementError =
                        ($scope.managementError ? $scope.managementError + " " : "") +
                        "Failed to load Jellyfin libraries from " + server.name + ".";
                }
            }

            rows.sort((a, b) => {
                let sa = (a.source + " " + a.serverName + " " + a.title).toLowerCase();
                let sb = (b.source + " " + b.serverName + " " + b.title).toLowerCase();
                if (sa < sb) return -1;
                if (sa > sb) return 1;
                return 0;
            });
            $scope.managementLibraries = rows;
            applySyncMetaToRows();
        } catch (err) {
            console.error(err);
            $scope.managementError = "Unable to load library management data.";
        } finally {
            $scope.managementLoading = false;
            $timeout();
        }
    };

    $scope.toggleLibrary = async (lib) => {
        await $scope.saveManagementSettings();
    };

    $scope.toggleContainsFiller = async (lib) => {
        await $scope.saveManagementSettings();
    };

    $scope.toggleHideContent = async (lib) => {
        await $scope.saveManagementSettings();
    };

    $scope.enableAllLibraries = async () => {
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            $scope.managementLibraries[i].enabled = true;
        }
        await $scope.saveManagementSettings();
    };

    $scope.disableAllLibraries = async () => {
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            $scope.managementLibraries[i].enabled = false;
        }
        await $scope.saveManagementSettings();
    };

    function collectDisabled(source) {
        let disabled = [];
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            let lib = $scope.managementLibraries[i];
            if ((lib.source || 'plex') !== source) continue;
            if (!lib.enabled) {
                disabled.push({
                    serverName: lib.serverName,
                    sectionKey: String(lib.sectionKey),
                    title: lib.title,
                    type: lib.type,
                });
            }
        }
        return disabled;
    }

    function collectFillerLibraries(source) {
        let filler = [];
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            let lib = $scope.managementLibraries[i];
            if ((lib.source || 'plex') !== source) continue;
            if (lib.containsFiller) {
                filler.push({
                    serverName: lib.serverName,
                    sectionKey: String(lib.sectionKey),
                    title: lib.title,
                    type: lib.type,
                });
            }
        }
        return filler;
    }

    function collectHiddenLibraries(source) {
        let hidden = [];
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            let lib = $scope.managementLibraries[i];
            if ((lib.source || 'plex') !== source) continue;
            if (lib.hideContent) {
                hidden.push({
                    serverName: lib.serverName,
                    sectionKey: String(lib.sectionKey),
                    title: lib.title,
                    type: lib.type,
                });
            }
        }
        return hidden;
    }

    $scope.saveManagementSettings = async () => {
        if ($scope.managementSaving) {
            return;
        }
        $scope.managementSaving = true;
        $scope.managementError = "";
        $timeout();
        try {
            let plexDisabled = collectDisabled('plex');
            let jfDisabled = collectDisabled('jellyfin');
            let plexFiller = collectFillerLibraries('plex');
            let jfFiller = collectFillerLibraries('jellyfin');
            let plexHidden = collectHiddenLibraries('plex');
            let jfHidden = collectHiddenLibraries('jellyfin');
            let plexSaved = await dizquetv.updatePlexLibrarySettings({
                disabledLibraries: plexDisabled,
                fillerLibraries: plexFiller,
                hiddenLibraries: plexHidden,
                autoSyncHours: $scope.autoSyncHours,
            }).catch(() => null);
            let jfSaved = await dizquetv.updateJellyfinLibrarySettings({
                disabledLibraries: jfDisabled,
                fillerLibraries: jfFiller,
                hiddenLibraries: jfHidden,
                autoSyncHours: $scope.jellyfinAutoSyncHours,
            }).catch(() => null);
            if (plexSaved) {
                $scope.autoSyncHours = plexSaved.autoSyncHours || 0;
                $scope.lastGlobalSyncAt = plexSaved.lastGlobalSyncAt || null;
            }
            if (jfSaved) {
                $scope.jellyfinAutoSyncHours = jfSaved.autoSyncHours || 0;
                $scope.jellyfinLastGlobalSyncAt = jfSaved.lastGlobalSyncAt || null;
            }
            await refreshBothStatuses();
            if (typeof plex.clearLibrarySettingsCache === 'function') {
                plex.clearLibrarySettingsCache();
            }
            if (typeof jellyfin.clearLibrarySettingsCache === 'function') {
                jellyfin.clearLibrarySettingsCache();
            }
            // Refresh session catalog so programming UI drops/shows hidden content immediately
            scheduleCatalogRefresh();
            let enabledCount = $scope.managementLibraries.filter((l) => l.enabled).length;
            let disabledCount = $scope.managementLibraries.length - enabledCount;
            let fillerCount = $scope.managementLibraries.filter((l) => l.containsFiller).length;
            let hiddenCount = $scope.managementLibraries.filter((l) => l.hideContent).length;
            $scope.managementStatus =
                "Saved. " + enabledCount + " enabled, " + disabledCount + " disabled, " +
                fillerCount + " filler, " + hiddenCount + " hide content.";
        } catch (err) {
            console.error(err);
            $scope.managementError = "Failed to save library settings.";
        } finally {
            $scope.managementSaving = false;
            $timeout();
        }
    };

    $scope.saveAutoSyncHours = async () => {
        $scope.managementStatus = "Saving auto-sync intervals...";
        $timeout();
        try {
            await dizquetv.updatePlexLibrarySettings({
                disabledLibraries: collectDisabled('plex'),
                fillerLibraries: collectFillerLibraries('plex'),
                hiddenLibraries: collectHiddenLibraries('plex'),
                autoSyncHours: $scope.autoSyncHours,
            });
            await dizquetv.updateJellyfinLibrarySettings({
                disabledLibraries: collectDisabled('jellyfin'),
                fillerLibraries: collectFillerLibraries('jellyfin'),
                hiddenLibraries: collectHiddenLibraries('jellyfin'),
                autoSyncHours: $scope.jellyfinAutoSyncHours,
            });
            $scope.managementStatus = "Auto re-sync intervals saved.";
        } catch (err) {
            console.error(err);
            $scope.managementError = "Failed to save auto-sync interval.";
        } finally {
            $timeout();
        }
    };

    $scope.syncOneLibrary = async (lib, full) => {
        if (!lib || !lib.enabled || $scope.syncBusy) {
            return;
        }
        $scope.syncBusy = true;
        lib.syncStatus = 'syncing';
        lib.progress = 0;
        lib.progressDetail = 'Starting…';
        lib.syncError = null;
        $scope.managementStatus =
            (full ? 'Full' : 'Incremental') + ' sync: ' + lib.source + ' / ' + lib.serverName + ' / ' + lib.title + '...';
        $scope.managementError = "";
        startProgressPoll();
        $timeout();
        try {
            let result;
            if (lib.source === 'jellyfin') {
                result = await dizquetv.syncJellyfinLibrary(lib.serverName, lib.sectionKey, { full: !!full });
            } else {
                result = await dizquetv.syncPlexLibrary(lib.serverName, lib.sectionKey, { full: !!full });
            }
            if (result && result.ok) {
                if (result.status) {
                    $scope.librarySync[libKey(lib)] = Object.assign(
                        { source: lib.source || 'plex' },
                        result.status
                    );
                }
                applySyncMetaToRows();
                let r = result.result || {};
                $scope.managementStatus =
                    'Synced ' + (lib.source || 'plex') + ' / ' + lib.title +
                    ' — ' + (r.itemCount != null ? r.itemCount : '?') + ' items' +
                    (r.collectionCount != null ? (', ' + r.collectionCount + ' collections') : '') +
                    (r.mode ? ' (' + r.mode + ')' : '') +
                    (r.added || r.updated || r.removed
                        ? (' +' + (r.added || 0) + ' ~' + (r.updated || 0) + ' -' + (r.removed || 0))
                        : '');
            } else {
                lib.syncStatus = 'error';
                lib.syncError = (result && result.error) ? result.error : 'Sync failed';
                $scope.managementError = (lib.source || 'plex') + ': ' + lib.syncError;
            }
        } catch (err) {
            console.error(err);
            lib.syncStatus = 'error';
            lib.syncError = (err && err.data && (err.data.error || err.data.message))
                || (err && err.message)
                || 'Sync failed';
            $scope.managementError = (lib.source || 'plex') + ': ' + lib.syncError;
        } finally {
            stopProgressPoll();
            $scope.syncBusy = false;
            if (lib.syncStatus === 'syncing') {
                lib.syncStatus = 'idle';
            }
            try { await refreshBothStatuses(); } catch (e) { /* ignore */ }
            // Defer catalog warm so returning to a backgrounded tab does not freeze
            scheduleCatalogRefresh();
            $timeout();
        }
    };

    $scope.syncAllLibraries = async (full) => {
        if ($scope.syncBusy) {
            return;
        }
        $scope.syncBusy = true;
        $scope.syncAllRunning = true;
        $scope.managementError = "";
        $scope.managementStatus = full
            ? "Full sync of all enabled libraries (this may take a while)..."
            : "Syncing all enabled libraries (incremental when possible)...";
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            if ($scope.managementLibraries[i].enabled) {
                $scope.managementLibraries[i].syncStatus = 'syncing';
                $scope.managementLibraries[i].progress = 0;
            }
        }
        startProgressPoll();
        $timeout();
        try {
            let hasPlex = $scope.managementLibraries.some((l) => l.enabled && l.source === 'plex');
            let hasJf = $scope.managementLibraries.some((l) => l.enabled && l.source === 'jellyfin');
            // Run sources independently so a Plex failure never skips Jellyfin (and vice versa)
            let parts = [];
            let errors = [];
            if (hasPlex) {
                $scope.managementStatus = (full ? 'Full' : 'Incremental') + ' sync: Plex…';
                $timeout();
                try {
                    let plexResult = await dizquetv.syncAllPlexLibraries({ full: !!full });
                    if (plexResult && plexResult.ok === false) {
                        errors.push('Plex: ' + (plexResult.error || 'sync all failed'));
                    } else {
                        parts.push('Plex ok');
                    }
                } catch (plexErr) {
                    console.error(plexErr);
                    errors.push(
                        'Plex: ' +
                        ((plexErr && plexErr.data && (plexErr.data.error || plexErr.data.message))
                            || (plexErr && plexErr.message)
                            || 'sync all failed')
                    );
                }
                try { await refreshBothStatuses(); } catch (e) { /* ignore */ }
                $timeout();
            }
            if (hasJf) {
                $scope.managementStatus = (full ? 'Full' : 'Incremental') + ' sync: Jellyfin…';
                $timeout();
                try {
                    let jfResult = await dizquetv.syncAllJellyfinLibraries({ full: !!full });
                    if (jfResult && jfResult.ok === false) {
                        errors.push('Jellyfin: ' + (jfResult.error || 'sync all failed'));
                    } else {
                        // Surface per-library failures from results array
                        let failed = [];
                        if (jfResult && Array.isArray(jfResult.results)) {
                            for (let i = 0; i < jfResult.results.length; i++) {
                                let r = jfResult.results[i];
                                if (r && r.ok === false) {
                                    failed.push(r.error || r.serverName || 'library failed');
                                }
                            }
                        }
                        if (failed.length) {
                            parts.push('Jellyfin partial');
                            errors.push('Jellyfin: ' + failed.slice(0, 3).join('; ') + (failed.length > 3 ? '…' : ''));
                        } else {
                            parts.push('Jellyfin ok');
                        }
                    }
                } catch (jfErr) {
                    console.error(jfErr);
                    errors.push(
                        'Jellyfin: ' +
                        ((jfErr && jfErr.data && (jfErr.data.error || jfErr.data.message))
                            || (jfErr && jfErr.message)
                            || 'sync all failed')
                    );
                }
                try { await refreshBothStatuses(); } catch (e) { /* ignore */ }
                $timeout();
            }
            await refreshBothStatuses();
            if (parts.length) {
                $scope.managementStatus = 'Sync all finished (' + parts.join(', ') + ').';
            } else if (!hasPlex && !hasJf) {
                $scope.managementStatus = 'No enabled libraries to sync.';
            } else {
                $scope.managementStatus = 'Sync all finished with errors.';
            }
            if (errors.length) {
                $scope.managementError = errors.join(' · ');
            }
            if (typeof plex.clearLibrarySettingsCache === 'function') {
                plex.clearLibrarySettingsCache();
            }
            if (typeof jellyfin.clearLibrarySettingsCache === 'function') {
                jellyfin.clearLibrarySettingsCache();
            }
            scheduleCatalogRefresh();
        } catch (err) {
            console.error(err);
            $scope.managementError =
                (err && err.data && (err.data.error || err.data.message))
                || (err && err.message)
                || "Sync all failed.";
        } finally {
            stopProgressPoll();
            $scope.syncBusy = false;
            $scope.syncAllRunning = false;
            try { await refreshBothStatuses(); } catch (e2) { /* ignore */ }
            $timeout();
        }
    };

    $scope.deleteOneLibraryCache = async (lib) => {
        if (!lib || $scope.syncBusy) {
            return;
        }
        let msg =
            'Delete local cache for "' + lib.title + '" on ' + lib.serverName +
            ' (' + (lib.source || 'plex') + ')?\n\n' +
            'Cached items for this library will be removed. You can re-sync later.';
        if (!confirm(msg)) {
            return;
        }
        $scope.managementError = "";
        $scope.managementStatus = 'Deleting cache for ' + lib.title + '...';
        $timeout();
        try {
            let result;
            if (lib.source === 'jellyfin') {
                result = await dizquetv.deleteJellyfinLibraryCache(lib.serverName, lib.sectionKey);
            } else {
                result = await dizquetv.deletePlexLibraryCache(lib.serverName, lib.sectionKey);
            }
            if (result && result.ok !== false) {
                await refreshBothStatuses();
                $scope.managementStatus = 'Cache deleted for ' + lib.title + '.';
                scheduleCatalogRefresh();
            } else {
                $scope.managementError = (result && result.error) || 'Delete failed';
            }
        } catch (err) {
            console.error(err);
            $scope.managementError = (err && err.data && err.data.error) || (err && err.message) || 'Delete failed';
        } finally {
            $timeout();
        }
    };

    $scope.deleteAllLibraryCache = async () => {
        if ($scope.syncBusy) {
            return;
        }
        let msg =
            'Delete ALL local library cache (Plex and Jellyfin)?\n\n' +
            'This removes all cached movies, shows, collections, and playlists. ' +
            'You can re-sync later. This cannot be undone.';
        if (!confirm(msg)) {
            return;
        }
        $scope.managementError = "";
        $scope.managementStatus = 'Deleting all library cache...';
        $timeout();
        try {
            await dizquetv.deleteAllPlexLibraryCache().catch(() => null);
            await dizquetv.deleteAllJellyfinLibraryCache().catch(() => null);
            await refreshBothStatuses();
            $scope.managementStatus = 'All library cache deleted.';
            if (typeof plex.clearLibrarySettingsCache === 'function') {
                plex.clearLibrarySettingsCache();
            }
            if (typeof jellyfin.clearLibrarySettingsCache === 'function') {
                jellyfin.clearLibrarySettingsCache();
            }
            scheduleCatalogRefresh();
        } catch (err) {
            console.error(err);
            $scope.managementError = (err && err.message) || 'Delete all failed';
        } finally {
            $timeout();
        }
    };
};
