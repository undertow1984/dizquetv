/**
 * Resolve external movie lists (Trakt / Letterboxd / paste) and match titles
 * against the local Plex + Jellyfin library caches for bulk channel import.
 *
 * Fetch strategies:
 *  - Trakt: official API (requires free client id)
 *  - Letterboxd: best-effort page scrape
 *  - Paste: CSV export or one title per line
 * IMDB list URLs are not supported (bot challenge blocks automated access).
 */
const request = require('request');

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class ExternalListService {
    constructor(db, plexLibraryCacheService, jellyfinLibraryCacheService) {
        this.db = db;
        this.plexCache = plexLibraryCacheService;
        this.jellyfinCache = jellyfinLibraryCacheService;
    }

    getSettingsDoc() {
        let rows = [];
        try {
            rows = this.db['external-list-settings'].find() || [];
        } catch (e) {
            rows = [];
        }
        if (!rows || rows.length === 0) {
            let doc = {
                traktClientId: process.env.TRAKT_CLIENT_ID || '',
            };
            try {
                this.db['external-list-settings'].save(doc);
                rows = this.db['external-list-settings'].find() || [];
            } catch (e) {
                return doc;
            }
        }
        let doc = rows[0] || { traktClientId: '' };
        if (typeof doc.traktClientId !== 'string') doc.traktClientId = '';
        return doc;
    }

    saveSettings(patch) {
        patch = patch || {};
        let doc = this.getSettingsDoc();
        if (typeof patch.traktClientId === 'string') {
            doc.traktClientId = patch.traktClientId.trim();
        }
        try {
            if (doc._id) {
                this.db['external-list-settings'].update({ _id: doc._id }, doc);
            } else {
                this.db['external-list-settings'].save(doc);
            }
        } catch (e) {
            console.error('external-list: save settings failed', e.message || e);
        }
        return {
            traktClientId: doc.traktClientId || '',
        };
    }

    getPublicSettings() {
        let doc = this.getSettingsDoc();
        return {
            traktClientId: doc.traktClientId || '',
            hasTraktClientId: !!(doc.traktClientId || process.env.TRAKT_CLIENT_ID),
        };
    }

    _httpGet(url, options) {
        options = options || {};
        return new Promise((resolve, reject) => {
            request(
                {
                    method: 'GET',
                    url: url,
                    headers: Object.assign(
                        {
                            'User-Agent': UA,
                            Accept: options.accept || 'text/html,application/json,*/*',
                            'Accept-Language': 'en-US,en;q=0.9',
                        },
                        options.headers || {}
                    ),
                    timeout: options.timeout || 45000,
                    gzip: true,
                    followAllRedirects: true,
                    encoding: 'utf8',
                },
                (err, res, body) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve({
                        status: res.statusCode,
                        body: body || '',
                        headers: res.headers || {},
                    });
                }
            );
        });
    }

    detectProvider(url, text) {
        let u = String(url || '').trim();
        if (/imdb\.com/i.test(u)) {
            // Explicitly unsupported — site serves bot challenges to scrapers
            return null;
        }
        if (/trakt\.tv|api\.trakt\.tv/i.test(u)) return 'trakt';
        if (/letterboxd\.com/i.test(u)) return 'letterboxd';
        if (text && String(text).trim()) {
            let t = String(text).trim();
            if (/Letterboxd URI/i.test(t) || /^Position\s*,\s*Name\s*,\s*Year/i.test(t)) {
                return 'letterboxd';
            }
            return 'paste';
        }
        return null;
    }

    normalizeTitle(s) {
        if (s == null) return '';
        let t = String(s)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/&/g, ' and ')
            .replace(/['’`]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        // Strip common trailing edition noise for matching
        t = t
            .replace(/\b(the )?(extended|director s|directors|unrated|theatrical|remastered|special) (cut|edition|version)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (t.indexOf('the ') === 0 && t.length > 6) {
            t = t.slice(4);
        }
        return t;
    }

    parseYear(v) {
        if (v == null || v === '') return null;
        let n = parseInt(String(v).replace(/[^\d]/g, '').slice(0, 4), 10);
        if (isNaN(n) || n < 1880 || n > 2100) return null;
        return n;
    }

    /**
     * Parse freeform text: CSV exports or one title per line ("Title (2020)" / "Title, 2020").
     */
    parsePastedText(text) {
        let raw = String(text || '').replace(/^\uFEFF/, '').trim();
        if (!raw) return { listName: 'Pasted list', items: [] };

        let lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
        if (!lines.length) return { listName: 'Pasted list', items: [] };

        let header = lines[0];
        let items = [];

        // Generic Title/Year CSV (optional Const / Title Type columns from exports)
        if (/Const/i.test(header) && /Title/i.test(header)) {
            let cols = this._parseCsvLine(header);
            let idx = {};
            for (let i = 0; i < cols.length; i++) {
                idx[cols[i].toLowerCase()] = i;
            }
            let titleI = idx['title'] != null ? idx['title'] : -1;
            let yearI = idx['year'] != null ? idx['year'] : -1;
            let constI = idx['const'] != null ? idx['const'] : -1;
            let typeI = idx['title type'] != null ? idx['title type'] : -1;
            for (let r = 1; r < lines.length; r++) {
                let cells = this._parseCsvLine(lines[r]);
                if (!cells.length) continue;
                let type = typeI >= 0 ? cells[typeI] : 'movie';
                if (type && !/movie|tv movie|video|short/i.test(type)) continue;
                let title = titleI >= 0 ? cells[titleI] : '';
                if (!title) continue;
                items.push({
                    title: title,
                    year: yearI >= 0 ? this.parseYear(cells[yearI]) : null,
                    imdbId: constI >= 0 ? cells[constI] : null,
                    position: items.length + 1,
                });
            }
            return { listName: 'CSV list', items: items, provider: 'paste' };
        }

        // Letterboxd export CSV
        if (/Letterboxd URI/i.test(header) || (/^Position/i.test(header) && /Name/i.test(header) && /Year/i.test(header))) {
            let cols = this._parseCsvLine(header);
            let idx = {};
            for (let i = 0; i < cols.length; i++) {
                idx[cols[i].toLowerCase()] = i;
            }
            let nameI = idx['name'] != null ? idx['name'] : -1;
            let yearI = idx['year'] != null ? idx['year'] : -1;
            for (let r = 1; r < lines.length; r++) {
                let cells = this._parseCsvLine(lines[r]);
                if (!cells.length) continue;
                let title = nameI >= 0 ? cells[nameI] : cells[1];
                if (!title) continue;
                items.push({
                    title: title,
                    year: yearI >= 0 ? this.parseYear(cells[yearI]) : null,
                    position: items.length + 1,
                });
            }
            return { listName: 'Letterboxd list (CSV)', items: items, provider: 'letterboxd' };
        }

        // One title per line
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            // Full-line comments only (do not skip titles like "#1 Cheerleader Camp")
            if (/^#\s/.test(line) || /^\/\/\s?/.test(line) || line === '#') continue;
            // "Title (2020)" or "Title - 2020" or "Title, 2020"
            let m = line.match(/^(.*?)[\s,\-–—]+\(?((?:19|20)\d{2})\)?\s*$/);
            if (m) {
                items.push({
                    title: m[1].replace(/^["']|["']$/g, '').trim(),
                    year: this.parseYear(m[2]),
                    position: items.length + 1,
                });
            } else {
                items.push({
                    title: line.replace(/^["']|["']$/g, '').trim(),
                    year: null,
                    position: items.length + 1,
                });
            }
        }
        return { listName: 'Pasted list', items: items, provider: 'paste' };
    }

    _parseCsvLine(line) {
        let out = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
            let ch = line[i];
            if (inQ) {
                if (ch === '"') {
                    if (line[i + 1] === '"') {
                        cur += '"';
                        i++;
                    } else {
                        inQ = false;
                    }
                } else {
                    cur += ch;
                }
            } else if (ch === '"') {
                inQ = true;
            } else if (ch === ',') {
                out.push(cur.trim());
                cur = '';
            } else {
                cur += ch;
            }
        }
        out.push(cur.trim());
        return out;
    }

    /**
     * Fetch list metadata + items from a URL (provider-specific).
     */
    async fetchListFromUrl(url, options) {
        options = options || {};
        let u = String(url || '').trim();
        if (/imdb\.com/i.test(u)) {
            throw new Error(
                'IMDB list URLs are not supported (bot challenge blocks automated access). ' +
                'Use a Letterboxd or Trakt list URL, or paste titles / a CSV export instead.'
            );
        }
        let provider = this.detectProvider(url);
        if (!provider) {
            throw new Error(
                'Unrecognized list URL. Use a Letterboxd or Trakt list link, or paste titles / CSV.'
            );
        }
        if (provider === 'trakt') {
            return await this._fetchTrakt(url, options);
        }
        if (provider === 'letterboxd') {
            return await this._fetchLetterboxd(url);
        }
        throw new Error('Unsupported provider: ' + provider);
    }

    async _fetchTrakt(url, options) {
        let clientId =
            (options.traktClientId && String(options.traktClientId).trim())
            || (this.getSettingsDoc().traktClientId || '').trim()
            || (process.env.TRAKT_CLIENT_ID || '').trim();
        if (!clientId) {
            throw new Error(
                'Trakt requires a free API client ID. Create an app at https://trakt.tv/oauth/applications ' +
                'and paste the Client ID in Advanced settings (or set TRAKT_CLIENT_ID).'
            );
        }

        let apiPath = this._traktUrlToApiPath(url);
        if (!apiPath) {
            throw new Error(
                'Could not parse Trakt list URL. Examples: ' +
                'https://trakt.tv/users/USERNAME/lists/LIST-SLUG or https://trakt.tv/lists/12345'
            );
        }

        let page = 1;
        let items = [];
        let listName = 'Trakt list';
        let warnings = [];
        let basePath = apiPath.replace(/\/items(\/.*)?$/i, '');
        let itemsPath = basePath + '/items/movies';
        let headers = {
            'trakt-api-version': '2',
            'trakt-api-key': clientId,
            'Content-Type': 'application/json',
        };

        // List meta
        try {
            let meta = await this._httpGet('https://api.trakt.tv' + basePath, {
                accept: 'application/json',
                headers: headers,
            });
            if (meta.status === 200) {
                try {
                    let j = JSON.parse(meta.body);
                    listName = j.name || j.title || listName;
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore meta */ }

        while (page <= 20) {
            let itemUrl =
                'https://api.trakt.tv' + itemsPath +
                '?extended=full&page=' + page + '&limit=100';
            let res = await this._httpGet(itemUrl, {
                accept: 'application/json',
                headers: headers,
            });
            if (res.status === 401 || res.status === 403) {
                throw new Error(
                    'Trakt rejected the client ID (HTTP ' + res.status + '). ' +
                    'Check the Client ID at https://trakt.tv/oauth/applications'
                );
            }
            if (res.status === 404) {
                throw new Error('Trakt list not found (404). Check that the list is public.');
            }
            if (res.status < 200 || res.status >= 300) {
                throw new Error('Trakt API error HTTP ' + res.status);
            }
            let batch;
            try {
                batch = JSON.parse(res.body);
            } catch (e) {
                throw new Error('Trakt returned non-JSON body');
            }
            if (!Array.isArray(batch) || batch.length === 0) break;
            for (let i = 0; i < batch.length; i++) {
                let row = batch[i];
                let movie = row.movie || null;
                if (!movie) continue;
                items.push({
                    title: movie.title,
                    year: this.parseYear(movie.year),
                    imdbId: movie.ids && movie.ids.imdb ? movie.ids.imdb : null,
                    tmdbId: movie.ids && movie.ids.tmdb != null ? String(movie.ids.tmdb) : null,
                    position: items.length + 1,
                });
            }
            if (batch.length < 100) break;
            page++;
        }

        if (!items.length) {
            warnings.push('Trakt list returned no movies (TV-only lists are skipped).');
        }
        return {
            provider: 'trakt',
            listName: listName,
            listUrl: url,
            items: items,
            warnings: warnings,
        };
    }

    _traktUrlToApiPath(url) {
        let u = String(url || '').trim();
        // https://trakt.tv/users/USER/lists/SLUG
        let m = u.match(/trakt\.tv\/users\/([^/?#]+)\/lists\/([^/?#]+)/i);
        if (m) {
            return '/users/' + encodeURIComponent(m[1]) + '/lists/' + encodeURIComponent(m[2]);
        }
        // https://trakt.tv/lists/12345
        m = u.match(/trakt\.tv\/lists\/(\d+)/i);
        if (m) {
            return '/lists/' + m[1];
        }
        // Already an API path
        m = u.match(/api\.trakt\.tv(\/users\/[^?#]+|\/lists\/\d+)/i);
        if (m) {
            return m[1].replace(/\/items.*$/, '');
        }
        return null;
    }

    async _fetchLetterboxd(url) {
        let warnings = [];
        // Normalize to list root with trailing slash (strip /page/N/ if present)
        let listUrl = String(url || '').trim().split('?')[0].replace(/\/page\/\d+\/?$/i, '');
        listUrl = listUrl.replace(/\/+$/, '') + '/';
        let listName = 'Letterboxd list';
        let items = [];
        let seen = {};

        // Scrape list pages: poster film-poster nodes (+ data-item-name). No API.
        try {
            for (let page = 1; page <= 50; page++) {
                let pageUrl = page === 1 ? listUrl : listUrl + 'page/' + page + '/';
                let res = await this._httpGet(pageUrl);
                if (res.status === 404) break;
                if (res.status !== 200 || !res.body || res.body.length < 500) {
                    if (/Just a moment|cf-browser|captcha|Attention Required/i.test(res.body || '')) {
                        warnings.push(
                            'Letterboxd blocked automated access (bot protection). ' +
                            'Export the list as CSV and paste it below.'
                        );
                    } else if (page === 1) {
                        warnings.push('Letterboxd returned HTTP ' + res.status);
                    }
                    break;
                }
                if (page === 1) {
                    let tMatch = res.body.match(/<title[^>]*>([^<]+)</i);
                    if (tMatch) {
                        listName = this._decodeHtml(tMatch[1])
                            .replace(/\s*&\s*bull\s*;\s*Letterboxd\s*$/i, '')
                            .replace(/\s*•\s*Letterboxd\s*$/i, '')
                            .replace(/\s*-\s*Letterboxd\s*$/i, '')
                            .replace(/, a list of films by .*$/i, '')
                            .replace(/^\u200e/, '') // LRM
                            .trim() || listName;
                    }
                }

                let pageItems = this._parseLetterboxdHtml(res.body);
                if (!pageItems.length) {
                    if (page === 1) {
                        warnings.push(
                            'No film posters found on the Letterboxd page. ' +
                            'Check the URL is a public list, or paste a CSV export.'
                        );
                    }
                    break;
                }

                let added = 0;
                for (let i = 0; i < pageItems.length; i++) {
                    let it = pageItems[i];
                    let norm = this.normalizeTitle(it.title);
                    if (!norm) continue;
                    if (seen[norm]) {
                        // Upgrade year if we learn it later
                        if (it.year != null && items[seen[norm] - 1] && items[seen[norm] - 1].year == null) {
                            items[seen[norm] - 1].year = it.year;
                        }
                        continue;
                    }
                    seen[norm] = items.length + 1; // 1-based index into items
                    items.push({
                        title: it.title,
                        year: it.year,
                        position: items.length + 1,
                    });
                    added++;
                }
                if (added === 0) break;
                // Full pages are typically 100 (or ~50); stop early on short last page
                if (pageItems.length < 28) break;
            }
        } catch (e) {
            warnings.push('Letterboxd page fetch failed: ' + (e.message || e));
        }

        // Fallback: CSV export if scrape got nothing
        if (!items.length) {
            try {
                let exportUrl = listUrl.replace(/\/+$/, '') + '/export/';
                let res = await this._httpGet(exportUrl, { accept: 'text/csv,text/plain,*/*' });
                if (res.status === 200 && res.body && /Name/i.test(res.body) && res.body.indexOf(',') >= 0) {
                    let parsed = this.parsePastedText(res.body);
                    if (parsed.items.length) {
                        return {
                            provider: 'letterboxd',
                            listName: listName,
                            listUrl: url,
                            items: parsed.items,
                            warnings: warnings,
                        };
                    }
                }
            } catch (e) { /* ignore */ }
        }

        if (!items.length) {
            let err = new Error(
                warnings[0] ||
                'Could not load Letterboxd list. Check the URL is public, or paste a CSV export.'
            );
            err.warnings = warnings;
            err.provider = 'letterboxd';
            err.listUrl = url;
            throw err;
        }
        return {
            provider: 'letterboxd',
            listName: listName,
            listUrl: url,
            items: items,
            warnings: warnings,
        };
    }

    /**
     * Parse films from a Letterboxd list page HTML.
     * Preferred sources (modern SSR):
     *  1) data-item-name="Title (Year)" on poster wrappers
     *  2) //*[@class="poster film-poster"]/child::a/span  (when link markup present)
     *  3) img[alt] inside .poster.film-poster
     */
    _parseLetterboxdHtml(html) {
        let byTitle = {}; // norm -> { title, year }

        let upsert = (rawTitle, yearHint) => {
            if (!rawTitle) return;
            let title = this._decodeHtml(String(rawTitle)).replace(/\s+/g, ' ').trim();
            if (!title) return;
            let year = yearHint != null ? this.parseYear(yearHint) : null;
            let m = title.match(/^(.*)\s+\(((?:19|20)\d{2})\)$/);
            if (m) {
                title = m[1].trim();
                year = year || this.parseYear(m[2]);
            }
            // Skip obvious non-titles
            if (/^letterboxd$/i.test(title) || title.length < 1) return;
            let norm = this.normalizeTitle(title);
            if (!norm) return;
            let prev = byTitle[norm];
            if (!prev || (year != null && prev.year == null)) {
                byTitle[norm] = { title: title, year: year };
            }
        };

        // 1) data-item-name="Title (2025)" — richest modern markup
        let reItem = /data-item-name=["']([^"']+)["']/gi;
        let m;
        while ((m = reItem.exec(html)) !== null) {
            upsert(m[1], null);
        }

        // 2) User XPath: //*[@class="poster film-poster"] / child::a / span
        //    class may include extra tokens; match poster + film-poster together
        let posterRe =
            /<([a-z0-9]+)([^>]*\bclass\s*=\s*["'][^"']*\bposter\b[^"']*\bfilm-poster\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;
        while ((m = posterRe.exec(html)) !== null) {
            let inner = m[3];
            // a > span text
            let spanM = inner.match(/<a\b[^>]*>\s*<span\b[^>]*>([\s\S]*?)<\/span>\s*<\/a>/i);
            if (spanM) {
                let t = spanM[1].replace(/<[^>]+>/g, '').trim();
                if (t) upsert(t, null);
            }
            // img alt inside poster (SSR often has title only here)
            let altM = inner.match(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/i);
            if (altM) upsert(altM[1], null);
        }

        // 3) data-film-name + year attributes when present
        let reFilm =
            /data-film-name=["']([^"']+)["'][^>]*data-film-release-year=["'](\d{4})?["']/gi;
        while ((m = reFilm.exec(html)) !== null) {
            upsert(m[1], m[2]);
        }
        reFilm =
            /data-film-release-year=["'](\d{4})?["'][^>]*data-film-name=["']([^"']+)["']/gi;
        while ((m = reFilm.exec(html)) !== null) {
            upsert(m[2], m[1]);
        }

        let keys = Object.keys(byTitle);
        let items = [];
        for (let i = 0; i < keys.length; i++) {
            items.push(byTitle[keys[i]]);
        }
        return items;
    }

    _decodeHtml(s) {
        return String(s || '')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/gi, "'")
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (_, n) => {
                try { return String.fromCharCode(parseInt(n, 10)); } catch (e) { return ''; }
            })
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
                try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return ''; }
            })
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lrm;/gi, '')
            .replace(/&bull;/gi, '•');
    }

    /**
     * Build searchable index of movies (and optionally shows) from local caches.
     */
    buildLibraryIndex() {
        let programs = []; // { norm, year, program }
        let byImdb = {};

        const addProgram = (p, serverName, source) => {
            if (!p || p.type !== 'movie') return;
            if (!(p.duration > 0)) return;
            let copy = Object.assign({}, p, {
                serverKey: p.serverKey || serverName,
                source: p.source || source,
                serverType: p.serverType || source,
            });
            let year = this.parseYear(p.year || (p.date && String(p.date).slice(0, 4)));
            let norms = [this.normalizeTitle(p.title), this.normalizeTitle(p.originalTitle || '')].filter(Boolean);
            for (let i = 0; i < norms.length; i++) {
                programs.push({ norm: norms[i], year: year, program: copy });
            }
            let imdb =
                p.imdbId
                || (p.guid && String(p.guid).match(/tt\d+/) && String(p.guid).match(/tt\d+/)[0])
                || (p.key && String(p.key).match(/tt\d+/) && String(p.key).match(/tt\d+/)[0])
                || null;
            if (imdb) {
                byImdb[String(imdb).toLowerCase()] = copy;
            }
        };

        const walkPlex = () => {
            if (!this.plexCache || !this.plexCache._mem) return;
            let servers = this.plexCache._mem;
            let names = Object.keys(servers);
            for (let s = 0; s < names.length; s++) {
                let serverName = names[s];
                let mem = servers[serverName];
                if (!mem || !mem.libraries) continue;
                let keys = Object.keys(mem.libraries);
                for (let k = 0; k < keys.length; k++) {
                    let data = mem.libraries[keys[k]];
                    if (!data) continue;
                    if (this.plexCache._isDisabled && this.plexCache._isDisabled(serverName, data.sectionKey)) {
                        continue;
                    }
                    if (this.plexCache._isHidden && this.plexCache._isHidden(serverName, data.sectionKey)) {
                        continue;
                    }
                    let items = data.items || {};
                    let ikeys = Object.keys(items);
                    for (let i = 0; i < ikeys.length; i++) {
                        addProgram(items[ikeys[i]], serverName, 'plex');
                    }
                }
            }
        };

        const walkJellyfin = () => {
            if (!this.jellyfinCache || !this.jellyfinCache._mem) return;
            let servers = this.jellyfinCache._mem;
            let names = Object.keys(servers);
            for (let s = 0; s < names.length; s++) {
                let serverName = names[s];
                let mem = servers[serverName];
                if (!mem || !mem.libraries) continue;
                let keys = Object.keys(mem.libraries);
                for (let k = 0; k < keys.length; k++) {
                    let data = mem.libraries[keys[k]];
                    if (!data) continue;
                    if (this.jellyfinCache._isDisabled && this.jellyfinCache._isDisabled(serverName, data.sectionKey)) {
                        continue;
                    }
                    if (this.jellyfinCache._isHidden && this.jellyfinCache._isHidden(serverName, data.sectionKey)) {
                        continue;
                    }
                    let items = data.items || {};
                    let ikeys = Object.keys(items);
                    for (let i = 0; i < ikeys.length; i++) {
                        addProgram(items[ikeys[i]], serverName, 'jellyfin');
                    }
                }
            }
        };

        walkPlex();
        walkJellyfin();

        // Index by normalized title → array of candidates
        let byNorm = {};
        for (let i = 0; i < programs.length; i++) {
            let e = programs[i];
            if (!byNorm[e.norm]) byNorm[e.norm] = [];
            byNorm[e.norm].push(e);
        }

        return { byNorm: byNorm, byImdb: byImdb, count: programs.length };
    }

    matchItems(listItems, index) {
        index = index || this.buildLibraryIndex();
        let matched = [];
        let unmatched = [];
        let usedKeys = {}; // avoid same movie twice when possible — allow if different list positions need same film? use once

        for (let i = 0; i < (listItems || []).length; i++) {
            let item = listItems[i];
            let hit = null;

            if (item.imdbId && index.byImdb[String(item.imdbId).toLowerCase()]) {
                hit = {
                    program: index.byImdb[String(item.imdbId).toLowerCase()],
                    score: 100,
                    match: 'imdb',
                };
            }

            if (!hit) {
                let norm = this.normalizeTitle(item.title);
                let cands = index.byNorm[norm] || [];
                if (!cands.length) {
                    // fuzzy: try without year-like noise already done; try partial
                    let keys = Object.keys(index.byNorm);
                    for (let k = 0; k < keys.length && cands.length < 5; k++) {
                        if (keys[k] === norm) continue;
                        if (keys[k].indexOf(norm) === 0 || norm.indexOf(keys[k]) === 0) {
                            if (Math.abs(keys[k].length - norm.length) <= 4) {
                                cands = cands.concat(index.byNorm[keys[k]]);
                            }
                        }
                    }
                }
                let year = item.year != null ? item.year : null;
                let best = null;
                for (let c = 0; c < cands.length; c++) {
                    let cand = cands[c];
                    let score = 50;
                    if (cand.norm === norm) score = 80;
                    if (year != null && cand.year != null) {
                        if (cand.year === year) score += 20;
                        else if (Math.abs(cand.year - year) === 1) score += 10;
                        else score -= 30;
                    }
                    if (!best || score > best.score) {
                        best = { program: cand.program, score: score, match: 'title' };
                    }
                }
                if (best && best.score >= 70) {
                    hit = best;
                }
            }

            if (hit && hit.program) {
                let pk =
                    (hit.program.source || '') +
                    '|' +
                    (hit.program.serverKey || '') +
                    '|' +
                    (hit.program.ratingKey || hit.program.key || '');
                // Allow duplicates from list if needed; still track
                matched.push({
                    title: item.title,
                    year: item.year,
                    imdbId: item.imdbId || null,
                    position: item.position || i + 1,
                    score: hit.score,
                    match: hit.match,
                    program: this._programForChannel(hit.program),
                });
                usedKeys[pk] = true;
            } else {
                unmatched.push({
                    title: item.title,
                    year: item.year,
                    imdbId: item.imdbId || null,
                    position: item.position || i + 1,
                });
            }
        }

        return {
            matched: matched,
            unmatched: unmatched,
            libraryMovieCount: index.count,
        };
    }

    _programForChannel(p) {
        // Clone and ensure commercials array for channel pipeline
        let out = Object.assign({}, p);
        if (typeof out.commercials === 'undefined') {
            out.commercials = [];
        }
        return out;
    }

    /**
     * Full resolve: fetch/parse + match.
     */
    async resolve(input) {
        input = input || {};
        let url = (input.url || '').trim();
        let text = (input.text || '').trim();
        let warnings = [];
        let list = null;

        if (text) {
            list = this.parsePastedText(text);
            list.listUrl = url || null;
            if (!list.provider) {
                list.provider = this.detectProvider(url, text) || 'paste';
            }
        }

        if ((!list || !list.items.length) && url) {
            try {
                list = await this.fetchListFromUrl(url, {
                    traktClientId: input.traktClientId,
                });
            } catch (err) {
                // If fetch fails but text also empty, rethrow with guidance
                if (!text) {
                    throw err;
                }
                warnings.push(err.message || String(err));
            }
        }

        if (!list || !list.items || !list.items.length) {
            throw new Error(
                'No list items found. Provide a Letterboxd or Trakt list URL, or paste a CSV export / one title per line.'
            );
        }

        if (list.warnings) {
            warnings = warnings.concat(list.warnings);
        }

        let index = this.buildLibraryIndex();
        let match = this.matchItems(list.items, index);

        return {
            ok: true,
            provider: list.provider || this.detectProvider(url, text) || 'unknown',
            listName: list.listName || 'External list',
            listUrl: list.listUrl || url || null,
            itemCount: list.items.length,
            matchedCount: match.matched.length,
            unmatchedCount: match.unmatched.length,
            libraryMovieCount: match.libraryMovieCount,
            matched: match.matched,
            unmatched: match.unmatched.slice(0, 200),
            unmatchedTruncated: match.unmatched.length > 200,
            warnings: warnings,
        };
    }
}

module.exports = ExternalListService;
