/**
 * Normalize channel/program icon URLs for EPG (XMLTV) and M3U export.
 *
 * Plex Web can often load logos even when they point at localhost or an old LAN IP.
 * Google TV / Android TV clients (and Plex Media Server logo fetch) usually cannot.
 *
 * Strategy:
 *  - Relative paths → {{host}} + path (substituted when the guide is requested)
 *  - Loopback / private-LAN URLs that are clearly dizqueTV assets → {{host}} + path
 *  - Optional: proxy external logos through the image cache so clients only hit dizqueTV
 */

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
        || pathname.indexOf('/resources/') === 0
        || pathname === '/favicon.svg'
        || pathname === '/favicon.ico'
    );
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
        return icon;
    }

    // Relative URL served by this dizqueTV instance
    if (icon.charAt(0) === '/') {
        return '{{host}}' + icon;
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
        return '{{host}}' + pathWithQuery;
    }

    // Private LAN + dizqueTV asset path → request host
    // Fixes logos saved with an old IP, Docker hostname, etc.
    if (isPrivateLanHost(host) && isDizqueAssetPath(pathname)) {
        return '{{host}}' + pathWithQuery;
    }

    // Optionally proxy everything else through the image cache so clients only
    // need to reach dizqueTV (helps TV clients with mixed HTTP/HTTPS and firewalls)
    if (opts.enableImageCache === true && opts.cacheImageService) {
        try {
            let hash = opts.cacheImageService.registerImageOnDatabase(icon);
            return '{{host}}/cache/images/' + hash;
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
        function (_m, path) {
            return host + path;
        }
    );

    // Private-LAN dizqueTV asset URLs → request host
    // Matches http(s)://10.x / 192.168.x / 172.16-31.x / *.local + /images|/cache/images|/resources
    out = out.replace(
        /https?:\/\/((?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:192\.168\.\d{1,3}\.\d{1,3})|(?:172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})|(?:[a-z0-9-]+\.local))(?::\d+)?(\/(?:images|cache\/images|resources)\/[^"'<\s]*)/gi,
        function (_m, _h, path) {
            return host + path;
        }
    );

    return out;
}

module.exports = {
    normalizeIconUrl,
    rewriteXmltvIconHosts,
    isLoopbackHost,
    isPrivateLanHost,
    isDizqueAssetPath,
};
