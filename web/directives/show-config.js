module.exports = function ($timeout, commonProgramTools, libraryCatalogPreload, dizquetv) {
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
            scope.content = [];
            scope.visible = false;
            scope.error = undefined;
            scope.playlistPushStatus = '';

            // Playlist push (same options as Library → Lists — dual Plex Movies/TV)
            scope.hasPlex = false;
            scope.hasJellyfin = false;
            scope.plexLibraries = [];
            scope.pushToPlex = false;
            scope.pushToJellyfin = false;
            scope.plexMovieLibraryRef = '';
            scope.plexTvLibraryRef = '';
            scope.plexMoviePlaylistId = null;
            scope.plexTvPlaylistId = null;
            scope.plexMovieLibraryTitle = null;
            scope.plexTvLibraryTitle = null;
            scope.jellyfinPlaylistId = null;
            scope.lastPlaylistPushError = null;
            scope.lastPlaylistPushAt = null;

            scope.plexMovieLibraries = function () {
                return (scope.plexLibraries || []).filter((l) => !l.type || l.type === 'movie');
            };
            scope.plexTvLibraries = function () {
                return (scope.plexLibraries || []).filter((l) => l.type === 'show');
            };

            // Add-programming catalog warms on app visit; Done stays off until ready
            scope.libraryCatalogReady = libraryCatalogPreload.isReady();
            scope.libraryCatalogLoading = libraryCatalogPreload.isLoading() || !scope.libraryCatalogReady;
            let unsubCatalog = libraryCatalogPreload.subscribe((snap) => {
                scope.libraryCatalogReady = !!snap.ready;
                scope.libraryCatalogLoading = !!snap.loading || !snap.ready;
                $timeout();
            });
            scope.$on('$destroy', () => {
                if (typeof unsubCatalog === 'function') {
                    unsubCatalog();
                }
            });
            libraryCatalogPreload.ensureLoaded().catch((err) => {
                console.error(err);
            });

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
                for (let j = 0; j < (scope.plexLibraries || []).length; j++) {
                    let lib = scope.plexLibraries[j];
                    if (
                        lib.serverName === serverName
                        && String(lib.sectionKey) === String(sectionKey)
                    ) {
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

            async function loadPlaylistTargets() {
                try {
                    let data = await dizquetv.getTrackedListPlexLibraries();
                    scope.hasPlex = !!(data && data.hasPlex);
                    scope.hasJellyfin = !!(data && data.hasJellyfin);
                    scope.plexLibraries = (data && data.libraries) || [];
                } catch (err) {
                    console.error(err);
                    scope.hasPlex = false;
                    scope.hasJellyfin = false;
                    scope.plexLibraries = [];
                }
                $timeout();
            }

            function resetPlaylistFields() {
                scope.pushToPlex = false;
                scope.pushToJellyfin = false;
                scope.plexMovieLibraryRef = '';
                scope.plexTvLibraryRef = '';
                scope.plexMoviePlaylistId = null;
                scope.plexTvPlaylistId = null;
                scope.plexMovieLibraryTitle = null;
                scope.plexTvLibraryTitle = null;
                scope.jellyfinPlaylistId = null;
                scope.lastPlaylistPushError = null;
                scope.lastPlaylistPushAt = null;
                scope.playlistPushStatus = '';
            }

            function applyShowPlaylistFields(show) {
                show = show || {};
                scope.pushToPlex = !!show.pushToPlex;
                scope.pushToJellyfin = !!show.pushToJellyfin;
                scope.plexMoviePlaylistId =
                    show.plexMoviePlaylistId || show.plexPlaylistId || null;
                scope.plexTvPlaylistId = show.plexTvPlaylistId || null;
                scope.plexMovieLibraryTitle =
                    show.plexMovieLibraryTitle || show.plexLibraryTitle || null;
                scope.plexTvLibraryTitle = show.plexTvLibraryTitle || null;
                scope.jellyfinPlaylistId = show.jellyfinPlaylistId || null;
                scope.lastPlaylistPushError = show.lastPlaylistPushError || null;
                scope.lastPlaylistPushAt = show.lastPlaylistPushAt || null;
                scope.plexMovieLibraryRef = plexLibraryRefValue(
                    show.plexMovieServerName || show.plexServerName,
                    show.plexMovieSectionKey || show.plexSectionKey
                );
                scope.plexTvLibraryRef = plexLibraryRefValue(
                    show.plexTvServerName,
                    show.plexTvSectionKey
                );
            }

            function buildShowPayload() {
                let movie = parsePlexLibraryRef(scope.plexMovieLibraryRef);
                let tv = parsePlexLibraryRef(scope.plexTvLibraryRef);
                let pushPlex = !!scope.pushToPlex && scope.hasPlex;
                return {
                    name: scope.name,
                    content: (scope.content || []).map((c) => {
                        let copy = Object.assign({}, c);
                        delete copy.$index;
                        return copy;
                    }),
                    id: scope.id,
                    pushToPlex: pushPlex,
                    pushToJellyfin: !!scope.pushToJellyfin && scope.hasJellyfin,
                    plexMovieServerName: pushPlex ? movie.serverName : null,
                    plexMovieSectionKey: pushPlex ? movie.sectionKey : null,
                    plexMovieLibraryTitle: pushPlex
                        ? (movie.libraryTitle || scope.plexMovieLibraryTitle)
                        : null,
                    plexMoviePlaylistId: scope.plexMoviePlaylistId || null,
                    plexTvServerName: pushPlex ? tv.serverName : null,
                    plexTvSectionKey: pushPlex ? tv.sectionKey : null,
                    plexTvLibraryTitle: pushPlex
                        ? (tv.libraryTitle || scope.plexTvLibraryTitle)
                        : null,
                    plexTvPlaylistId: scope.plexTvPlaylistId || null,
                    // legacy aliases = movies
                    plexServerName: pushPlex ? movie.serverName : null,
                    plexSectionKey: pushPlex ? movie.sectionKey : null,
                    plexLibraryTitle: pushPlex
                        ? (movie.libraryTitle || scope.plexMovieLibraryTitle)
                        : null,
                    plexPlaylistId: scope.plexMoviePlaylistId || null,
                    jellyfinPlaylistId: scope.jellyfinPlaylistId || null,
                    lastPlaylistPushAt: scope.lastPlaylistPushAt || null,
                    lastPlaylistPushError: scope.lastPlaylistPushError || null,
                };
            }

            function refreshContentIndexes() {
                if (!Array.isArray(scope.content)) {
                    scope.content = [];
                }
                for (let i = 0; i < scope.content.length; i++) {
                    if (scope.content[i]) {
                        scope.content[i].$index = i;
                    }
                }
            }

            scope.contentSplice = (a, b) => {
                if (!Array.isArray(scope.content)) {
                    scope.content = [];
                    return;
                }
                scope.content.splice(a, b);
                refreshContentIndexes();
            };

            scope.dropFunction = (dropIndex, program) => {
                if (!program || !Array.isArray(scope.content)) {
                    return false;
                }
                let y = typeof program.$index === 'number' ? program.$index : scope.content.indexOf(program);
                if (y < 0) {
                    return false;
                }
                let z = typeof dropIndex === 'number' ? dropIndex : scope.content.length;
                scope.content.splice(y, 1);
                if (z > y) {
                    z--;
                }
                scope.content.splice(z, 0, program);
                refreshContentIndexes();
                $timeout();
                return false;
            };

            scope.linker((show) => {
                loadPlaylistTargets();
                if (typeof (show) === 'undefined') {
                    scope.name = "";
                    scope.content = [];
                    scope.id = undefined;
                    scope.title = "Create Custom Show";
                    resetPlaylistFields();
                } else {
                    scope.name = show.name;
                    // Copy so UI edits don't mutate the table row until Done
                    scope.content = Array.isArray(show.content)
                        ? show.content.map((c) => Object.assign({}, c))
                        : [];
                    scope.id = show.id;
                    scope.title = "Edit Custom Show";
                    applyShowPlaylistFields(show);
                }
                scope.showTools = false;
                scope.error = undefined;
                scope.playlistPushStatus = '';
                refreshContentIndexes();
                scope.visible = true;
                $timeout();
            });

            scope.finished = (cancelled) => {
                if (cancelled) {
                    scope.visible = false;
                    return scope.onDone();
                }
                scope.error = undefined;
                if ((typeof (scope.name) === 'undefined') || (scope.name.length == 0)) {
                    scope.error = "Please enter a name";
                }
                if (scope.content.length == 0) {
                    scope.error = "Please add at least one clip.";
                }
                if (
                    scope.pushToPlex
                    && scope.hasPlex
                    && !(scope.plexMovieLibraryRef || '').trim()
                    && !(scope.plexTvLibraryRef || '').trim()
                ) {
                    scope.error = "Select a Plex Movies and/or TV library for the playlist.";
                }
                if (typeof (scope.error) !== 'undefined') {
                    $timeout(() => {
                        scope.error = undefined;
                    }, 30000);
                    return;
                }
                scope.visible = false;
                scope.onDone(buildShowPayload());
            };
            scope.sortShows = () => {
                scope.content = commonProgramTools.sortShows(scope.content);
                refreshContentIndexes();
            };
            scope.sortByDate = () => {
                scope.content = commonProgramTools.sortByDate(scope.content);
                refreshContentIndexes();
            };
            scope.shuffleShows = () => {
                scope.content = commonProgramTools.shuffle(scope.content);
                refreshContentIndexes();
            };
            scope.showRemoveAllShow = () => {
                scope.content = [];
                refreshContentIndexes();
            };
            scope.showRemoveDuplicates = () => {
                scope.content = commonProgramTools.removeDuplicates(scope.content);
                refreshContentIndexes();
            };
            scope.getProgramDisplayTitle = (x) => {
                return commonProgramTools.getProgramDisplayTitle(x);
            };

            scope.removeSpecials = () => {
                scope.content = commonProgramTools.removeSpecials(scope.content);
                refreshContentIndexes();
            };

            /** Called by embedded plex-library "Add to show". */
            scope.importPrograms = (selectedPrograms) => {
                if (!selectedPrograms || !selectedPrograms.length) {
                    return;
                }
                if (!Array.isArray(scope.content)) {
                    scope.content = [];
                }
                let batch = [];
                for (let i = 0, l = selectedPrograms.length; i < l; i++) {
                    let item = selectedPrograms[i];
                    if (!item) continue;
                    // Clone so list rows are independent of library tree nodes
                    let copy = JSON.parse(JSON.stringify(item));
                    if (typeof copy.commercials === 'undefined') {
                        copy.commercials = [];
                    }
                    batch.push(copy);
                }
                if (!batch.length) {
                    return;
                }
                scope.content = scope.content.concat(batch);
                refreshContentIndexes();
                $timeout();
            };

            scope.durationString = (duration) => {
                var date = new Date(0);
                date.setSeconds(Math.floor(duration / 1000));
                return date.toISOString().substr(11, 8);
            };

            scope.programSquareStyle = (x) => {
                return commonProgramTools.programSquareStyle(x);
            };
        }
    };
};
