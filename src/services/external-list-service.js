/**
 * Resolve external lists (Trakt / Letterboxd / paste) and match titles
 * against the local Plex + Jellyfin library caches for bulk channel import.
 * Matches both movies and TV shows (shows expand to playable episodes).
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
            // IMDB sometimes censors letters with *
            .replace(/\*/g, '')
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
     * IMDB list episode titles are usually "Show Name: Episode Title"
     * (also "Show - Episode" / "Show — Episode").
     * Multi-colon titles ("Growing Pains: Happy Halloween: Part 1") keep
     * everything after the first separator as the episode title.
     */
    _splitEpisodeListTitle(title) {
        let t = String(title || '').trim();
        if (!t) return { showTitle: null, episodeTitle: null };
        let m = t.match(/^(.+?)\s*[:：]\s*(.+)$/);
        if (!m) m = t.match(/^(.+?)\s+[–—-]\s+(.+)$/);
        if (m) {
            return {
                showTitle: m[1].trim(),
                episodeTitle: m[2].trim(),
            };
        }
        return { showTitle: null, episodeTitle: t };
    }

    /** Extra title variants for softer matching (parts, punctuation). */
    _titleVariants(s) {
        let base = String(s || '').trim();
        if (!base) return [];
        let out = [base];
        // drop "Part N" / "Pt. N" suffixes
        let noPart = base.replace(/\s*[:\-]?\s*part\s*\d+\s*$/i, '').trim();
        if (noPart && noPart !== base) out.push(noPart);
        // drop trailing parenthetical
        let noParen = base.replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (noParen && noParen !== base) out.push(noParen);
        return out;
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
        // IMDB list export: movies + TV series / mini-series / specials / video / short
        if (/Const/i.test(header) && /Title/i.test(header)) {
            let cols = this._parseCsvLine(header);
            let idx = {};
            for (let i = 0; i < cols.length; i++) {
                idx[cols[i].toLowerCase()] = i;
            }
            let titleI = idx['title'] != null ? idx['title'] : -1;
            let origI = idx['original title'] != null ? idx['original title'] : -1;
            let yearI = idx['year'] != null ? idx['year'] : -1;
            let constI = idx['const'] != null ? idx['const'] : -1;
            let typeI = idx['title type'] != null ? idx['title type'] : -1;
            for (let r = 1; r < lines.length; r++) {
                let cells = this._parseCsvLine(lines[r]);
                if (!cells.length) continue;
                let typeRaw = typeI >= 0 ? String(cells[typeI] || '') : 'movie';
                let typeKey = typeRaw.replace(/\s+/g, '').toLowerCase();
                // Skip non-library content only (keep TV episodes — common in IMDB lists)
                if (
                    typeKey
                    && /^(videogame|game|podcastseries|podcastepisode|musicvideo)$/i.test(typeKey)
                ) {
                    continue;
                }
                let mediaKind = 'movie';
                if (/^(tvepisode|episode)$/i.test(typeKey) || /^tv\s*episode$/i.test(typeRaw)) {
                    mediaKind = 'episode';
                } else if (
                    /^(tvseries|tvminiseries|tvspecial|tvshort)$/i.test(typeKey)
                    || /series|mini/i.test(typeRaw)
                ) {
                    mediaKind = 'show';
                } else if (/^(tvmovie)$/i.test(typeKey) || /tv\s*movie/i.test(typeRaw)) {
                    mediaKind = 'movie';
                } else if (!typeKey || /^(movie|video|short)$/i.test(typeKey)) {
                    mediaKind = 'movie';
                } else if (/show|series/i.test(typeRaw)) {
                    mediaKind = 'show';
                }
                let title = titleI >= 0 ? cells[titleI] : '';
                if (!title) continue;
                let originalTitle =
                    origI >= 0 && cells[origI] && cells[origI] !== title
                        ? cells[origI]
                        : null;
                // IMDB episode titles are often "Show Name: Episode Title"
                let showTitle = null;
                let episodeTitle = null;
                if (mediaKind === 'episode') {
                    let split = this._splitEpisodeListTitle(title);
                    showTitle = split.showTitle;
                    episodeTitle = split.episodeTitle;
                    if (originalTitle) {
                        let os = this._splitEpisodeListTitle(originalTitle);
                        // Prefer original show name when present (e.g. Disneyland vs Magical World of Disney)
                        if (os.showTitle) {
                            // keep both via originalTitle field for matcher
                        }
                    }
                }
                items.push({
                    title: title,
                    originalTitle: originalTitle,
                    year: yearI >= 0 ? this.parseYear(cells[yearI]) : null,
                    imdbId: constI >= 0 ? cells[constI] : null,
                    mediaKind: mediaKind,
                    titleType: typeRaw || null,
                    showTitle: showTitle,
                    episodeTitle: episodeTitle,
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
     * Build searchable index of movies + TV shows from local caches.
     * Episodes are indexed under their show for expansion after a show match.
     */
    buildLibraryIndex() {
        let programs = []; // { norm, year, kind, program }
        let byImdb = {};
        // source|server|showRatingKey → playable episodes
        let episodesByShowKey = {};
        // source|server|norm(showTitle) → playable episodes (fallback)
        let episodesByShowNorm = {};
        // norm keys for single-episode matching (list rows with Title Type = TV Episode)
        let episodesByTitleNorm = {}; // episode title alone
        let episodesByShowEpNorm = {}; // "show episode" combined

        const extractImdb = (p) => {
            if (!p) return null;
            if (p.imdbId) return String(p.imdbId).toLowerCase();
            let fields = [p.guid, p.Guid, p.key, p.ratingKey];
            for (let i = 0; i < fields.length; i++) {
                if (!fields[i]) continue;
                let m = String(fields[i]).match(/tt\d+/i);
                if (m) return m[0].toLowerCase();
            }
            return null;
        };

        const tagProgram = (p, serverName, source) => {
            return Object.assign({}, p, {
                serverKey: p.serverKey || serverName,
                source: p.source || source,
                serverType: p.serverType || source,
            });
        };

        const pushEpIndex = (map, key, copy, year) => {
            if (!key) return;
            if (!map[key]) map[key] = [];
            map[key].push({ year: year, program: copy });
        };

        const addTitleEntry = (p, serverName, source, kind) => {
            if (!p) return;
            if (kind === 'movie') {
                if (p.type && p.type !== 'movie') return;
                if (!(p.duration > 0)) return;
            } else if (kind === 'show') {
                if (p.type && p.type !== 'show') return;
            } else {
                return;
            }
            let copy = tagProgram(p, serverName, source);
            let year = this.parseYear(p.year || (p.date && String(p.date).slice(0, 4)));
            let norms = [
                this.normalizeTitle(p.title),
                this.normalizeTitle(p.originalTitle || ''),
                this.normalizeTitle(p.showTitle || ''),
            ].filter(Boolean);
            // de-dupe norms
            let seenN = {};
            for (let i = 0; i < norms.length; i++) {
                if (seenN[norms[i]]) continue;
                seenN[norms[i]] = true;
                programs.push({
                    norm: norms[i],
                    year: year,
                    kind: kind,
                    program: copy,
                });
            }
            let imdb = extractImdb(p);
            if (imdb) {
                // Prefer not overwriting a movie with a show or vice-versa when both exist
                if (!byImdb[imdb] || byImdb[imdb].type === copy.type) {
                    byImdb[imdb] = copy;
                }
            }
        };

        const addEpisode = (p, serverName, source) => {
            if (!p || p.type !== 'episode') return;
            if (!(p.duration > 0)) return;
            let copy = tagProgram(p, serverName, source);
            let year = this.parseYear(p.year || (p.date && String(p.date).slice(0, 4)));
            let showRk =
                p.grandparentRatingKey
                || p.seriesId
                || p.grandparentKey
                || null;
            if (showRk) {
                let sk =
                    (copy.source || source) +
                    '|' +
                    (copy.serverKey || serverName) +
                    '|' +
                    String(showRk);
                if (!episodesByShowKey[sk]) episodesByShowKey[sk] = [];
                episodesByShowKey[sk].push(copy);
            }
            let showNorm = this.normalizeTitle(p.showTitle || p.grandparentTitle || '');
            if (showNorm) {
                let nk =
                    (copy.source || source) +
                    '|' +
                    (copy.serverKey || serverName) +
                    '|' +
                    showNorm;
                if (!episodesByShowNorm[nk]) episodesByShowNorm[nk] = [];
                episodesByShowNorm[nk].push(copy);
            }
            // Title indexes for matching IMDB "Show: Episode" list rows
            let epNorm = this.normalizeTitle(p.title || '');
            if (epNorm) {
                pushEpIndex(episodesByTitleNorm, epNorm, copy, year);
            }
            if (showNorm && epNorm) {
                pushEpIndex(episodesByShowEpNorm, showNorm + ' ' + epNorm, copy, year);
                // also "show: episode" style as single string
                pushEpIndex(
                    episodesByShowEpNorm,
                    this.normalizeTitle(
                        (p.showTitle || p.grandparentTitle || '') + ': ' + (p.title || '')
                    ),
                    copy,
                    year
                );
            }
            let imdb = extractImdb(p);
            if (imdb && !byImdb[imdb]) {
                byImdb[imdb] = copy;
            }
        };

        const walkLibraryBag = (data, serverName, source) => {
            if (!data) return;
            // Movies live in items
            let items = data.items || {};
            let ikeys = Object.keys(items);
            for (let i = 0; i < ikeys.length; i++) {
                let p = items[ikeys[i]];
                if (!p) continue;
                if (p.type === 'movie' || (!p.type && data.type === 'movie')) {
                    addTitleEntry(p, serverName, source, 'movie');
                } else if (p.type === 'episode') {
                    addEpisode(p, serverName, source);
                } else if (p.type === 'show') {
                    addTitleEntry(p, serverName, source, 'show');
                }
            }
            // TV show shells
            let shows = data.shows || {};
            let skeys = Object.keys(shows);
            for (let i = 0; i < skeys.length; i++) {
                addTitleEntry(shows[skeys[i]], serverName, source, 'show');
            }
            // Episodes
            let episodes = data.episodes || {};
            let ekeys = Object.keys(episodes);
            for (let i = 0; i < ekeys.length; i++) {
                addEpisode(episodes[ekeys[i]], serverName, source);
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
                    walkLibraryBag(data, serverName, 'plex');
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
                    walkLibraryBag(data, serverName, 'jellyfin');
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

        return {
            byNorm: byNorm,
            byImdb: byImdb,
            episodesByShowKey: episodesByShowKey,
            episodesByShowNorm: episodesByShowNorm,
            episodesByTitleNorm: episodesByTitleNorm,
            episodesByShowEpNorm: episodesByShowEpNorm,
            count: programs.length,
        };
    }

    /**
     * Pick best episode candidate from an index list using optional year.
     */
    _bestEpisodeCandidate(cands, year) {
        if (!cands || !cands.length) return null;
        let best = null;
        for (let i = 0; i < cands.length; i++) {
            let c = cands[i];
            let score = 80;
            if (year != null && c.year != null) {
                if (c.year === year) score += 20;
                else if (Math.abs(c.year - year) === 1) score += 10;
            }
            if (!best || score > best.score) {
                best = { program: c.program, score: score };
            }
        }
        return best && best.score >= 70 ? best : null;
    }

    /**
     * Match a single list row that is a TV episode (IMDB "Show: Episode Title").
     */
    _matchEpisodeItem(item, index) {
        if (!item || !index) return null;
        let year = item.year != null ? item.year : null;

        // Build candidate (show, episode) pairs from Title + Original Title
        let pairs = [];
        let titlesToSplit = [item.title];
        if (item.originalTitle) titlesToSplit.push(item.originalTitle);
        for (let t = 0; t < titlesToSplit.length; t++) {
            let full = titlesToSplit[t];
            let fullNorm = this.normalizeTitle(full);
            if (fullNorm) {
                let hit = this._bestEpisodeCandidate(
                    index.episodesByShowEpNorm[fullNorm],
                    year
                );
                if (hit) return Object.assign({ match: 'episode-full' }, hit);
            }
            let split = this._splitEpisodeListTitle(full);
            if (split.showTitle || split.episodeTitle) {
                pairs.push(split);
            }
        }
        if (item.showTitle || item.episodeTitle) {
            pairs.push({ showTitle: item.showTitle, episodeTitle: item.episodeTitle });
        }

        let best = null;
        for (let p = 0; p < pairs.length; p++) {
            let showTitle = pairs[p].showTitle;
            let episodeTitle = pairs[p].episodeTitle;
            let showVars = this._titleVariants(showTitle || '');
            let epVars = this._titleVariants(episodeTitle || '');
            if (!epVars.length && episodeTitle) epVars = [episodeTitle];

            for (let si = 0; si < Math.max(1, showVars.length); si++) {
                let showNorm = this.normalizeTitle(showVars[si] || showTitle || '');
                for (let ei = 0; ei < epVars.length; ei++) {
                    let epNorm = this.normalizeTitle(epVars[ei]);
                    if (!epNorm) continue;

                    // Combined "show episode"
                    if (showNorm) {
                        let hit = this._bestEpisodeCandidate(
                            index.episodesByShowEpNorm[showNorm + ' ' + epNorm],
                            year
                        );
                        if (hit && (!best || hit.score > best.score)) {
                            best = Object.assign({ match: 'episode-show-title' }, hit);
                        }
                    }

                    // Episode title alone — only if unique in library (avoids
                    // mapping every "Show: Halloween" to the same episode)
                    let aloneCands = index.episodesByTitleNorm[epNorm] || [];
                    if (aloneCands.length === 1) {
                        let hit2 = this._bestEpisodeCandidate(aloneCands, year);
                        if (hit2 && hit2.score >= 70 && (!best || hit2.score > best.score)) {
                            best = Object.assign({ match: 'episode-title-unique' }, hit2);
                        }
                    } else if (aloneCands.length > 1 && year != null) {
                        let hit2 = this._bestEpisodeCandidate(aloneCands, year);
                        // year must actually disambiguate
                        if (
                            hit2
                            && hit2.score >= 100
                            && (!best || hit2.score > best.score)
                        ) {
                            best = Object.assign({ match: 'episode-title-year' }, hit2);
                        }
                    }

                    // Scan show's episodes
                    if (showNorm && index.episodesByShowNorm) {
                        let keys = Object.keys(index.episodesByShowNorm);
                        for (let k = 0; k < keys.length; k++) {
                            let parts = keys[k].split('|');
                            if (parts[parts.length - 1] !== showNorm) continue;
                            let eps = index.episodesByShowNorm[keys[k]] || [];
                            for (let e = 0; e < eps.length; e++) {
                                let ep = eps[e];
                                let n = this.normalizeTitle(ep.title || '');
                                if (!n) continue;
                                let score = 0;
                                if (n === epNorm) score = 90;
                                else if (n.indexOf(epNorm) >= 0 || epNorm.indexOf(n) >= 0) {
                                    if (Math.abs(n.length - epNorm.length) <= 8) score = 78;
                                }
                                if (score <= 0) continue;
                                let ey = this.parseYear(
                                    ep.year || (ep.date && String(ep.date).slice(0, 4))
                                );
                                if (year != null && ey != null) {
                                    if (ey === year) score += 15;
                                    else if (Math.abs(ey - year) === 1) score += 5;
                                }
                                if (!best || score > best.score) {
                                    best = {
                                        program: ep,
                                        score: score,
                                        match: 'episode-in-show',
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }

        if (best && best.score >= 70) return best;
        return null;
    }

    /**
     * Expand a matched show shell to playable episodes from the same server/library index.
     */
    _episodesForShow(showProgram, index) {
        if (!showProgram || !index) return [];
        let source = showProgram.source || showProgram.serverType || '';
        let server = showProgram.serverKey || showProgram.serverName || '';
        let rk = showProgram.ratingKey || showProgram.jellyfinId || showProgram.seriesId || null;
        let eps = [];
        if (rk) {
            let sk = source + '|' + server + '|' + String(rk);
            eps = index.episodesByShowKey[sk] || [];
        }
        if (!eps.length) {
            let norm = this.normalizeTitle(showProgram.title || showProgram.showTitle || '');
            if (norm) {
                let nk = source + '|' + server + '|' + norm;
                eps = index.episodesByShowNorm[nk] || [];
            }
        }
        // Stable season/episode order
        eps = eps.slice().sort((a, b) => {
            let sa = a.season != null ? Number(a.season) : 0;
            let sb = b.season != null ? Number(b.season) : 0;
            if (sa !== sb) return sa - sb;
            let ea = a.episode != null ? Number(a.episode) : 0;
            let eb = b.episode != null ? Number(b.episode) : 0;
            return ea - eb;
        });
        return eps;
    }

    matchItems(listItems, index) {
        index = index || this.buildLibraryIndex();
        let matched = []; // playable programs (movies + expanded episodes)
        let unmatched = [];
        let matchedListCount = 0;

        for (let i = 0; i < (listItems || []).length; i++) {
            let item = listItems[i];
            let hit = null;
            let preferKind = item.mediaKind || null; // 'movie' | 'show' | 'episode' | null

            // --- IMDB id (works for movies, shows, and episodes when guids exist) ---
            if (item.imdbId && index.byImdb[String(item.imdbId).toLowerCase()]) {
                let prog = index.byImdb[String(item.imdbId).toLowerCase()];
                let kind =
                    prog.type === 'show'
                        ? 'show'
                        : prog.type === 'episode'
                          ? 'episode'
                          : 'movie';
                hit = {
                    program: prog,
                    score: 100,
                    match: 'imdb',
                    kind: kind,
                };
            }

            // --- TV Episode list rows: match a single library episode ---
            if (!hit && (preferKind === 'episode' || /:/.test(item.title || ''))) {
                let epHit = this._matchEpisodeItem(item, index);
                if (epHit && epHit.program) {
                    hit = {
                        program: epHit.program,
                        score: epHit.score,
                        match: epHit.match || 'episode',
                        kind: 'episode',
                    };
                }
            }

            // --- Movie / show title match ---
            if (!hit && preferKind !== 'episode') {
                let titleCandidates = [item.title];
                if (item.originalTitle) titleCandidates.push(item.originalTitle);
                let year = item.year != null ? item.year : null;
                let best = null;
                for (let ti = 0; ti < titleCandidates.length; ti++) {
                    let normsTry = this._titleVariants(titleCandidates[ti]).map((v) =>
                        this.normalizeTitle(v)
                    );
                    // also plain normalize
                    normsTry.unshift(this.normalizeTitle(titleCandidates[ti]));
                    let seenN = {};
                    for (let ni = 0; ni < normsTry.length; ni++) {
                        let norm = normsTry[ni];
                        if (!norm || seenN[norm]) continue;
                        seenN[norm] = true;
                        let cands = index.byNorm[norm] || [];
                        if (!cands.length) {
                            let keys = Object.keys(index.byNorm);
                            for (let k = 0; k < keys.length && cands.length < 8; k++) {
                                if (keys[k] === norm) continue;
                                if (
                                    keys[k].indexOf(norm) === 0
                                    || norm.indexOf(keys[k]) === 0
                                ) {
                                    if (Math.abs(keys[k].length - norm.length) <= 4) {
                                        cands = cands.concat(index.byNorm[keys[k]]);
                                    }
                                }
                            }
                        }
                        for (let c = 0; c < cands.length; c++) {
                            let cand = cands[c];
                            let score = 50;
                            if (cand.norm === norm) score = 80;
                            if (preferKind && cand.kind === preferKind) score += 15;
                            else if (preferKind && cand.kind && cand.kind !== preferKind) {
                                score -= 10;
                            }
                            if (year != null && cand.year != null) {
                                if (cand.year === year) score += 20;
                                else if (Math.abs(cand.year - year) === 1) score += 10;
                                else if (cand.norm === norm) score += 0;
                                else score -= 30;
                            }
                            if (!best || score > best.score) {
                                best = {
                                    program: cand.program,
                                    score: score,
                                    match: 'title',
                                    kind: cand.kind,
                                };
                            }
                        }
                    }
                }
                if (best && best.score >= 70) {
                    hit = best;
                }
            }

            // Last chance for ambiguous rows that look like "Show: Episode"
            if (!hit) {
                let epHit = this._matchEpisodeItem(item, index);
                if (epHit && epHit.program) {
                    hit = {
                        program: epHit.program,
                        score: epHit.score,
                        match: epHit.match || 'episode',
                        kind: 'episode',
                    };
                }
            }

            if (hit && hit.program) {
                let isShow = hit.program.type === 'show' || hit.kind === 'show';
                let isEpisode = hit.program.type === 'episode' || hit.kind === 'episode';
                if (isEpisode) {
                    matchedListCount++;
                    matched.push({
                        title: item.title,
                        year: item.year,
                        imdbId: item.imdbId || null,
                        position: item.position || i + 1,
                        score: hit.score,
                        match: hit.match,
                        program: this._programForChannel(hit.program),
                    });
                } else if (isShow) {
                    let eps = this._episodesForShow(hit.program, index);
                    if (eps.length) {
                        matchedListCount++;
                        for (let e = 0; e < eps.length; e++) {
                            matched.push({
                                title: item.title,
                                year: item.year,
                                imdbId: item.imdbId || null,
                                position: item.position || i + 1,
                                score: hit.score,
                                match: (hit.match || 'title') + '-episodes',
                                program: this._programForChannel(eps[e]),
                            });
                        }
                    } else {
                        // Show shell found but no playable episodes in cache
                        unmatched.push({
                            title: item.title,
                            year: item.year,
                            imdbId: item.imdbId || null,
                            position: item.position || i + 1,
                            reason: 'Show found but no episodes in library cache (sync TV libraries?)',
                        });
                    }
                } else if (hit.program.type === 'movie' || hit.program.duration > 0) {
                    matchedListCount++;
                    matched.push({
                        title: item.title,
                        year: item.year,
                        imdbId: item.imdbId || null,
                        position: item.position || i + 1,
                        score: hit.score,
                        match: hit.match,
                        program: this._programForChannel(hit.program),
                    });
                } else {
                    unmatched.push({
                        title: item.title,
                        year: item.year,
                        imdbId: item.imdbId || null,
                        position: item.position || i + 1,
                    });
                }
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
            matchedListCount: matchedListCount,
            libraryMovieCount: index.count,
            libraryCount: index.count,
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

        // matchedCount = list titles found in library (movies or shows).
        // matched[] = playable programs (movies + all episodes for matched shows).
        let listMatched =
            typeof match.matchedListCount === 'number'
                ? match.matchedListCount
                : match.matched.length;
        return {
            ok: true,
            provider: list.provider || this.detectProvider(url, text) || 'unknown',
            listName: list.listName || 'External list',
            listUrl: list.listUrl || url || null,
            itemCount: list.items.length,
            matchedCount: listMatched,
            programCount: match.matched.length,
            unmatchedCount: match.unmatched.length,
            libraryMovieCount: match.libraryMovieCount,
            libraryCount: match.libraryCount || match.libraryMovieCount,
            matched: match.matched,
            unmatched: match.unmatched.slice(0, 200),
            unmatchedTruncated: match.unmatched.length > 200,
            warnings: warnings,
        };
    }
}

module.exports = ExternalListService;
