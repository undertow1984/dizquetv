module.exports = function ($scope, $timeout, dizquetv) {
    $scope.lists = [];
    $scope.loading = false;
    $scope.busy = false;
    $scope.error = '';
    $scope.status = '';

    $scope.showAdd = false;
    $scope.form = emptyForm();
    $scope.selected = null;
    $scope.edit = null;
    $scope.detailLoading = false;
    $scope.hasPlex = false;
    $scope.hasJellyfin = false;
    /** @type {{ serverName: string, sectionKey: string, title: string, label: string, type: string }[]} */
    $scope.plexLibraries = [];

    function emptyForm() {
        return {
            name: '',
            url: '',
            text: '',
            /** radio: true = Yes, false = No */
            createChannel: true,
            saveAsCustomShow: false,
            pushToPlex: false,
            pushToJellyfin: false,
            /** "serverName|sectionKey" — Movies library */
            plexMovieLibraryRef: '',
            /** "serverName|sectionKey" — TV library */
            plexTvLibraryRef: '',
        };
    }

    function plexLibraryRefValue(serverName, sectionKey) {
        if (!serverName || sectionKey == null || sectionKey === '') return '';
        return String(serverName) + '|' + String(sectionKey);
    }

    function parsePlexLibraryRef(ref) {
        ref = String(ref || '');
        let i = ref.indexOf('|');
        if (i < 0) {
            return { serverName: null, sectionKey: null, libraryTitle: null };
        }
        let serverName = ref.slice(0, i);
        let sectionKey = ref.slice(i + 1);
        let title = null;
        for (let j = 0; j < $scope.plexLibraries.length; j++) {
            let lib = $scope.plexLibraries[j];
            if (lib.serverName === serverName && String(lib.sectionKey) === String(sectionKey)) {
                title = lib.title;
                break;
            }
        }
        return {
            serverName: serverName || null,
            sectionKey: sectionKey || null,
            libraryTitle: title,
        };
    }

    function plexMovieLibraries() {
        return ($scope.plexLibraries || []).filter((l) => !l.type || l.type === 'movie');
    }
    function plexTvLibraries() {
        return ($scope.plexLibraries || []).filter((l) => l.type === 'show');
    }
    $scope.plexMovieLibraries = plexMovieLibraries;
    $scope.plexTvLibraries = plexTvLibraries;

    function plexFieldsFromForm(form) {
        form = form || {};
        let movie = parsePlexLibraryRef(form.plexMovieLibraryRef);
        let tv = parsePlexLibraryRef(form.plexTvLibraryRef);
        return {
            plexMovieServerName: movie.serverName,
            plexMovieSectionKey: movie.sectionKey,
            plexMovieLibraryTitle: movie.libraryTitle,
            plexMovieLibraryRef: form.plexMovieLibraryRef || '',
            plexTvServerName: tv.serverName,
            plexTvSectionKey: tv.sectionKey,
            plexTvLibraryTitle: tv.libraryTitle,
            plexTvLibraryRef: form.plexTvLibraryRef || '',
            // legacy aliases
            plexServerName: movie.serverName,
            plexSectionKey: movie.sectionKey,
            plexLibraryTitle: movie.libraryTitle,
        };
    }

    function formatTime(ts) {
        if (!ts) return 'Never';
        try {
            let d = new Date(Number(ts));
            if (isNaN(d.getTime())) return String(ts);
            return d.toLocaleString();
        } catch (e) {
            return String(ts);
        }
    }
    $scope.formatTime = formatTime;

    $scope.refreshList = async () => {
        // While a save/match is in progress, keep the section visible under the busy overlay
        // instead of blanking the page with the initial loader.
        let quiet = !!$scope.busy;
        if (!quiet) {
            $scope.loading = true;
        }
        $scope.error = '';
        $timeout();
        try {
            let lists = await dizquetv.getTrackedLists();
            $scope.lists = lists || [];
        } catch (err) {
            console.error(err);
            $scope.error = 'Failed to load lists.';
            $scope.lists = [];
        } finally {
            if (!quiet) {
                $scope.loading = false;
            }
            $timeout();
        }
    };

    $scope.loadServers = async () => {
        try {
            let plex = await dizquetv.getPlexServers().catch(() => []);
            let jf = await dizquetv.getJellyfinServers().catch(() => []);
            $scope.hasPlex = !!(plex && plex.length);
            $scope.hasJellyfin = !!(jf && jf.length);
            try {
                let pl = await dizquetv.getTrackedListPlexLibraries();
                $scope.plexLibraries = (pl && pl.libraries) || [];
                if (typeof pl.hasPlex === 'boolean') $scope.hasPlex = pl.hasPlex;
                if (typeof pl.hasJellyfin === 'boolean') $scope.hasJellyfin = pl.hasJellyfin;
            } catch (e2) {
                $scope.plexLibraries = [];
            }
        } catch (e) {
            $scope.hasPlex = false;
            $scope.hasJellyfin = false;
            $scope.plexLibraries = [];
        }
        $timeout();
    };

    $scope.openAdd = () => {
        $scope.showAdd = true;
        $scope.form = emptyForm();
        $scope.form.pushToPlex = false;
        $scope.form.pushToJellyfin = false;
        let movies = plexMovieLibraries();
        let tvs = plexTvLibraries();
        $scope.form.plexMovieLibraryRef =
            movies.length === 1
                ? plexLibraryRefValue(movies[0].serverName, movies[0].sectionKey)
                : '';
        $scope.form.plexTvLibraryRef =
            tvs.length === 1
                ? plexLibraryRefValue(tvs[0].serverName, tvs[0].sectionKey)
                : '';
        $scope.error = '';
        $scope.status = '';
        $scope.selected = null;
        $scope.edit = null;
    };

    $scope.closeAdd = () => {
        if ($scope.busy) return;
        $scope.showAdd = false;
        $scope.form = emptyForm();
    };

    $scope.addList = async () => {
        if ($scope.busy) return;
        let name = ($scope.form.name || '').trim();
        let url = ($scope.form.url || '').trim();
        let text = ($scope.form.text || '').trim();
        if (!name) {
            $scope.error = 'Name is required.';
            return;
        }
        if (!url && !text) {
            $scope.error = 'Enter a Letterboxd or Trakt list URL and/or paste titles.';
            return;
        }
        let pushToPlex = !!$scope.form.pushToPlex && $scope.hasPlex;
        if (
            pushToPlex
            && !($scope.form.plexMovieLibraryRef || '').trim()
            && !($scope.form.plexTvLibraryRef || '').trim()
        ) {
            $scope.error = 'Select a Plex Movies and/or TV library for the playlist.';
            return;
        }
        let plexFields = pushToPlex ? plexFieldsFromForm($scope.form) : {};
        $scope.busy = true;
        $scope.error = '';
        $scope.status = 'Fetching list and matching against library cache…';
        $timeout();
        try {
            let created = await dizquetv.createTrackedList(Object.assign({
                name: name,
                url: url,
                text: text,
                createChannel: $scope.form.createChannel === true,
                saveAsCustomShow: $scope.form.saveAsCustomShow === true,
                pushToPlex: pushToPlex,
                pushToJellyfin: !!$scope.form.pushToJellyfin && $scope.hasJellyfin,
            }, plexFields));
            $scope.status =
                'Added “' + name + '” — matched ' +
                (created.matchedCount || 0) + ' of ' + (created.itemCount || 0) +
                (created.channelNumber != null ? ' · channel #' + created.channelNumber : '') +
                (created.customShowId ? ' · custom show' : '') +
                '.';
            $scope.showAdd = false;
            $scope.form = emptyForm();
            await $scope.refreshList();
            if (created && created.id) {
                await $scope.selectList(created.id, { force: true });
            }
        } catch (err) {
            console.error(err);
            $scope.error =
                (err && err.data && err.data.error)
                || (err && err.message)
                || 'Failed to add list.';
            $scope.status = '';
        } finally {
            $scope.busy = false;
            $timeout();
        }
    };

    $scope.selectList = async (id, opts) => {
        // Block user clicks while processing; allow internal reloads (opts.force).
        if ($scope.busy && !(opts && opts.force)) return;
        $scope.detailLoading = true;
        $scope.error = '';
        $timeout();
        try {
            $scope.selected = await dizquetv.getTrackedList(id);
            $scope.edit = {
                name: ($scope.selected && $scope.selected.name) || '',
                url: ($scope.selected && $scope.selected.url) || '',
                text: ($scope.selected && $scope.selected.text) || '',
                channelNumber:
                    $scope.selected && $scope.selected.channelNumber != null
                        ? $scope.selected.channelNumber
                        : null,
                createChannel: !!(
                    $scope.selected
                    && ($scope.selected.createChannel || $scope.selected.channelNumber != null)
                ),
                saveAsCustomShow: !!( $scope.selected && $scope.selected.saveAsCustomShow ),
                pushToPlex: !!( $scope.selected && $scope.selected.pushToPlex ),
                pushToJellyfin: !!( $scope.selected && $scope.selected.pushToJellyfin ),
                plexMovieLibraryRef: plexLibraryRefValue(
                    $scope.selected && ($scope.selected.plexMovieServerName || $scope.selected.plexServerName),
                    $scope.selected && ($scope.selected.plexMovieSectionKey || $scope.selected.plexSectionKey)
                ),
                plexTvLibraryRef: plexLibraryRefValue(
                    $scope.selected && $scope.selected.plexTvServerName,
                    $scope.selected && $scope.selected.plexTvSectionKey
                ),
            };
        } catch (err) {
            console.error(err);
            $scope.error = 'Failed to load list detail.';
            $scope.selected = null;
            $scope.edit = null;
        } finally {
            $scope.detailLoading = false;
            $timeout();
        }
    };

    /**
     * Save list name, channel number, and media-playlist push flags.
     * Server keeps linked channel in sync; playlist push runs on next refresh
     * (and immediately if push flags were just enabled).
     */
    $scope.saveListIdentity = async () => {
        if (!$scope.selected || $scope.busy) return;
        let name = ($scope.edit && $scope.edit.name ? String($scope.edit.name) : '').trim();
        if (!name) {
            $scope.error = 'Name is required.';
            return;
        }
        let channelNumber = $scope.edit ? $scope.edit.channelNumber : null;
        if (channelNumber === '' || typeof channelNumber === 'undefined') {
            channelNumber = null;
        } else if (channelNumber != null) {
            channelNumber = parseInt(channelNumber, 10);
            if (isNaN(channelNumber) || channelNumber < 1) {
                $scope.error = 'Channel number must be a positive integer (or empty to unlink).';
                return;
            }
        }
        let pushToPlex = !!( $scope.edit && $scope.edit.pushToPlex && $scope.hasPlex );
        let pushToJellyfin = !!( $scope.edit && $scope.edit.pushToJellyfin && $scope.hasJellyfin );
        if (
            pushToPlex
            && !($scope.edit.plexMovieLibraryRef || '').trim()
            && !($scope.edit.plexTvLibraryRef || '').trim()
        ) {
            $scope.error = 'Select a Plex Movies and/or TV library for the playlist.';
            return;
        }
        let plexFields = pushToPlex ? plexFieldsFromForm($scope.edit) : {
            plexMovieServerName: null,
            plexMovieSectionKey: null,
            plexMovieLibraryTitle: null,
            plexTvServerName: null,
            plexTvSectionKey: null,
            plexTvLibraryTitle: null,
            plexServerName: null,
            plexSectionKey: null,
            plexLibraryTitle: null,
        };
        let nowPush = pushToPlex || pushToJellyfin;
        let url = ($scope.edit && $scope.edit.url ? String($scope.edit.url) : '').trim();
        let text = $scope.edit && typeof $scope.edit.text === 'string' ? $scope.edit.text : '';
        let prevUrl = ($scope.selected.url || '').trim();
        let prevText = $scope.selected.text || '';
        let sourceChanged = url !== prevUrl || text !== prevText;

        $scope.busy = true;
        $scope.error = '';
        $scope.status = 'Saving list / channel settings…';
        $timeout();
        try {
            let createChannel = $scope.edit.createChannel === true;
            let saveAsCustomShow = $scope.edit.saveAsCustomShow === true;
            let needRefresh =
                nowPush
                || saveAsCustomShow
                || sourceChanged
                || (createChannel && channelNumber == null);

            let updated = await dizquetv.updateTrackedList(
                $scope.selected.id,
                Object.assign(
                    {
                        name: name,
                        url: url,
                        text: text,
                        channelNumber: channelNumber,
                        createChannel: createChannel,
                        saveAsCustomShow: saveAsCustomShow,
                        pushToPlex: pushToPlex,
                        pushToJellyfin: pushToJellyfin,
                    },
                    plexFields
                )
            );
            // Refresh to re-match (if source changed) and/or update channel / playlists
            if (needRefresh) {
                $scope.status = sourceChanged
                    ? 'Re-matching list and updating channel / playlists…'
                    : 'Updating channel / custom show / playlists…';
                $timeout();
                updated = await dizquetv.refreshTrackedList(updated.id, {
                    syncChannel: true,
                    createChannel: createChannel && (updated.channelNumber == null),
                    saveAsCustomShow: saveAsCustomShow,
                });
            }
            $scope.selected = updated;
            $scope.edit = {
                name: updated.name,
                url: updated.url || '',
                text: updated.text || '',
                channelNumber: updated.channelNumber != null ? updated.channelNumber : null,
                createChannel: !!(updated.createChannel || updated.channelNumber != null),
                saveAsCustomShow: !!updated.saveAsCustomShow,
                pushToPlex: !!updated.pushToPlex,
                pushToJellyfin: !!updated.pushToJellyfin,
                plexMovieLibraryRef: plexLibraryRefValue(
                    updated.plexMovieServerName || updated.plexServerName,
                    updated.plexMovieSectionKey || updated.plexSectionKey
                ),
                plexTvLibraryRef: plexLibraryRefValue(
                    updated.plexTvServerName,
                    updated.plexTvSectionKey
                ),
            };
            let plexStatus = '';
            if (updated.pushToPlex) {
                let bits = [];
                if (updated.plexMovieLibraryTitle || updated.plexMovieSectionKey || updated.plexLibraryTitle) {
                    bits.push(
                        'Movies: ' +
                        (updated.plexMovieLibraryTitle || updated.plexLibraryTitle || updated.plexMovieSectionKey)
                    );
                }
                if (updated.plexTvLibraryTitle || updated.plexTvSectionKey) {
                    bits.push('TV: ' + (updated.plexTvLibraryTitle || updated.plexTvSectionKey));
                }
                plexStatus = bits.length ? ' · Plex ' + bits.join(', ') : ' · Plex playlist';
            }
            $scope.status =
                'Saved “' + updated.name + '”' +
                (updated.channelNumber != null ? ' · channel #' + updated.channelNumber : '') +
                (updated.customShowId ? ' · custom show' : '') +
                plexStatus +
                (updated.pushToJellyfin ? ' · Jellyfin playlist' : '') +
                (sourceChanged ? ' · re-matched' : '') +
                '.';
            await $scope.refreshList();
        } catch (err) {
            console.error(err);
            $scope.error =
                (err && err.data && err.data.error)
                || (err && err.message)
                || 'Save failed.';
            $scope.status = '';
        } finally {
            $scope.busy = false;
            $timeout();
        }
    };

    $scope.refreshOne = async (list) => {
        if (!list || $scope.busy) return;
        $scope.busy = true;
        $scope.error = '';
        $scope.status = 'Refreshing “' + list.name + '”…';
        $timeout();
        try {
            let r = await dizquetv.refreshTrackedList(list.id, {
                syncChannel: true,
                createChannel: list.channelNumber == null ? false : false,
            });
            $scope.status =
                'Refreshed “' + list.name + '” — ' +
                (r.matchedCount || 0) + ' matched' +
                (r.channelNumber != null ? ' · channel #' + r.channelNumber : '') +
                '.';
            await $scope.refreshList();
            if ($scope.selected && $scope.selected.id === list.id) {
                await $scope.selectList(list.id, { force: true });
            }
        } catch (err) {
            console.error(err);
            $scope.error =
                (err && err.data && err.data.error)
                || (err && err.message)
                || 'Refresh failed.';
            $scope.status = '';
            await $scope.refreshList();
        } finally {
            $scope.busy = false;
            $timeout();
        }
    };

    $scope.createChannelForList = async (list) => {
        if (!list || $scope.busy) return;
        $scope.busy = true;
        $scope.error = '';
        $scope.status = 'Creating channel for “' + list.name + '”…';
        $timeout();
        try {
            let r = await dizquetv.refreshTrackedList(list.id, {
                createChannel: true,
                syncChannel: true,
            });
            $scope.status =
                'Channel #' + r.channelNumber + ' ready for “' + list.name +
                '” (' + (r.matchedCount || 0) + ' programs).';
            await $scope.refreshList();
            if ($scope.selected && $scope.selected.id === list.id) {
                await $scope.selectList(list.id, { force: true });
            }
        } catch (err) {
            console.error(err);
            $scope.error =
                (err && err.data && err.data.error)
                || (err && err.message)
                || 'Channel create failed.';
            $scope.status = '';
        } finally {
            $scope.busy = false;
            $timeout();
        }
    };

    $scope.refreshAll = async () => {
        if ($scope.busy) return;
        if (!$scope.lists.length) return;
        $scope.busy = true;
        $scope.error = '';
        $scope.status = 'Refreshing all lists…';
        $timeout();
        try {
            let r = await dizquetv.refreshAllTrackedLists({ syncChannel: true });
            let ok = 0;
            let fail = 0;
            let results = (r && r.results) || [];
            for (let i = 0; i < results.length; i++) {
                if (results[i].ok) ok++;
                else fail++;
            }
            $scope.status = 'Refresh all done — ' + ok + ' ok' + (fail ? ', ' + fail + ' failed' : '') + '.';
            await $scope.refreshList();
            if ($scope.selected) {
                await $scope.selectList($scope.selected.id, { force: true });
            }
        } catch (err) {
            console.error(err);
            $scope.error = 'Refresh all failed.';
            $scope.status = '';
        } finally {
            $scope.busy = false;
            $timeout();
        }
    };

    $scope.deleteList = async (list) => {
        if (!list || $scope.busy) return;
        let msg =
            'Delete tracked list “' + list.name + '”?\n\n' +
            'The list tracking entry is removed. Linked channels are not deleted.';
        if (!confirm(msg)) return;
        $scope.busy = true;
        $timeout();
        try {
            await dizquetv.deleteTrackedList(list.id);
            if ($scope.selected && $scope.selected.id === list.id) {
                $scope.selected = null;
            }
            $scope.status = 'Deleted “' + list.name + '”.';
            await $scope.refreshList();
        } catch (err) {
            console.error(err);
            $scope.error = 'Delete failed.';
        } finally {
            $scope.busy = false;
            $timeout();
        }
    };

    $scope.refreshList();
    $scope.loadServers();
};
