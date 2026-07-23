/**
 * Normalize channel/program icon URLs for EPG (XMLTV) and M3U export.
 *
 * Plex Web can often load logos even when they point at localhost or an old LAN IP.
 * Google TV / Android TV clients (and Plex Media Server logo fetch) usually cannot.
 *
 * Strategy:
 *  - Relative paths → {{host}} + path (substituted when the guide is requested)
 *  - Loopback / private-LAN URLs that are clearly dizqueTV assets → {{host}} + path
 *  - Local asset URLs get ?v=<file mtime> so clients (Jellyfin, etc.) re-fetch after logo changes
 *  - Optional: proxy external logos through the image cache so clients only hit dizqueTV
 */

const fs = require('fs');
const path = require('path');

function isLoopbackHost(hostname) {
    if (!hostname) {
        return false;
    }
    let h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
    return (
        h === 'localhost'
        || h === '127.0.0.1'
        || h === '0.0.0.0'
        || h === '::1'
    );
}

function isPrivateLanHost(hostname) {
    if (!hostname) {
        return false;
    }
    let h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
    if (isLoopbackHost(h)) {
        return true;
    }
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
        return true;
    }
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) {
        return true;
    }
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) {
        return true;
    }
    // .local mDNS hostnames (often used in home labs)
    if (h.endsWith('.local')) {
        return true;
    }
    return false;
}

function isDizqueAssetPath(pathname) {
    if (!pathname) {
        return false;
    }
    return (
        pathname === '/images'
        || pathname.indexOf('/images/') === 0
        || pathname.indexOf('/cache/images/') === 0
        || pathname.indexOf('/cache/channel-logos/') === 0 // legacy logo URL
        || pathname.indexOf('/resources/') === 0
        || pathname === '/favicon.svg'
        || pathname === '/favicon.ico'
    );
}

function isChannelLogoPath(pathname) {
    if (!pathname) {
        return false;
    }
    return (
        pathname.indexOf('/images/channel-logos/') === 0
        || pathname.indexOf('/cache/channel-logos/') === 0
    );
}

/**
 * Prefer canonical /images/channel-logos/ over legacy /cache/channel-logos/.
 */
function canonicalizeAssetPathname(pathname) {
    if (!pathname) {
        return pathname;
    }
    if (pathname.indexOf('/cache/channel-logos/') === 0) {
        return '/images/channel-logos/' + pathname.slice('/cache/channel-logos/'.length);
    }
    return pathname;
}

/**
 * Absolute filesystem path for a dizqueTV static asset URL path, if it exists.
 */
