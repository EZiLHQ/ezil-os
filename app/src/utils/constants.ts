/** Named app routes — kept in one place so a path never gets typo'd twice. */
export const Routes = {
    HOME: '/',
    LOGIN: '/login',
    COMPUTERS: '/computers',
    COMPUTER: '/computer',
    /**
     * The EZiL OS shell. This is where a successful sign-in with no explicit
     * `returnUrl` lands (see `safeReturnUrl`'s empty-input branch). `/computers`
     * remains reachable and is still the fallback used when a `returnUrl` is
     * present but rejected, and when the shell itself cannot produce a
     * computer (`/os`'s `CouldNotOpen`) or fails to boot (`<BootWatchdog>`).
     */
    OS: '/os',
    /**
     * `/app/<id>` serves the same shell as `/os`, opened at one app (see
     * docs/APP-ROUTES.md). Build it with `shellAppRoute`.
     */
    APP: '/app',
} as const;

/**
 * Every id `/app/<id>` accepts: the shell registry's app ids
 * (`shell/ezil/apps/registry.js` `APPS`) and its URL aliases
 * (`shell/ezil/app-link.js` `ALIASES`). Anything else is a 404. A test reads
 * both shell files and fails if this list drifts from them.
 */
export const SHELL_APP_IDS = ['secure-browser', 'desktop', 'code', 'app-store', 'settings', 'preview'] as const;
export const SHELL_APP_ALIASES = { browser: 'desktop' } as const;

export function isShellAppId(id: unknown): id is string {
    return typeof id === 'string'
        && ((SHELL_APP_IDS as readonly string[]).includes(id) || Object.hasOwn(SHELL_APP_ALIASES, id));
}

/** `/app/<id>` for an allowlisted id; throws on anything else. */
export function shellAppRoute(id: string): string {
    if (!isShellAppId(id)) throw new Error('Not a shell app id');
    return `${Routes.APP}/${id}`;
}

/**
 * `pathname` plus a page's search params, re-serialised for a return URL.
 * `/` is left readable in values: the shell refuses a project `path` whose
 * separators arrive percent-encoded, so `path=src/main.ts` must survive the
 * sign-in round trip as written.
 */
export function returnUrlFor(pathname: string, params: Record<string, string | string[] | undefined>): string {
    const pairs: string[] = [];
    const encode = (value: string) => encodeURIComponent(value).replace(/%2F/g, '/');
    for (const [key, value] of Object.entries(params)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            pairs.push(`${encode(key)}=${encode(item)}`);
        }
    }
    return `${pathname}${pairs.length ? `?${pairs.join('&')}` : ''}`;
}

/** Query param carrying the URL to return to after a successful login. */
export const RETURN_URL_PARAM = 'returnUrl';

/**
 * Hard cap on live (non-soft-deleted) computers per user. Mirrored in the
 * database as a CHECK constraint (see
 * src/server/db/schema/computers.ts) and re-exported from
 * src/server/api/routers/computer.ts so the server-side source of truth and
 * this client-facing constant can never drift silently.
 */
export const MAX_COMPUTERS_PER_USER = 2;

/** Builds `?returnUrl=<path>` for a redirect back after login. */
export function getReturnUrlQueryParam(pathname: string): string {
    return new URLSearchParams({ [RETURN_URL_PARAM]: pathname }).toString();
}

/**
 * Narrows a caller-supplied `returnUrl` down to a same-origin path.
 *
 * 🔴 `returnUrl` arrives from a query string — i.e. from whatever link the
 * user clicked. It is then handed to a navigation primitive. Before this
 * existed the value went straight into `redirect()`, and after the sign-in
 * path moved to `window.location.assign` (see `login/actions.ts`) it would go
 * straight into the browser's address bar. Either way an unfiltered value is
 * an open redirect: `/login?returnUrl=https://evil.example` sends a user who
 * just typed their password to somebody else's site, from a URL that starts
 * with ours.
 *
 * The rule is "one of this app's own pages, on this origin", which means:
 *   - it must start with `/`;
 *   - but NOT `//` or `/\`, which browsers read as protocol-relative
 *     ("//evil.example" is `https://evil.example`, not a path);
 *   - it must carry no control characters or whitespace, which are the
 *     usual way a second URL is smuggled past a naive parse, and no
 *     backslash anywhere;
 *   - and its PATH must be, exactly, one this app sends people back to:
 *     `/os`, `/app/<shell app id>` (see `SHELL_APP_IDS`), `/computers`,
 *     `/computer/<uuid>`, `/billing/return`. Matching whole paths is also
 *     what refuses dot segments (`/app/../admin`) and encoded separators or
 *     dots (`/app/%2e%2e/x`, `/os%2fadmin`): none of those shapes can be on
 *     the list. The query is data and is kept as it is (`%2F` there is
 *     ordinary encoding).
 *
 * 🔴 THREE outcomes, on purpose — these are not the same decision:
 *   - No `returnUrl` was supplied at all (absent, or an empty string): there
 *     is nothing to reject, this is just an ordinary sign-in, and it lands on
 *     `Routes.OS` — the product's actual entry point.
 *   - A `returnUrl` under `/app` that failed the checks (an unknown app, a
 *     dot segment, an encoded separator): the person was on their way into
 *     the OS, so they land on `Routes.OS`, the same page without the app.
 *   - Any other `returnUrl` that failed: an anomalous, possibly hostile
 *     input, arriving on a session that just authenticated. It is not
 *     rejected loudly — there is no useful error to show someone who
 *     followed a bad link — but it also does not get the benefit of the
 *     doubt that a plain sign-in gets: it lands on `Routes.COMPUTERS`, the
 *     plain list view, rather than on the shell.
 *
 * Compatibility (docs/APP-ROUTES.md §6 has the table). Before `/app/<id>`
 * existed, any path that passed the shape checks was kept, so a few paths
 * that used to come back now land on `/computers`: `/`, `/pricing`,
 * `/login`, `/admin/*`, `/os/`, `/computers/`. No producer in this repository
 * sends any of them. The cases below are numbered as the tests name them
 * (`constants.test.ts`, "compatibility decisions"); their ORDER is part of
 * the rule.
 */
