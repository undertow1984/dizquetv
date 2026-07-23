module.exports = function ($timeout, $location, plex, jellyfin, dizquetv, commonProgramTools, libraryCatalogPreload) {
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
/** 'all' | 'plex' | 'jellyfin' */
            scope.mediaSourceFilter = 'all';
            /** Merged playlists + collections */
            scope.lists = [];
            scope.shows = [];
            scope.customShows = [];
            /** Full unfiltered catalog (all servers) */
            scope._allLists = [];
            scope._allShows = [];
            scope._allCustomShows = [];
            scope.listFilter = "";
            scope.showFilter = "";
            scope.customFilter = "";
            scope.loading = false;
            scope.importing = false;
            scope.status = "";
            scope.errors = [];
            scope.progress = { current: 0, total: 0 };

            /** Optional channel name override for content-source import. */
            scope.channelName = "";

            function sortByTitle(items) {
                return (items || []).slice().sort((a, b) => {
                    let ta = (a.title || a.name || "").toString();
                    let tb = (b.title || b.name || "").toString();
                    return ta.localeCompare(tb, undefined, { sensitivity: 'base', numeric: true });
                });
            }

            function mediaApi(mediaSource) {
                return mediaSource === 'jellyfin' ? jellyfin : plex;
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

            /** Same shape as channel-config content sources */
            function makeContentSource(server, source) {
                let type = source.type || "playlist";
                if (
                    type !== "playlist"
                    && type !== "collection"
                    && type !== "show"
                    && type !== "custom"
                ) {
                    type = "playlist";
                }
                let mediaSource = source.mediaSource || source.serverType || source.source
                    || (type === 'custom' ? 'custom' : null)
                    || (server && server.source) || 'plex';
                return {
                    type: type,
                    key: source.key,
                    title: source.title,
                    serverName: (server && server.name) || source.serverName || "",
                    mediaSource: mediaSource,
                    source: mediaSource,
                    serverType: mediaSource,
                    collectionType: source.collectionType || null,
                    collectionKind: source.collectionKind || null,
                    playlistKind: source.playlistKind || null,
                    libraryTitle: source.libraryTitle || null,
                    librarySectionKey: source.librarySectionKey || null,
                    libraryType: source.libraryType || null,
                    jellyfinId: source.jellyfinId || source.ratingKey || null,
                    ratingKey: source.ratingKey || source.jellyfinId || null,
                    genreId: source.genreId || null,
                    lastSyncedAt: new Date().toISOString(),
                };
            }

            function contentSourceId(src) {
                let ms = src.mediaSource || src.serverType || src.source || 'plex';
                return String(ms) + "\0" + (src.serverName || "") + "\0" + (src.type || "") + "\0" + (src.key || "");
            }

            /**
             * Merge newly imported sources into existing contentSources.
             */
            function mergeContentSources(existing, incoming) {
                let list = Array.isArray(existing) ? existing.slice() : [];
                for (let i = 0; i < incoming.length; i++) {
                    let src = incoming[i];
                    let id = contentSourceId(src);
                    let idx = -1;
                    for (let j = 0; j < list.length; j++) {
                        if (contentSourceId(list[j]) === id) {
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
                scope.lists = [];
                scope.shows = [];
                scope.customShows = [];
                scope._allLists = [];
                scope._allShows = [];
                scope._allCustomShows = [];
                scope.listFilter = "";
                scope.showFilter = "";
                scope.customFilter = "";
                scope.errors = [];
                scope.status = "";
                scope.progress = { current: 0, total: 0 };
                scope.importing = false;
                scope.loading = true;
                scope._nextNumber = null;
                scope.channelName = "";
                $timeout();
                try {
                    let plexServers = await dizquetv.getPlexServers().catch(() => []);
                    let jfServers = await dizquetv.getJellyfinServers().catch(() => []);
                    let servers = [];
                    (plexServers || []).forEach((s) => {
                        servers.push(Object.assign({}, s, {
                            source: 'plex',
                            displayName: 'Plex - ' + s.name,
                        }));
                    });
                    (jfServers || []).forEach((s) => {
                        servers.push(Object.assign({}, s, {
                            source: 'jellyfin',
                            displayName: 'Jellyfin - ' + s.name,
                        }));
                    });
                    scope.servers = servers;
                    await scope.loadLists();
                } catch (err) {
                    console.error(err);
                    scope.errors.push("Unable to load media servers.");
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            }

            /**
             * Load playlists+collections / shows / custom programming from local
             * library cache only (same /api/content-sources/catalog as channel Properties).
             */
            scope.loadLists = async () => {
                scope.listFilter = "";
                scope.showFilter = "";
                scope.customFilter = "";
                scope.errors = [];
                scope.loading = true;
                $timeout();
                try {
                    // Plex/Jellyfin from session cache; custom shows always live
                    await libraryCatalogPreload.ensureLoaded();
                    let catalog = libraryCatalogPreload.getContentSourceCatalog()
                        || await dizquetv.getContentSourceCatalog();
                    let lists = (catalog.lists || []).map((p) => {
                        return Object.assign({}, p, { selected: false });
                    });
                    let shows = (catalog.shows || []).map((s) => {
                        return Object.assign({}, s, { selected: false });
                    });
                    let liveCustoms = await libraryCatalogPreload.fetchCustomShowsLive();
                    let customShows = (liveCustoms || []).map((c) => ({
                        title: c.name,
                        key: c.id,
                        type: 'custom',
                        selected: false,
                        count: c.count,
                        serverName: '',
                        mediaSource: 'custom',
                        source: 'custom',
                        serverType: 'custom',
                    }));

                    let warnings = catalog.warnings || [];
                    for (let w = 0; w < warnings.length && w < 4; w++) {
                        scope.errors.push(warnings[w]);
                    }

                    scope._allLists = sortByTitle(lists);
                    scope._allShows = sortByTitle(shows);
                    scope._allCustomShows = sortByTitle(customShows);
                    scope.applyMediaSourceFilter();
                } catch (err) {
                    console.error(err);
                    scope.errors.push("Unable to load content sources from cache.");
                    scope._allLists = [];
                    scope._allShows = [];
                    scope._allCustomShows = [];
                    scope.applyMediaSourceFilter();
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            };

            scope.mediaSourceFilterFn = (item) => {
                if (!item) return false;
                let ms = item.mediaSource || item.serverType || item.source || 'plex';
                if (ms === 'custom' || item.type === 'custom') return true;
                if (scope.mediaSourceFilter === 'all') return true;
                return ms === scope.mediaSourceFilter;
            };

            scope.setMediaSourceFilter = (v) => {
                if (v === 'plex' || v === 'jellyfin' || v === 'all') {
                    let prev = scope.mediaSourceFilter;
                    scope.mediaSourceFilter = v;
                    // Reload when switching media type so we don't keep unused server data warm only —
                    // still cheap via cache; ensures empty-server types refresh cleanly.
                    if (prev !== v) {
                        scope.loadLists();
                    } else {
                        scope.applyMediaSourceFilter();
                    }
                }
            };

            scope.applyMediaSourceFilter = () => {
                let f = scope.mediaSourceFilterFn;
                scope.lists = (scope._allLists || []).filter(f);
                scope.shows = (scope._allShows || []).filter(f);
                scope.customShows = (scope._allCustomShows || []).slice();
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
                if (scope.importing) {
                    return;
                }
                let selected = [];
                for (let i = 0; i < scope.lists.length; i++) {
                    if (scope.lists[i].selected) {
                        selected.push(scope.lists[i]);
                    }
                }
                for (let i = 0; i < scope.shows.length; i++) {
                    if (scope.shows[i].selected) {
                        selected.push(scope.shows[i]);
                    }
                }
                for (let i = 0; i < scope.customShows.length; i++) {
                    if (scope.customShows[i].selected) {
                        selected.push(scope.customShows[i]);
                    }
                }
                if (selected.length === 0) {
                    scope.errors = ["Select at least one playlist, collection, TV show, or custom programming."];
                    $timeout();
                    return;
                }

                // If Name is set, all selected sources import into that one channel.
                // Otherwise each content source title becomes the channel name
                // (sources that share a title still merge into one channel).
                let overrideName = (scope.channelName || "").trim();
                let groups = {};
                let groupOrder = [];
                for (let i = 0; i < selected.length; i++) {
                    let src = selected[i];
                    let channelTitle = overrideName || src.title;
                    let key = normalizeName(channelTitle);
                    if (!groups[key]) {
                        groups[key] = {
                            name: channelTitle,
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

                // Index servers for expand
                let serverByKey = {};
                for (let i = 0; i < scope.servers.length; i++) {
                    let s = scope.servers[i];
                    let ms = s.source || 'plex';
                    serverByKey[ms + '\0' + s.name] = s;
                }

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
                            let mediaSource = source.mediaSource || source.source || 'plex';

                            if (source.type === 'custom' || mediaSource === 'custom') {
                                try {
                                    let show = await dizquetv.getShow(source.key);
                                    if (!show || !Array.isArray(show.content) || !show.content.length) {
                                        expandErrors.push(
                                            `Custom programming "${source.title}" has no items.`
                                        );
                                        continue;
                                    }
                                    for (let c = 0; c < show.content.length; c++) {
                                        let item = JSON.parse(JSON.stringify(show.content[c]));
                                        item.customShowId = show.id || source.key;
                                        item.customShowName = show.name || source.title;
                                        item.customOrder = c;
                                        if (typeof item.commercials === 'undefined') {
                                            item.commercials = [];
                                        }
                                        programs.push(item);
                                    }
                                    contentSources.push(makeContentSource(null, source));
                                } catch (err) {
                                    console.error(err);
                                    expandErrors.push(
                                        `Failed custom programming "${source.title}".`
                                    );
                                }
                                continue;
                            }

                            let server = serverByKey[mediaSource + '\0' + source.serverName];
                            if (!server) {
                                expandErrors.push(
                                    "Server not found: " + mediaSource + " / " + source.serverName
                                );
                                continue;
                            }
                            let expandItem = Object.assign({}, source, {
                                mediaSource: mediaSource,
                                source: mediaSource,
                                serverType: mediaSource,
                            });
                            if (mediaSource === 'jellyfin' && !expandItem.jellyfinId && expandItem.key) {
                                let m = String(expandItem.key).match(/\/Items\/([^/?]+)/i)
                                    || String(expandItem.key).match(/\/Genres\/([^/]+)/i)
                                    || String(expandItem.key).match(/\/Favorites\/Library\/([^/?]+)/i);
                                if (m) {
                                    expandItem.jellyfinId = m[1];
                                    expandItem.ratingKey = expandItem.ratingKey || m[1];
                                }
                            }
                            let more = await mediaApi(mediaSource).expandToPrograms(
                                server,
                                expandItem,
                                expandErrors
                            );
                            if (more && more.length) {
                                for (let m = 0; m < more.length; m++) {
                                    if (mediaSource === 'jellyfin') {
                                        more[m].source = 'jellyfin';
                                        more[m].serverType = 'jellyfin';
                                        more[m].serverKey = server.name;
                                    }
                                }
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
                            let full = await dizquetv.getChannel(existing.number);
                            if (!full) {
                                scope.errors.push(
                                    `Could not load channel #${existing.number} "${group.name}".`
                                );
                                continue;
                            }
                            full.programs = prepared.programs;
                            full.duration = prepared.duration;
                            full.startTime = full.startTime ? new Date(full.startTime) : defaultStartTime();
                            full.contentSources = mergeContentSources(
                                full.contentSources,
                                contentSources
                            );
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

