import { CANONICAL_ORIGIN, OWNED_APP_ORIGINS } from '@/utils/forwarded';

export { OWNED_APP_ORIGINS };

/** Stripe return URLs may use only owned apps or explicit local development ports. */
export function billingReturnOrigin(headers?: Pick<Headers, 'get'>): string {
    const origin = headers?.get('origin');
    if (origin && OWNED_APP_ORIGINS.some(owned => origin === owned)) return origin;
    if (origin && process.env.NODE_ENV !== 'production') {
        const local = /^http:\/\/(?:localhost|127\.0\.0\.1):([0-9]{1,5})$/.exec(origin);
        if (local && local[0] === origin && Number(local[1]) <= 65535) return origin;
    }
    return CANONICAL_ORIGIN;
}
