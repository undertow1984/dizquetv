module.exports = function ($timeout, $location, plex, dizquetv, commonProgramTools) {
    return {
        restrict: 'E',
        templateUrl: 'templates/bulk-channel-import.html',
        replace: true,
        scope: {
            visible: "=visible",
            channels: "=channels",
            onDone: "=onDone"
        },
        link: function (scope) {
            scope.servers = [];
            scope.selectedServerName = null;
            scope.playlists = [];
            scope.collections = [];
            scope.shows = [];
            scope.playlistFilter = "";
            scope.collectionFilter = "";
            scope.showFilter = "";
            scope.loading = false;
            scope.importing = false;
            scope.status = "";
            scope.errors = [];
            scope.progress = { current: 0, total: 0 };

            function sortByTitle(items) {
                return (items || []).slice().sort((a, b) => {
                    let ta = (a.title || a.name || "").toString();
                    let tb = (b.title || b.name || "").toString();
                    return ta.localeCompare(tb, undefined, { sensitivity: 'base', numeric: true });
                });
            }

            function getSelectedServer() {
                if (!scope.selectedServerName) {
                    return null;
                }
                for (let i = 0; i < scope.servers.length; i++) {
                    if (scope.servers[i].name === scope.selectedServerName) {
                        return scope.servers[i];
                    }
                }
                return null;
            }

            function nextChannelNumber(knownChannels) {
                let max = 0;
                let list = knownChannels || scope.channels || [];
                for (let i = 0; i < list.length; i++) {
                    let n = parseInt(list[i].number, 10);
                    if (!isNaN(n) && n > max) {
                        max = n;
                    }
                }
                if (scope._nextNumber && scope._nextNumber > max) {
                    max = scope._nextNumber - 1;
                }
                return max + 1;
            }

            function defaultStartTime() {
                let startTime = new Date();
                startTime.setMilliseconds(0);
                startTime.setSeconds(0);
                if (startTime.getMinutes() < 30) {
                    startTime.setMinutes(0);
                } else {
                    startTime.setMinutes(30);
                }
                return startTime;
            }

            function normalizeName(s) {
                return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
            }

            function findChannelByName(name, channelList) {
                let n = normalizeName(name);
                for (let i = 0; i < channelList.length; i++) {
                    if (normalizeName(channelList[i].name) === n) {
                        return channelList[i];
                    }
                }
                return null;
            }

            function makeContentSource(server, source) {
                let type = source.type || "playlist";
                if (type !== "playlist" && type !== "collection" && type !== "show") {
                    type = "playlist";
                }
                return {
                    type: type,
                    key: source.key,
                    title: source.title,
                    serverName: server.name,
                    collectionType: source.collectionType || null,
                    libraryTitle: source.libraryTitle || null,
                    lastSyncedAt: new Date().toISOString(),
                };
            }

            /**
             * Merge newly imported sources into existing contentSources by serverName+type+key.
             */
            function mergeContentSources(existing, incoming) {
                let list = Array.isArray(existing) ? existing.slice() : [];
                for (let i = 0; i < incoming.length; i++) {
                    let src = incoming[i];
                    let idx = -1;
                    for (let j = 0; j < list.length; j++) {
                        if (
                            list[j].serverName === src.serverName
                            && list[j].type === src.type
                            && list[j].key === src.key
                        ) {
                            idx = j;
                            break;
                        }
                    }
                    if (idx >= 0) {
                        list[idx] = src;
                    } else {
                        list.push(src);
                    }
                }
                return list;
            }

            function preparePrograms(programs) {
                let list = programs.slice();
                // Remove duplicates then randomize
                if (typeof commonProgramTools.removeDuplicates === 'function') {
                    list = commonProgramTools.removeDuplicates(list);
                }
                list = commonProgramTools.shuffle(list);
                let duration = 0;
                for (let i = 0; i < list.length; i++) {
                    if (typeof list[i].commercials === 'undefined') {
                        list[i].commercials = [];
                    }
                    duration += list[i].duration || 0;
                }
                return { programs: list, duration: duration };
            }

            async function shouldEnableWatermarkByDefault() {
                try {
                    let ffmpegSettings = await dizquetv.getFfmpegSettings();
                    return (
                        ffmpegSettings
                        && ffmpegSettings.enableChannelWatermarkGlobally === true
                        && ffmpegSettings.disableChannelOverlay !== true
                    );
                } catch (err) {
                    console.error("Could not load ffmpeg settings for watermark default.", err);
                    return false;
                }
            }

            function buildNewChannel(name, number, programs, duration, watermarkEnabled, contentSources) {
                return {
                    name: name,
                    number: number,
                    programs: programs,
                    contentSources: contentSources,
                    watermark: {
                        enabled: watermarkEnabled === true,
                        position: "bottom-right",
                        width: 10.00,
                        verticalMargin: 0.00,
                        horizontalMargin: 0.00,
                        duration: 0,
                    },
                    fillerCollections: [],
                    guideFlexPlaceholder: "",
                    fillerRepeatCooldown: 30 * 60 * 1000,
                    fallback: [],
                    guideMinimumDurationSeconds: 5 * 60,
                    icon: `/images/dizquetv.png`,
                    groupTitle: "dizqueTV",
                    disableFillerOverlay: true,
                    iconWidth: 120,
                    iconDuration: 60,
                    iconPosition: "2",
                    startTime: defaultStartTime(),
                    offlinePicture: `/images/generic-offline-screen.png`,
                    offlineSoundtrack: '',
                    offlineMode: "pic",
                    duration: duration,
                    transcoding: {
                        targetResolution: "",
                    },
                    onDemand: {
                        isOnDemand: false,
                        modulo: 1,
                    },
                };
            }

            scope.$watch('visible', function (v) {
                if (v) {
                    open();
                }
            });

            async function open() {
                scope.playlists = [];
                scope.collections = [];
                scope.shows = [];
                scope.playlistFilter = "";
                scope.collectionFilter = "";
                scope.showFilter = "";
                scope.errors = [];
                scope.status = "";
                scope.progress = { current: 0, total: 0 };
                scope.importing = false;
                scope.loading = true;
                scope._nextNumber = null;
                $timeout();
                try {
                    let servers = await dizquetv.getPlexServers();
                    scope.servers = servers || [];
                    if (scope.servers.length === 0) {
                        scope.selectedServerName = null;
                        scope.loading = false;
                        $timeout();
                        return;
                    }
                    let prev = scope.selectedServerName;
                    let stillThere = false;
                    for (let i = 0; i < scope.servers.length; i++) {
                        if (scope.servers[i].name === prev) {
                            stillThere = true;
                            break;
                        }
                    }
                    scope.selectedServerName = stillThere ? prev : scope.servers[0].name;
                    await scope.loadLists();
                } catch (err) {
                    console.error(err);
                    scope.errors.push("Unable to load Plex servers.");
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            }

            scope.loadLists = async () => {
                scope.playlists = [];
                scope.collections = [];
                scope.shows = [];
                scope.playlistFilter = "";
                scope.collectionFilter = "";
                scope.showFilter = "";
                scope.errors = [];
                let server = getSelectedServer();
                if (!server) {
                    $timeout();
                    return;
                }
                scope.loading = true;
                $timeout();
                try {
                    let play = await plex.getPlaylists(server);
                    let cols = await plex.getCollections(server);
                    let tv = await plex.getShows(server);
                    play = sortByTitle(play).map((p) => {
                        return {
                            title: p.title,
                            key: p.key,
                            type: "playlist",
                            selected: false,
                            icon: p.icon,
                            count: p.count,
                        };
                    });
                    cols = sortByTitle(cols).map((c) => {
                        return {
                            title: c.title,
                            key: c.key,
                            type: "collection",
                            collectionType: c.collectionType,
                            libraryTitle: c.libraryTitle,
                            selected: false,
                            icon: c.icon,
                            count: c.count,
                        };
                    });
                    tv = sortByTitle(tv).map((s) => {
                        return {
                            title: s.title,
                            key: s.key,
                            type: "show",
                            libraryTitle: s.libraryTitle,
                            selected: false,
                            icon: s.icon,
                            count: s.count,
                            ratingKey: s.ratingKey,
                        };
                    });
                    scope.playlists = play;
                    scope.collections = cols;
                    scope.shows = tv;
                } catch (err) {
                    console.error(err);
                    scope.errors.push("Unable to load playlists/collections/shows from " + server.name);
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            };

            scope.selectAll = (list, value) => {
                for (let i = 0; i < list.length; i++) {
                    list[i].selected = value;
                }
            };

            scope.selectedCount = (list) => {
                let n = 0;
                for (let i = 0; i < list.length; i++) {
                    if (list[i].selected) {
                        n++;
                    }
                }
                return n;
            };

            scope.cancel = () => {
                if (scope.importing) {
                    return;
                }
                scope.visible = false;
                if (typeof scope.onDone === 'function') {
                    scope.onDone(false);
                }
            };

            scope.importSelected = async () => {
                let server = getSelectedServer();
                if (!server || scope.importing) {
                    return;
                }
                let selected = [];
                for (let i = 0; i < scope.playlists.length; i++) {
                    if (scope.playlists[i].selected) {
                        selected.push(scope.playlists[i]);
                    }
                }
                for (let i = 0; i < scope.collections.length; i++) {
                    if (scope.collections[i].selected) {
                        selected.push(scope.collections[i]);
                    }
                }
                for (let i = 0; i < scope.shows.length; i++) {
                    if (scope.shows[i].selected) {
                        selected.push(scope.shows[i]);
                    }
                }
                if (selected.length === 0) {
                    scope.errors = ["Select at least one playlist, collection, or TV show."];
                    $timeout();
                    return;
                }

                // Group by channel name so playlist + collection with the same title
                // update one channel with both sources' content.
                let groups = {};
                let groupOrder = [];
                for (let i = 0; i < selected.length; i++) {
                    let src = selected[i];
                    let key = normalizeName(src.title);
                    if (!groups[key]) {
                        groups[key] = {
                            name: src.title,
                            sources: [],
                        };
                        groupOrder.push(key);
                    }
                    groups[key].sources.push(src);
                }

                scope.importing = true;
                scope.errors = [];
                scope.progress = { current: 0, total: groupOrder.length };
                scope.status = "Starting import...";
                scope._nextNumber = nextChannelNumber(scope.channels);
                $timeout();

                let watermarkEnabled = await shouldEnableWatermarkByDefault();
                let created = 0;
                let updated = 0;

                // Snapshot of known channels (name + number); refresh after each create
                let known = (scope.channels || []).map((c) => {
                    return { name: c.name, number: c.number };
                });

                for (let g = 0; g < groupOrder.length; g++) {
                    let group = groups[groupOrder[g]];
                    scope.progress.current = g + 1;
                    scope.status = `Importing "${group.name}" (${g + 1}/${groupOrder.length})...`;
                    $timeout();

                    try {
                        let expandErrors = [];
                        let programs = [];
                        let contentSources = [];

                        for (let s = 0; s < group.sources.length; s++) {
                            let source = group.sources[s];
                            let more = await plex.expandToPrograms(server, source, expandErrors);
                            if (more && more.length) {
                                programs = programs.concat(more);
                            }
                            contentSources.push(makeContentSource(server, source));
                        }

                        if (expandErrors.length > 0) {
                            scope.errors = scope.errors.concat(expandErrors);
                        }
                        if (!programs.length) {
                            scope.errors.push(`"${group.name}" has no importable items — skipped.`);
                            continue;
                        }

                        let prepared = preparePrograms(programs);
                        let existing = findChannelByName(group.name, known);

                        if (existing) {
                            // Update existing channel: replace programming, shuffle, dedupe, track sources
                            let full = await dizquetv.getChannel(existing.number);
                            if (!full) {
                                scope.errors.push(`Could not load channel #${existing.number} "${group.name}".`);
                                continue;
                            }
                            full.programs = prepared.programs;
                            full.duration = prepared.duration;
                            full.startTime = full.startTime ? new Date(full.startTime) : defaultStartTime();
                            full.contentSources = mergeContentSources(full.contentSources, contentSources);
                            // Keep channel name as-is (preserve user's casing)
                            await dizquetv.updateChannel(full);
                            updated++;
                        } else {
                            let number = scope._nextNumber;
                            scope._nextNumber = number + 1;
                            let channel = buildNewChannel(
                                group.name,
                                number,
                                prepared.programs,
                                prepared.duration,
                                watermarkEnabled,
                                contentSources
                            );
                            await dizquetv.addChannel(channel);
                            known.push({ name: group.name, number: number });
                            created++;
                        }
                    } catch (err) {
                        console.error(err);
                        scope.errors.push(`Failed to import "${group.name}".`);
                    }
                    $timeout();
                }

                scope.importing = false;
                let parts = [];
                if (created) {
                    parts.push(`created ${created}`);
                }
                if (updated) {
                    parts.push(`updated ${updated}`);
                }
                scope.status = parts.length
                    ? `Done. ${parts.join(", ")} channel(s).`
                    : "Done. No channels changed.";
                $timeout();
                if (created > 0 || updated > 0) {
                    $timeout(() => {
                        scope.visible = false;
                        if (typeof scope.onDone === 'function') {
                            scope.onDone(true);
                        }
                    }, scope.errors.length === 0 ? 600 : 1500);
                }
            };
        }
    };
};
