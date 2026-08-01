/** Named app routes — kept in one place so a path never gets typo'd twice. */
export const Routes = {
    HOME: '/',
    LOGIN: '/login',
    COMPUTERS: '/computers',
    COMPUTER: '/computer',
    /**
     * The EZiL OS shell. Added as a route, NOT yet as anyone's destination:
     * `/computers` remains where login lands and remains the fallback if the
     * shell is unavailable. Flipping the entry point is a separate, deliberate
     * change.
     */
    OS: '/os',
} as const;

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
 * Narrows a caller-supplied `returnUrl` down to a same-origin path, or falls
 * back to `/computers`.
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
 * The rule is "a path on this origin and nothing else", which means:
 *   - it must start with `/`;
 *   - but NOT `//` or `/\`, which browsers read as protocol-relative
 *     ("//evil.example" is `https://evil.example`, not a path);
 *   - and it must carry no control characters or whitespace, which are the
 *     usual way a second URL is smuggled past a naive parse.
 *
 * Anything else is not rejected loudly — there is no useful error to show
 * someone who followed a bad link — it just lands on the same place a login
 * with no `returnUrl` lands.
 */
export function safeReturnUrl(value: string | string[] | undefined | null): string {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string' || raw.length === 0) return Routes.COMPUTERS;
    if (!raw.startsWith('/')) return Routes.COMPUTERS;
    if (raw.startsWith('//') || raw.startsWith('/\\')) return Routes.COMPUTERS;
    // Control characters and whitespace, checked by codepoint rather than
    // by a regex literal so the guard itself contains no control bytes.
    for (let i = 0; i < raw.length; i += 1) {
        const code = raw.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) return Routes.COMPUTERS;
    }
    return raw;
}
