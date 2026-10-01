/**
 * Refuses state-changing requests that a browser sent from another origin.
 *
 * 🔴 WHY THIS EXISTS. The session cookie is `SameSite=Lax`, which stops a
 * cross-SITE page from riding it on a POST — but `os.ezil.org` shares its site
 * (`ezil.org`) with the desktop hosts (`*-app.ezil.org` and friends), whose
 * content the computer's owner controls. To the browser a POST from
 * `evil-app.ezil.org` to `os.ezil.org` is same-site, so Lax sends the cookie.
 * Without this check any page served from somebody's computer could drive the
 * API of whoever opened it (restart their desktop, read preview URLs back
 * through a JSON response, …).
 *
 * Next.js already checks `Origin` for server actions; this covers the tRPC
 * endpoint and the `/api/shell/*` and `/auth/*` route handlers, which it does
 * not.
 *
 * The rule, for every method that is not GET/HEAD/OPTIONS:
 *   - `Sec-Fetch-Site: same-origin` (or `none`, a user-initiated navigation)
 *     passes; `same-site` and `cross-site` are refused. Every browser this app
 *     supports sends the header.
 *   - Without `Sec-Fetch-Site`, an `Origin` header that names a different host
 *     (or the opaque `null`) is refused.
 *   - A request with neither header passes. That is not a browser: it is the
 *     SDK, the MCP connector, a cron or a webhook, none of which carry ambient
 *     credentials — they authenticate with a bearer or a secret of their own,
 *     which a cross-origin page cannot attach.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckRequest {
    method: string;
    headers: Pick<Headers, 'get'>;
}

export function isCrossOriginWrite(request: OriginCheckRequest): boolean {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return false;

    const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
    if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none';

    const origin = request.headers.get('origin');
    if (origin === null) return false;

    const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host'))
        ?.split(',')[0]
        ?.trim()
        .toLowerCase();
    if (!host) return true;
    try {
        return new URL(origin).host.toLowerCase() !== host;
    } catch {
        // `Origin: null` (sandboxed frames, some cross-origin redirects) and
        // anything unparseable.
        return true;
    }
}
