/**
 * Minimal Jellyfin API client for dizqueTV.
 * Auth: API key (Dashboard → API Keys) via Authorization header / api_key query.
 */
const request = require('request');

const USER_ID_GUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isLikelyJellyfinUserId(value) {
    if (value == null) return false;
    let s = String(value).trim();
    // Standard GUID, or 32-char hex without dashes
    if (USER_ID_GUID_RE.test(s)) return true;
    if (/^[0-9a-fA-F]{32}$/.test(s)) return true;
    return false;
}

class Jellyfin {
    constructor(opts) {
        opts = opts || {};
        let uri = typeof opts.uri !== 'undefined' ? opts.uri : 'http://127.0.0.1:8096';
        if (uri.endsWith('/')) {
            uri = uri.slice(0, -1);
        }
        this._uri = uri;
        this._apiKey = typeof opts.apiKey !== 'undefined'
            ? String(opts.apiKey || '').trim()
            : String(opts.accessToken || '').trim();
        this._userId = typeof opts.userId !== 'undefined'
            ? String(opts.userId || '').trim()
            : '';
        this._deviceId = opts.deviceId || 'dizquetv-jellyfin';
        this._client = 'dizqueTV';
        this._version = '1.0.0';
        this._userIdValidated = false;
    }

    get URL() {
        return this._uri;
    }

    get userId() {
        return this._userId;
    }

    authHeader() {
        // MediaBrowser auth used by Jellyfin/Emby clients
        let parts = [
            `MediaBrowser Client="${this._client}"`,
            `Device="dizqueTV"`,
            `DeviceId="${this._deviceId}"`,
            `Version="${this._version}"`,
        ];
        if (this._apiKey) {
            parts.push(`Token="${this._apiKey}"`);
        }
        return parts.join(', ');
    }

    doRequest(req) {
        return new Promise((resolve, reject) => {
            request(req, (err, res, body) => {
                if (err) {
                    reject(err);
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    let snippet = '';
                    try {
                        snippet = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
                    } catch (e) { /* ignore */ }
                    reject(Error(`Jellyfin request failed ${res.statusCode} ${req.method} ${req.url}: ${snippet}`));
                    return;
                }
                resolve({ res: res, body: body });
            });
        });
    }

    async Get(path, qs) {
        if (!this._apiKey) {
            throw Error('No Jellyfin API key provided.');
        }
        let url = path.startsWith('http') ? path : `${this._uri}${path.startsWith('/') ? '' : '/'}${path}`;
        let req = {
            method: 'get',
            url: url,
            qs: Object.assign({}, qs || {}),
            headers: {
                'Accept': 'application/json',
                'Authorization': this.authHeader(),
                'X-Emby-Token': this._apiKey,
            },
            jar: false,
            // Library sync pages can be large; 60s was too short on slow Jellyfin hosts
            timeout: 180000,
        };
        // Prefer query api_key as well (works for image/stream URLs and some proxies)
        if (!req.qs.api_key) {
            req.qs.api_key = this._apiKey;
        }
        let result = await this.doRequest(req);
        if (!result.body || result.body === '') {
            return null;
        }
        try {
            return JSON.parse(result.body);
        } catch (e) {
            throw Error('Jellyfin returned non-JSON body for ' + path);
        }
    }

