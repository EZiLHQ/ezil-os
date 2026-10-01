/**
 * "Create a user, then authenticate": adopt an EZiL OS sign-in into the
 * shared EZiL account (EZiL Works) on first use of `/os`.
 *
 * All three EZiL products share one Supabase project. EZiL AI
 * (`ai.ezil.work`) and Works accept a token only when it carries
 * `app_metadata.ezil_role` and an `ezil_works.accounts` row backs it. An OS
 * invitee (`tools/invite.ts add`) has neither. Works already owns the one
 * endpoint that fixes that for an existing sign-in — `POST /account`
 * (ezil-work `apps/api/src/routes/identity.ts`): it verifies the caller's own
 * bearer, refuses an existing account (409 `account_exists`) and the
 * `operations` role (403 `role_unusable`), sets the role with ITS service
 * role, creates the account row, and undoes the role if the row fails.
 *
 * So this module never writes `app_metadata` or `ezil_works.*` itself and the
 * OS holds no service role: it calls Works with the user's own access token
 * and role `builder`, and asks the caller to refresh the session so the new
 * claim is in the token.
 *
 * 🔴 The refresh must happen in a Route Handler (`/auth/refresh`), never in
 * the `/os` Server Component that calls this. A Server Component cannot set
 * cookies; refreshing there would rotate the refresh token while the browser
 * kept the old one, and the next refresh would trip Supabase's reuse
 * detection and sign the user out.
 *
 * Idempotent: a token that already has the claim makes no request at all; a
 * sign-in whose auth record already has the role (a stale token) only needs
 * the refresh. Never throws.
 */

/** The role an OS user is adopted with. Works refuses `operations`. */
export const OS_ADOPTION_ROLE = 'builder' as const;

/** Query parameter that marks "already refreshed once on this load chain", so a refusal can never loop. */
export const EZIL_ACCOUNT_REFRESHED_PARAM = 'ezil_account';
export const EZIL_ACCOUNT_REFRESHED_VALUE = 'refreshed';

const WORKS_TIMEOUT_MS = 8_000;

export type EnsureEzilAccountResult =
    /** The token already carries a role: nothing to do. */
    | { status: 'ready'; role: string }
    /** Works created the account (or the auth record already had a role): refresh the session, then reload. */
    | { status: 'refresh'; adopted: boolean }
    /** Adoption is not configured here (`EZIL_WORKS_API_ORIGIN` unset) or there is no cookie session. */
    | { status: 'skipped'; reason: 'not_configured' | 'no_session' }
    /** Works refused or could not be reached. `message` is safe to show; `retry` says whether a later load may succeed. */
    | { status: 'failed'; code: string; httpStatus?: number; message: string; retry: boolean };

/** Read (not verify) `app_metadata.ezil_role` from an access token. Identity comes from `getUser()` upstream. */
export function tokenEzilRole(accessToken: string): string | null {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    try {
        const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { app_metadata?: { ezil_role?: unknown } };
        const role = claims.app_metadata?.ezil_role;
        return typeof role === 'string' && role !== '' ? role : null;
    } catch {
        return null;
    }
}

/** `EZIL_WORKS_API_ORIGIN` as an origin with no trailing slash; https only, except http on localhost. */
export function parseWorksApiOrigin(value: string | undefined): string | null {
    if (!value?.trim()) return null;
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return url.origin;
}

export interface EnsureEzilAccountInput {
    /** The cookie session's access token, or null when there is none. */
    accessToken: string | null;
    /** `app_metadata` of the user as the auth server reports it now (`getUser()`), fresher than the token. */
    userAppMetadata: Record<string, unknown> | undefined;
    /** `EZIL_WORKS_API_ORIGIN`, already parsed; null disables adoption. */
    worksApiOrigin: string | null;
    fetchImpl?: typeof fetch;
}

function worksMessage(body: unknown): { code: string | null; message: string | null } {
    if (typeof body !== 'object' || body === null) return { code: null, message: null };
    const record = body as { error?: unknown; message?: unknown };
    return {
        code: typeof record.error === 'string' ? record.error : null,
        message: typeof record.message === 'string' ? record.message.slice(0, 300) : null,
    };
}

