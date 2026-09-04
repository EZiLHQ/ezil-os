/**
 * `parseAuthFragment` — the one part of `/auth/invited` that is pure, and the
 * part attacker-controlled text reaches first.
 *
 * The fragment is whatever is after `#` in the address bar. It is not sent to
 * a server, nothing has validated it, and anybody can put a user on a URL that
 * carries one. So the properties asserted here are: both tokens or neither, an
 * error wins over everything, and NOTHING in the fragment can become a
 * destination.
 */
import { describe, expect, it } from 'vitest';

import { parseAuthFragment } from './fragment';

/** The shape Supabase's implicit-grant verify redirect really produces. */
const INVITE_FRAGMENT =
    '#access_token=eyJhbGciOi.aaa.bbb&expires_at=1788888888&expires_in=3600' +
    '&refresh_token=rt-ccc&token_type=bearer&type=invite';

describe('a real invite fragment', () => {
    it('yields both tokens and the type', () => {
        expect(parseAuthFragment(INVITE_FRAGMENT)).toEqual({
            kind: 'session',
            accessToken: 'eyJhbGciOi.aaa.bbb',
            refreshToken: 'rt-ccc',
            type: 'invite',
        });
    });

    it('works with or without the leading #', () => {
        expect(parseAuthFragment(INVITE_FRAGMENT.slice(1))).toEqual(
            parseAuthFragment(INVITE_FRAGMENT),
        );
    });

    it('reads a recovery fragment the same way', () => {
        const result = parseAuthFragment('#access_token=a&refresh_token=b&type=recovery');
        expect(result).toEqual({
            kind: 'session',
            accessToken: 'a',
            refreshToken: 'b',
            type: 'recovery',
        });
    });

    it('tolerates a missing type', () => {
        expect(parseAuthFragment('#access_token=a&refresh_token=b')).toMatchObject({
            kind: 'session',
            type: null,
        });
    });
});

describe('🔴 both tokens or neither — half a session is not a session', () => {
    it.each([
        ['access_token alone', '#access_token=a&expires_in=3600&token_type=bearer'],
        ['refresh_token alone', '#refresh_token=b'],
        ['an empty access_token', '#access_token=&refresh_token=b'],
        ['an empty refresh_token', '#access_token=a&refresh_token='],
        ['a whitespace-only access_token', '#access_token=%20%20&refresh_token=b'],
    ])('%s is `none`, never a partial session', (_label, hash) => {
        // `setSession` needs both; a session that cannot refresh dies silently
        // mid-use, which is worse than never signing in.
        expect(parseAuthFragment(hash)).toEqual({ kind: 'none' });
    });
});

describe('nothing to do', () => {
    it.each([
        ['no hash at all', undefined],
        ['null', null],
        ['an empty string', ''],
        ['a bare #', '#'],
        ['whitespace', '#   '],
        ['a plain anchor', '#section-2'],
        ['a path-looking fragment', '#/os'],
        ['an unrelated query-ish fragment', '#foo=bar&baz=qux'],
    ])('%s is `none`', (_label, hash) => {
        expect(parseAuthFragment(hash)).toEqual({ kind: 'none' });
    });

    it('is not fooled by a non-string', () => {
        expect(parseAuthFragment(42 as unknown as string)).toEqual({ kind: 'none' });
    });
});

describe('an error in the fragment', () => {
    it('reads GoTrue\'s expired-link shape', () => {
        const result = parseAuthFragment(
            '#error=access_denied&error_code=otp_expired' +
                '&error_description=Email+link+is+invalid+or+has+expired',
        );
        expect(result).toEqual({
            kind: 'error',
            code: 'otp_expired',
            // `+` is a space in a query-string encoding, and URLSearchParams
            // decodes it as one — the message is displayed, so this matters.
            description: 'Email link is invalid or has expired',
        });
    });

    it('falls back to `error` when there is no `error_code`', () => {
        expect(parseAuthFragment('#error=access_denied')).toEqual({
            kind: 'error',
            code: 'access_denied',
            description: null,
        });
    });

    it('🔴 an error wins even when tokens are also present', () => {
        // Same precedence auth-js uses: "If there's an error in the URL, it
        // doesn't matter what flow it is". A fragment carrying both is not a
        // shape GoTrue produces — which is exactly why it should not be
        // treated as a valid session.
        expect(
            parseAuthFragment('#access_token=a&refresh_token=b&error_code=otp_expired'),
        ).toMatchObject({ kind: 'error', code: 'otp_expired' });
    });
});

describe('🔴 nothing in the fragment can steer the page', () => {
    it('drops every extra parameter, including navigation-shaped ones', () => {
        const result = parseAuthFragment(
            '#access_token=a&refresh_token=b&type=invite' +
                '&next=https%3A%2F%2Fevil.example&redirect_to=%2F%2Fevil.example' +
                '&returnUrl=%2Fadmin%2Ftelemetry',
        );
        // The returned object has four keys and none of them is a destination.
        // `/auth/invited` navigates to a module constant (`Routes.OS`), so
        // there is nothing here for a crafted link to point at.
        expect(Object.keys(result).sort()).toEqual([
            'accessToken',
            'kind',
            'refreshToken',
            'type',
        ]);
        expect(JSON.stringify(result)).not.toMatch(/evil\.example/);
    });

    it('treats a second # as part of the value, not as a new fragment', () => {
        // Whatever a crafted link does with extra hashes, the result is either
        // a token string or `none` — never a parsed destination.
        const result = parseAuthFragment('#access_token=a#b&refresh_token=c');
        expect(result).toMatchObject({ kind: 'session', accessToken: 'a#b' });
    });

    it('takes the FIRST value when a key is repeated', () => {
        expect(parseAuthFragment('#access_token=first&access_token=second&refresh_token=r'))
            .toMatchObject({ accessToken: 'first' });
    });

    it('returns the token verbatim, without decoding it twice', () => {
        // A JWT is base64url: no `+`, no `/`, no `=` padding in the parts we
        // see. But the value must still survive one, and only one, decode.
        const result = parseAuthFragment('#access_token=a.b-c_d&refresh_token=x%2By');
        expect(result).toMatchObject({ accessToken: 'a.b-c_d', refreshToken: 'x+y' });
    });
});
