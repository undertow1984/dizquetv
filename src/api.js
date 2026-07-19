
const express = require('express')
const path = require('path')
const fs = require('fs')
const constants = require('./constants');
const JSONStream = require('JSONStream');
const FFMPEGInfo = require('./ffmpeg-info');
const PlexServerDB = require('./dao/plex-server-db');
const Plex = require("./plex.js");

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
function api(db, channelService, fillerDB, customShowDB, xmltvInterval,  guideService, _m3uService, eventService, ffmpegSettingsService, plexLibraryCacheService, imagemagickSettingsService ) {
    let m3uService = _m3uService;
    const router = express.Router()
    const plexServerDB = new PlexServerDB(channelService, fillerDB, customShowDB, db);

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
        await channelService.saveChannel( req.body.number, req.body );
        // Return saved channel so UI can pick up generated logo path, etc.
        let saved = await channelService.getChannel(req.body.number);
        res.send( saved || { number: req.body.number } )
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }
    })
    router.put('/api/channel', async (req, res) => {
      try {
        await channelService.saveChannel( req.body.number, req.body );
        let saved = await channelService.getChannel(req.body.number);
        res.send( saved || { number: req.body.number } )
      } catch(err) {
        console.error(err);
        res.status(500).send("error");
      }

    })
    router.delete('/api/channel', async (req, res) => {
      try {
        await channelService.deleteChannel(req.body.number);
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
            logo.mv(path.join(process.env.DATABASE, '/images/uploads/', logo.name));
            
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
        doc.disabledLibraries = disabled.map((d) => {
          return {
            serverName: String(d.serverName || ""),
            sectionKey: String(d.sectionKey || ""),
            title: d.title ? String(d.title) : undefined,
            type: d.type ? String(d.type) : undefined,
          };
        }).filter((d) => d.serverName && d.sectionKey);

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
        // Only treat sections as cached when at least one library was synced
        // (playlists-only cache must not suppress live library discovery)
        let has = plexLibraryCacheService.hasLibraryCache
          ? plexLibraryCacheService.hasLibraryCache(req.params.serverName)
          : plexLibraryCacheService.hasServerCache(req.params.serverName);
        let sections = plexLibraryCacheService.getCachedSections(req.params.serverName, { includeDisabled: includeDisabled });
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
        let hit = plexLibraryCacheService.getCachedPlaylistsList(req.params.serverName);
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
        let hit = plexLibraryCacheService.getCachedCollectionsList(req.params.serverName);
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
        let hit = plexLibraryCacheService.getCachedShowsList(req.params.serverName);
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
        await customShowDB.saveShow(id, req.body );
        return res.status(204).send({});
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
      }
    })
    router.put('/api/show', async (req, res) => {
      try {
        let uuid = await customShowDB.createShow(req.body );
        return res.status(201).send({id: uuid});
      } catch(err) {
        console.error(err);
       res.status(500).send("error");
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
            file: process.env.DATABASE + '/xmltv.xml'
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


    return router
}


