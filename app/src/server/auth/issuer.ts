/**
 * EZiL ID's exact issuer, trailing slash included. Isolated here so code that only needs the value (the
 * delegation verifier) does not import the cookie and sign-in machinery in `auth0.ts`, which re-exports it.
 */
export const AUTH0_ISSUER = 'https://id.ezil.work/';
