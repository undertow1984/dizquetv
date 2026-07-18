module.exports = function ($timeout, commonProgramTools, plex, dizquetv) {
    return {
        restrict: 'E',
        templateUrl: 'templates/show-config.html',
        replace: true,
        scope: {
            linker: "=linker",
            onDone: "=onDone"
        },
        link: function (scope, element, attrs) {
            scope.showTools = false;
            scope.showPlexLibrary = false;
            scope.content = [];
            scope.visible = false;
            scope.error = undefined;

            // Plex playlist import section state.
            // Keep selection on an object so ng-model works across ng-if/ng-show child scopes
            // (primitives get shadowed on the child scope and import would always see the first value).
            scope.plexServers = [];
            scope.playlists = [];
            scope.playlistImport = {
                serverName: null,
                key: null,
                pending: false,
                errors: [],
            };

            function getSelectedPlaylistServer() {
                if (!scope.playlistImport.serverName) {
                    return null;
                }
                for (let i = 0; i < scope.plexServers.length; i++) {
                    if (scope.plexServers[i].name === scope.playlistImport.serverName) {
                        return scope.plexServers[i];
                    }
                }
                return null;
            }

            function getSelectedPlaylist() {
                if (!scope.playlistImport.key) {
                    return null;
                }
                for (let i = 0; i < scope.playlists.length; i++) {
                    if (scope.playlists[i].key === scope.playlistImport.key) {
                        return scope.playlists[i];
                    }
                }
                return null;
            }

            function refreshContentIndexes() {
                for (let i = 0; i < scope.content.length; i++) {
                    scope.content[i].$index = i;
                }
            }

            scope.contentSplice = (a,b) => {
                scope.content.splice(a,b)
                refreshContentIndexes();
            }

            scope.dropFunction = (dropIndex, program) => {
                let y = program.$index;
                let z = dropIndex + scope.currentStartIndex - 1;
                scope.content.splice(y, 1);
                if (z >= y) {
                    z--;
                }
                scope.content.splice(z, 0, program );
                refreshContentIndexes();
                $timeout();
                return false;
            }
            scope.setUpWatcher = function setupWatchers() {
                this.$watch('vsRepeat.startIndex', function(val) {
                    scope.currentStartIndex = val;
                });
            };

            scope.movedFunction = (index) => {
                console.log("movedFunction(" + index + ")");
            }



            scope.linker( (show) => {
                if ( typeof(show) === 'undefined') {
                    scope.name = "";
                    scope.content = [];
                    scope.id = undefined;
                    scope.title = "Create Custom Show";
                } else {
                    scope.name = show.name;
                    scope.content = show.content;
                    scope.id = show.id;
                    scope.title = "Edit Custom Show";
                }
                scope.playlistImport.key = null;
                scope.playlistImport.errors = [];
                scope.playlists = [];
                refreshContentIndexes();
                scope.visible = true;
                loadPlexServers();
            } );

            async function loadPlexServers() {
                try {
                    let servers = await dizquetv.getPlexServers();
                    scope.plexServers = servers || [];
                    if (scope.plexServers.length > 0) {
                        let prev = scope.playlistImport.serverName;
                        let stillThere = false;
                        for (let i = 0; i < scope.plexServers.length; i++) {
                            if (scope.plexServers[i].name === prev) {
                                stillThere = true;
                                break;
                            }
                        }
                        scope.playlistImport.serverName = stillThere ? prev : scope.plexServers[0].name;
                        await scope.loadPlaylists();
                    } else {
                        scope.playlistImport.serverName = null;
                        scope.playlistImport.key = null;
                        scope.playlists = [];
                    }
                    $timeout();
                } catch (err) {
                    console.error("Could not load Plex servers for playlist import.", err);
                    scope.plexServers = [];
                    $timeout();
                }
            }

            scope.loadPlaylists = async () => {
                scope.playlists = [];
                scope.playlistImport.key = null;
                scope.playlistImport.errors = [];
                let server = getSelectedPlaylistServer();
                if (!server) {
                    $timeout();
                    return;
                }
                try {
                    let playlists = await plex.getPlaylists(server);
                    for (let i = 0; i < playlists.length; i++) {
                        playlists[i].type = "playlist";
                    }
                    scope.playlists = playlists;
                    if (scope.playlists.length > 0) {
                        scope.playlistImport.key = scope.playlists[0].key;
                    }
                } catch (err) {
                    console.error("Could not load Plex playlists.", err);
                    scope.playlistImport.errors.push("Unable to load playlists from " + server.name);
                }
                $timeout();
            };

            scope.importPlaylist = async () => {
                let server = getSelectedPlaylistServer();
                let playlist = getSelectedPlaylist();
                if (!playlist || !server || scope.playlistImport.pending) {
                    return;
                }
                // Capture selection now — do not re-read later after async gaps
                let playlistKey = scope.playlistImport.key;
                let playlistTitle = playlist.title;
                let serverName = server.name;
                scope.playlistImport.pending = true;
                scope.playlistImport.errors = [];
                $timeout();
                try {
                    // Resolve again by key in case list was refreshed
                    let toImport = null;
                    for (let i = 0; i < scope.playlists.length; i++) {
                        if (scope.playlists[i].key === playlistKey) {
                            toImport = scope.playlists[i];
                            break;
                        }
                    }
                    if (!toImport) {
                        toImport = playlist;
                    }
                    let errors = [];
                    let nested = await plex.getNested(
                        server,
                        toImport,
                        false,
                        errors
                    );
                    if (errors.length > 0) {
                        scope.playlistImport.errors = scope.playlistImport.errors.concat(errors);
                    }
                    if (!nested || nested.length === 0) {
                        scope.playlistImport.errors.push(
                            "Playlist \"" + playlistTitle + "\" has no importable items."
                        );
                        return;
                    }
                    let imported = [];
                    for (let i = 0; i < nested.length; i++) {
                        let item = nested[i];
                        // Only import playable leaf items (same as library picker)
                        if (item.type !== 'movie' && item.type !== 'episode' && item.type !== 'track') {
                            continue;
                        }
                        delete item.server;
                        item.serverKey = serverName;
                        item.commercials = [];
                        imported.push(JSON.parse(angular.toJson(item)));
                    }
                    if (imported.length === 0) {
                        scope.playlistImport.errors.push(
                            "Playlist \"" + playlistTitle + "\" has no playable video/audio items."
                        );
                        return;
                    }
                    // Use playlist title as show name when empty (typical create flow)
                    if (!scope.name || scope.name.length === 0) {
                        scope.name = playlistTitle;
                    }
                    scope.content = scope.content.concat(imported);
                    refreshContentIndexes();
                } catch (err) {
                    console.error("Could not import Plex playlist.", err);
                    scope.playlistImport.errors.push(
                        "Failed to import playlist \"" + playlistTitle + "\"."
                    );
                } finally {
                    scope.playlistImport.pending = false;
                    $timeout();
                }
            };

            scope.finished = (cancelled) => {
                if (cancelled) {
                    scope.visible = false;
                    return scope.onDone();
                }
                if ( (typeof(scope.name) === 'undefined') || (scope.name.length == 0) ) {
                    scope.error = "Please enter a name";
                }
                if ( scope.content.length == 0) {
                    scope.error = "Please add at least one clip.";
                }
                if (typeof(scope.error) !== 'undefined') {
                    $timeout( () => {
                        scope.error = undefined;
                    }, 30000);
                    return;
                }
                scope.visible = false;
                scope.onDone( {
                    name: scope.name,
                    content: scope.content.map( (c) => {
                        delete c.$index
                        return c;
                    } ),
                    id: scope.id,
                } );
            }
            scope.showList = () => {
                return ! scope.showPlexLibrary;
            }
            scope.sortShows = () => {
                scope.content = commonProgramTools.sortShows(scope.content);
                refreshContentIndexes();
            }
            scope.sortByDate = () => {
                scope.content = commonProgramTools.sortByDate(scope.content);
                refreshContentIndexes();
            }
            scope.shuffleShows = () => {
                scope.content = commonProgramTools.shuffle(scope.content);
                refreshContentIndexes();
            }
            scope.showRemoveAllShow = () => {
                scope.content = [];
                refreshContentIndexes();
            }
            scope.showRemoveDuplicates = () => {
                scope.content = commonProgramTools.removeDuplicates(scope.content);
                refreshContentIndexes();
            }
            scope.getProgramDisplayTitle = (x) => {
                return commonProgramTools.getProgramDisplayTitle(x);
            }

            scope.removeSpecials = () => {
                scope.content = commonProgramTools.removeSpecials(scope.content);
                refreshContentIndexes();

            }
            scope.importPrograms = (selectedPrograms) => {
                for (let i = 0, l = selectedPrograms.length; i < l; i++) {
                    selectedPrograms[i].commercials = []
                }
                scope.content = scope.content.concat(selectedPrograms);
                refreshContentIndexes();
                scope.showPlexLibrary = false;
            }


            scope.durationString = (duration) => {
                var date = new Date(0);
                date.setSeconds( Math.floor(duration / 1000) ); // specify value for SECONDS here
                return date.toISOString().substr(11, 8);
            }

            let interpolate = ( () => {
                let h = 60*60*1000 / 6;
                let ix = [0, 1*h, 2*h, 4*h, 8*h, 24*h];
                let iy = [0, 1.0, 1.25, 1.5, 1.75, 2.0];
                let n = ix.length;

                return (x) => {
                    for (let i = 0; i < n-1; i++) {
                        if( (ix[i] <= x) && ( (x < ix[i+1]) || i==n-2 ) ) {
                            return iy[i] + (iy[i+1] - iy[i]) * ( (x - ix[i]) / (ix[i+1] - ix[i]) );
                        }
                    }
                }

            } )();

            scope.programSquareStyle = (x) => {
                return commonProgramTools.programSquareStyle(x);
            }

        }
    };
}
