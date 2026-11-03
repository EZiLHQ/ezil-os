import 'server-only';

/**
 * The page a person was headed for, kept across "Sign out and use another account".
 *
 * That sign-out leaves through id.ezil.work's logout, which comes back to the registered `/login` with nothing else
 * (`post_logout_redirect_uri` is an exact allow-list entry, so no query can ride on it). The destination waits here
 * instead, in a host-only `__Host-` cookie no `*.ezil.org` sibling can plant, for at most ten minutes;
 * `/auth/auth0/login` expires it once a sign-in starts.
 *
 * It is a hint, never trusted: every reader passes it through `safeReturnUrl` like any `?returnUrl=`. base64url keeps
 * `;` and `,` in a query out of the cookie header.
 */
export const LOGIN_RETURN_COOKIE = '__Host-ezil-login-return';
export const LOGIN_RETURN_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
export const LOGIN_RETURN_MAX_AGE = 600;
const MAX_LENGTH = 2048;

export function encodeLoginReturn(path: string): string | null {
    return path.length > MAX_LENGTH ? null : Buffer.from(path, 'utf8').toString('base64url');
}

export function decodeLoginReturn(value: string | undefined): string | undefined {
    if (!value || value.length > Math.ceil(MAX_LENGTH * 4 / 3) + 4 || !/^[\w-]+$/.test(value)) return undefined;
    return Buffer.from(value, 'base64url').toString('utf8') || undefined;
}
