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
 *   - Without `Sec-Fetch-Site`, an `Origin` that is not this origin is refused:
 *     a different host (default ports ignored), a different scheme when the
 *     edge says which scheme it served, or the opaque `null`.
 *   - A request with neither header passes. That is not a browser: it is the
 *     SDK, the MCP connector, a cron or a webhook, none of which carry ambient
 *     credentials — they authenticate with a bearer or a secret of their own,
 *     which a cross-origin page cannot attach.
 */
import { forwardedHost, forwardedProto, withoutDefaultPort } from '@/utils/forwarded';

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

    const host = forwardedHost(request.headers);
    if (!host) return true;
    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        // `Origin: null` (sandboxed frames, some cross-origin redirects) and
        // anything unparseable.
        return true;
    }
    const originProto = parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'http:' ? 'http' : null;
    if (!originProto) return true;
    const proto = forwardedProto(request.headers);
    if (proto && proto !== originProto) return true;
    return withoutDefaultPort(parsed.host.toLowerCase(), originProto) !== host;
}

/** Whether the refused request is a top-level page load rather than an API call. */
export function isDocumentNavigation(request: OriginCheckRequest): boolean {
    if (request.headers.get('sec-fetch-mode') === 'navigate') return true;
    return (request.headers.get('accept') ?? '').includes('text/html');
}
