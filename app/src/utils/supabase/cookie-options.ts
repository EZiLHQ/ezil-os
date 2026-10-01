import type { CookieOptionsWithName } from '@supabase/ssr';

/**
 * Name of the Supabase auth cookie (and, by `@supabase/ssr`'s convention, the
 * prefix of its chunks and of the PKCE `-code-verifier` cookie) on HTTPS.
 *
 * 🔴 WHY `__Host-`. The app is served from `os.ezil.org`, and the desktops it
 * opens are served from sibling hosts under the same registrable domain —
 * `*-app.ezil.org`, `*-code.ezil.org`, `*-nekodesktop.ezil.org` — which carry
 * content the computer's owner controls (they have root inside it). Any page
 * on a sibling host can set a cookie with `Domain=ezil.org`, and the browser
 * would send it here. With the library's default name that is enough to
 * plant somebody else's session in a victim's browser: the victim signs into
 * what looks like their own OS and works inside the attacker's computer.
 *
 * A `__Host-` cookie is only accepted when it is `Secure`, has `Path=/` and
 * carries NO `Domain` attribute, so no sibling host can set or overwrite it.
 * `ezil-os.vercel.app` never had this problem — `vercel.app` is on the Public
 * Suffix List — which is why this arrives with the move to `os.ezil.org`.
 */
export const SECURE_AUTH_COOKIE_NAME = '__Host-ezil-os-auth';

/**
 * Cookie options for every Supabase client in the app. The server, the
 * middleware and the browser client MUST agree on the name, or one of them
 * writes a session the others cannot see — so they all call this.
 *
 * `secure` is decided by the caller from the request it is serving (or, in
 * the browser, from `location.protocol`), never from `NODE_ENV`: a production
 * build served over plain HTTP on loopback (`bun run dev:verify`, the local
 * host) must still be able to keep a session, and a `Secure` cookie set over
 * HTTP is silently dropped by Safari. On HTTP the library's defaults apply
 * unchanged — the sibling-host attack needs HTTPS hosts under ezil.org, and
 * there are none of those on loopback.
 */
export function authCookieOptions(secure: boolean): CookieOptionsWithName | undefined {
    if (!secure) return undefined;
    return { name: SECURE_AUTH_COOKIE_NAME, path: '/', sameSite: 'lax', secure: true };
}

/**
 * Whether the request was made over HTTPS, as seen by the edge in front of
 * the app. Vercel (and any reasonable proxy) sets `x-forwarded-proto`; with
 * no header at all this is a direct, local connection.
 */
export function isHttpsRequest(headers: Pick<Headers, 'get'>): boolean {
    const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    return proto === 'https';
}
