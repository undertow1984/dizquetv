// Jellyfin server registry + program fixup when servers change/delete

const ICON_FIELDS = ['icon', 'showIcon', 'seasonIcon', 'episodeIcon'];

class JellyfinServerDB {
    constructor(channelService, fillerDB, showDB, db) {
        this.channelService = channelService;
        this.db = db;
        this.fillerDB = fillerDB;
        this.showDB = showDB;
    }

    async fixupAllChannels(name, newServer) {
        let channelNumbers = await this.channelService.getAllChannelNumbers();
        return await Promise.all(channelNumbers.map(async (i) => {
            let channel = await this.channelService.getChannel(i);
            let channelReport = {
                channelNumber: channel.number,
                channelName: channel.name,
                destroyedPrograms: 0,
                modifiedPrograms: 0,
            };
            this.fixupProgramArray(channel.programs, name, newServer, channelReport);
            let fallbackTouched = false;
            if (
                typeof channel.fallback !== 'undefined'
                && channel.fallback.length > 0
                && channel.fallback[0].isOffline
            ) {
                channel.fallback = [];
                if (channel.offlineMode != 'pic') {
                    channel.offlineMode = 'pic';
                    channel.offlinePicture = `http://localhost:${process.env.PORT}/images/generic-offline-screen.png`;
                }
                fallbackTouched = true;
            }
            this.fixupProgramArray(channel.fallback, name, newServer, channelReport);
            // Only persist when this server actually affected the channel.
            // Always-saving re-triggers dynamic logo generation for every channel.
            let changed =
                fallbackTouched
                || channelReport.destroyedPrograms > 0
                || channelReport.modifiedPrograms > 0;
            if (changed) {
                await this.channelService.saveChannel(i, channel, {
                    skipDynamicLogo: true,
                    ignoreOnDemand: true,
                });
            }
            return channelReport;
        }));
    }

    async fixupAllFillers(name, newServer) {
        let fillers = await this.fillerDB.getAllFillers();
        return await Promise.all(fillers.map(async (filler) => {
            let fillerReport = {
                channelNumber: '--',
                channelName: filler.name + ' (filler)',
                destroyedPrograms: 0,
                modifiedPrograms: 0,
            };
            this.fixupProgramArray(filler.content, name, newServer, fillerReport);
            filler.content = this.removeOffline(filler.content);
            if (fillerReport.destroyedPrograms > 0 || fillerReport.modifiedPrograms > 0) {
                await this.fillerDB.saveFiller(filler.id, filler);
            }
            return fillerReport;
        }));
    }

    async fixupAllShows(name, newServer) {
        let shows = await this.showDB.getAllShows();
        return await Promise.all(shows.map(async (show) => {
            let showReport = {
                channelNumber: '--',
                channelName: show.name + ' (custom show)',
                destroyedPrograms: 0,
                modifiedPrograms: 0,
            };
            this.fixupProgramArray(show.content, name, newServer, showReport);
            show.content = this.removeOffline(show.content);
            if (showReport.destroyedPrograms > 0 || showReport.modifiedPrograms > 0) {
                await this.showDB.saveShow(show.id, show);
            }
            return showReport;
        }));
    }

    removeOffline(progs) {
        if (typeof progs === 'undefined') {
            return progs;
        }
        return progs.filter((p) => true !== p.isOffline);
    }

    async fixupEveryProgramHolders(serverName, newServer) {
        let reports = await Promise.all([
            this.fixupAllChannels(serverName, newServer),
            this.fixupAllFillers(serverName, newServer),
            this.fixupAllShows(serverName, newServer),
        ]);
        let report = [];
        reports.forEach((r) => r.forEach((r2) => report.push(r2)));
        return report;
    }

    async deleteServer(name) {
        let report = await this.fixupEveryProgramHolders(name, null);
        this.db['jellyfin-servers'].remove({ name: name });
        return report;
    }

    doesNameExist(name) {
        return this.db['jellyfin-servers'].find({ name: name }).length > 0;
    }

    _normalizeUserId(userId) {
        if (userId == null) {
            return '';
        }
        return String(userId).trim();
    }

