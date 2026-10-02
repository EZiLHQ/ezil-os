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