export function safeReturnUrl(value: string | string[] | undefined | null): string {
    // Case 1 — nothing supplied. A repeated parameter counts by its first
    // value only, so `?returnUrl=/os&returnUrl=https://evil` cannot widen.
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string' || raw.length === 0) return Routes.OS;
    // Case 2 — hostile shapes, refused before the path is read at all, and so
    // BEFORE case 4: `/app\..\admin` or `/app/code<TAB>` is not "an /app path
    // we cannot vouch for", it is a smuggling attempt, and lands on
    // `/computers`. Not a path (a scheme, a relative path); protocol-relative
    // `//` and `/\`; a backslash anywhere, query included. Besides
    // `constants.test.ts`, the login page, the Auth0 flow and `/auth/confirm`
    // each have a test that asserts this case's `/computers`.
    if (!raw.startsWith('/')) return Routes.COMPUTERS;
    if (raw.startsWith('//') || raw.startsWith('/\\') || raw.includes('\\')) return Routes.COMPUTERS;
    // Control characters and whitespace, checked by codepoint rather than
    // by a regex literal so the guard itself contains no control bytes.
    for (let i = 0; i < raw.length; i += 1) {
        const code = raw.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) return Routes.COMPUTERS;
    }
    const end = raw.search(/[?#]/);
    const path = end === -1 ? raw : raw.slice(0, end);
    // Case 3 — one of this app's return pages: kept byte for byte, query and
    // hash included. The query is data: `path=src/main.ts` keeps its `/`
    // (see `returnUrlFor`) and `%2F` there is ordinary encoding.
    if (isReturnPath(path)) return raw;
    // Case 4 — a rejected `/app` path (`/app`, `/app/`, `/app/unknown`,
    // `/app/Code`, `/app/../x`, `/app/%2e%2e/x`, `/app/code%2fx`,
    // `/app/code/x`): the person was on their way into the OS.
    if (path === Routes.APP || path.startsWith(`${Routes.APP}/`)) return Routes.OS;
    // Case 5 — any other rejected path, including every page base accepted
    // and this list does not (see "Compatibility" above). The destination
    // is the one base gave rejected input; the rejection itself is new, and
    // only `constants.test.ts` pins it.
    return Routes.COMPUTERS;
}

const UUID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pages a sign-in may return to, matched as whole paths (so no dot
 * segment, encoded separator, trailing slash or extra segment can pass). */
function isReturnPath(path: string): boolean {
    // `/os`: the shell; `?app=` / `?settings=` live in its query. Produced by
    // the `/os` page, the pricing CTA and `EZIL_ID_SIGN_IN_URL`.
    // `/computers`: `computers/layout.tsx`. `/billing/return`: its own page.
    if (path === Routes.OS || path === Routes.COMPUTERS || path === '/billing/return') return true;
    // `/app/<id>`: one segment, an allowlisted registry id or alias,
    // case-sensitive (`isShellAppId`: an exact entry of `SHELL_APP_IDS` or an
    // own key of `SHELL_APP_ALIASES`, so `__proto__` and friends fail).
    // Produced by the `/app/[appId]` page.
    if (path.startsWith(`${Routes.APP}/`)) return isShellAppId(path.slice(Routes.APP.length + 1));
    // `/computer/<uuid>`: `computer/layout.tsx` (`x-pathname`); either case.
    if (path.startsWith(`${Routes.COMPUTER}/`)) return UUID_PATH.test(path.slice(Routes.COMPUTER.length + 1));
    return false;
}
