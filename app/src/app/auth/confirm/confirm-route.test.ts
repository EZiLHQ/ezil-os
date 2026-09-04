/**
 * `GET /auth/confirm` — the server-side half of an emailed link.
 *
 * The Supabase client is stubbed at the module boundary rather than through a
 * seam, because the unit under test IS the route handler and its whole job is
 * the order of four things: validate the type, verify the token, follow the
 * per-type destination, and fall back to one failure page. A seam here would
 * have meant exporting a second `GET` that takes a client — i.e. two handlers,
 * one of them the one that actually ships.
 *
 * 🔴 WHAT THIS CANNOT SEE. `verifyOtp` writes the session cookies through
 * `createClient`'s `setAll`, and this stub has no cookies. So these tests
 * prove CONTROL FLOW — which destination, on which input — and not that a real
 * session lands on the response. The mechanism is the one `../callback/route.ts`
 * already uses in production (set-cookies inside the handler, then
 * `NextResponse.redirect`), which is a reason to believe it, not a measurement
 * of it. The measurement belongs to row R2, against the deployed host.
 */
import { describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => {
    const state = {
        /** Every `verifyOtp` argument the handler passed, in order. */
        calls: [] as { type: string; token_hash: string }[],
        /** What `verifyOtp` answers next. `null` = success. */
        error: null as { message: string } | null,
    };
    return state;
});

vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({
        auth: {
            verifyOtp: async (args: { type: string; token_hash: string }) => {
                stub.calls.push(args);
                return { data: { user: null, session: null }, error: stub.error };
            },
        },
    }),
}));

import { NextRequest } from 'next/server';

import { destinationFor, isVerifiableType, VERIFIABLE_TYPES } from './confirm-link';
import { GET } from './route';

const ORIGIN = 'https://os.ezil.work';

async function confirm(query: string) {
    stub.calls = [];
    stub.error = null;
    const response = await GET(new NextRequest(`${ORIGIN}/auth/confirm${query}`));
    return { response, location: response.headers.get('location'), calls: stub.calls };
}

async function confirmFailing(query: string) {
    stub.calls = [];
    stub.error = { message: 'Token has expired or is invalid' };
    const response = await GET(new NextRequest(`${ORIGIN}/auth/confirm${query}`));
    return { response, location: response.headers.get('location'), calls: stub.calls };
}

// ── The type allow-list ─────────────────────────────────────────────────────

describe('isVerifiableType — a runtime check, because the TYPE is not one', () => {
    it('accepts exactly the four link types this app sends', () => {
        expect([...VERIFIABLE_TYPES]).toEqual(['invite', 'magiclink', 'recovery', 'email']);
        for (const type of VERIFIABLE_TYPES) expect(isVerifiableType(type)).toBe(true);
    });

    it.each([
        ['signup — self-service sign-up was deleted with this row', 'signup'],
        ['email_change — this app never initiates one', 'email_change'],
        ['a typo', 'invitee'],
        ['empty', ''],
        ['absent', null],
        ['case-shifted', 'INVITE'],
    ])('rejects %s', (_label, value) => {
        expect(isVerifiableType(value)).toBe(false);
    });

    it('🔴 `as EmailOtpType` would have accepted every one of those', () => {
        // `EmailOtpType` is `... | (string & {})`, so the cast the upstream
        // Next.js example uses is not a check. This is the check.
        const cast = 'anything at all' as unknown as string;
        expect(isVerifiableType(cast)).toBe(false);
    });
});

describe('destinationFor', () => {
    it('sends an invite to the set-your-password page, not to next', () => {
        // An invited account has no password: the invite created it.
        expect(destinationFor('invite', '/os')).toBe('/auth/invited');
        expect(destinationFor('invite', '/computers')).toBe('/auth/invited');
    });

    it('sends every other type to the caller-supplied destination', () => {
        expect(destinationFor('recovery', '/computers')).toBe('/computers');
        expect(destinationFor('magiclink', '/os')).toBe('/os');
        expect(destinationFor('email', '/os')).toBe('/os');
    });
});