function resolveLocalAssetFile(pathname) {
    if (!pathname || pathname.charAt(0) !== '/') {
        return null;
    }
    let clean = pathname.split('?')[0];
    try {
        const dbPaths = require('./database-paths');
        if (isChannelLogoPath(clean)) {
            let abs = dbPaths.resolveLocalLogoPath(clean);
            if (abs && fs.existsSync(abs)) {
                return abs;
            }
            // Try basename under images/channel-logos
            let base = path.basename(clean);
            let fallback = path.join(dbPaths.channelLogosDir(), base);
            if (fs.existsSync(fallback)) {
                return fallback;
            }
            return null;
        }
        if (clean.indexOf('/images/') === 0 || clean.indexOf('/cache/images/') === 0) {
            let rel = clean.replace(/^\//, '').split('/').join(path.sep);
            let abs = path.join(dbPaths.dbRoot(), rel);
            if (fs.existsSync(abs)) {
                return abs;
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}

/**
 * File mtime in ms for cache-busting, or null if not a local file we can stat.
 */
function getLocalAssetMtimeMs(pathname) {
    try {
        let abs = resolveLocalAssetFile(pathname);
        if (!abs) {
            return null;
        }
        let st = fs.statSync(abs);
        return Math.floor(st.mtimeMs);
    } catch (e) {
        return null;
    }
}

/**
 * Append/replace ?v=<mtime> on local asset paths so EPG clients re-download when
 * the logo file changes (stable filenames like ch3-logo.png or uploads/foo.png).
 *
 * @param {string} pathWithOptionalQuery e.g. /images/channel-logos/ch1-logo.png?v=old
 * @returns {string}
 */
function withLocalAssetCacheBuster(pathWithOptionalQuery) {
    if (!pathWithOptionalQuery || typeof pathWithOptionalQuery !== 'string') {
        return pathWithOptionalQuery;
    }
    let raw = pathWithOptionalQuery.trim();
    if (!raw) {
        return raw;
    }
    let pathname = raw.split('?')[0];
    if (!isDizqueAssetPath(pathname)) {
        return raw;
    }
    pathname = canonicalizeAssetPathname(pathname);
    let mtime = getLocalAssetMtimeMs(pathname);
    if (mtime == null) {
        // Keep path canonical even without mtime
        let rest = raw.indexOf('?') >= 0 ? raw.slice(raw.indexOf('?')) : '';
        return pathname + rest;
    }
    return pathname + '?v=' + mtime;
}

/**
 * Apply local-asset cache buster to a full icon URL or host-relative path.
 * Preserves {{host}} / absolute host prefix.
 */
function versionIconUrl(icon) {
    if (!icon || typeof icon !== 'string') {
        return icon || '';
    }
    let s = icon.trim();
    if (!s) {
        return '';
    }
    if (s.indexOf('{{host}}') === 0) {
        return '{{host}}' + withLocalAssetCacheBuster(s.slice('{{host}}'.length));
    }
    if (s.charAt(0) === '/') {
        return withLocalAssetCacheBuster(s);
    }
    if (/^https?:\/\//i.test(s)) {
        try {
            let u = new URL(s);
            if (!isDizqueAssetPath(u.pathname || '')) {
                return s;
            }
            let pathPart = withLocalAssetCacheBuster((u.pathname || '') + (u.search || ''));
            return u.origin + pathPart;
        } catch (e) {
            return s;
        }
    }
    return s;
}

/**
 * @param {string} icon
 * @param {{ enableImageCache?: boolean, cacheImageService?: { registerImageOnDatabase: Function } }} [opts]
 * @returns {string}
 */
function normalizeIconUrl(icon, opts) {
    opts = opts || {};
    if (typeof icon !== 'string') {
        return '';
    }
    icon = icon.trim();
    if (!icon) {
        return '';
    }
    if (icon.indexOf('{{host}}') !== -1) {
        // Still version local assets so guide refresh picks up logo file changes
        return versionIconUrl(icon);
    }

    // Relative URL served by this dizqueTV instance
    if (icon.charAt(0) === '/') {
        return '{{host}}' + withLocalAssetCacheBuster(icon);
    }

    let u;
    try {
        u = new URL(icon);
    } catch (e) {
        // Not a full URL; leave as-is
        return icon;
    }

    let pathname = u.pathname || '/';
    let pathWithQuery = pathname + (u.search || '');
    let host = u.hostname || '';

    // Loopback always → request host (Google TV cannot use the TV's "localhost")
    if (isLoopbackHost(host)) {
        return '{{host}}' + withLocalAssetCacheBuster(pathWithQuery);
    }

    // Private LAN + dizqueTV asset path → request host
    // Fixes logos saved with an old IP, Docker hostname, etc.
    if (isPrivateLanHost(host) && isDizqueAssetPath(pathname)) {
        return '{{host}}' + withLocalAssetCacheBuster(pathWithQuery);
    }

    // Optionally proxy everything else through the image cache so clients only
    // need to reach dizqueTV (helps TV clients with mixed HTTP/HTTPS and firewalls)
    if (opts.enableImageCache === true && opts.cacheImageService) {
        try {
            let hash = opts.cacheImageService.registerImageOnDatabase(icon);
            return versionIconUrl('{{host}}/cache/images/' + hash);
        } catch (e) {
            console.error('Failed to register icon for cache', icon, e);
            return icon;
        }
    }

    return icon;
}

/**
 * Rewrite leftover bad absolute logo URLs in an already-generated XMLTV string
 * when serving /api/xmltv.xml. Safe net for guides written before normalization.
 *
 * Also re-applies ?v=<mtime> for local logo files so Jellyfin / other EPG clients
 * fetch the current image after a logo change (even if xmltv.xml on disk still has
 * an older cache-buster from the last write).
 *
 * @param {string} xml
 * @param {string} host e.g. http://192.168.1.10:8000
 * @returns {string}
 */
function rewriteXmltvIconHosts(xml, host) {
    if (typeof xml !== 'string' || !host) {
        return xml;
    }
    let out = xml.replace(/\{\{host\}\}/g, host);

    // Loopback absolute URLs → request host
    out = out.replace(
        /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::\d+)?(\/[^"'<\s]*)/gi,
        function (_m, pathPart) {
            return host + pathPart;
        }
    );

    // Private-LAN dizqueTV asset URLs → request host
    // Matches http(s)://10.x / 192.168.x / 172.16-31.x / *.local + /images|/cache/images|/resources|/cache/channel-logos
    out = out.replace(
        /https?:\/\/((?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:192\.168\.\d{1,3}\.\d{1,3})|(?:172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})|(?:[a-z0-9-]+\.local))(?::\d+)?(\/(?:images|cache\/images|cache\/channel-logos|resources)\/[^"'<\s]*)/gi,
        function (_m, _h, pathPart) {
            return host + pathPart;
        }
    );

    // Live cache-bust local channel logos / uploads on every guide fetch
    out = rewriteXmltvLocalIconVersions(out, host);

    return out;
}

/**
 * For each icon src under this host pointing at dizqueTV static assets, set
 * ?v= to the current file mtime and canonicalize /cache/channel-logos → /images/channel-logos.
 *
 * @param {string} xml
 * @param {string} [host] absolute host prefix used in src attributes
 */
function rewriteXmltvLocalIconVersions(xml, host) {
    if (typeof xml !== 'string') {
        return xml;
    }
    // Match src=".../images/..." or src=".../cache/channel-logos/..." (with optional query)
    return xml.replace(
        /src="((?:https?:\/\/[^"/]+|\{\{host\}\})?)(\/(?:images|cache\/images|cache\/channel-logos)\/[^"?]+)(\?[^"]*)?"/gi,
        function (_m, hostPrefix, pathname, _query) {
            let versionedPath = withLocalAssetCacheBuster(pathname);
            // Prefer the request host when provided; keep existing prefix otherwise
            let prefix = hostPrefix || '';
            if (host && prefix && /^https?:\/\//i.test(prefix)) {
                // leave absolute host as-is (already rewritten)
            }
            return 'src="' + prefix + versionedPath + '"';
        }
    );
}

module.exports = {
    normalizeIconUrl,
    rewriteXmltvIconHosts,
    rewriteXmltvLocalIconVersions,
    withLocalAssetCacheBuster,
    versionIconUrl,
    canonicalizeAssetPathname,
    isLoopbackHost,
    isPrivateLanHost,
    isDizqueAssetPath,
    isChannelLogoPath,
};
