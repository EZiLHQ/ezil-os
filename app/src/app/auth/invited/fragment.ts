/**
 * Reading the session Supabase hands back in the URL **fragment**.
 *
 * ── Why a fragment, and why this cannot be done on the server ───────────────
 * Supabase invites are not PKCE. Verbatim from the installed
 * `@supabase/auth-js` (`dist/module/GoTrueAdminApi.js:95`):
 *
 *   "Note that PKCE is not supported when using `inviteUserByEmail`. This is
 *    because the browser initiating the invite is often different from the
 *    browser accepting the invite which makes it difficult to provide the
 *    security guarantees required of the PKCE flow."
 *
 * So the default invite email's `{{ .ConfirmationURL }}` —
 * `<project>/auth/v1/verify?token={{ .TokenHash }}&type=invite&redirect_to=…`
 * (supabase.com/docs/guides/auth/auth-email-templates) — completes as an
 * IMPLICIT grant: the browser is redirected to `redirect_to` with
 * `#access_token=…&refresh_token=…&expires_in=…&token_type=bearer&type=invite`.
 * A fragment is never sent to a server, so `/auth/callback` (a route handler
 * reading `?code=`) can never see it. That was row A1's open hand-off.
 *
 * 🔴 AND AUTH-JS WILL NOT PICK IT UP EITHER. `@supabase/ssr`'s
 * `createBrowserClient` hard-codes `flowType: "pkce"`
 * (`dist/module/createBrowserClient.js:34`), and auth-js's
 * `_getSessionFromURL` starts with a flow-type check:
 *
 *     case 'implicit':
 *         if (this.flowType === 'pkce') {
 *             throw new AuthPKCEGrantCodeExchangeError('Not a valid PKCE flow url.');
 *         }
 *
 * — so `detectSessionInUrl` THROWS on an invite fragment instead of
 * establishing the session. Reading the fragment here and calling
 * `setSession()` explicitly is therefore not belt-and-braces; it is the only
 * thing that works with this client.
 *
 * ── Why this is a separate, pure module ─────────────────────────────────────
 * It is the only part of `/auth/invited` that can be tested without a browser
 * and without Supabase, and it is the part attacker-controlled text reaches
 * first. It returns TOKENS AND NOTHING ELSE — no destination, no redirect, no
 * message to render as markup. Anything else in the fragment is dropped on the
 * floor, so a crafted `#…&next=https://evil.example` has nothing to steer.
 */

export interface AuthFragmentSession {
    kind: 'session';
    accessToken: string;
    refreshToken: string;
    /** `invite`, `recovery`, … — informational only; never a destination. */
    type: string | null;
}

export interface AuthFragmentError {
    kind: 'error';
    /** GoTrue's own `error_code` where present, e.g. `otp_expired`. */
    code: string | null;
    /** Already URL-decoded. Rendered as TEXT by the caller, never as markup. */
    description: string | null;
}

export interface AuthFragmentNone {
    kind: 'none';
}

export type AuthFragment = AuthFragmentSession | AuthFragmentError | AuthFragmentNone;

/**
 * Parse `window.location.hash`.
 *
 * 🔴 BOTH TOKENS OR NEITHER. A fragment carrying only an `access_token` is not
 * half a session: `setSession` needs the refresh token, and a session that
 * cannot refresh silently dies mid-use. `none` is the honest answer, and the
 * caller then falls back to "is there already a session?" rather than
 * establishing a broken one.
 *
 * 🔴 An `error` in the fragment wins over everything else, even if tokens are
 * somehow present too — the same precedence auth-js's `_getSessionFromURL`
 * uses ("If there's an error in the URL, it doesn't matter what flow it is").
 */
export function parseAuthFragment(hash: string | null | undefined): AuthFragment {
    if (typeof hash !== 'string') return { kind: 'none' };

    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    if (raw.trim().length === 0) return { kind: 'none' };

    let params: URLSearchParams;
    try {
        params = new URLSearchParams(raw);
    } catch {
        // `URLSearchParams` does not throw on ordinary input, but the fragment
        // is attacker-reachable and a parse failure must not take the page
        // down with it.
        return { kind: 'none' };
    }

    const error = params.get('error');
    const errorCode = params.get('error_code');
    const errorDescription = params.get('error_description');
    if (error !== null || errorCode !== null || errorDescription !== null) {
        return {
            kind: 'error',
            code: errorCode ?? error,
            description: errorDescription,
        };
    }

    const accessToken = (params.get('access_token') ?? '').trim();
    const refreshToken = (params.get('refresh_token') ?? '').trim();
    if (!accessToken || !refreshToken) return { kind: 'none' };

    return {
        kind: 'session',
        accessToken,
        refreshToken,
        type: params.get('type'),
    };
}
