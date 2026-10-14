/**
 * Same-origin cookies for SERVER-SIDE readiness probes of preview origins.
 *
 * An AWS desktop URL is a bootstrap URL (worker/src/aws-origin.ts
 * `handleAwsBrowserHost`): `GET /preview-bootstrap?token=…` answers `302` plus
 * `Set-Cookie: ezil_preview=…`, and every later request to that origin is
 * refused `401 aws_preview_auth_required` without the cookie. A browser keeps
 * the cookie; a plain `fetch(…, { redirect: 'follow' })` does not, so a probe
 * judged a working AWS desktop as dead.
 *
 * 🔴 A cookie is only ever sent back to the EXACT origin (scheme, host, port)
 * that set it. `Domain=` is ignored (every cookie is host-only), and a redirect
 * to any other origin is never followed at all (see `getFollowingSameOriginCookies`).
 */

export type ProbeCookieJar = Map<string, Map<string, string>>;

/** Redirect hops a probe follows; `fetch`'s own default is 20. */
export const PROBE_MAX_REDIRECTS = 10;

function setCookieLines(headers: Headers): string[] {
    return typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/).filter(Boolean);
}

/** Record the response's cookies under the origin that sent them. */
export function storeSetCookies(jar: ProbeCookieJar, url: URL, headers: Headers): void {
    for (const line of setCookieLines(headers)) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair!.indexOf('=');
        if (eq <= 0) continue;
        const name = pair!.slice(0, eq).trim();
        const value = pair!.slice(eq + 1).trim();
        if (!name) continue;
        // A Secure cookie never rides plain HTTP.
        if (url.protocol !== 'https:' && attrs.some((a) => a.trim().toLowerCase() === 'secure')) continue;
        const cookies = jar.get(url.origin) ?? new Map<string, string>();
        const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a));
        if (expired) cookies.delete(name);
        else cookies.set(name, value);
        jar.set(url.origin, cookies);
    }
}

/** The `Cookie` header for this exact origin, or undefined when it set none. */
export function cookieHeaderFor(jar: ProbeCookieJar, url: URL): string | undefined {
    const cookies = jar.get(url.origin);
    if (!cookies || cookies.size === 0) return undefined;
    return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * GET with manual redirects: cookies set by an origin are replayed to that
 * origin only, at most `maxRedirects` hops are followed, and the final
 * response (any status) is returned. Throws on a hop limit or a non-HTTP
 * redirect target, as `fetch` itself throws on a redirect loop.
 *
 * 🔴 SSRF: only SAME-ORIGIN redirects are followed. The caller validated the
 * starting origin (`isOwnDesktopOrigin`); a server there (an app preview the
 * user controls, or a desktop the user is root on) must not be able to point
 * this server-side request at a private service or a metadata endpoint. A
 * redirect to any other origin ends the walk: that 3xx is returned as the
 * final response, and nothing is ever requested from its target.
 */
export async function getFollowingSameOriginCookies(
    rawUrl: string,
    init: { headers?: Record<string, string>; signal?: AbortSignal; cache?: RequestCache },
    jar: ProbeCookieJar = new Map(),
    maxRedirects = PROBE_MAX_REDIRECTS,
): Promise<{ response: Response; url: URL; jar: ProbeCookieJar }> {
    let url = new URL(rawUrl);
    for (let hop = 0; ; hop++) {
        const headers = new Headers(init.headers);
        headers.delete('cookie');
        const cookie = cookieHeaderFor(jar, url);
        if (cookie) headers.set('cookie', cookie);
        const response = await fetch(url.toString(), {
            method: 'GET', headers, redirect: 'manual', cache: init.cache, signal: init.signal,
        });
        storeSetCookies(jar, url, response.headers);
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) return { response, url, jar };
        if (hop >= maxRedirects) throw new Error('too_many_redirects');
        const next = new URL(location, url);
        if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new Error('unsupported_redirect');
        if (next.origin !== url.origin) return { response, url, jar };
        await response.body?.cancel().catch(() => undefined);
        url = next;
    }
}
