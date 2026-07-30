/** Named app routes — kept in one place so a path never gets typo'd twice. */
export const Routes = {
    HOME: '/',
    LOGIN: '/login',
    COMPUTERS: '/computers',
    COMPUTER: '/computer',
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
