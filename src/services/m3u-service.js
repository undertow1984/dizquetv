const { normalizeIconUrl } = require('../icon-url');

/**
 * Manager and Generate M3U content
 *
 * @class M3uService
 */
class M3uService {
    constructor(fileCacheService, channelService, db) {
        this.channelService = channelService;
        this.cacheService = fileCacheService;
        this.db = db || null;
        this.cacheReady = false;
        this.channelService.on("channel-update", (data) => {
            this.clearCache();
        } );
    }

    /**
     * Path suffix for a channel URL based on global FFmpeg stream mode (Tunarr-aligned).
     * HDHR always uses /video (mpegts); this is for M3U/IPTV clients.
     */
    getStreamPathForMode(streamMode) {
        let mode = (streamMode || 'mpegts').toString().toLowerCase();
        switch (mode) {
            case 'hls':
            case 'hls_slower':
            case 'hls_direct_v2':
                return 'm3u8';
            case 'hls_direct':
                return 'hls-direct';
            case 'mpegts':
            default:
                return 'video';
        }
    }

    getConfiguredStreamMode() {
        try {
            if (this.db && this.db['ffmpeg-settings']) {
                let s = this.db['ffmpeg-settings'].find()[0];
                if (s && s.streamMode) {
                    return String(s.streamMode).toLowerCase();
                }
            }
        } catch (e) { /* ignore */ }
        return 'mpegts';
    }

    /**
     * Get the channel list in HLS or M3U
     *
     * @param {string} [type='m3u'] List type
     * @returns {promise} Return a Promise with HLS or M3U file content
     * @memberof M3uService
     */
    getChannelList(host) {
        return this.buildM3uList(host);
    }

    /**
     *  Build M3U with cache
     *
     * @param {string} host
     * @returns {promise} M3U file content
     * @memberof M3uService
     */

    async buildM3uList(host) {
        if (this.cacheReady) {
            const cachedM3U = await this.cacheService.getCache('channels.m3u');
            if (cachedM3U) {
                return this.replaceHostOnM3u(host, cachedM3U);
            }
        }
        let channels = await this.channelService.getAllChannels();


        channels.sort((a, b) => {
            return parseInt(a.number) < parseInt(b.number) ? -1 : 1
        });

        const tvg = `{{host}}/api/xmltv.xml`;

        let data = `#EXTM3U url-tvg="${tvg}" x-tvg-url="${tvg}"\n`;

        for (var i = 0; i < channels.length; i++) {
            if (channels[i].stealth !== true) {
                let logo = normalizeIconUrl(channels[i].icon || '');
                if (!logo) {
                    logo = '{{host}}/images/dizquetv.png';
                }
                let streamPath = this.getStreamPathForMode(this.getConfiguredStreamMode());
                let mode = this.getConfiguredStreamMode();
                let qs = `channel=${channels[i].number}`;
                if (mode === 'hls_slower') {
                    qs += '&streamMode=hls_slower';
                } else if (mode === 'hls_direct_v2') {
                    qs += '&streamMode=hls_direct_v2';
                }
                data += `#EXTINF:0 tvg-id="${channels[i].number}" CUID="${channels[i].number}" tvg-chno="${channels[i].number}" tvg-name="${channels[i].name}" tvg-logo="${logo}" group-title="${channels[i].groupTitle}",${channels[i].name}\n`
                data += `{{host}}/${streamPath}?${qs}\n`
            }
        }
        if (channels.length === 0) {
            data += `#EXTINF:0 tvg-id="1" tvg-chno="1" tvg-name="dizqueTV" tvg-logo="{{host}}/resources/dizquetv.png" group-title="dizqueTV",dizqueTV\n`
            data += `{{host}}/setup\n`
        }
        let saveCacheThread = async() => {
            try {
                await this.cacheService.setCache('channels.m3u', data);
                this.cacheReady = true;
            } catch(err) {
                console.error(err);
            }
        };
        saveCacheThread();
        return this.replaceHostOnM3u(host, data);
    }

    /**
     * Replace {{host}} string with a URL on file contents.
     *
     * @param {*} host
     * @param {*} data
     * @returns
     * @memberof M3uService
     */
    replaceHostOnM3u(host, data) {
        return data.replace(/\{\{host\}\}/g, host);
    }

    /**
     * Clear channels.m3u file from cache folder.
     *
     * @memberof M3uService
     */
    async clearCache() {
        this.cacheReady = false;
    }
}

module.exports = M3uService;