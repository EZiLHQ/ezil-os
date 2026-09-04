/**
 * The decisions `./route.ts` makes about an emailed confirmation link, kept
 * out of the route file itself.
 *
 * 🔴 NOT A STYLE CHOICE. Next's App Router validates a `route.ts` module's
 * export list and fails the BUILD on anything that is not a route export —
 * MEASURED on this project: `"isVerifiableType" is not a valid Route export
 * field`, `next build` exit 1. So a route handler's helpers either live in a
 * file like this one or are unexported and untestable. This is the first.
 */

/**
 * The OTP types `/auth/confirm` will verify.
 *
 * 🔴 A RUNTIME ALLOW-LIST, not a cast. `EmailOtpType` in `@supabase/auth-js`
 * is `'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' |
 * 'email' | (string & {})` — the `(string & {})` member means TypeScript
 * accepts ANY string as that type, so the `as EmailOtpType` the upstream
 * Next.js example uses validates precisely nothing. An unchecked `type` from
 * the query string would go straight into a request to the auth server.
 *
 * `signup` and `email_change` are deliberately absent: self-service sign-up
 * was deleted with this row (see `app/src/app/login/actions.ts`) and this app
 * never initiates an email change, so accepting either would be an entry point
 * with nothing on the other end of it.
 */
export const VERIFIABLE_TYPES = ['invite', 'magiclink', 'recovery', 'email'] as const;

export type VerifiableType = (typeof VERIFIABLE_TYPES)[number];

export function isVerifiableType(value: string | null | undefined): value is VerifiableType {
    return typeof value === 'string' && (VERIFIABLE_TYPES as readonly string[]).includes(value);
}

/** Where an invited user sets the password their account does not have yet. */
export const INVITED_PATH = '/auth/invited';

/**
 * Where a verified link lands.
 *
 * An `invite` has no password — the account was created by the invite itself —
 * so it goes to `/auth/invited`, the one place that asks for one. Everything
 * else goes to the caller's `next`, which the route has already narrowed with
 * `safeReturnUrl`; that narrowing is what stops `?next=https://evil.example`
 * from turning a freshly-minted session into an open redirect.
 */
export function destinationFor(type: VerifiableType, next: string): string {
    return type === 'invite' ? INVITED_PATH : next;
}