    async Post(path, body, qs) {
        if (!this._apiKey && path.indexOf('Authenticate') === -1) {
            throw Error('No Jellyfin API key provided.');
        }
        let url = `${this._uri}${path.startsWith('/') ? '' : '/'}${path}`;
        let req = {
            method: 'post',
            url: url,
            qs: Object.assign({}, qs || {}),
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': this.authHeader(),
            },
            body: body ? JSON.stringify(body) : undefined,
            jar: false,
            timeout: 60000,
        };
        if (this._apiKey) {
            req.headers['X-Emby-Token'] = this._apiKey;
            req.qs.api_key = this._apiKey;
        }
        let result = await this.doRequest(req);
        if (!result.body || result.body === '') {
            return null;
        }
        try {
            return JSON.parse(result.body);
        } catch (e) {
            return result.body;
        }
    }

    async Delete(path, qs) {
        if (!this._apiKey) {
            throw Error('No Jellyfin API key provided.');
        }
        let url = `${this._uri}${path.startsWith('/') ? '' : '/'}${path}`;
        let req = {
            method: 'delete',
            url: url,
            qs: Object.assign({}, qs || {}),
            headers: {
                'Accept': 'application/json',
                'Authorization': this.authHeader(),
                'X-Emby-Token': this._apiKey,
            },
            jar: false,
            timeout: 60000,
        };
        req.qs.api_key = this._apiKey;
        let result = await this.doRequest(req);
        if (!result.body || result.body === '') {
            return null;
        }
        try {
            return JSON.parse(result.body);
        } catch (e) {
            return result.body;
        }
    }

    async checkServerStatus() {
        try {
            // System/Info/Public does not require auth; prefer authenticated Info when possible
            if (this._apiKey) {
                await this.Get('/System/Info');
            } else {
                await this.Get('/System/Info/Public');
            }
            return 1;
        } catch (err) {
            console.error('Error getting Jellyfin server status', err.message || err);
            return -1;
        }
    }

    _normalizeUserList(users) {
        if (Array.isArray(users)) {
            return users;
        }
        if (users && Array.isArray(users.Users)) {
            return users.Users;
        }
        if (users && Array.isArray(users.Items)) {
            return users.Items;
        }
        return [];
    }

    async _listUsers() {
        // Prefer full list (API key / admin). Fall back to public users.
        try {
            let users = this._normalizeUserList(await this.Get('/Users'));
            if (users.length) return users;
        } catch (e) {
            console.error('dizqueTV jellyfin: GET /Users failed', e.message || e);
        }
        try {
            let users = this._normalizeUserList(await this.Get('/Users/Public'));
            if (users.length) return users;
        } catch (e2) {
            console.error('dizqueTV jellyfin: GET /Users/Public failed', e2.message || e2);
        }
        return [];
    }

    async _pickUserIdFromList(users, preferred) {
        preferred = preferred ? String(preferred).trim() : '';
        if (preferred) {
            // Match by Id
            let byId = users.find((u) => u && String(u.Id) === preferred);
            if (byId && byId.Id) return String(byId.Id);
            // Match by Name / username (common UI mistake: typing "admin")
            let byName = users.find((u) =>
                u && (
                    String(u.Name || '').toLowerCase() === preferred.toLowerCase()
                    || String(u.PrimaryImageTag || '') === preferred
                )
            );
            if (byName && byName.Id) return String(byName.Id);
        }
        let admin = users.find((u) => u && u.Policy && u.Policy.IsAdministrator && !u.Policy.IsDisabled);
        let pick = admin || users.find((u) => u && !(u.Policy && u.Policy.IsDisabled)) || users[0];
        return pick && pick.Id ? String(pick.Id) : '';
    }

    /**
     * Ensure a valid Jellyfin user GUID is set.
     * Accepts optional username and resolves it to Id. Rejects non-GUID junk
     * that would produce "UserId is not a valid Guid" from Jellyfin.
     *
     * @param {{ forceRefresh?: boolean }} [options]
     */
    async ensureUserId(options) {
        options = options || {};
        let candidate = this._userId ? String(this._userId).trim() : '';

        if (!options.forceRefresh && this._userIdValidated && isLikelyJellyfinUserId(candidate)) {
            return candidate;
        }

        // If candidate looks like a GUID, try a lightweight validation
        if (!options.forceRefresh && isLikelyJellyfinUserId(candidate)) {
            try {
                // /Users/{id} works with API key for existing users
                await this.Get('/Users/' + candidate);
                this._userId = candidate;
                this._userIdValidated = true;
                return this._userId;
            } catch (e) {
                console.error(
                    'dizqueTV jellyfin: stored userId rejected by server, re-resolving',
                    candidate,
                    e.message || e
                );
                candidate = '';
            }
        }

        let users = await this._listUsers();
        if (!users.length) {
            throw Error(
                'No Jellyfin users found. Create a user in Jellyfin, or set User ID to a valid user GUID ' +
                '(Dashboard → Users → open user → copy Id from URL).'
            );
        }

        let resolved = await this._pickUserIdFromList(users, candidate || this._userId);
        if (!resolved || !isLikelyJellyfinUserId(resolved)) {
            throw Error(
                'Could not resolve a valid Jellyfin user id. ' +
                'Leave User ID blank to auto-pick an admin, or paste the user GUID from Jellyfin.'
            );
        }
        this._userId = resolved;
        this._userIdValidated = true;
        return this._userId;
    }

    /** Library views for the configured user (Movies / TV Shows / etc.). */
    async getViews() {
        let userId = await this.ensureUserId();
        // Prefer user views; fall back to library media folders (API-key friendly)
        try {
            let res = await this.Get(`/Users/${userId}/Views`);
            if (res && Array.isArray(res.Items) && res.Items.length) {
                return res.Items;
            }
        } catch (e) {
            console.error('dizqueTV jellyfin: Users/Views failed, trying UserViews/MediaFolders', e.message || e);
        }
        try {
            let res = await this.Get('/UserViews', { userId: userId });
            if (res && Array.isArray(res.Items) && res.Items.length) {
                return res.Items;
            }
        } catch (e2) { /* ignore */ }
        try {
            let folders = await this.Get('/Library/MediaFolders');
            let items = (folders && folders.Items) ? folders.Items : (Array.isArray(folders) ? folders : []);
            return items;
        } catch (e3) {
            throw e3;
        }
    }

    /**
     * Items under a parent (library, show, season, folder).
     */
    async getItems(parentId, options) {
        options = options || {};
        let userId = await this.ensureUserId();
        let qs = {
            ParentId: parentId,
            Recursive: options.recursive === true ? 'true' : 'false',
            Fields: options.fields || 'BasicSyncInfo,MediaSources,Path,Overview,ProductionYear,PremiereDate,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,SeasonName,PrimaryImageAspectRatio',
            SortBy: options.sortBy || 'SortName',
            SortOrder: options.sortOrder || 'Ascending',
            EnableImageTypes: 'Primary,Thumb,Banner',
            UserId: userId,
        };
        if (options.includeItemTypes) {
            qs.IncludeItemTypes = options.includeItemTypes;
        }
        if (options.excludeItemTypes) {
            qs.ExcludeItemTypes = options.excludeItemTypes;
        }
        if (typeof options.startIndex === 'number') {
            qs.StartIndex = options.startIndex;
        }
        if (typeof options.limit === 'number') {
            qs.Limit = options.limit;
        }
        try {
            let res = await this.Get(`/Users/${userId}/Items`, qs);
            return (res && res.Items) ? res.Items : [];
        } catch (e) {
            // Fallback: global Items endpoint with UserId query (works better with some API-key setups)
            console.error('dizqueTV jellyfin: Users/Items failed, trying /Items', e.message || e);
            let res = await this.Get('/Items', qs);
            return (res && res.Items) ? res.Items : [];
        }
    }

    async getItem(itemId) {
        let userId = await this.ensureUserId();
        let fields = {
            Fields: 'BasicSyncInfo,MediaSources,Path,Overview,ProductionYear,PremiereDate,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,SeasonName',
            UserId: userId,
        };
        try {
            return await this.Get(`/Users/${userId}/Items/${itemId}`, fields);
        } catch (e) {
            return await this.Get('/Items/' + itemId, fields);
        }
    }

    imageUrl(itemId, imageType, tag) {
        if (!itemId) {
            return '';
        }
        imageType = imageType || 'Primary';
        let q = `api_key=${encodeURIComponent(this._apiKey)}`;
        if (tag) {
            q += `&tag=${encodeURIComponent(tag)}`;
        }
        return `${this._uri}/Items/${itemId}/Images/${imageType}?${q}`;
    }

    /**
     * Direct file stream URL suitable for FFmpeg input.
     * static=true asks Jellyfin not to transcode.
     * Prefer including container extension + MediaSourceId + UserId for reliable Range seeks.
     *
     * @param {string} itemId
     * @param {string} [mediaSourceId]
     * @param {{ container?: string, userId?: string, startTimeTicks?: number }} [opts]
     */
    streamUrl(itemId, mediaSourceId, opts) {
        opts = opts || {};
        let container = (opts.container || '').toString().replace(/^\./, '').toLowerCase();
        // Normalize common jellyfin container names for URL path
        if (container === 'mpegts') container = 'ts';
        if (container === 'matroska') container = 'mkv';
        let path = `/Videos/${itemId}/stream`;
        if (container) {
            path += `.${container}`;
        }
        let q = `static=true&Static=true&api_key=${encodeURIComponent(this._apiKey)}`;
        if (mediaSourceId) {
            q += `&MediaSourceId=${encodeURIComponent(mediaSourceId)}`;
        }
        let uid = opts.userId || this._userId;
        if (uid) {
            q += `&UserId=${encodeURIComponent(uid)}`;
        }
        // Server-side seek (ticks = 100ns). Helps avoid FFmpeg downloading to mid-point.
        if (typeof opts.startTimeTicks === 'number' && opts.startTimeTicks > 0) {
            q += `&StartTimeTicks=${Math.floor(opts.startTimeTicks)}`;
        }
        return `${this._uri}${path}?${q}`;
    }

    /**
     * Device profile that allows direct stream AND an HTTP/TS remux-or-transcode
     * path. Mid-program starts use StartTimeTicks + transcoding so Jellyfin seeks
     * server-side (MKV over HTTP + FFmpeg -ss often hangs).
     */
    _playbackDeviceProfile() {
        return {
            Name: 'dizqueTV',
            MaxStreamingBitrate: 120000000,
            MaxStaticBitrate: 120000000,
            MusicStreamingTranscodingBitrate: 320000,
            DirectPlayProfiles: [
                { Type: 'Video' },
                { Type: 'Audio' },
            ],
            TranscodingProfiles: [
                {
                    Container: 'ts',
                    Type: 'Video',
                    AudioCodec: 'aac,mp3,ac3,eac3',
                    VideoCodec: 'h264,hevc,mpeg2video',
                    Context: 'Streaming',
                    Protocol: 'http',
                    MaxAudioChannels: '6',
                    MinSegments: '1',
                    BreakOnNonKeyFrames: true,
                    CopyTimestamps: true,
                },
                {
                    Container: 'mkv',
                    Type: 'Video',
                    AudioCodec: 'aac,mp3,ac3,eac3,flac',
                    VideoCodec: 'h264,hevc,mpeg2video,mpeg4',
                    Context: 'Streaming',
                    Protocol: 'http',
                    MaxAudioChannels: '6',
                    CopyTimestamps: true,
                },
            ],
            ContainerProfiles: [],
            CodecProfiles: [],
            SubtitleProfiles: [
                { Format: 'srt', Method: 'External' },
                { Format: 'vtt', Method: 'External' },
                { Format: 'ass', Method: 'External' },
            ],
        };
    }

    _absolutizeStreamUrl(relOrAbs) {
        if (!relOrAbs) return null;
        let streamUrl;
        if (relOrAbs.startsWith('http://') || relOrAbs.startsWith('https://')) {
            streamUrl = relOrAbs;
        } else {
            let rel = relOrAbs.startsWith('/') ? relOrAbs : '/' + relOrAbs;
            streamUrl = `${this._uri}${rel}`;
        }
        if (streamUrl.indexOf('api_key=') === -1 && streamUrl.indexOf('ApiKey=') === -1) {
            streamUrl += (streamUrl.indexOf('?') >= 0 ? '&' : '?') +
                'api_key=' + encodeURIComponent(this._apiKey);
        }
        // Also pass token form some proxies expect
        if (streamUrl.indexOf('api_key=') !== -1 && streamUrl.indexOf('X-Emby-Token=') === -1) {
            // already have api_key; fine
        }
        return streamUrl;
    }

    async _playbackInfo(itemId, userId, startTimeTicks, enableTranscoding) {
        return await this.Post(
            `/Items/${itemId}/PlaybackInfo`,
            {
                UserId: userId,
                DeviceProfile: this._playbackDeviceProfile(),
                MaxStreamingBitrate: 120000000,
                StartTimeTicks: startTimeTicks || 0,
                EnableDirectPlay: !enableTranscoding,
                EnableDirectStream: !enableTranscoding,
                EnableTranscoding: !!enableTranscoding,
                AllowVideoStreamCopy: true,
                AllowAudioStreamCopy: true,
                AutoOpenLiveStream: false,
            },
            { UserId: userId }
        );
    }

    /**
     * Resolve a stream URL FFmpeg can open.
     *
     * @returns {{
     *   streamUrl: string,
     *   mediaSourceId: string,
     *   container: string,
     *   path: string|null,
     *   mode: 'local'|'direct'|'transcode'|'static',
     *   serverSeeked: boolean,
     *   startTimeTicks: number
     * }}
     *
     * serverSeeked=true means Jellyfin already started at startMs — do NOT pass -ss to FFmpeg.
     */
    async resolvePlayback(itemId, options) {
        options = options || {};
        let userId = await this.ensureUserId();
        let startMs = (typeof options.startMs === 'number' && options.startMs > 0) ? options.startMs : 0;
        let startTimeTicks = startMs > 0 ? Math.floor(startMs * 10000) : 0;
        // Mid-program: force server-side start. Static MKV + FFmpeg -ss over HTTP is unreliable.
        let midStart = startMs >= 2000;

        let mediaSource = null;
        let streamUrl = null;
        let mode = 'static';
        let serverSeeked = false;

        // 1) Mid-start: PlaybackInfo with transcoding + StartTimeTicks (Jellyfin seeks)
        if (midStart) {
            try {
                let info = await this._playbackInfo(itemId, userId, startTimeTicks, true);
                if (info && Array.isArray(info.MediaSources) && info.MediaSources.length > 0) {
                    mediaSource = info.MediaSources[0];
                    if (mediaSource.TranscodingUrl) {
                        streamUrl = this._absolutizeStreamUrl(mediaSource.TranscodingUrl);
                        mode = 'transcode';
                        serverSeeked = true;
                    } else if (mediaSource.DirectStreamUrl) {
                        // Some builds still return direct with StartTimeTicks ignored —
                        // treat as direct and let FFmpeg seek only as last resort.
                        streamUrl = this._absolutizeStreamUrl(mediaSource.DirectStreamUrl);
                        mode = 'direct';
                        serverSeeked = false;
                    }
                }
            } catch (e) {
                console.error('dizqueTV jellyfin: mid-start PlaybackInfo(transcode) failed', e.message || e);
            }
        }

        // 2) Start at 0 (or mid-start fallback): prefer direct stream
        if (!streamUrl) {
            try {
                let info = await this._playbackInfo(itemId, userId, 0, false);
                if (info && Array.isArray(info.MediaSources) && info.MediaSources.length > 0) {
                    mediaSource = info.MediaSources[0];
                    if (mediaSource.DirectStreamUrl) {
                        streamUrl = this._absolutizeStreamUrl(mediaSource.DirectStreamUrl);
                        mode = 'direct';
                    } else if (mediaSource.TranscodingUrl) {
                        streamUrl = this._absolutizeStreamUrl(mediaSource.TranscodingUrl);
                        mode = 'transcode';
                        // TranscodingUrl without StartTimeTicks still starts at 0
                        serverSeeked = midStart ? false : false;
                    }
                }
            } catch (e) {
                console.error('dizqueTV jellyfin: PlaybackInfo(direct) failed', e.message || e);
            }
        }

        // 3) getItem for path/container metadata
        if (!mediaSource) {
            try {
                let item = await this.getItem(itemId);
                if (item && item.MediaSources && item.MediaSources.length > 0) {
                    mediaSource = item.MediaSources[0];
                }
            } catch (e2) {
                console.error('dizqueTV jellyfin: getItem for playback failed', e2.message || e2);
            }
        }

        let mediaSourceId = (mediaSource && mediaSource.Id) || itemId;
        let container = (mediaSource && (mediaSource.Container || mediaSource.container)) || '';
        let path = (mediaSource && mediaSource.Path) || null;
        let videoWidth = null;
        let videoHeight = null;
        let videoCodec = null;
        if (mediaSource) {
            if (mediaSource.Width) videoWidth = mediaSource.Width;
            if (mediaSource.Height) videoHeight = mediaSource.Height;
            // Prefer video stream from MediaStreams
            let streams = mediaSource.MediaStreams || [];
            for (let si = 0; si < streams.length; si++) {
                if (streams[si] && streams[si].Type === 'Video') {
                    if (streams[si].Width) videoWidth = streams[si].Width;
                    if (streams[si].Height) videoHeight = streams[si].Height;
                    if (streams[si].Codec) videoCodec = streams[si].Codec;
                    break;
                }
            }
        }

        // 4) Last resort static URL (no server seek)
        if (!streamUrl) {
            streamUrl = this.streamUrl(itemId, mediaSourceId, {
                container: container || 'mkv',
                userId: userId,
                startTimeTicks: 0,
            });
            mode = 'static';
            serverSeeked = false;
        }

        return {
            streamUrl: streamUrl,
            mediaSourceId: mediaSourceId,
            container: container,
            path: path,
            mode: mode,
            serverSeeked: serverSeeked,
            startTimeTicks: startTimeTicks,
            bitrate: mediaSource && mediaSource.Bitrate,
            size: mediaSource && mediaSource.Size,
            videoWidth: videoWidth,
            videoHeight: videoHeight,
            videoCodec: videoCodec,
        };
    }

    /** Redact secrets from a stream URL for logging. */
    redactUrl(url) {
        if (!url) return '';
        return String(url)
            .replace(/([?&](?:api_key|ApiKey|apiKey|X-Emby-Token|api_token)=)[^&]*/gi, '$1***')
            .replace(/([?&](?:MediaSourceId|mediaSourceId)=)[^&]*/gi, '$1…');
    }

    /** Authenticate by username/password and return { accessToken, userId, serverId }. */
    async authenticateByName(username, password) {
        // Temporary no-token auth header for sign-in
        let prev = this._apiKey;
        this._apiKey = '';
        try {
            let url = `${this._uri}/Users/AuthenticateByName`;
            let req = {
                method: 'post',
                url: url,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `MediaBrowser Client="${this._client}", Device="dizqueTV", DeviceId="${this._deviceId}", Version="${this._version}"`,
                },
                body: JSON.stringify({ Username: username, Pw: password || '' }),
                jar: false,
                timeout: 60000,
            };
            let result = await this.doRequest(req);
            let data = JSON.parse(result.body);
            this._apiKey = data.AccessToken || prev;
            this._userId = (data.User && data.User.Id) || this._userId;
            this._userIdValidated = !!this._userId;
            return {
                accessToken: data.AccessToken,
                userId: this._userId,
                serverId: data.ServerId,
            };
        } catch (err) {
            this._apiKey = prev;
            throw err;
        }
    }
}

Jellyfin.isLikelyJellyfinUserId = isLikelyJellyfinUserId;
module.exports = Jellyfin;
module.exports.isLikelyJellyfinUserId = isLikelyJellyfinUserId;