// ── The handler ─────────────────────────────────────────────────────────────

describe('GET /auth/confirm — the happy paths', () => {
    it('verifies an invite and sends the browser to /auth/invited', async () => {
        const { response, location, calls } = await confirm(
            '?token_hash=hash-abc&type=invite',
        );

        expect(calls).toEqual([{ type: 'invite', token_hash: 'hash-abc' }]);
        expect(location).toBe(`${ORIGIN}/auth/invited`);
        // 🔴 MEASURED: `NextResponse.redirect` answers 307, not 302. Either is
        // a redirect the BROWSER follows itself — which is the property that
        // matters, since `/os` only boots on a document load
        // (docs/PLATFORM-NOTES.md §17). Asserted as "a redirect", not as a
        // number, so a Next default change is not a false failure.
        expect(response.status).toBeGreaterThanOrEqual(300);
        expect(response.status).toBeLessThan(400);
    });

    it('sends a magic link to /os by default', async () => {
        const { location } = await confirm('?token_hash=h&type=magiclink');
        expect(location).toBe(`${ORIGIN}/os`);
    });

    it('honours ?next= for a non-invite type', async () => {
        const { location } = await confirm('?token_hash=h&type=recovery&next=%2Fcomputers');
        expect(location).toBe(`${ORIGIN}/computers`);
    });

    it('accepts this app\'s own ?returnUrl= spelling too', async () => {
        const { location } = await confirm('?token_hash=h&type=recovery&returnUrl=%2Fcomputers');
        expect(location).toBe(`${ORIGIN}/computers`);
    });

    it('🔴 never redirects off-origin, however the link was crafted', async () => {
        // A session has just been minted; an unfiltered `next` here would send
        // the newly-signed-in user to somebody else's site from a URL that
        // starts with ours. `safeReturnUrl` sends a REJECTED value to
        // /computers (not /os), which is how the two cases stay
        // distinguishable — see `utils/constants.ts`.
        for (const hostile of [
            'https://evil.example',
            '//evil.example',
            '/\\evil.example',
            'https:%2F%2Fevil.example',
        ]) {
            const { location } = await confirm(
                `?token_hash=h&type=recovery&next=${encodeURIComponent(hostile)}`,
            );
            expect(location).toBe(`${ORIGIN}/computers`);
        }
    });
});

describe('GET /auth/confirm — every failure is the same page', () => {
    const FAILED = `${ORIGIN}/login?error=auth_callback_failed`;

    it('🔴 refuses an unlisted type WITHOUT calling the auth server', async () => {
        for (const type of ['signup', 'email_change', 'bogus', '']) {
            const { location, calls } = await confirm(`?token_hash=h&type=${type}`);
            expect(location).toBe(FAILED);
            expect(calls).toEqual([]);
        }
    });

    it('refuses a missing type, and a missing token_hash', async () => {
        expect((await confirm('?token_hash=h')).location).toBe(FAILED);
        expect((await confirm('?type=invite')).location).toBe(FAILED);
        expect((await confirm('')).location).toBe(FAILED);
        // and none of those reached the auth server
        expect((await confirm('?type=invite')).calls).toEqual([]);
    });

    it('sends an expired or already-used link to the same place', async () => {
        const { location, calls } = await confirmFailing('?token_hash=stale&type=invite');
        // The positive control for the test above: this one DID reach the auth
        // server, and was turned away by it rather than by the allow-list.
        expect(calls).toEqual([{ type: 'invite', token_hash: 'stale' }]);
        expect(location).toBe(FAILED);
    });

    it('does not carry a hostile next through to the failure page either', async () => {
        const { location } = await confirmFailing(
            '?token_hash=stale&type=invite&next=https%3A%2F%2Fevil.example',
        );
        expect(location).toBe(FAILED);
    });
});
