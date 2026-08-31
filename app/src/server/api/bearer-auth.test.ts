/**
 * `userFromBearer` — the header half of `createTRPCContext`.
 *
 * This is the seam where a second way to AUTHENTICATE was added (so `sdk/` and
 * the `mcp/` connector, which have no cookie jar, can call the same API the
 * browser does) without adding a second way to AUTHORIZE. The property that
 * matters is the one asserted hardest below: a bearer that is present but does
 * not check out must resolve to `null`, never fall through to the cookie.
 */
import { describe, expect, it } from 'vitest';

import type { User } from '@supabase/supabase-js';

import { type BearerVerifier, userFromBearer } from './bearer-auth';

const ALICE = { id: 'alice-uuid' } as User;

/** Accepts exactly one token; anything else is rejected the way GoTrue would. */
const verifier = (goodToken: string, cookieUser: User | null = null): BearerVerifier & { calls: (string | undefined)[] } => {
    const calls: (string | undefined)[] = [];
    return {
        calls,
        auth: {
            async getUser(jwt?: string) {
                calls.push(jwt);
                if (jwt === undefined) return { data: { user: cookieUser }, error: null };
                return jwt === goodToken
                    ? { data: { user: ALICE }, error: null }
                    : { data: { user: null }, error: { message: 'invalid JWT' } };
            },
        },
    };
};

const headers = (value?: string) => new Headers(value ? { authorization: value } : {});

describe('userFromBearer', () => {
    it('returns undefined when no Authorization header is offered — meaning "use the cookie"', async () => {
        const v = verifier('good');
        await expect(userFromBearer(v, headers())).resolves.toBeUndefined();
        expect(v.calls).toEqual([]);
    });

    it('resolves a valid bearer to its user', async () => {
        const v = verifier('good');
        await expect(userFromBearer(v, headers('Bearer good'))).resolves.toEqual(ALICE);
        expect(v.calls).toEqual(['good']);
    });

    it('is case-insensitive in the scheme and tolerates extra whitespace', async () => {
        const v = verifier('good');
        await expect(userFromBearer(v, headers('bearer   good'))).resolves.toEqual(ALICE);
        await expect(userFromBearer(v, headers('  BEARER good  '))).resolves.toEqual(ALICE);
    });

    // 🔴 The whole point. Each of these is a request that OFFERED a credential
    // and failed to prove it. If any returned `undefined`, the caller would go
    // on to read the session cookie and serve the browser's own user — handing
    // a stranger's dead token the signed-in user's computers.
    it.each([
        ['an expired/forged token', 'Bearer wrong'],
        ['an empty token', 'Bearer    '],
        ['a token with no scheme', 'good'],
        ['the wrong scheme', 'Basic Z29vZA=='],
        ['a scheme-only header', 'Bearer'],
    ])('never falls back to the cookie for %s', async (_label, header) => {
        const v = verifier('good', ALICE); // cookie WOULD authenticate as Alice
        const result = await userFromBearer(v, headers(header));
        expect(result).toBeNull();
        expect(result).not.toBeUndefined();
    });

    it('resolves to null — not a throw — when the verifier reports an error', async () => {
        const v = verifier('good');
        await expect(userFromBearer(v, headers('Bearer nope'))).resolves.toBeNull();
    });
});

describe('userFromBearer — header parsing hardening', () => {
    const v = (): BearerVerifier => ({
        auth: {
            async getUser(jwt?: string) {
                return jwt === 'good'
                    ? { data: { user: ALICE }, error: null }
                    : { data: { user: null }, error: { message: 'invalid' } };
            },
        },
    });

    // Applied to an attacker-controlled header, so it must not be the
    // `\s+(.+)` shape CodeQL flags for polynomial backtracking.
    it('matches a very long token without catastrophic backtracking', async () => {
        const started = Date.now();
        await userFromBearer(v(), new Headers({ authorization: `Bearer ${'a'.repeat(50_000)}` }));
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('accepts a tab as the separator, per RFC 7230 whitespace', async () => {
        const h = new Headers({ authorization: 'Bearer\tgood' });
        await expect(userFromBearer(v(), h)).resolves.toEqual(ALICE);
    });

    it('does not treat a multi-word value as the first word', async () => {
        // "bad good" must not match as token "bad" — the whole value is the token.
        await expect(userFromBearer(v(), new Headers({ authorization: 'Bearer bad good' }))).resolves.toBeNull();
    });
});
