
const express = require('express')
const path = require('path')
const fs = require('fs')
const constants = require('./constants');
const JSONStream = require('JSONStream');
const FFMPEGInfo = require('./ffmpeg-info');
const PlexServerDB = require('./dao/plex-server-db');
const Plex = require("./plex.js");
const JellyfinServerDB = require('./dao/jellyfin-server-db');
const Jellyfin = require("./jellyfin.js");

const timeSlotsService = require('./services/time-slots-service');
const randomSlotsService = require('./services/random-slots-service');
const throttle = require('./services/throttle');

function safeString(object) {
  let o = object;
  for(let i = 1; i < arguments.length; i++) {
    o = o[arguments[i]];
    if (typeof(o) === 'undefined') {
      return "missing";
    }
  }
  return String(o);
}

module.exports = { router: api }
function api(db, channelService, fillerDB, customShowDB, xmltvInterval,  guideService, _m3uService, eventService, ffmpegSettingsService, plexLibraryCacheService, imagemagickSettingsService, jellyfinLibraryCacheService ) {
    let m3uService = _m3uService;
    const router = express.Router()
    const plexServerDB = new PlexServerDB(channelService, fillerDB, customShowDB, db);
    const jellyfinServerDB = new JellyfinServerDB(channelService, fillerDB, customShowDB, db);
    const ExternalListService = require('./services/external-list-service');
    const externalListService = new ExternalListService(db, plexLibraryCacheService, jellyfinLibraryCacheService);
    const TrackedListService = require('./services/tracked-list-service');
    const trackedListService = new TrackedListService(db, externalListService, channelService, customShowDB);

    router.get('/api/version', async (req, res) => {
      try {
        let ffmpegSettings = db['ffmpeg-settings'].find()[0];
        let v = await (new FFMPEGInfo(ffmpegSettings)).getVersion();
        res.send( {
            "dizquetv" : constants.VERSION_NAME,
            "ffmpeg" : v,
            "nodejs" : process.version,
        } );
      } catch(err) {
          console.error(err);
          res.status(500).send("error");
      }
    });

    // Plex Servers
    router.get('/api/plex-servers', (req, res) => {
      try {
        let servers = db['plex-servers'].find()
        servers.sort( (a,b) => { return a.index - b.index } );
        res.send(servers)
      } catch(err) {
         console.error(err);
        res.status(500).send("error");
      }
    })
    router.post("/api/plex-servers/status", async (req, res) => {
      try {
        let servers = db['plex-servers'].find( {
            name: req.body.name,
        });
        if (servers.length != 1) {
            return res.status(404).send(req.t("api.plex_server_not_found"));
        }
        let plex = new Plex(servers[0]);
        let s = await Promise.race( [
            (async() => {
                return await plex.checkServerStatus();
            })(),
            new Promise( (resolve, reject) => {
                setTimeout( () => { resolve(-1); }, 60000);
            }),
        ]);
        res.send( {
            status: s,
        });
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.post("/api/plex-servers/foreignstatus", async (req, res) => {
      try {
        let server = req.body;
        let plex = new Plex(server);
        let s = await Promise.race( [
            (async() => {
                return await plex.checkServerStatus();
            })(),
            new Promise( (resolve, reject) => {
                setTimeout( () => { resolve(-1); }, 60000);
            }),
        ]);
        res.send( {
            status: s,
        });
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.delete('/api/plex-servers', async (req, res) => {
      let name = "unknown";
      try {
        name = req.body.name;
        if (typeof(name) === 'undefined') {
            return res.status(400).send("Missing name");
        }
        let report = await plexServerDB.deleteServer(name);
        res.send(report)
        eventService.push(
          "settings-update",
          {
            "message": `Plex server ${name} removed.`,
            "module" : "plex-server",
            "detail" : {
              "serverName" : name,
              "action" : "delete"
            },
            "level" : "warn"
          }
        );

      } catch(err) {
        console.error(err);
       res.status(500).send("error");
       eventService.push(
        "settings-update",
        {
          "message": "Error deleting plex server.",
          "module" : "plex-server",
          "detail" : {
            "action": "delete",
            "serverName" : name,
            "error" : safeString(err, "message"),
          },
          "level" : "danger"
        }
      );
      }
    })
    router.post('/api/plex-servers', async (req, res) => {
        try {
            let report = await plexServerDB.updateServer(req.body);
            let modifiedPrograms = 0;
            let destroyedPrograms = 0;
            report.forEach( (r) => {
              modifiedPrograms += r.modifiedPrograms;
              destroyedPrograms += r.destroyedPrograms;
            } );
            res.status(204).send("Plex server updated.");;
            eventService.push(
              "settings-update",
              {
                "message": `Plex server ${req.body.name} updated. ${modifiedPrograms} programs modified, ${destroyedPrograms} programs deleted`,
                "module" : "plex-server",
                "detail" : {
                  "serverName" : req.body.name,
                  "action" : "update"
                },
                "level" : "warning"
              }
            );
        
        } catch (err) {
            console.error("Could not update plex server.", err);
            res.status(400).send("Could not add plex server.");
            eventService.push(
              "settings-update",
              {
                "message": "Error updating plex server.",
                "module" : "plex-server",
                "detail" : {
                  "action": "update",
                  "serverName" : safeString(req, "body", "name"),
                  "error" : safeString(err, "message"),
                },
                "level" : "danger"
              }
            );
        }
    })
    router.put('/api/plex-servers', async (req, res) => {
        try {
            await plexServerDB.addServer(req.body);
            res.status(201).send("Plex server added.");;
            eventService.push(
              "settings-update",
              {
                "message": `Plex server ${req.body.name} added.`,
                "module" : "plex-server",
                "detail" : {
                  "serverName" : req.body.name,
                  "action" : "add"
                },
                "level" : "info"
              }
            );

        } catch (err) {
            console.error("Could not add plex server.", err);
            res.status(400).send("Could not add plex server.");
            eventService.push(
              "settings-update",
              {
                "message": "Error adding plex server.",
                "module" : "plex-server",
                "detail" : {
                  "action": "add",
                  "serverName" : safeString(req, "body", "name"),
                  "error" : safeString(err, "message"),
                },
                "level" : "danger"
              }
            );
        }
    })

    // Jellyfin Servers
    router.get('/api/jellyfin-servers', (req, res) => {
        try {
            let servers = db['jellyfin-servers'].find();
            servers.sort((a, b) => { return a.index < b.index ? -1 : 1 });
            // Do not expose full API keys in list responses? Keep parity with Plex (token is returned).
            res.send(servers);
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.post("/api/jellyfin-servers/status", async (req, res) => {
        try {
            let servers = db['jellyfin-servers'].find({ name: req.body.name });
            if (servers.length != 1) {
                return res.status(404).send("Jellyfin server not found");
            }
            let jf = new Jellyfin(servers[0]);
            let status = await jf.checkServerStatus();
            res.send({ status: status });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.post("/api/jellyfin-servers/foreignstatus", async (req, res) => {
        try {
            let server = req.body;
            let jf = new Jellyfin(server);
            let status = await jf.checkServerStatus();
            res.send({ status: status });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.delete('/api/jellyfin-servers', async (req, res) => {
        try {
            let name = req.body.name;
            if (typeof (name) === 'undefined') {
                return res.status(400).send("Missing name");
            }
            let report = await jellyfinServerDB.deleteServer(name);
            eventService.push(
                "settings-update",
                {
                    "message": `Jellyfin server ${name} removed.`,
                    "module": "jellyfin-server",
                    "detail": {
                        "serverName": name,
                        "action": "delete"
                    },
                    "level": "warning"
                }
            );
            res.send(report);
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
            eventService.push(
                "settings-update",
                {
                    "message": "Error deleting jellyfin server.",
                    "module": "jellyfin-server",
                    "detail": {
                        "action": "delete",
                        "serverName": safeString(req, "body", "name"),
                        "error": safeString(err, "message"),
                    },
                    "level": "danger"
                }
            );
        }
    });

    router.post('/api/jellyfin-servers', async (req, res) => {
        try {
            let report = await jellyfinServerDB.updateServer(req.body);
            res.status(204).send("Jellyfin server updated.");
            let modifiedPrograms = 0;
            let destroyedPrograms = 0;
            report.forEach((r) => {
                modifiedPrograms += r.modifiedPrograms;
                destroyedPrograms += r.destroyedPrograms;
            });
            eventService.push(
                "settings-update",
                {
                    "message": `Jellyfin server ${req.body.name} updated. ${modifiedPrograms} programs modified, ${destroyedPrograms} programs deleted`,
                    "module": "jellyfin-server",
                    "detail": {
                        "serverName": req.body.name,
                        "action": "update",
                        "destroyedPrograms": destroyedPrograms,
                        "modifiedPrograms": modifiedPrograms,
                    },
                    "level": "info"
                }
            );
        } catch (err) {
            console.error("Could not update jellyfin server.", err);
            res.status(400).send("Could not update jellyfin server.");
            eventService.push(
                "settings-update",
                {
                    "message": "Error updating jellyfin server.",
                    "module": "jellyfin-server",
                    "detail": {
                        "action": "update",
                        "serverName": safeString(req, "body", "name"),
                        "error": safeString(err, "message"),
                    },
                    "level": "danger"
                }
            );
        }
    });

    router.put('/api/jellyfin-servers', async (req, res) => {
        try {
            let created = await jellyfinServerDB.addServer(req.body);
            res.status(201).send(created || "Jellyfin server added.");
            eventService.push(
                "settings-update",
                {
                    "message": `Jellyfin server ${created ? created.name : req.body.name} added.`,
                    "module": "jellyfin-server",
                    "detail": {
                        "serverName": created ? created.name : req.body.name,
                        "action": "add"
                    },
                    "level": "info"
                }
            );
        } catch (err) {
            console.error("Could not add jellyfin server.", err);
            res.status(400).send(err.message || "Could not add jellyfin server.");
            eventService.push(
                "settings-update",
                {
                    "message": "Error adding jellyfin server.",
                    "module": "jellyfin-server",
                    "detail": {
                        "action": "add",
                        "serverName": safeString(req, "body", "name"),
                        "error": safeString(err, "message"),
                    },
                    "level": "danger"
                }
            );
        }
    });

    /**
     * Proxy a GET to a configured Jellyfin server so the web UI avoids CORS.
     * Body: { name, path, params }
     * path may include "{userId}" which is replaced after ensureUserId().
     */
    router.post('/api/jellyfin-servers/proxy', async (req, res) => {
        try {
            let name = req.body && req.body.name;
            let path = req.body && req.body.path;
            let params = (req.body && req.body.params) || {};
            if (!name || !path) {
                return res.status(400).send("Missing name or path");
            }
            // Disallow absolute URLs / path traversal
            if (typeof path !== 'string' || path.indexOf('://') !== -1 || path.indexOf('..') !== -1) {
                return res.status(400).send("Invalid path");
            }
            let servers = db['jellyfin-servers'].find({ name: name });
            if (servers.length != 1) {
                return res.status(404).send("Jellyfin server not found");
            }
            let jf = new Jellyfin(servers[0]);
            if (path.indexOf('{userId}') !== -1) {
                // ensureUserId validates GUID / resolves username → Id
                let uid = await jf.ensureUserId();
                path = path.split('{userId}').join(uid);
                // Persist only a validated user GUID
                if (uid && Jellyfin.isLikelyJellyfinUserId(uid) && servers[0].userId !== uid) {
                    try {
                        let row = servers[0];
                        row.userId = uid;
                        db['jellyfin-servers'].update({ _id: row._id }, row);
                    } catch (e) { /* ignore */ }
                }
            }
            if (!path.startsWith('/')) {
                path = '/' + path;
            }
            let data = await jf.Get(path, params);
            res.send(data);
        } catch (err) {
            console.error("Jellyfin proxy error", err);
            res.status(502).send(err.message || "Jellyfin proxy failed");
        }
    });

    // ---- Jellyfin library settings + local cache ----
    function getJellyfinLibrarySettingsDoc() {
        if (jellyfinLibraryCacheService && typeof jellyfinLibraryCacheService.getSettingsDoc === 'function') {
            return jellyfinLibraryCacheService.getSettingsDoc();
        }
        let rows = db['jellyfin-library-settings'].find();
        if (!rows || rows.length === 0) {
            let doc = {
                disabledLibraries: [],
                fillerLibraries: [],
                hiddenLibraries: [],
                autoSyncHours: 0,
                lastGlobalSyncAt: null,
                librarySync: {},
            };
            db['jellyfin-library-settings'].save(doc);
            rows = db['jellyfin-library-settings'].find();
        }
        let doc = rows[0];
        if (!Array.isArray(doc.disabledLibraries)) {
            doc.disabledLibraries = [];
        }
        if (!Array.isArray(doc.fillerLibraries)) {
            doc.fillerLibraries = [];
        }
        if (!Array.isArray(doc.hiddenLibraries)) {
            doc.hiddenLibraries = [];
        }
        return doc;
    }

    function normalizeLibraryRefList(list) {
        if (!Array.isArray(list)) {
            return [];
        }
        return list.map((d) => {
            return {
                serverName: String(d.serverName || ""),
                sectionKey: String(d.sectionKey || ""),
                title: d.title ? String(d.title) : undefined,
                type: d.type ? String(d.type) : undefined,
            };
        }).filter((d) => d.serverName && d.sectionKey);
    }

    router.get('/api/jellyfin-library-settings', (req, res) => {
        try {
            let doc = getJellyfinLibrarySettingsDoc();
            let syncStatus = jellyfinLibraryCacheService
                ? jellyfinLibraryCacheService.getSyncStatus()
                : { autoSyncHours: doc.autoSyncHours || 0, lastGlobalSyncAt: doc.lastGlobalSyncAt || null, librarySync: doc.librarySync || {}, syncing: [] };
            res.send({
                disabledLibraries: doc.disabledLibraries || [],
                fillerLibraries: doc.fillerLibraries || [],
                hiddenLibraries: doc.hiddenLibraries || [],
                autoSyncHours: syncStatus.autoSyncHours || 0,
                lastGlobalSyncAt: syncStatus.lastGlobalSyncAt || null,
                librarySync: syncStatus.librarySync || {},
                syncing: syncStatus.syncing || [],
            });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.put('/api/jellyfin-library-settings', (req, res) => {
        try {
            let doc = getJellyfinLibrarySettingsDoc();
            let disabled = req.body && req.body.disabledLibraries;
            if (!Array.isArray(disabled)) {
                return res.status(400).send("disabledLibraries must be an array");
            }
            doc.disabledLibraries = normalizeLibraryRefList(disabled);
            if (typeof req.body.fillerLibraries !== 'undefined') {
                if (!Array.isArray(req.body.fillerLibraries)) {
                    return res.status(400).send("fillerLibraries must be an array");
                }
                doc.fillerLibraries = normalizeLibraryRefList(req.body.fillerLibraries);
            }
            if (typeof req.body.hiddenLibraries !== 'undefined') {
                if (!Array.isArray(req.body.hiddenLibraries)) {
                    return res.status(400).send("hiddenLibraries must be an array");
                }
                doc.hiddenLibraries = normalizeLibraryRefList(req.body.hiddenLibraries);
            }

            if (typeof req.body.autoSyncHours !== 'undefined') {
                let n = parseFloat(req.body.autoSyncHours);
                if (isNaN(n) || n < 0) n = 0;
                if (n > 168) n = 168;
                doc.autoSyncHours = n;
            }

            if (jellyfinLibraryCacheService && typeof jellyfinLibraryCacheService.saveSettingsDoc === 'function') {
                jellyfinLibraryCacheService.saveSettingsDoc(doc);
            } else {
                db['jellyfin-library-settings'].update({ _id: doc._id }, doc);
            }
            let syncStatus = jellyfinLibraryCacheService
                ? jellyfinLibraryCacheService.getSyncStatus()
                : { autoSyncHours: doc.autoSyncHours || 0, lastGlobalSyncAt: doc.lastGlobalSyncAt || null, librarySync: doc.librarySync || {}, syncing: [] };
            res.send({
                disabledLibraries: doc.disabledLibraries,
                fillerLibraries: doc.fillerLibraries || [],
                hiddenLibraries: doc.hiddenLibraries || [],
                autoSyncHours: syncStatus.autoSyncHours || 0,
                lastGlobalSyncAt: syncStatus.lastGlobalSyncAt || null,
                librarySync: syncStatus.librarySync || {},
                syncing: syncStatus.syncing || [],
            });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.get('/api/jellyfin-library-cache/status', (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            res.send(jellyfinLibraryCacheService.getSyncStatus());
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.post('/api/jellyfin-library-cache/sync-all', async (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            let full = !!(req.body && req.body.full);
            let result = await jellyfinLibraryCacheService.syncAll({ full: full, reason: 'manual' });
            res.send(result);
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.post('/api/jellyfin-library-cache/sync-library', async (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            let serverName = req.body && req.body.serverName;
            let sectionKey = req.body && req.body.sectionKey;
            let full = !!(req.body && req.body.full);
            if (!serverName || sectionKey == null || sectionKey === '') {
                return res.status(400).send("serverName and sectionKey required");
            }
            let result = await jellyfinLibraryCacheService.syncLibrary(serverName, sectionKey, { full: full });
            res.send(result);
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.post('/api/jellyfin-library-cache/delete-library', (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            let serverName = req.body && req.body.serverName;
            let sectionKey = req.body && req.body.sectionKey;
            if (!serverName || sectionKey == null || sectionKey === '') {
                return res.status(400).send("serverName and sectionKey required");
            }
            res.send(jellyfinLibraryCacheService.deleteLibraryCache(serverName, sectionKey));
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.post('/api/jellyfin-library-cache/delete-all', (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            res.send(jellyfinLibraryCacheService.deleteAllCache());
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.get('/api/jellyfin-library-cache/sections/:serverName', (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            let includeDisabled = req.query.includeDisabled === '1' || req.query.includeDisabled === 'true';
            let includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
            let has = jellyfinLibraryCacheService.hasLibraryCache
                ? jellyfinLibraryCacheService.hasLibraryCache(req.params.serverName)
                : jellyfinLibraryCacheService.hasServerCache(req.params.serverName);
            let sections = jellyfinLibraryCacheService.getCachedSections(req.params.serverName, {
                includeDisabled: includeDisabled,
                includeHidden: includeHidden,
            });
            res.send({ fromCache: !!has, sections: sections || [] });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.get('/api/jellyfin-library-cache/playlists/:serverName', (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            let includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
            let r = jellyfinLibraryCacheService.getCachedPlaylistsList(req.params.serverName, {
                includeHidden: includeHidden,
            });
            res.send({ fromCache: !!r.fromCache, playlists: r.list || [] });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.get('/api/jellyfin-library-cache/collections/:serverName', (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            let includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
            let r = jellyfinLibraryCacheService.getCachedCollectionsList(req.params.serverName, {
                includeHidden: includeHidden,
            });
            res.send({ fromCache: !!r.fromCache, collections: r.list || [] });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.get('/api/jellyfin-library-cache/shows/:serverName', (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            let includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
            let r = jellyfinLibraryCacheService.getCachedShowsList(req.params.serverName, {
                includeHidden: includeHidden,
            });
            res.send({ fromCache: !!r.fromCache, shows: r.list || [] });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.post('/api/jellyfin-library-cache/nested', (req, res) => {
        try {
            if (!jellyfinLibraryCacheService) {
                return res.status(503).send("cache service unavailable");
            }
            let serverName = req.body && req.body.serverName;
            let key = req.body && req.body.key;
            let includeCollections = req.body && req.body.includeCollections;
            if (!serverName || key == null) {
                return res.status(400).send("serverName and key required");
            }
            let r = jellyfinLibraryCacheService.getCachedNested(serverName, key, {
                includeCollections: includeCollections,
            });
            if (!r) {
                return res.send({ fromCache: false, nested: null });
            }
            res.send({ fromCache: true, nested: r.nested || [], kind: r.kind, note: r.note });
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    // Channels
    router.get('/api/channels', async (req, res) => {
      try {
        let channels = await channelService.getAllChannelNumbers();
        channels.sort((a, b) => { return a.number < b.number ? -1 : 1 })
        res.send(channels)
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.get('/api/channel/:number', async (req, res) => {
      try {
        let number = parseInt(req.params.number, 10);
        let channel = await channelService.getChannel(number);

        if (channel != null) {
          res.send(channel);
        } else {
            return res.status(404).send("Channel not found");
        }
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.get('/api/channel/programless/:number', async (req, res) => {
      try {
        let number = parseInt(req.params.number, 10);
        let channel = await channelService.getChannel(number);

        if (channel != null) {
          let copy = {};
          Object.keys(channel).forEach( (key) => {
            if (key != 'programs') {
              copy[key] = channel[key];
            }
          } );
          res.send(copy);
        } else {
            return res.status(404).send("Channel not found");
        }
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })

    router.get('/api/channel/programs/:number', async (req, res) => {
      try {
        let number = parseInt(req.params.number, 10);
        let channel = await channelService.getChannel(number);

        if (channel != null) {
          let programs = channel.programs;
          if (typeof(programs) === 'undefined') {
            return res.status(404).send("Channel doesn't have programs?");
          }
          res.writeHead(200, {
            'Content-Type': 'application/json'
          });

          let transformStream = JSONStream.stringify();
          transformStream.pipe(res);

          for (let i = 0; i < programs.length; i++) {
            transformStream.write( programs[i] );
            await throttle();
          }
          transformStream.end();

        } else {
          return res.status(404).send("Channel not found");
        }
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.get('/api/channel/description/:number', async (req, res) => {
      try {
        let number = parseInt(req.params.number, 10);
        let channel = await channelService.getChannel(number);
        if (channel != null) {
            res.send({
                number: channel.number,
                icon: channel.icon,
                name: channel.name,
                stealth: channel.stealth,
                contentSources: channel.contentSources || [],
            });
        } else {
            return res.status(404).send("Channel not found");
        }
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.get('/api/channelNumbers', async (req, res) => {
      try {
        let channels = await channelService.getAllChannelNumbers();
        channels.sort( (a,b) => { return parseInt(a) - parseInt(b) } );
        res.send(channels)
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    // we urgently need an actual channel service
    router.post('/api/channel', async (req, res) => {
      try {
        let previousNumber =
          typeof req.body.previousNumber !== 'undefined'
            ? req.body.previousNumber
            : (typeof req.body.originalNumber !== 'undefined' ? req.body.originalNumber : null);
        await channelService.saveChannel( req.body.number, req.body );
        // Return saved channel so UI can pick up generated logo path, etc.
        let saved = await channelService.getChannel(req.body.number);
        try {
          if (trackedListService) {
            await trackedListService.applyChannelSave(saved || req.body, {
              previousNumber: previousNumber,
            });
          }
        } catch (syncErr) {
          console.error('tracked-list channel sync on create failed', syncErr.message || syncErr);
        }
        res.send( saved || { number: req.body.number } )
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }
    })
    router.put('/api/channel', async (req, res) => {
      try {
        let previousNumber =
          typeof req.body.previousNumber !== 'undefined'
            ? req.body.previousNumber
            : (typeof req.body.originalNumber !== 'undefined' ? req.body.originalNumber : null);
        await channelService.saveChannel( req.body.number, req.body );
        let saved = await channelService.getChannel(req.body.number);
        try {
          if (trackedListService) {
            await trackedListService.applyChannelSave(saved || req.body, {
              previousNumber: previousNumber != null ? previousNumber : req.body.number,
            });
          }
        } catch (syncErr) {
          console.error('tracked-list channel sync on update failed', syncErr.message || syncErr);
        }
        res.send( saved || { number: req.body.number } )
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }

    })
    router.delete('/api/channel', async (req, res) => {
      try {
        await channelService.deleteChannel(req.body.number);
        try {
          if (trackedListService) {
            await trackedListService.applyChannelDelete(req.body.number);
          }
        } catch (syncErr) {
          console.error('tracked-list channel unlink on delete failed', syncErr.message || syncErr);
        }
        res.send( { number: req.body.number} )
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })

    // Enable channel watermark checkbox on all existing channels
    router.post('/api/channels/enable-watermarks', async (req, res) => {
      try {
        let channels = await channelService.getAllChannels();
        let updated = 0;
        for (let i = 0; i < channels.length; i++) {
          let channel = channels[i];
          if (typeof(channel.watermark) === 'undefined' || channel.watermark == null || typeof(channel.watermark) !== 'object') {
            channel.watermark = {
              enabled: true,
              position: "bottom-right",
              width: 10.00,
              verticalMargin: 0.00,
              horizontalMargin: 0.00,
              duration: 0,
            };
          } else {
            channel.watermark.enabled = true;
          }
          await channelService.saveChannel(channel.number, channel);
          updated++;
        }
        res.send({ updated: updated });
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }
    })

    router.post('/api/upload/image', async (req, res) => {
      try {
        if(!req.files) {
            res.send({
                status: false,
                message: 'No file uploaded'
            });
        } else {
            const logo = req.files.image;
            const dbPaths = require('./database-paths');
            logo.mv(path.join(dbPaths.imagesUploadsDir(), logo.name));
            
            res.send({
                status: true,
                message: 'File is uploaded',
                data: {
                    name: logo.name,
                    mimetype: logo.mimetype,
                    size: logo.size,
                    fileUrl: `${req.protocol}://${req.get('host')}/images/uploads/${logo.name}`
                }
            });
        }
      } catch (err) {
          res.status(500).send(err);
      }
    })

    // Plex library enable/disable settings (which libraries dizqueTV will use)
    function getPlexLibrarySettingsDoc() {
      if (plexLibraryCacheService && typeof plexLibraryCacheService.getSettingsDoc === 'function') {
        return plexLibraryCacheService.getSettingsDoc();
      }
      let rows = db['plex-library-settings'].find();
      if (!rows || rows.length === 0) {
        let doc = {
          disabledLibraries: [],
          fillerLibraries: [],
          hiddenLibraries: [],
          autoSyncHours: 0,
          lastGlobalSyncAt: null,
          librarySync: {},
        };
        db['plex-library-settings'].save(doc);
        rows = db['plex-library-settings'].find();
      }
      let doc = rows[0];
      if (!Array.isArray(doc.disabledLibraries)) {
        doc.disabledLibraries = [];
      }
      if (!Array.isArray(doc.fillerLibraries)) {
        doc.fillerLibraries = [];
      }
      if (!Array.isArray(doc.hiddenLibraries)) {
        doc.hiddenLibraries = [];
      }
      return doc;
    }

    router.get('/api/plex-library-settings', (req, res) => {
      try {
        let doc = getPlexLibrarySettingsDoc();
        let syncStatus = plexLibraryCacheService
          ? plexLibraryCacheService.getSyncStatus()
          : { autoSyncHours: doc.autoSyncHours || 0, lastGlobalSyncAt: doc.lastGlobalSyncAt || null, librarySync: doc.librarySync || {}, syncing: [] };
        res.send({
          disabledLibraries: doc.disabledLibraries || [],
          fillerLibraries: doc.fillerLibraries || [],
          hiddenLibraries: doc.hiddenLibraries || [],
          autoSyncHours: syncStatus.autoSyncHours || 0,
          lastGlobalSyncAt: syncStatus.lastGlobalSyncAt || null,
          librarySync: syncStatus.librarySync || {},
          syncing: syncStatus.syncing || [],
        });
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    router.put('/api/plex-library-settings', (req, res) => {
      try {
        let doc = getPlexLibrarySettingsDoc();
        let disabled = req.body && req.body.disabledLibraries;
        if (!Array.isArray(disabled)) {
          return res.status(400).send("disabledLibraries must be an array");
        }
        // Normalize entries
        doc.disabledLibraries = normalizeLibraryRefList(disabled);
        if (typeof req.body.fillerLibraries !== 'undefined') {
          if (!Array.isArray(req.body.fillerLibraries)) {
            return res.status(400).send("fillerLibraries must be an array");
          }
          doc.fillerLibraries = normalizeLibraryRefList(req.body.fillerLibraries);
        }
        if (typeof req.body.hiddenLibraries !== 'undefined') {
          if (!Array.isArray(req.body.hiddenLibraries)) {
            return res.status(400).send("hiddenLibraries must be an array");
          }
          doc.hiddenLibraries = normalizeLibraryRefList(req.body.hiddenLibraries);
        }

        if (typeof req.body.autoSyncHours !== 'undefined') {
          let n = parseFloat(req.body.autoSyncHours);
          if (isNaN(n) || n < 0) n = 0;
          if (n > 168) n = 168;
          doc.autoSyncHours = n;
        }

        if (plexLibraryCacheService && typeof plexLibraryCacheService.saveSettingsDoc === 'function') {
          plexLibraryCacheService.saveSettingsDoc(doc);
        } else {
          db['plex-library-settings'].update({ _id: doc._id }, doc);
        }
        let syncStatus = plexLibraryCacheService
          ? plexLibraryCacheService.getSyncStatus()
          : { autoSyncHours: doc.autoSyncHours || 0, lastGlobalSyncAt: doc.lastGlobalSyncAt || null, librarySync: doc.librarySync || {}, syncing: [] };
        res.send({
          disabledLibraries: doc.disabledLibraries,
          fillerLibraries: doc.fillerLibraries || [],
          hiddenLibraries: doc.hiddenLibraries || [],
          autoSyncHours: syncStatus.autoSyncHours || 0,
          lastGlobalSyncAt: syncStatus.lastGlobalSyncAt || null,
          librarySync: syncStatus.librarySync || {},
          syncing: syncStatus.syncing || [],
        });
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    // ---- Plex library local cache sync ----
    router.get('/api/plex-library-cache/status', (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.status(503).send("cache service unavailable");
        }
        res.send(plexLibraryCacheService.getSyncStatus());
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    router.post('/api/plex-library-cache/sync-all', async (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.status(503).send("cache service unavailable");
        }
        let full = !!(req.body && req.body.full);
        // Long-running: respond after start? For simplicity await (UI can show spinner)
        let result = await plexLibraryCacheService.syncAll({ full: full, reason: 'manual' });
        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ ok: false, error: err.message || String(err) });
      }
    });

    router.post('/api/plex-library-cache/sync-library', async (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.status(503).send("cache service unavailable");
        }
        let serverName = req.body && req.body.serverName;
        let sectionKey = req.body && req.body.sectionKey;
        let full = !!(req.body && req.body.full);
        if (!serverName || sectionKey == null || sectionKey === '') {
          return res.status(400).send("serverName and sectionKey required");
        }
        let result = await plexLibraryCacheService.syncLibrary(serverName, sectionKey, { full: full });
        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ ok: false, error: err.message || String(err) });
      }
    });

    router.post('/api/plex-library-cache/delete-library', (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.status(503).send("cache service unavailable");
        }
        let serverName = req.body && req.body.serverName;
        let sectionKey = req.body && req.body.sectionKey;
        if (!serverName || sectionKey == null || sectionKey === '') {
          return res.status(400).send("serverName and sectionKey required");
        }
        res.send(plexLibraryCacheService.deleteLibraryCache(serverName, sectionKey));
      } catch (err) {
        console.error(err);
        res.status(500).send({ ok: false, error: err.message || String(err) });
      }
    });

    router.post('/api/plex-library-cache/delete-all', (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.status(503).send("cache service unavailable");
        }
        res.send(plexLibraryCacheService.deleteAllCache());
      } catch (err) {
        console.error(err);
        res.status(500).send({ ok: false, error: err.message || String(err) });
      }
    });

    // Cache read APIs used by the browser client
    router.get('/api/plex-library-cache/sections/:serverName', (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.send({ sections: [], fromCache: false });
        }
        let includeDisabled = req.query.includeDisabled === '1';
        let includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
        // Only treat sections as cached when at least one library was synced
        // (playlists-only cache must not suppress live library discovery)
        let has = plexLibraryCacheService.hasLibraryCache
          ? plexLibraryCacheService.hasLibraryCache(req.params.serverName)
          : plexLibraryCacheService.hasServerCache(req.params.serverName);
        let sections = plexLibraryCacheService.getCachedSections(req.params.serverName, {
          includeDisabled: includeDisabled,
          includeHidden: includeHidden,
        });
        res.send({ sections: sections, fromCache: !!has });
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    router.get('/api/plex-library-cache/playlists/:serverName', (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.send({ playlists: null, fromCache: false });
        }
        let includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
        let hit = plexLibraryCacheService.getCachedPlaylistsList(req.params.serverName, {
          includeHidden: includeHidden,
        });
        res.send({ playlists: hit.list, fromCache: !!hit.fromCache });
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    router.get('/api/plex-library-cache/collections/:serverName', (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.send({ collections: [], fromCache: false });
        }
        let includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
        let hit = plexLibraryCacheService.getCachedCollectionsList(req.params.serverName, {
          includeHidden: includeHidden,
        });
        res.send({ collections: hit.list || [], fromCache: !!hit.fromCache });
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    router.get('/api/plex-library-cache/shows/:serverName', (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.send({ shows: [], fromCache: false });
        }
        let includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
        let hit = plexLibraryCacheService.getCachedShowsList(req.params.serverName, {
          includeHidden: includeHidden,
        });
        res.send({ shows: hit.list || [], fromCache: !!hit.fromCache });
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    router.post('/api/plex-library-cache/nested', (req, res) => {
      try {
        if (!plexLibraryCacheService) {
          return res.send({ nested: null, fromCache: false });
        }
        let serverName = req.body && req.body.serverName;
        let key = req.body && req.body.key;
        let includeCollections = !(req.body && req.body.includeCollections === false);
        if (!serverName || !key) {
          return res.status(400).send("serverName and key required");
        }
        let hit = plexLibraryCacheService.getCachedNested(serverName, key, {
          includeCollections: includeCollections,
        });
        if (!hit) {
          return res.send({ nested: null, fromCache: false });
        }
        res.send({ nested: hit.nested, fromCache: true });
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    /**
     * Fast title/summary search against in-memory Plex + Jellyfin library caches.
     * Used by programming UI filters (avoids expanding every show via nested HTTP).
     * Body: { title?, summary?, limit? }
     */
    router.post('/api/library-cache/search', (req, res) => {
      try {
        let body = req.body || {};
        let opts = {
          title: body.title || '',
          summary: body.summary || '',
          limit: body.limit,
        };
        let movies = [];
        let shows = [];
        let episodes = [];
        if (plexLibraryCacheService && typeof plexLibraryCacheService.searchCached === 'function') {
          let pr = plexLibraryCacheService.searchCached(opts);
          movies = movies.concat((pr && pr.movies) || []);
          shows = shows.concat((pr && pr.shows) || []);
          episodes = episodes.concat((pr && pr.episodes) || []);
        }
        if (jellyfinLibraryCacheService && typeof jellyfinLibraryCacheService.searchCached === 'function') {
          let jr = jellyfinLibraryCacheService.searchCached(opts);
          movies = movies.concat((jr && jr.movies) || []);
          shows = shows.concat((jr && jr.shows) || []);
          episodes = episodes.concat((jr && jr.episodes) || []);
        }
        res.send({
          movies: movies,
          shows: shows,
          episodes: episodes,
          fromCache: true,
          movieCount: movies.length,
          showCount: shows.length,
          episodeCount: episodes.length,
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({ error: err.message || String(err) });
      }
    });

    /**
     * Content-sources catalog (channel Properties + bulk import).
     * Always served from local library cache + custom shows — never contacts
     * Plex/Jellyfin live. Empty playlists/collections (count 0) are omitted.
     */
    router.get('/api/content-sources/catalog', async (req, res) => {
      try {
        function hasAddableContent(item) {
          if (!item) return false;
          if (Array.isArray(item.children) && item.children.length === 0) return false;
          if (item.count === null || typeof item.count === 'undefined' || item.count === '') {
            return true;
          }
          let n = parseInt(item.count, 10);
          if (isNaN(n)) return true;
          return n > 0;
        }
        function sortByTitle(list) {
          return (list || []).slice().sort((a, b) => {
            let ta = (a.title || a.name || '').toString();
            let tb = (b.title || b.name || '').toString();
            return ta.localeCompare(tb, undefined, { sensitivity: 'base', numeric: true });
          });
        }
        function tagList(items, serverName, mediaSource, type) {
          let out = [];
          for (let i = 0; i < (items || []).length; i++) {
            let src = items[i];
            if (!hasAddableContent(src)) continue;
            let row = Object.assign({}, src);
            delete row.children;
            row.type = row.type || type;
            row.serverName = serverName;
            row.mediaSource = mediaSource;
            row.source = mediaSource;
            row.serverType = mediaSource;
            out.push(row);
          }
          return out;
        }

        let lists = [];
        let shows = [];
        let warnings = [];
        let serverStatus = [];

        let plexServers = [];
        try {
          plexServers = db['plex-servers'].find() || [];
        } catch (e) {
          plexServers = [];
        }
        for (let s = 0; s < plexServers.length; s++) {
          let server = plexServers[s];
          let name = server.name;
          let st = {
            name: name,
            mediaSource: 'plex',
            playlistsFromCache: false,
            collectionsFromCache: false,
            showsFromCache: false,
          };
          if (plexLibraryCacheService) {
            let pl = plexLibraryCacheService.getCachedPlaylistsList(name);
            let col = plexLibraryCacheService.getCachedCollectionsList(name);
            let sh = plexLibraryCacheService.getCachedShowsList(name);
            st.playlistsFromCache = !!(pl && pl.fromCache);
            st.collectionsFromCache = !!(col && col.fromCache);
            st.showsFromCache = !!(sh && sh.fromCache);
            if (pl && pl.fromCache && Array.isArray(pl.list)) {
              lists = lists.concat(tagList(pl.list, name, 'plex', 'playlist'));
            } else {
              warnings.push('Plex playlists not in cache for "' + name + '" — sync library cache in Library Management.');
            }
            if (col && col.fromCache && Array.isArray(col.list)) {
              lists = lists.concat(tagList(col.list, name, 'plex', 'collection'));
            } else {
              warnings.push('Plex collections not in cache for "' + name + '" — sync library cache in Library Management.');
            }
            if (sh && sh.fromCache && Array.isArray(sh.list)) {
              shows = shows.concat(tagList(sh.list, name, 'plex', 'show'));
            } else {
              warnings.push('Plex TV shows not in cache for "' + name + '" — sync library cache in Library Management.');
            }
          } else {
            warnings.push('Plex library cache service unavailable.');
          }
          serverStatus.push(st);
        }

        let jfServers = [];
        try {
          jfServers = db['jellyfin-servers'].find() || [];
        } catch (e) {
          jfServers = [];
        }
        for (let s = 0; s < jfServers.length; s++) {
          let server = jfServers[s];
          let name = server.name;
          let st = {
            name: name,
            mediaSource: 'jellyfin',
            playlistsFromCache: false,
            collectionsFromCache: false,
            showsFromCache: false,
          };
          if (jellyfinLibraryCacheService) {
            let pl = jellyfinLibraryCacheService.getCachedPlaylistsList(name);
            let col = jellyfinLibraryCacheService.getCachedCollectionsList(name);
            let sh = jellyfinLibraryCacheService.getCachedShowsList(name);
            st.playlistsFromCache = !!(pl && pl.fromCache);
            st.collectionsFromCache = !!(col && col.fromCache);
            st.showsFromCache = !!(sh && sh.fromCache);
            if (pl && pl.fromCache && Array.isArray(pl.list)) {
              lists = lists.concat(tagList(pl.list, name, 'jellyfin', 'playlist'));
            } else {
              warnings.push('Jellyfin playlists not in cache for "' + name + '" — sync library cache in Library Management.');
            }
            if (col && col.fromCache && Array.isArray(col.list)) {
              lists = lists.concat(tagList(col.list, name, 'jellyfin', 'collection'));
            } else {
              warnings.push('Jellyfin collections not in cache for "' + name + '" — sync library cache in Library Management.');
            }
            if (sh && sh.fromCache && Array.isArray(sh.list)) {
              shows = shows.concat(tagList(sh.list, name, 'jellyfin', 'show'));
            } else {
              warnings.push('Jellyfin TV shows not in cache for "' + name + '" — sync library cache in Library Management.');
            }
          } else {
            warnings.push('Jellyfin library cache service unavailable.');
          }
          serverStatus.push(st);
        }

        let customShows = [];
        try {
          let customs = await customShowDB.getAllShowsInfo();
          for (let i = 0; i < (customs || []).length; i++) {
            let cs = customs[i];
            customShows.push({
              type: 'custom',
              key: cs.id,
              title: cs.name,
              name: cs.name,
              count: cs.count,
              serverName: '',
              mediaSource: 'custom',
              source: 'custom',
              serverType: 'custom',
            });
          }
        } catch (err) {
          console.error(err);
          warnings.push('Failed to load custom programming.');
        }

        lists = sortByTitle(lists);
        shows = sortByTitle(shows);
        customShows = sortByTitle(customShows);

        res.send({
          lists: lists,
          shows: shows,
          customShows: customShows,
          servers: serverStatus,
          warnings: warnings,
          fromCache: true,
        });
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });

    // ---- External list import (Trakt / Letterboxd / paste) ----
    router.get('/api/external-lists/settings', (req, res) => {
        try {
            res.send(externalListService.getPublicSettings());
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.put('/api/external-lists/settings', (req, res) => {
        try {
            let saved = externalListService.saveSettings(req.body || {});
            res.send(Object.assign({ ok: true }, saved));
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    /**
     * Resolve a list URL and/or pasted CSV/titles against local library cache.
     * Body: { url?, text?, traktClientId? }
     */
    router.post('/api/external-lists/resolve', async (req, res) => {
        try {
            let result = await externalListService.resolve(req.body || {});
            res.send(result);
        } catch (err) {
            console.error('external-list resolve failed', err);
            res.status(400).send({
                ok: false,
                error: err.message || String(err),
                warnings: err.warnings || [],
                provider: err.provider || null,
            });
        }
    });

    // ---- Tracked lists (Library → Lists; refreshable like Radarr/Sonarr) ----
    router.get('/api/tracked-lists', (req, res) => {
        try {
            res.send(trackedListService.listSummaries());
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    /** Plex libraries that can receive a playlist from Lists */
    router.get('/api/tracked-lists/plex-libraries', (req, res) => {
        try {
            res.send({
                libraries: trackedListService.listPlexLibrariesForPlaylists(),
                hasPlex: trackedListService._hasPlexServer(),
                hasJellyfin: trackedListService._hasJellyfinServer(),
            });
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.get('/api/tracked-lists/:id', (req, res) => {
        try {
            let doc = trackedListService.get(req.params.id);
            if (!doc) return res.status(404).send({ ok: false, error: 'List not found' });
            res.send(doc);
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    /** Full matched programs for a tracked list (content sources / add programming) */
    router.get('/api/tracked-lists/:id/programs', (req, res) => {
        try {
            let programs = trackedListService.getPrograms(req.params.id);
            if (programs === null) {
                return res.status(404).send({ ok: false, error: 'List not found' });
            }
            res.send({ id: req.params.id, programs: programs, count: programs.length });
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.post('/api/tracked-lists', async (req, res) => {
        try {
            let created = await trackedListService.create(req.body || {});
            res.status(201).send(created);
        } catch (err) {
            console.error('tracked-list create failed', err);
            res.status(400).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.put('/api/tracked-lists/:id', async (req, res) => {
        try {
            let updated = await trackedListService.updateMeta(req.params.id, req.body || {});
            res.send(updated);
        } catch (err) {
            console.error(err);
            res.status(400).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.post('/api/tracked-lists/:id/refresh', async (req, res) => {
        try {
            let body = req.body || {};
            let refreshed = await trackedListService.refresh(req.params.id, {
                createChannel: body.createChannel === true,
                syncChannel: body.syncChannel !== false,
                renameChannel: body.renameChannel === true,
                traktClientId: body.traktClientId,
            });
            res.send(refreshed);
        } catch (err) {
            console.error('tracked-list refresh failed', err);
            res.status(400).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.post('/api/tracked-lists/refresh-all', async (req, res) => {
        try {
            let body = req.body || {};
            let result = await trackedListService.refreshAll({
                syncChannel: body.syncChannel !== false,
            });
            res.send(result);
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    router.delete('/api/tracked-lists/:id', async (req, res) => {
        try {
            res.send(await trackedListService.delete(req.params.id));
        } catch (err) {
            console.error(err);
            res.status(500).send({ ok: false, error: err.message || String(err) });
        }
    });

    // Filler
    router.get('/api/fillers', async (req, res) => {
      try {
        let fillers = await fillerDB.getAllFillersInfo();
        res.send(fillers);
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.get('/api/filler/:id', async (req, res) => {
      try {
        let id = req.params.id;
        if (typeof(id) === 'undefined') {
          return res.status(400).send("Missing id");
        }
        let filler = await fillerDB.getFiller(id);
        if (filler == null) {
            return res.status(404).send("Filler not found");
        }
        res.send(filler);
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.post('/api/filler/:id', async (req, res) => {
      try {
        let id = req.params.id;
        if (typeof(id) === 'undefined') {
          return res.status(400).send("Missing id");
        }
        await fillerDB.saveFiller(id, req.body );
        return res.status(204).send({});
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.put('/api/filler', async (req, res) => {
      try {
        let uuid = await fillerDB.createFiller(req.body );
        return res.status(201).send({id: uuid});
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.delete('/api/filler/:id', async (req, res) => {
      try {
        let id = req.params.id;
        if (typeof(id) === 'undefined') {
          return res.status(400).send("Missing id");
        }
        await fillerDB.deleteFiller(id);
        return res.status(204).send({});
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })

    router.get('/api/filler/:id/channels', async(req, res) => {
      try {
        let id = req.params.id;
        if (typeof(id) === 'undefined') {
          return res.status(400).send("Missing id");
        }
        let channels = await fillerDB.getFillerChannels(id);
        if (channels == null) {
            return res.status(404).send("Filler not found");
        }
        res.send(channels);
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }
    } );


    // Custom Shows
    /**
     * Persist custom show and optionally push Plex/Jellyfin playlists (Lists parity).
     * Returns the saved show (with playlist ids / push errors when applicable).
     */
    async function saveCustomShowWithPlaylistPush(id, body) {
        let show = Object.assign({}, body || {});
        delete show.id;
        let movieKey = show.plexMovieSectionKey || show.plexSectionKey;
        let tvKey = show.plexTvSectionKey;
        if (show.pushToPlex && !movieKey && !tvKey) {
            throw new Error('Select a Plex Movies and/or TV library for the playlist.');
        }
        // Preserve existing playlist ids when updating so replace works
        if (id) {
            let prev = await customShowDB.getShow(id);
            if (prev) {
                if (show.plexMoviePlaylistId == null && (prev.plexMoviePlaylistId || prev.plexPlaylistId)) {
                    show.plexMoviePlaylistId = prev.plexMoviePlaylistId || prev.plexPlaylistId;
                }
                if (show.plexTvPlaylistId == null && prev.plexTvPlaylistId) {
                    show.plexTvPlaylistId = prev.plexTvPlaylistId;
                }
                if (show.plexPlaylistId == null && prev.plexPlaylistId) {
                    show.plexPlaylistId = prev.plexPlaylistId;
                }
                if (show.jellyfinPlaylistId == null && prev.jellyfinPlaylistId) {
                    show.jellyfinPlaylistId = prev.jellyfinPlaylistId;
                }
            }
        }
        if (id) {
            await customShowDB.saveShow(id, show);
        } else {
            id = await customShowDB.createShow(show);
        }
        let saved = await customShowDB.getShow(id);
        if (!saved) {
            throw new Error('Failed to load saved custom show');
        }
        if (saved.pushToPlex || saved.pushToJellyfin) {
            let doc = {
                name: saved.name,
                pushToPlex: !!saved.pushToPlex,
                pushToJellyfin: !!saved.pushToJellyfin,
                plexMovieServerName: saved.plexMovieServerName || saved.plexServerName || null,
                plexMovieSectionKey:
                    saved.plexMovieSectionKey != null
                        ? String(saved.plexMovieSectionKey)
                        : (saved.plexSectionKey != null ? String(saved.plexSectionKey) : null),
                plexMovieLibraryTitle: saved.plexMovieLibraryTitle || saved.plexLibraryTitle || null,
                plexMoviePlaylistId: saved.plexMoviePlaylistId || saved.plexPlaylistId || null,
                plexTvServerName: saved.plexTvServerName || null,
                plexTvSectionKey:
                    saved.plexTvSectionKey != null ? String(saved.plexTvSectionKey) : null,
                plexTvLibraryTitle: saved.plexTvLibraryTitle || null,
                plexTvPlaylistId: saved.plexTvPlaylistId || null,
                plexServerName: saved.plexMovieServerName || saved.plexServerName || null,
                plexSectionKey:
                    saved.plexMovieSectionKey != null
                        ? String(saved.plexMovieSectionKey)
                        : (saved.plexSectionKey != null ? String(saved.plexSectionKey) : null),
                plexLibraryTitle: saved.plexMovieLibraryTitle || saved.plexLibraryTitle || null,
                plexPlaylistId: saved.plexMoviePlaylistId || saved.plexPlaylistId || null,
                jellyfinPlaylistId: saved.jellyfinPlaylistId || null,
            };
            try {
                await trackedListService.pushPlaylistsFromPrograms(doc, saved.content || []);
                saved.plexMoviePlaylistId = doc.plexMoviePlaylistId || null;
                saved.plexTvPlaylistId = doc.plexTvPlaylistId || null;
                saved.plexPlaylistId = doc.plexMoviePlaylistId || doc.plexPlaylistId || null;
                saved.jellyfinPlaylistId = doc.jellyfinPlaylistId || null;
                saved.lastPlaylistPushAt = doc.lastPlaylistPushAt || Date.now();
                saved.lastPlaylistPushError = doc.lastPlaylistPushError || null;
            } catch (pushErr) {
                console.error('custom-show playlist push failed', pushErr);
                saved.lastPlaylistPushAt = Date.now();
                saved.lastPlaylistPushError = pushErr.message || String(pushErr);
            }
            await customShowDB.saveShow(id, saved);
            saved = await customShowDB.getShow(id);
        } else {
            // Clear push error when disabled; keep last playlist ids for re-enable
            if (saved.lastPlaylistPushError) {
                saved.lastPlaylistPushError = null;
                await customShowDB.saveShow(id, saved);
            }
        }
        return saved;
    }

    router.get('/api/shows', async (req, res) => {
      try {
        let fillers = await customShowDB.getAllShowsInfo();
        res.send(fillers);
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.get('/api/show/:id', async (req, res) => {
      try {
        let id = req.params.id;
        if (typeof(id) === 'undefined') {
          return res.status(400).send("Missing id");
        }
        let filler = await customShowDB.getShow(id);
        if (filler == null) {
            return res.status(404).send("Custom show not found");
        }
        res.send(filler);
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.post('/api/show/:id', async (req, res) => {
      try {
        let id = req.params.id;
        if (typeof(id) === 'undefined') {
          return res.status(400).send("Missing id");
        }
        let saved = await saveCustomShowWithPlaylistPush(id, req.body);
        return res.status(200).send(saved || {});
      } catch(err) {
        console.error(err);
        res.status(400).send({ error: err.message || String(err) });
      }
    })
    router.put('/api/show', async (req, res) => {
      try {
        let saved = await saveCustomShowWithPlaylistPush(null, req.body);
        return res.status(201).send({ id: saved.id, show: saved });
      } catch(err) {
        console.error(err);
        res.status(400).send({ error: err.message || String(err) });
      }
    })
    router.delete('/api/show/:id', async (req, res) => {
      try {
        let id = req.params.id;
        if (typeof(id) === 'undefined') {
          return res.status(400).send("Missing id");
        }
        await customShowDB.deleteShow(id);
        return res.status(204).send({});
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    });

    // FFMPEG SETTINGS
    router.get('/api/ffmpeg-settings', (req, res) => {
      try {
        let ffmpeg = ffmpegSettingsService.get();
        res.send(ffmpeg)
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.put('/api/ffmpeg-settings', (req, res) => {
      try {
        let result = ffmpegSettingsService.update(req.body);
        let err = result.error

        if (typeof(err) !== 'undefined') {
          return res.status(400).send(err);
        }
        // Stream mode affects M3U channel URLs
        if (m3uService && typeof m3uService.clearCache === 'function') {
          m3uService.clearCache();
        }
        eventService.push(
          "settings-update",
          {
            "message": "FFMPEG configuration updated.",
            "module" : "ffmpeg",
            "detail" : {
              "action" : "update"
            },
            "level" : "info"
          }
        );
        res.send(result.ffmpeg)
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
       eventService.push(
        "settings-update",
        {
          "message": "Error updating FFMPEG configuration.",
          "module" : "ffmpeg",
          "detail" : {
            "action": "update",
            "error" : safeString(err, "message"),
          },
          "level" : "danger"
        }
       );

      }
    })
    router.post('/api/ffmpeg-settings', (req, res) => { // RESET
      try {
        let ffmpeg = ffmpegSettingsService.reset();
        if (m3uService && typeof m3uService.clearCache === 'function') {
          m3uService.clearCache();
        }

        eventService.push(
          "settings-update",
          {
            "message": "FFMPEG configuration reset.",
            "module" : "ffmpeg",
            "detail" : {
              "action" : "reset"
            },
            "level" : "warning"
          }
        );
        res.send(ffmpeg)
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
        eventService.push(
          "settings-update",
          {
            "message": "Error reseting FFMPEG configuration.",
            "module" : "ffmpeg",
            "detail" : {
              "action": "reset",
              "error" : safeString(err, "message"),
            },
            "level" : "danger"
          }
        );

      }

    })

    // ---- Jellyfin path / stream settings ----
    function ensureJellyfinSettingsDoc() {
        let rows = db['jellyfin-settings'].find();
        if (!rows || rows.length === 0) {
            db['jellyfin-settings'].save({
                streamPath: 'jellyfin',
                pathReplace: '',
                pathReplaceWith: '',
            });
            rows = db['jellyfin-settings'].find();
        }
        let doc = rows[0];
        if (typeof doc.streamPath === 'undefined' || !doc.streamPath) {
            doc.streamPath = 'jellyfin';
        }
        if (typeof doc.pathReplace === 'undefined' || doc.pathReplace === null) {
            doc.pathReplace = '';
        }
        if (typeof doc.pathReplaceWith === 'undefined' || doc.pathReplaceWith === null) {
            doc.pathReplaceWith = '';
        }
        return doc;
    }

    router.get('/api/jellyfin-settings', (req, res) => {
        try {
            res.send(ensureJellyfinSettingsDoc());
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.put('/api/jellyfin-settings', (req, res) => {
        try {
            let doc = ensureJellyfinSettingsDoc();
            let next = {
                streamPath: (req.body && req.body.streamPath === 'direct') ? 'direct' : 'jellyfin',
                pathReplace: (req.body && typeof req.body.pathReplace === 'string') ? req.body.pathReplace : '',
                pathReplaceWith: (req.body && typeof req.body.pathReplaceWith === 'string') ? req.body.pathReplaceWith : '',
            };
            db['jellyfin-settings'].update({ _id: doc._id }, next);
            let saved = db['jellyfin-settings'].find()[0];
            res.send(saved);
            eventService.push(
                "settings-update",
                {
                    "message": "Jellyfin path settings updated.",
                    "module": "jellyfin",
                    "detail": { "action": "update" },
                    "level": "info"
                }
            );
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
            eventService.push(
                "settings-update",
                {
                    "message": "Error updating Jellyfin configuration",
                    "module": "jellyfin",
                    "detail": {
                        "action": "update",
                        "error": safeString(err, "message"),
                    },
                    "level": "danger"
                }
            );
        }
    });

    router.post('/api/jellyfin-settings', (req, res) => {
        try {
            let doc = ensureJellyfinSettingsDoc();
            let reset = {
                streamPath: 'jellyfin',
                pathReplace: '',
                pathReplaceWith: '',
            };
            db['jellyfin-settings'].update({ _id: doc._id }, reset);
            res.send(db['jellyfin-settings'].find()[0]);
            eventService.push(
                "settings-update",
                {
                    "message": "Jellyfin path settings reset.",
                    "module": "jellyfin",
                    "detail": { "action": "reset" },
                    "level": "warning"
                }
            );
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    // PLEX SETTINGS
    router.get('/api/plex-settings', (req, res) => {
      try {
        let plex = db['plex-settings'].find()[0]
        res.send(plex)
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.put('/api/plex-settings', (req, res) => {
      try {
        db['plex-settings'].update({ _id: req.body._id }, req.body)
        let plex = db['plex-settings'].find()[0]
        res.send(plex)
        eventService.push(
          "settings-update",
          {
            "message": "Plex configuration updated.",
            "module" : "plex",
            "detail" : {
              "action" : "update"
            },
            "level" : "info"
          }
        );

      } catch(err) {
        console.error(err);
       res.status(500).send("error");
        eventService.push(
          "settings-update",
          {
            "message": "Error updating Plex configuration",
            "module" : "plex",
            "detail" : {
              "action": "update",
              "error" : safeString(err, "message"),
            },
            "level" : "danger"
          }
        );

      }

    })
    router.post('/api/plex-settings', (req, res) => { // RESET
      try {
        db['plex-settings'].update({ _id: req.body._id }, {
            streamPath: 'plex',
            debugLogging: true,
            directStreamBitrate: '20000',
            transcodeBitrate: '2000',
            mediaBufferSize: 1000,
            transcodeMediaBufferSize: 20000,
            maxPlayableResolution: "1920x1080",
            maxTranscodeResolution: "1920x1080",
            videoCodecs: 'h264,hevc,mpeg2video,av1',
            audioCodecs: 'ac3',
            maxAudioChannels: '2',
            audioBoost: '100',
            enableSubtitles: false,
            subtitleSize: '100',
            updatePlayStatus: false,
            streamProtocol: 'http',
            forceDirectPlay: false,
            pathReplace: '',
            pathReplaceWith: ''
        })
        let plex = db['plex-settings'].find()[0]
        res.send(plex)
        eventService.push(
          "settings-update",
          {
            "message": "Plex configuration reset.",
            "module" : "plex",
            "detail" : {
              "action" : "reset"
            },
            "level" : "warning"
          }
        );
      } catch(err) {
        console.error(err);
       res.status(500).send("error");

        eventService.push(
          "settings-update",
          {
            "message": "Error reseting Plex configuration",
            "module" : "plex",
            "detail" : {
            "action": "reset",
            "error" : safeString(err, "message"),
          },
            "level" : "danger"
          }
        );


      }

    })

    router.get('/api/xmltv-last-refresh', (req, res) => {
      try {
        res.send(JSON.stringify({ value: xmltvInterval.lastUpdated.valueOf() }))
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }

    })

    // XMLTV SETTINGS
    router.get('/api/xmltv-settings', (req, res) => {
      try {
        let xmltv = db['xmltv-settings'].find()[0]
        res.send(xmltv)
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }

    })
    router.put('/api/xmltv-settings', (req, res) => {
      try {
        let xmltv = db['xmltv-settings'].find()[0]
        db['xmltv-settings'].update(
            { _id: req.body._id },
            {
                _id: req.body._id,
                cache:   req.body.cache,
                refresh: req.body.refresh,
                enableImageCache: (req.body.enableImageCache === true),
                file: xmltv.file,
            }
        );
        xmltv = db['xmltv-settings'].find()[0]
        res.send(xmltv)
        eventService.push(
          "settings-update",
          {
            "message": "xmltv settings updated.",
            "module" : "xmltv",
            "detail" : {
              "action" : "update"
            },
            "level" : "info"
          }
        );
        updateXmltv()
      } catch(err) {
        console.error(err);
        res.status(500).send("error");

        eventService.push(
          "settings-update",
          {
            "message": "Error updating xmltv configuration",
            "module" : "xmltv",
            "detail" : {
            "action": "update",
            "error" : safeString(err, "message"),
          },
            "level" : "danger"
          }
        );

      }

    })
    router.post('/api/xmltv-settings', (req, res) => {
      try {
        db['xmltv-settings'].update({ _id: req.body._id }, {
            _id: req.body._id,
            cache: 12,
            refresh: 4,
            file: require('./database-paths').xmltvFile()
        })
        var xmltv = db['xmltv-settings'].find()[0]
        res.send(xmltv)
        eventService.push(
          "settings-update",
          {
            "message": "xmltv settings reset.",
            "module" : "xmltv",
            "detail" : {
              "action" : "reset"
            },
            "level" : "warning"
          }
        );

        updateXmltv()
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
        eventService.push(
          "settings-update",
          {
            "message": "Error reseting xmltv configuration",
            "module" : "xmltv",
            "detail" : {
              "action": "reset",
              "error" : safeString(err, "message"),
            },
            "level" : "danger"
          }
        );

      }
    })

    router.get('/api/guide/status', async (req, res) => {
        try {
            let s = await guideService.getStatus();
            res.send(s);
        } catch(err) {
            console.error(err);
            res.status(500).send("error");
        }
    });

    router.get('/api/guide/debug', async (req, res) => {
      try {
          let s = await guideService.get();
          res.send(s);
      } catch(err) {
          console.error(err);
          res.status(500).send("error");
      }
  });


    router.get('/api/guide/channels/:number', async (req, res) => {
        try {
            let dateFrom = new Date(req.query.dateFrom);
            let dateTo = new Date(req.query.dateTo);
            let lineup = await guideService.getChannelLineup(  req.params.number , dateFrom, dateTo );
            if (lineup == null) {
              console.log(`GET /api/guide/channels/${req.params.number} : 404 Not Found`);
              res.status(404).send("Channel not found in TV guide");
            } else {
              res.send( lineup );
            }
        } catch (err) {
            console.error(err);
            res.status(500).send("error");
        }
    });


    //HDHR SETTINGS
    // ImageMagick settings (executable path for dynamic channel logos)
    router.get('/api/imagemagick-settings', (req, res) => {
      try {
        if (!imagemagickSettingsService) {
          return res.send({ magickPath: '' });
        }
        res.send(imagemagickSettingsService.get());
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
      }
    });
    router.put('/api/imagemagick-settings', (req, res) => {
      try {
        if (!imagemagickSettingsService) {
          return res.status(500).send("ImageMagick settings unavailable");
        }
        let saved = imagemagickSettingsService.update(req.body || {});
        eventService.push(
          "settings-update",
          {
            "message": "ImageMagick configuration updated.",
            "module": "imagemagick",
            "detail": { "action": "update" },
            "level": "info"
          }
        );
        res.send(saved);
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
        eventService.push(
          "settings-update",
          {
            "message": "Error updating ImageMagick configuration.",
            "module": "imagemagick",
            "detail": {
              "action": "update",
              "error": safeString(err, "message"),
            },
            "level": "danger"
          }
        );
      }
    });
    router.post('/api/imagemagick-settings', (req, res) => {
      try {
        if (!imagemagickSettingsService) {
          return res.status(500).send("ImageMagick settings unavailable");
        }
        let saved = imagemagickSettingsService.reset();
        eventService.push(
          "settings-update",
          {
            "message": "ImageMagick configuration reset.",
            "module": "imagemagick",
            "detail": { "action": "reset" },
            "level": "warning"
          }
        );
        res.send(saved);
      } catch (err) {
        console.error(err);
        res.status(500).send("error");
        eventService.push(
          "settings-update",
          {
            "message": "Error resetting ImageMagick configuration.",
            "module": "imagemagick",
            "detail": {
              "action": "reset",
              "error": safeString(err, "message"),
            },
            "level": "danger"
          }
        );
      }
    });
    router.post('/api/imagemagick-settings/test', (req, res) => {
      try {
        if (!imagemagickSettingsService) {
          return res.send({ ok: false, error: "ImageMagick settings unavailable" });
        }
        res.send(imagemagickSettingsService.test(req.body || {}));
      } catch (err) {
        console.error(err);
        res.status(500).send({ ok: false, error: err.message || String(err) });
      }
    });

    router.get('/api/hdhr-settings', (req, res) => {
      try {
        let hdhr = db['hdhr-settings'].find()[0]
        res.send(hdhr)
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }

    })
    router.put('/api/hdhr-settings', (req, res) => {
      try {
        db['hdhr-settings'].update({ _id: req.body._id }, req.body)
        let hdhr = db['hdhr-settings'].find()[0]
        res.send(hdhr)
        eventService.push(
          "settings-update",
          {
            "message": "HDHR configuration updated.",
            "module" : "hdhr",
            "detail" : {
              "action" : "update"
            },
            "level" : "info"
          }
        );

      } catch(err) {
        console.error(err);
        res.status(500).send("error");
        eventService.push(
          "settings-update",
          {
            "message": "Error updating HDHR configuration",
            "module" : "hdhr",
            "detail" : {
              "action": "action",
              "error" : safeString(err, "message"),
            },
            "level" : "danger"
          }
        );

      }

    })
    router.post('/api/hdhr-settings', (req, res) => {
      try {
        db['hdhr-settings'].update({ _id: req.body._id }, {
            _id: req.body._id,
            tunerCount: 1,
            autoDiscovery: true,
        })
        var hdhr = db['hdhr-settings'].find()[0]
        res.send(hdhr)
        eventService.push(
          "settings-update",
          {
            "message": "HDHR configuration reset.",
            "module" : "hdhr",
            "detail" : {
              "action" : "reset"
            },
            "level" : "warning"
          }
        );

      } catch(err) {
        console.error(err);
        res.status(500).send("error");
        eventService.push(
          "settings-update",
          {
            "message": "Error reseting HDHR configuration",
            "module" : "hdhr",
            "detail" : {
              "action": "reset",
              "error" : safeString(err, "message"),
            },
            "level" : "danger"
          }
        );

      }

    })


    // XMLTV.XML Download
    router.get('/api/xmltv.xml', async (req, res) => {
      try {
        // Prefer forwarded host when behind reverse proxy (helps HTTPS logo URLs for TV clients)
        const xfProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
        const protocol = xfProto || req.protocol;
        const hostHeader = req.get('x-forwarded-host') || req.get('host');
        const host = `${protocol}://${hostHeader}`;

        res.set('Cache-Control', 'no-store')
        res.type('application/xml');


        let xmltvSettings = db['xmltv-settings'].find()[0];
        const fileContent = await fs.readFileSync(xmltvSettings.file, 'utf8');
        // Replace {{host}} and rewrite leftover localhost / private-LAN asset URLs
        // so Google TV / Plex apps can fetch channel logos (web often worked anyway).
        const { rewriteXmltvIconHosts } = require('./icon-url');
        const fileFinal = rewriteXmltvIconHosts(fileContent, host);
        res.send(fileFinal);
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }

    })

    //tool services
    router.post('/api/channel-tools/time-slots', async (req, res) => {
      try {
        let toolRes = await timeSlotsService(req.body.programs, req.body.schedule);
        if ( typeof(toolRes.userError) !=='undefined') {
          console.error("time slots error: " + toolRes.userError);
          return res.status(400).send(toolRes.userError);
        }
        await streamToolResult(toolRes, res);
      } catch(err) {
        console.error(err);
        res.status(500).send("Internal error");
      }
    });

    router.post('/api/channel-tools/random-slots', async (req, res) => {
      try {
        let toolRes = await randomSlotsService(req.body.programs, req.body.schedule);
        if ( typeof(toolRes.userError) !=='undefined') {
          console.error("random slots error: " + toolRes.userError);
          return res.status(400).send(toolRes.userError);
        }
        await streamToolResult(toolRes, res);
      } catch(err) {
        console.error(err);
        res.status(500).send("Internal error");
      }
    });

    // CHANNELS.M3U Download 
    router.get('/api/channels.m3u', async (req, res) => {
      try {
        res.type('text');

        const xfProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
        const protocol = xfProto || req.protocol;
        const hostHeader = req.get('x-forwarded-host') || req.get('host');
        const host = `${protocol}://${hostHeader}`;
        const data = await m3uService.getChannelList(host);

        res.send(data);

      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }

    })


    function updateXmltv() {
        xmltvInterval.updateXML()
        xmltvInterval.restartInterval()
    }
    async function streamToolResult(toolRes, res) {
      let programs = toolRes.programs;
      delete toolRes.programs;
      let s = JSON.stringify(toolRes);
      s = s.slice(0, -1);

      res.writeHead(200, {
        'Content-Type': 'application/json'
      });

      let transformStream = JSONStream.stringify(
        s + ',"programs":[',
        ',' ,
        ']}');
      transformStream.pipe(res);

      for (let i = 0; i < programs.length; i++) {
        transformStream.write( programs[i] );
        await throttle();
      }
      transformStream.end();
    }

    // -------------------------------------------------------------------------
    // Config export / import (zip of config/ + images/)
    // -------------------------------------------------------------------------
    const configTransfer = require('./services/config-transfer-service');

    /**
     * Download a zip of the current config/ and images/ directories.
     */
    router.get('/api/config/export', async (req, res) => {
        let zipPath = null;
        try {
            let exported = await configTransfer.exportConfigZip();
            zipPath = exported.path;
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader(
                'Content-Disposition',
                'attachment; filename="' + exported.filename + '"'
            );
            res.setHeader('Content-Length', String(exported.bytes));
            let stream = fs.createReadStream(zipPath);
            stream.on('error', (err) => {
                console.error(err);
                if (!res.headersSent) {
                    res.status(500).send('Failed to read export zip.');
                }
            });
            stream.on('close', () => {
                try {
                    if (zipPath && fs.existsSync(zipPath)) {
                        fs.unlinkSync(zipPath);
                    }
                } catch (e) { /* ignore temp cleanup */ }
            });
            stream.pipe(res);
        } catch (err) {
            console.error(err);
            try {
                if (zipPath && fs.existsSync(zipPath)) {
                    fs.unlinkSync(zipPath);
                }
            } catch (e) { /* ignore */ }
            if (!res.headersSent) {
                res.status(500).send({
                    message: 'Failed to export configuration.',
                    error: err && err.message ? err.message : String(err),
                });
            }
        }
    });

    /**
     * Import a config zip. Backs up current config+images to backup/backup{ts}.zip
     * then replaces config/ and images/ with the archive contents.
     * Multipart field name: file
     */
    router.post('/api/config/import', async (req, res) => {
        try {
            if (!req.files || !req.files.file) {
                return res.status(400).send({
                    message: 'No zip file uploaded. Use form field "file".',
                });
            }
            let uploaded = req.files.file;
            let name = (uploaded.name || '').toLowerCase();
            if (name && !name.endsWith('.zip')) {
                return res.status(400).send({
                    message: 'Import file must be a .zip archive.',
                });
            }
            // Prefer temp path if express-fileupload wrote one; otherwise use buffer
            let source = uploaded.tempFilePath || uploaded.data;
            if (!source) {
                return res.status(400).send({ message: 'Empty upload.' });
            }
            try {
                let result = await configTransfer.importConfigZip(source);
                res.send({
                    status: true,
                    message:
                        'Configuration imported. A backup of the previous config was saved. ' +
                        'Reload the page to use the new configuration.',
                    backupFilename: result.backupFilename,
                    backupBytes: result.backupBytes,
                    reloadRequired: true,
                });
            } finally {
                // Clean express-fileupload temp file when present
                try {
                    if (uploaded.tempFilePath && fs.existsSync(uploaded.tempFilePath)) {
                        fs.unlinkSync(uploaded.tempFilePath);
                    }
                } catch (e) { /* ignore */ }
            }
        } catch (err) {
            console.error(err);
            res.status(500).send({
                message: 'Failed to import configuration.',
                error: err && err.message ? err.message : String(err),
            });
        }
    });

    return router
}


