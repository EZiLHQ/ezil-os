/**
 * EZiL ID's (Auth0) issuer. Its own module, free of `server-only` and
 * `next/headers`, so `server/api/delegation-auth.ts` can name the same issuer
 * the sign-in bridge trusts without importing the sign-in machinery.
 */
export const AUTH0_ISSUER = 'https://id.ezil.work/';
