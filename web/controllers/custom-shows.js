module.exports = function ($scope, $timeout, dizquetv, plex) {
    $scope.shows = []
    $scope.showShowConfig = false
    $scope.selectedShow = null
    $scope.selectedShowIndex = -1
    $scope.refreshing = false
    $scope.refreshStatus = ""
    $scope.refreshErrors = []

    $scope.refreshShow = async () => {
        $scope.shows = [ { id: '?', pending: true} ]
        $timeout();
        let shows = await dizquetv.getAllShowsInfo();
        shows.sort( (a,b) => {
            return a.name > b.name;
        } );

        $scope.shows = shows;
        $timeout();
    }
    $scope.refreshShow();

    
    
    let feedToShowConfig = () => {};
    let feedToDeleteShow = feedToShowConfig;

    $scope.registerShowConfig = (feed) => {
        feedToShowConfig = feed;
    }

    $scope.registerDeleteShow = (feed) => {
        feedToDeleteShow = feed;
    }

    $scope.queryChannel = async (index, channel) => {
        let ch = await dizquetv.getChannelDescription(channel.number);
        ch.pending = false;
        $scope.shows[index] = ch;
        $scope.$apply();
    }

    $scope.onShowConfigDone = async (show) => {
        if ($scope.selectedChannelIndex != -1) {
            $scope.shows[ $scope.selectedChannelIndex ].pending = false;
        }
        if (typeof show !== 'undefined') {
            // not canceled
            try {
                if ($scope.selectedChannelIndex == -1) { // add new show
                    await dizquetv.createShow(show);
                } else {
                    $scope.shows[ $scope.selectedChannelIndex ].pending = true;
                    await dizquetv.updateShow(show.id, show);
                }
            } catch (err) {
                console.error('Could not save custom show', err);
                let msg =
                    (err && err.data && (err.data.error || err.data.message))
                    || (err && err.message)
                    || 'Failed to save custom show';
                alert(msg);
            }
            await $scope.refreshShow();
        }
    }
    $scope.selectShow = async (index) => {
        try {
            if ( (index != -1) && $scope.shows[index].pending) {
                return;
            }
            $scope.selectedChannelIndex = index;
            if (index === -1) {
                feedToShowConfig();
            } else {
                $scope.shows[index].pending = true;
                let f = await dizquetv.getShow($scope.shows[index].id);
                feedToShowConfig(f);
                $timeout();
            }
        } catch( err ) {
            console.error("Could not fetch show.", err);
        }
    }

    $scope.deleteShow = async (index) => {
        try {
            if ( $scope.shows[index].pending) {
                return;
            }
            let show = $scope.shows[index];
            if (confirm("Are you sure to delete show: " + show.name + "? This will NOT delete the show's programs from channels that are using.")) {
                show.pending = true;
                await dizquetv.deleteShow(show.id);
                $timeout();
                await $scope.refreshShow();
                $timeout();
            }

        } catch (err) {
            console.error("Could not delete show.", err);
        }

    }

    function normalizeName(s) {
        return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
    }

    /** Match custom show name to playlist or collection title (case-insensitive). */
    function namesMatch(showName, plexTitle) {
        let a = normalizeName(showName);
        let b = normalizeName(plexTitle);
        if (!a || !b) {
            return false;
        }
        if (a === b) {
            return true;
        }
        // "My Shows Collection" matches custom show "My Shows"
        let stripCollection = (n) => {
            if (n.length > 11 && n.slice(-11) === " collection") {
                return n.slice(0, -11).trim();
            }
            return n;
        };
        return stripCollection(a) === stripCollection(b);
    }

    function dedupePrograms(programs) {
        let seen = {};
        let out = [];
        for (let i = 0; i < programs.length; i++) {
            let p = programs[i];
            let id = (p.serverKey || "") + "|" + (p.ratingKey || p.key || p.plexFile || p.title + "|" + p.duration);
            if (seen[id]) {
                continue;
            }
            seen[id] = true;
            out.push(p);
        }
        return out;
    }

    /**
     * Refresh all custom shows from Plex playlists/collections with matching names.
     * If both a playlist and a collection match, content from both is imported.
     */
    $scope.refreshFromPlex = async () => {
        if ($scope.refreshing) {
            return;
        }
        $scope.refreshing = true;
        $scope.refreshStatus = "Loading Plex servers...";
        $scope.refreshErrors = [];
        $timeout();

        try {
            let servers = await dizquetv.getPlexServers();
            if (!servers || servers.length === 0) {
                $scope.refreshErrors.push("No Plex servers configured. Add one under Settings.");
                $scope.refreshStatus = "";
                return;
            }

            $scope.refreshStatus = "Loading playlists and collections...";
            $timeout();

            // Build catalog of playlists + collections across all servers
            let catalog = []; // { server, kind, title, item }
            for (let s = 0; s < servers.length; s++) {
                let server = servers[s];
                try {
                    let playlists = await plex.getPlaylists(server);
                    for (let i = 0; i < playlists.length; i++) {
                        let p = playlists[i];
                        p.type = "playlist";
                        catalog.push({
                            server: server,
                            kind: "playlist",
                            title: p.title,
                            item: p,
                        });
                    }
                } catch (err) {
                    console.error(err);
                    $scope.refreshErrors.push("Failed to load playlists from " + server.name);
                }
                try {
                    let collections = await plex.getCollections(server);
                    for (let i = 0; i < collections.length; i++) {
                        let c = collections[i];
                        catalog.push({
                            server: server,
                            kind: "collection",
                            title: c.title,
                            item: c,
                        });
                    }
                } catch (err) {
                    console.error(err);
                    $scope.refreshErrors.push("Failed to load collections from " + server.name);
                }
            }

            let showsInfo = await dizquetv.getAllShowsInfo();
            if (!showsInfo || showsInfo.length === 0) {
                $scope.refreshStatus = "No custom shows to refresh.";
                return;
            }

            let updated = 0;
            let skipped = 0;
            let emptyMatch = 0;

            for (let i = 0; i < showsInfo.length; i++) {
                let info = showsInfo[i];
                $scope.refreshStatus = `Refreshing "${info.name}" (${i + 1}/${showsInfo.length})...`;
                // Mark row pending in list if present
                for (let r = 0; r < $scope.shows.length; r++) {
                    if ($scope.shows[r].id === info.id) {
                        $scope.shows[r].pending = true;
                    }
                }
                $timeout();

                let matches = catalog.filter((c) => namesMatch(info.name, c.title));
                if (matches.length === 0) {
                    skipped++;
                    for (let r = 0; r < $scope.shows.length; r++) {
                        if ($scope.shows[r].id === info.id) {
                            $scope.shows[r].pending = false;
                        }
                    }
                    continue;
                }

                let errors = [];
                let programs = [];
                // Prefer playlists first, then collections (both imported when present)
                matches.sort((a, b) => {
                    if (a.kind === b.kind) {
                        return 0;
                    }
                    return a.kind === "playlist" ? -1 : 1;
                });

                for (let m = 0; m < matches.length; m++) {
                    let match = matches[m];
                    try {
                        let more = await plex.expandToPrograms(match.server, match.item, errors);
                        programs = programs.concat(more || []);
                    } catch (err) {
                        console.error(err);
                        $scope.refreshErrors.push(
                            `Failed to import ${match.kind} "${match.title}" for show "${info.name}".`
                        );
                    }
                }
                if (errors.length > 0) {
                    $scope.refreshErrors = $scope.refreshErrors.concat(errors);
                }

                programs = dedupePrograms(programs);
                for (let p = 0; p < programs.length; p++) {
                    programs[p].commercials = [];
                }

                if (programs.length === 0) {
                    emptyMatch++;
                    $scope.refreshErrors.push(
                        `"${info.name}" matched ${matches.length} playlist/collection(s) but no playable items were found.`
                    );
                    for (let r = 0; r < $scope.shows.length; r++) {
                        if ($scope.shows[r].id === info.id) {
                            $scope.shows[r].pending = false;
                        }
                    }
                    continue;
                }

                try {
                    let full = await dizquetv.getShow(info.id);
                    full.content = programs;
                    full.name = info.name;
                    await dizquetv.updateShow(info.id, full);
                    updated++;
                } catch (err) {
                    console.error(err);
                    $scope.refreshErrors.push(`Failed to save custom show "${info.name}".`);
                }

                for (let r = 0; r < $scope.shows.length; r++) {
                    if ($scope.shows[r].id === info.id) {
                        $scope.shows[r].pending = false;
                    }
                }
            }

            await $scope.refreshShow();
            $scope.refreshStatus =
                `Done. Updated ${updated} show(s)` +
                (skipped ? `, ${skipped} with no matching playlist/collection` : "") +
                (emptyMatch ? `, ${emptyMatch} matched but empty` : "") +
                ".";
        } catch (err) {
            console.error(err);
            $scope.refreshErrors.push("Refresh failed unexpectedly.");
            $scope.refreshStatus = "";
        } finally {
            $scope.refreshing = false;
            $timeout();
        }
    }

}