export async function ensureEzilAccount(input: EnsureEzilAccountInput): Promise<EnsureEzilAccountResult> {
    if (input.accessToken === null) return { status: 'skipped', reason: 'no_session' };
    const claimed = tokenEzilRole(input.accessToken);
    if (claimed !== null) return { status: 'ready', role: claimed };

    // The auth record already has a role (set by Works earlier; this token
    // predates it): the account exists, only the token is stale.
    const recorded = input.userAppMetadata?.ezil_role;
    if (typeof recorded === 'string' && recorded !== '') return { status: 'refresh', adopted: false };

    if (input.worksApiOrigin === null) return { status: 'skipped', reason: 'not_configured' };

    let response: Response;
    try {
        response = await (input.fetchImpl ?? fetch)(`${input.worksApiOrigin}/account`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${input.accessToken}` },
            body: JSON.stringify({ role: OS_ADOPTION_ROLE }),
            redirect: 'error',
            signal: AbortSignal.timeout(WORKS_TIMEOUT_MS),
        });
    } catch {
        return {
            status: 'failed',
            code: 'works_unreachable',
            message: 'EZiL could not finish setting up your account right now. Reload EZiL OS to try again.',
            retry: true,
        };
    }

    if (response.status === 201) return { status: 'refresh', adopted: true };

    const detail = worksMessage(await response.json().catch(() => null));
    if (response.status === 409) {
        // An account row exists while the auth record has no role: the two
        // systems disagree, and retrying cannot fix that.
        return {
            status: 'failed',
            code: detail.code ?? 'account_exists',
            httpStatus: 409,
            message: 'This sign-in already has an EZiL account that is not set up for EZiL OS. Contact EZiL support.',
            retry: false,
        };
    }
    if (response.status >= 400 && response.status < 500) {
        return {
            status: 'failed',
            code: detail.code ?? `works_http_${response.status}`,
            httpStatus: response.status,
            // Works writes its refusal messages for people (refusal.ts); keep its own when it sent one.
            message: detail.message ?? 'EZiL refused to set up an account for this sign-in. Contact EZiL support.',
            retry: response.status === 401 || response.status === 429,
        };
    }
    return {
        status: 'failed',
        code: detail.code ?? `works_http_${response.status}`,
        httpStatus: response.status,
        message: 'EZiL could not finish setting up your account right now. Reload EZiL OS to try again.',
        retry: true,
    };
}

/** Where `/os` sends the browser to refresh its session once, then come back marked. */
export function refreshSessionUrl(returnPath: string): string {
    const back = `${returnPath}${returnPath.includes('?') ? '&' : '?'}${EZIL_ACCOUNT_REFRESHED_PARAM}=${EZIL_ACCOUNT_REFRESHED_VALUE}`;
    return `/auth/refresh?returnUrl=${encodeURIComponent(back)}`;
}

/**
 * The `/os` page step: adopt if needed, and say where to go. `redirectTo` is
 * set only when a session refresh is due and has not already happened on this
 * load chain (`refreshedMarker`), so a refused or stale adoption can never
 * loop. A failure is logged (never the token) and the OS still opens: EZiL AI
 * then explains the missing account in the chat.
 */
export async function ezilAccountStepForOsPage(params: {
    userId: string;
    accessToken: string | null;
    userAppMetadata: Record<string, unknown> | undefined;
    worksApiOrigin: string | null;
    refreshedMarker: string | string[] | undefined;
    fetchImpl?: typeof fetch;
}): Promise<{ redirectTo: string | null; result: EnsureEzilAccountResult }> {
    const result = await ensureEzilAccount(params);
    const alreadyRefreshed = (Array.isArray(params.refreshedMarker) ? params.refreshedMarker[0] : params.refreshedMarker) === EZIL_ACCOUNT_REFRESHED_VALUE;
    if (result.status === 'failed') {
        console.error('[os] EZiL account setup failed', { userId: params.userId, code: result.code, httpStatus: result.httpStatus, retry: result.retry, message: result.message });
    } else if (result.status === 'refresh' && alreadyRefreshed) {
        console.error('[os] EZiL account: the session still has no role after one refresh', { userId: params.userId, adopted: result.adopted });
    } else if (result.status === 'refresh' && result.adopted) {
        console.info('[os] EZiL account created for this sign-in (role builder); refreshing the session', { userId: params.userId });
    }
    const redirectTo = result.status === 'refresh' && !alreadyRefreshed ? refreshSessionUrl('/os') : null;
    return { redirectTo, result };
}