    async updateServer(server) {
        let name = server.name;
        if (typeof name === 'undefined') {
            throw Error('Missing server name from request');
        }
        let s = this.db['jellyfin-servers'].find({ name: name });
        if (s.length != 1) {
            throw Error("Server doesn't exist.");
        }
        s = s[0];
        // Explicit empty userId clears auto-resolved id so it can be rediscovered
        let nextUserId;
        if (Object.prototype.hasOwnProperty.call(server, 'userId')) {
            nextUserId = this._normalizeUserId(server.userId);
        } else {
            nextUserId = this._normalizeUserId(s.userId);
        }
        let newServer = {
            name: s.name,
            uri: server.uri,
            apiKey: server.apiKey || server.accessToken || s.apiKey,
            userId: nextUserId,
            index: s.index,
        };
        this.normalizeServer(newServer);

        // Resolve/validate userId against Jellyfin so we never store a bad id
        try {
            const Jellyfin = require('../jellyfin');
            let jf = new Jellyfin(newServer);
            newServer.userId = await jf.ensureUserId({
                forceRefresh: !Jellyfin.isLikelyJellyfinUserId(newServer.userId),
            });
        } catch (e) {
            console.error('dizqueTV: could not validate Jellyfin userId on update', e.message || e);
            // Keep blank rather than a known-bad value; client will retry later
            const Jellyfin = require('../jellyfin');
            if (newServer.userId && !Jellyfin.isLikelyJellyfinUserId(newServer.userId)) {
                newServer.userId = '';
            }
        }

        // Skip program fixup when connection fields that affect program URLs did not change
        let uriChanged = String(s.uri || '') !== String(newServer.uri || '');
        let keyChanged = String(s.apiKey || '') !== String(newServer.apiKey || '');
        let report = [];
        if (uriChanged || keyChanged) {
            report = await this.fixupEveryProgramHolders(name, newServer);
        }
        this.db['jellyfin-servers'].update({ _id: s._id }, newServer);
        return report;
    }

    async addServer(server) {
        let name = server.name;
        if (typeof name === 'undefined' || name === '') {
            name = 'jellyfin';
        }
        let i = 2;
        let prefix = name;
        let resultName = name;
        while (this.doesNameExist(resultName)) {
            resultName = `${prefix}${i}`;
            i += 1;
        }
        name = resultName;
        let index = this.db['jellyfin-servers'].find({}).length;
        let newServer = {
            name: name,
            uri: server.uri,
            apiKey: server.apiKey || server.accessToken || '',
            userId: this._normalizeUserId(server.userId),
            index: index,
        };
        this.normalizeServer(newServer);
        if (!newServer.uri) {
            throw Error('Missing Jellyfin server URI');
        }
        if (!newServer.apiKey) {
            throw Error('Missing Jellyfin API key');
        }
        try {
            const Jellyfin = require('../jellyfin');
            let jf = new Jellyfin(newServer);
            newServer.userId = await jf.ensureUserId({ forceRefresh: true });
        } catch (e) {
            console.error('dizqueTV: could not resolve Jellyfin userId on add', e.message || e);
        }
        this.db['jellyfin-servers'].save(newServer);
        return newServer;
    }

    fixupProgramArray(arr, serverName, newServer, channelReport) {
        if (typeof arr !== 'undefined') {
            for (let i = 0; i < arr.length; i++) {
                arr[i] = this.fixupProgram(arr[i], serverName, newServer, channelReport);
            }
        }
    }

    fixupProgram(program, serverName, newServer, channelReport) {
        if (!program || program.serverKey !== serverName) {
            return program;
        }
        // Only rewrite jellyfin-owned rows
        if (!(program.source === 'jellyfin' || program.serverType === 'jellyfin')) {
            return program;
        }
        if (newServer == null) {
            channelReport.destroyedPrograms += 1;
            return {
                isOffline: true,
                duration: program.duration,
            };
        }
        let modified = false;
        ICON_FIELDS.forEach((field) => {
            if (
                typeof program[field] === 'string'
                && program[field].includes('/Items/')
                && program[field].includes('api_key=')
            ) {
                let m = program[field].match(/\/Items\/([^/]+)\/Images\/([^?]+)/);
                if (m) {
                    let next =
                        `${newServer.uri}/Items/${m[1]}/Images/${m[2]}?api_key=${encodeURIComponent(newServer.apiKey)}`;
                    if (program[field] !== next) {
                        program[field] = next;
                        modified = true;
                    }
                }
            }
        });
        // Do NOT mark modified for relative plexFile/stream paths — they are not server-absolute.
        if (modified) {
            channelReport.modifiedPrograms += 1;
        }
        return program;
    }

    normalizeServer(server) {
        while (server.uri && server.uri.endsWith('/')) {
            server.uri = server.uri.slice(0, -1);
        }
        if (server.apiKey) {
            server.apiKey = String(server.apiKey).trim();
        }
        if (server.userId) {
            server.userId = String(server.userId).trim();
        }
    }
}

module.exports = JellyfinServerDB;
