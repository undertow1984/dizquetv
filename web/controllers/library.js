module.exports = function ($scope, $timeout, dizquetv, plex) {
    $scope.showManagement = false;
    $scope.managementLoading = false;
    $scope.managementSaving = false;
    $scope.managementError = "";
    $scope.managementStatus = "";
    $scope.managementLibraries = []; // { serverName, sectionKey, title, type, enabled, lastFullSyncAt, ... }

    $scope.autoSyncHours = 0;
    $scope.lastGlobalSyncAt = null;
    $scope.librarySync = {};
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
        return String(lib.serverName) + '|' + String(lib.sectionKey);
    }

    function applySyncMetaToRows() {
        let syncMap = $scope.librarySync || {};
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            let lib = $scope.managementLibraries[i];
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

    let _progressPoll = null;
    function startProgressPoll() {
        stopProgressPoll();
        _progressPoll = setInterval(async () => {
            try {
                let st = await dizquetv.getPlexLibraryCacheStatus();
                if (st) {
                    $scope.librarySync = st.librarySync || {};
                    $scope.lastGlobalSyncAt = st.lastGlobalSyncAt || $scope.lastGlobalSyncAt;
                    $scope.syncingKeys = st.syncing || [];
                    applySyncMetaToRows();
                    $timeout();
                }
            } catch (e) { /* ignore */ }
        }, 800);
    }
    function stopProgressPoll() {
        if (_progressPoll) {
            clearInterval(_progressPoll);
            _progressPoll = null;
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
    };

    $scope.loadManagementLibraries = async () => {
        $scope.managementLoading = true;
        $scope.managementError = "";
        $scope.managementStatus = "";
        $scope.managementLibraries = [];
        $timeout();
        try {
            let servers = await dizquetv.getPlexServers();
            if (!servers || servers.length === 0) {
                $scope.managementError = "No Plex servers configured. Add one under Settings.";
                return;
            }
            let settings = await dizquetv.getPlexLibrarySettings();
            $scope.autoSyncHours = (settings && typeof settings.autoSyncHours === 'number')
                ? settings.autoSyncHours
                : 0;
            $scope.lastGlobalSyncAt = (settings && settings.lastGlobalSyncAt) || null;
            $scope.librarySync = (settings && settings.librarySync) || {};
            $scope.syncingKeys = (settings && settings.syncing) || [];

            let disabled = {};
            let list = (settings && settings.disabledLibraries) ? settings.disabledLibraries : [];
            for (let i = 0; i < list.length; i++) {
                if (list[i].serverName && list[i].sectionKey) {
                    disabled[list[i].serverName + "|" + list[i].sectionKey] = true;
                }
            }

            let rows = [];
            for (let s = 0; s < servers.length; s++) {
                let server = servers[s];
                try {
                    // Live Plex list so newly added sections appear before first cache sync
                    let libs = await plex.getLibrary(server, { includeDisabled: true, preferLive: true });
                    for (let i = 0; i < libs.length; i++) {
                        let lib = libs[i];
                        let id = server.name + "|" + lib.sectionKey;
                        rows.push({
                            serverName: server.name,
                            sectionKey: lib.sectionKey,
                            title: lib.title,
                            type: lib.type,
                            icon: lib.icon,
                            enabled: !disabled[id],
                        });
                    }
                } catch (err) {
                    console.error(err);
                    $scope.managementError =
                        ($scope.managementError ? $scope.managementError + " " : "") +
                        "Failed to load libraries from " + server.name + ".";
                }
            }
            rows.sort((a, b) => {
                let sa = (a.serverName + " " + a.title).toLowerCase();
                let sb = (b.serverName + " " + b.title).toLowerCase();
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
        // ng-model already flipped enabled; persist immediately
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

    $scope.saveManagementSettings = async () => {
        if ($scope.managementSaving) {
            return;
        }
        $scope.managementSaving = true;
        $scope.managementError = "";
        $timeout();
        try {
            let disabled = [];
            for (let i = 0; i < $scope.managementLibraries.length; i++) {
                let lib = $scope.managementLibraries[i];
                if (!lib.enabled) {
                    disabled.push({
                        serverName: lib.serverName,
                        sectionKey: String(lib.sectionKey),
                        title: lib.title,
                        type: lib.type,
                    });
                }
            }
            let saved = await dizquetv.updatePlexLibrarySettings({
                disabledLibraries: disabled,
                autoSyncHours: $scope.autoSyncHours,
            });
            if (saved) {
                $scope.autoSyncHours = saved.autoSyncHours || 0;
                $scope.lastGlobalSyncAt = saved.lastGlobalSyncAt || null;
                $scope.librarySync = saved.librarySync || {};
                $scope.syncingKeys = saved.syncing || [];
                applySyncMetaToRows();
            }
            if (typeof plex.clearLibrarySettingsCache === 'function') {
                plex.clearLibrarySettingsCache();
            }
            $scope.managementStatus =
                "Saved. " +
                ($scope.managementLibraries.length - disabled.length) +
                " enabled, " +
                disabled.length +
                " disabled.";
        } catch (err) {
            console.error(err);
            $scope.managementError = "Failed to save library settings.";
        } finally {
            $scope.managementSaving = false;
            $timeout();
        }
    };

    $scope.saveAutoSyncHours = async () => {
        $scope.managementStatus = "Saving auto-sync interval...";
        $timeout();
        try {
            // Preserve current disabled list
            let disabled = [];
            for (let i = 0; i < $scope.managementLibraries.length; i++) {
                let lib = $scope.managementLibraries[i];
                if (!lib.enabled) {
                    disabled.push({
                        serverName: lib.serverName,
                        sectionKey: String(lib.sectionKey),
                        title: lib.title,
                        type: lib.type,
                    });
                }
            }
            let saved = await dizquetv.updatePlexLibrarySettings({
                disabledLibraries: disabled,
                autoSyncHours: $scope.autoSyncHours,
            });
            if (saved) {
                $scope.autoSyncHours = saved.autoSyncHours || 0;
                $scope.lastGlobalSyncAt = saved.lastGlobalSyncAt || null;
                $scope.librarySync = saved.librarySync || {};
            }
            $scope.managementStatus =
                ($scope.autoSyncHours > 0)
                    ? ("Auto re-sync every " + $scope.autoSyncHours + " hour(s).")
                    : "Auto re-sync disabled.";
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
            (full ? 'Full' : 'Incremental') + ' sync: ' + lib.serverName + ' / ' + lib.title + '...';
        $scope.managementError = "";
        startProgressPoll();
        $timeout();
        try {
            let result = await dizquetv.syncPlexLibrary(lib.serverName, lib.sectionKey, { full: !!full });
            if (result && result.ok) {
                if (result.status) {
                    $scope.librarySync[libKey(lib)] = result.status;
                }
                applySyncMetaToRows();
                let r = result.result || {};
                $scope.managementStatus =
                    'Synced ' + lib.title +
                    ' — ' + (r.itemCount != null ? r.itemCount : '?') + ' items' +
                    (r.collectionCount != null ? (', ' + r.collectionCount + ' collections') : '') +
                    (r.mode ? ' (' + r.mode + ')' : '') +
                    (r.added || r.updated || r.removed
                        ? (' +' + (r.added || 0) + ' ~' + (r.updated || 0) + ' -' + (r.removed || 0))
                        : '');
            } else {
                lib.syncStatus = 'error';
                lib.syncError = (result && result.error) ? result.error : 'Sync failed';
                $scope.managementError = lib.syncError;
            }
        } catch (err) {
            console.error(err);
            lib.syncStatus = 'error';
            lib.syncError = (err && err.data && err.data.error) || (err && err.message) || 'Sync failed';
            $scope.managementError = lib.syncError;
        } finally {
            stopProgressPoll();
            $scope.syncBusy = false;
            if (lib.syncStatus === 'syncing') {
                lib.syncStatus = 'idle';
            }
            try {
                let st = await dizquetv.getPlexLibraryCacheStatus();
                if (st) {
                    $scope.librarySync = st.librarySync || {};
                    $scope.lastGlobalSyncAt = st.lastGlobalSyncAt || $scope.lastGlobalSyncAt;
                    $scope.syncingKeys = st.syncing || [];
                    applySyncMetaToRows();
                }
            } catch (e) { /* ignore */ }
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
        // Mark enabled libs as pending progress
        for (let i = 0; i < $scope.managementLibraries.length; i++) {
            if ($scope.managementLibraries[i].enabled) {
                $scope.managementLibraries[i].syncStatus = 'syncing';
                $scope.managementLibraries[i].progress = 0;
            }
        }
        startProgressPoll();
        $timeout();
        try {
            let result = await dizquetv.syncAllPlexLibraries({ full: !!full });
            if (result && result.status) {
                $scope.librarySync = result.status.librarySync || {};
                $scope.lastGlobalSyncAt = result.status.lastGlobalSyncAt || result.lastGlobalSyncAt || null;
                $scope.syncingKeys = result.status.syncing || [];
                applySyncMetaToRows();
            }
            $scope.managementStatus =
                "Sync all finished" +
                ($scope.lastGlobalSyncAt ? (" at " + $scope.formatSyncTime($scope.lastGlobalSyncAt)) : "") +
                ".";
            if (typeof plex.clearLibrarySettingsCache === 'function') {
                plex.clearLibrarySettingsCache();
            }
        } catch (err) {
            console.error(err);
            $scope.managementError =
                (err && err.data && err.data.error) || (err && err.message) || "Sync all failed.";
        } finally {
            stopProgressPoll();
            $scope.syncBusy = false;
            $scope.syncAllRunning = false;
            $timeout();
        }
    };

    $scope.deleteOneLibraryCache = async (lib) => {
        if (!lib || $scope.syncBusy) {
            return;
        }
        let msg =
            'Delete local cache for "' + lib.title + '" on ' + lib.serverName + '?\n\n' +
            'Movies, shows, episodes, collections, and related cache for this library will be removed. ' +
            'You can re-sync later.';
        if (!confirm(msg)) {
            return;
        }
        $scope.managementError = "";
        $scope.managementStatus = 'Deleting cache for ' + lib.title + '...';
        $timeout();
        try {
            let result = await dizquetv.deletePlexLibraryCache(lib.serverName, lib.sectionKey);
            if (result && result.ok) {
                if (result.status) {
                    $scope.librarySync = result.status.librarySync || {};
                    $scope.lastGlobalSyncAt = result.status.lastGlobalSyncAt || $scope.lastGlobalSyncAt;
                    $scope.syncingKeys = result.status.syncing || [];
                }
                applySyncMetaToRows();
                $scope.managementStatus = 'Cache deleted for ' + lib.title + '.';
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
            'Delete ALL local Plex library cache?\n\n' +
            'This removes cached movies, shows, episodes, collections, and playlists for every server. ' +
            'You will need to run Sync All again. This cannot be undone.';
        if (!confirm(msg)) {
            return;
        }
        // Second confirm for safety
        if (!confirm('Are you sure? Type OK mentally and press OK to permanently delete all cache.')) {
            return;
        }
        $scope.managementError = "";
        $scope.managementStatus = 'Deleting all library cache...';
        $timeout();
        try {
            let result = await dizquetv.deleteAllPlexLibraryCache();
            if (result && result.ok) {
                if (result.status) {
                    $scope.librarySync = result.status.librarySync || {};
                    $scope.lastGlobalSyncAt = result.status.lastGlobalSyncAt || null;
                    $scope.syncingKeys = result.status.syncing || [];
                } else {
                    $scope.librarySync = {};
                    $scope.lastGlobalSyncAt = null;
                }
                applySyncMetaToRows();
                $scope.managementStatus = 'All library cache deleted.';
            } else {
                $scope.managementError = (result && result.error) || 'Delete all failed';
            }
        } catch (err) {
            console.error(err);
            $scope.managementError = (err && err.data && err.data.error) || (err && err.message) || 'Delete all failed';
        } finally {
            $timeout();
        }
    };
};
