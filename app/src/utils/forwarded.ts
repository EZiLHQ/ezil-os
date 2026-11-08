/**
 * The scheme and host a request was made to, as seen by the edge in front of
 * the app. One parser for every caller — the OAuth `redirectTo`, the auth
 * cookie's name and the cross-origin write guard all depend on these, and three
 * hand-rolled readings of the same headers used to disagree (a comma-separated
 * `x-forwarded-proto: https, http` built a redirect URL starting "https, http").
 *
 * Vercel and any reasonable reverse proxy set `x-forwarded-proto` and
 * `x-forwarded-host`; `next start` adds them for direct connections. A proxy
 * that terminates TLS without forwarding the scheme is misconfigured for this
 * app: the server would think it is on HTTP while the browser is on HTTPS.
 */
type HeaderReader = Pick<Headers, 'get'>;

/** First hop of a comma-separated forwarded header, trimmed and lower-cased. */
function firstHop(value: string | null): string | null {
    const hop = value?.split(',')[0]?.trim().toLowerCase();
    return hop ? hop : null;
}

/** `'https'`, `'http'`, or `null` when nothing in front of the app said. */
export function forwardedProto(headers: HeaderReader): 'https' | 'http' | null {
    const proto = firstHop(headers.get('x-forwarded-proto'));
    return proto === 'https' || proto === 'http' ? proto : null;
}

/** Drops `:443` from an HTTPS host and `:80` from an HTTP one. */
export function withoutDefaultPort(host: string, proto: 'https' | 'http' | null): string {
    if (proto !== 'http' && host.endsWith(':443')) return host.slice(0, -4);
    if (proto !== 'https' && host.endsWith(':80')) return host.slice(0, -3);
    return host;
}

/** The public host (with a non-default port, if any), or `null`. */
export function forwardedHost(headers: HeaderReader): string | null {
    const host = firstHop(headers.get('x-forwarded-host')) ?? firstHop(headers.get('host'));
    return host ? withoutDefaultPort(host, forwardedProto(headers)) : null;
}

/**
 * The public origin the browser used (e.g. https://os-staging.ezil.work behind
 * Caddy), not the app's own listener: `request.url` is the loopback address when
 * the app sits behind a reverse proxy. Falls back to `fallback` with no host header.
 */
export function publicOrigin(headers: HeaderReader, fallback: string): string {
    const host = forwardedHost(headers);
    return host ? `${forwardedProto(headers) ?? 'http'}://${host}` : new URL(fallback).origin;
}

/** Public app origins this deployment may redirect to (auth callbacks, Stripe returns). */
export const OWNED_APP_ORIGINS = [
    'https://os.ezil.org',
    'https://os.ezil.work',
    'https://os-staging.ezil.work',
] as const;
const CANONICAL_ORIGIN = 'https://os.ezil.org';

/** The fixed PR preview slot hosts (`deploy/aws/os-staging/preview`). Exact hosts, never a `*.ezil.work` grant. */
const PR_PREVIEW_SLOT_ORIGIN = /^https:\/\/os-pv[1-9]\.ezil\.work$/;

/**
 * This container's own PR preview origin, or `null`. Read at runtime, so the image a
 * preview tested can be promoted unchanged: only the preview host's env overlay sets
 * both `EZIL_DEPLOY_ENV=pr-preview` and the slot origin, and a value that is not
 * exactly a slot origin is ignored.
 */
export function prPreviewOrigin(): string | null {
    if (process.env.EZIL_DEPLOY_ENV !== 'pr-preview') return null;
    const origin = process.env.EZIL_PR_PREVIEW_ORIGIN ?? '';
    return PR_PREVIEW_SLOT_ORIGIN.test(origin) ? origin : null;
}

/** An owned origin: a fixed one, or this container's own preview slot. */
export function isOwnedAppOrigin(origin: string): boolean {
    return (OWNED_APP_ORIGINS as readonly string[]).includes(origin) || origin === prPreviewOrigin();
}

/** Where an unowned origin is sent: a preview never bounces its QA session into production. */
export function canonicalAppOrigin(): string {
    return prPreviewOrigin() ?? CANONICAL_ORIGIN;
}

/** `publicOrigin`, but only an owned origin (or local dev outside production); otherwise the canonical one. */
export function ownedPublicOrigin(headers: HeaderReader, fallback: string): string {
    const origin = publicOrigin(headers, fallback);
    if (isOwnedAppOrigin(origin)) return origin;
    if (process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/.test(origin)) return origin;
    return canonicalAppOrigin();
}
