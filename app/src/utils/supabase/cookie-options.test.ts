import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { authCookieOptions, isHttpsRequest, SECURE_AUTH_COOKIE_NAME } from './cookie-options';

describe('authCookieOptions', () => {
    it('🔴 on HTTPS the session cookie is a __Host- cookie: Secure, Path=/, no Domain', () => {
        const options = authCookieOptions(true);
        expect(options?.name).toBe(SECURE_AUTH_COOKIE_NAME);
        expect(SECURE_AUTH_COOKIE_NAME.startsWith('__Host-')).toBe(true);
        expect(options?.secure).toBe(true);
        expect(options?.path).toBe('/');
        // A Domain attribute would make the browser reject a __Host- cookie
        // outright, and would hand it to every sibling host besides.
        expect(options && 'domain' in options).toBe(false);
        expect(options?.sameSite).toBe('lax');
    });

    it('on plain HTTP it leaves the library defaults alone', () => {
        expect(authCookieOptions(false)).toBeUndefined();
    });
});

describe('isHttpsRequest', () => {
    const h = (value?: string) => new Headers(value === undefined ? {} : { 'x-forwarded-proto': value });

    it('reads the proto the edge saw', () => {
        expect(isHttpsRequest(h('https'))).toBe(true);
        expect(isHttpsRequest(h('HTTPS'))).toBe(true);
        expect(isHttpsRequest(h('http'))).toBe(false);
    });

    it('takes the first hop of a comma-separated chain', () => {
        expect(isHttpsRequest(h('https, http'))).toBe(true);
    });

    it('treats a missing header as a direct local connection', () => {
        expect(isHttpsRequest(h())).toBe(false);
    });
});

describe('every Supabase client agrees on the cookie name', () => {
    // A client that used the library default would write (or look for) a
    // session the others cannot see — sign-in would appear to work and then
    // every page would treat the visitor as signed out.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const read = (file: string) => readFileSync(path.join(here, file), 'utf8');

    for (const file of ['server.ts', 'middleware.ts', 'client.ts']) {
        it(`${file} passes authCookieOptions`, () => {
            expect(read(file)).toMatch(/cookieOptions: authCookieOptions\(/);
        });
    }
});
