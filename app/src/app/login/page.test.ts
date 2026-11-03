import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
beforeEach(() => { vi.stubEnv('AUTH0_CLIENT_ID', ''); vi.stubEnv('AUTH0_SECRET_ID', ''); });
afterEach(() => vi.unstubAllEnvs());

// Rendering login must not need a session, database, or OAuth request.
vi.mock('./actions', () => ({ signInWithGoogle: vi.fn(), signInWithPassword: vi.fn() }));
// The page a sign-out kept (`./return-cookie`); `throws` is a render outside any request.
const jar = vi.hoisted(() => ({ value: undefined as string | undefined, throws: false }));
vi.mock('next/headers', () => ({
    cookies: async () => {
        if (jar.throws) throw new Error('cookies() outside a request scope');
        return { get: (name: string) => (name === '__Host-ezil-login-return' && jar.value !== undefined ? { name, value: jar.value } : undefined) };
    },
}));
beforeEach(() => { jar.value = undefined; jar.throws = false; });

import LoginPage from './page';

async function render(params: Record<string, string | string[]> = {}) {
    return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
}

describe('lock screen entry', () => {
    it('offers one Google action and a collapsed, labelled password disclosure', async () => {
        const html = await render();
        expect(html).toContain('Sign in or get started with Google.');
        expect(html.match(/>Continue with Google<\/button>/g)).toHaveLength(1);
        expect(html).toContain('aria-expanded="false" aria-controls="email-sign-in"');
        expect(html).toContain('id="email-sign-in" hidden=""');
        expect(html).toContain('<label for="email"');
        expect(html).toContain('<label for="password"');
        expect(html).not.toContain('role="alert"');
    });

    it('opens the email form for a direct link and preserves a safe destination', async () => {
        const html = await render({ method: 'email', returnUrl: '/os?computer=example' });
        expect(html).toContain('aria-expanded="true"');
        expect(html).not.toContain('id="email-sign-in" hidden');
        expect(html).toContain('name="returnUrl" value="/os?computer=example"');
        expect(html).toContain('autoComplete="current-password"');
        expect(html).toContain('Email and password work for existing accounts.');
    });

    it('keeps credentials out of the URL even before JavaScript loads', async () => {
        const html = await render({ method: 'email' });
        const passwordForm = html.match(/<form\b[^>]*id="email-sign-in"[^>]*>/)?.[0];
        expect(passwordForm).toContain('method="post"');
    });

    it('rejects a foreign return URL before handing it to the form', async () => {
        const html = await render({ returnUrl: 'https://untrusted.example/' });
        expect(html).not.toContain('untrusted.example');
        expect(html).toContain('name="returnUrl" value="/computers"');
    });

    it.each(['auth_callback_failed', '<script>provider failure</script>', ['private detail', 'other detail']])(
        'shows a generic, accessible callback failure for %j', async error => {
            const html = await render({ error });
            expect(html).toContain('role="alert"');
            expect(html).toContain('Please try again.');
            for (const value of [error].flat()) expect(html).not.toContain(value);
        },
    );
});

describe('EZiL ID entry', () => {
    it('offers the Auth0 document link only when both settings are present', async () => {
        expect(await render()).not.toContain('Continue with EZiL ID');
        vi.stubEnv('AUTH0_CLIENT_ID', 'client');
        expect(await render()).not.toContain('Continue with EZiL ID');
        vi.stubEnv('AUTH0_SECRET_ID', 'private-test-secret');
        const html = await render({ returnUrl: '/os?computer=one' });
        expect(html).toContain('Continue with EZiL ID');
        expect(html).toContain('href="/auth/auth0/login?returnUrl=%2Fos%3Fcomputer%3Done"');
        expect(html).toContain('Continue with Google');
        expect(html).toContain('id="email-sign-in"');
        expect(html).not.toContain('private-test-secret');
    });
    it('sanitises the Auth0 link destination', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', 'client'); vi.stubEnv('AUTH0_SECRET_ID', 'secret');
        const html = await render({ returnUrl: '//evil.example' });
        expect(html).toContain('href="/auth/auth0/login?returnUrl=%2Fcomputers"');
        expect(html).not.toContain('evil.example');
    });
});

describe('auth recovery: Sign out and use another account', () => {
    const kept = (path: string) => Buffer.from(path, 'utf8').toString('base64url');
    const auth0 = () => { vi.stubEnv('AUTH0_CLIENT_ID', 'client'); vi.stubEnv('AUTH0_SECRET_ID', 'private-test-secret'); };
    // A real document POST: `method="post"` on the same `<form>` tag as the action.
    const signOutForm = (html: string) => html.match(/<form\b(?=[^>]*\baction="\/auth\/signout")(?=[^>]*\bmethod="post")[^>]*>[\s\S]*?<\/form>/)?.[0];

    it('🔴 an unverified-email refusal explains verify-then-retry and offers a plain sign-out form below Continue with EZiL ID', async () => {
        auth0();
        const html = await render({ error: 'email_unverified', returnUrl: '/app/browser' });
        expect(html).toContain('role="alert"');
        expect(html).toContain('The email address on this EZiL ID is not verified yet. Open the verification link EZiL ID emailed you, then choose Continue with EZiL ID again.');
        // Retrying is Continue again, still headed for the same page.
        expect(html).toContain('href="/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser"');
        const form = signOutForm(html);
        expect(form).toBeDefined();
        expect(form).toContain('<input type="hidden" name="returnUrl" value="/app/browser"/>');
        expect(form).toContain('<button type="submit" aria-describedby="switch-account-hint"');
        expect(form).toContain('>Sign out and use another account</button>');
        expect(form).toContain('id="switch-account-hint"');
        // Order: Continue with EZiL ID, then the sign-out, then the Google and password forms.
        expect(html.indexOf('Continue with EZiL ID</a>')).toBeLessThan(html.indexOf(form!));
        expect(html.indexOf(form!)).toBeLessThan(html.indexOf('Continue with Google'));
        expect(html).not.toContain('private-test-secret');
    });

    it.each([undefined, 'account_conflict', 'auth0_failed'])('offers the same sign-out on every EZiL ID render (error %j)', async error => {
        auth0();
        const html = await render(error ? { error } : {});
        expect(signOutForm(html)).toContain('name="returnUrl" value="/os"');
    });

    it('never without Auth0: there is no id.ezil.work session to leave', async () => {
        expect(await render({ error: 'email_unverified' })).not.toContain('/auth/signout');
    });

    it.each([
        ['https://evil.example/', '/computers'], ['//evil.example', '/computers'], ['/%5Cevil.example', '/computers'],
        ['/app/%2e%2e/admin', '/os'], ['/app/browser?q=1#frag', '/app/browser?q=1#frag'],
    ])('narrows %j to %j for Continue and for the sign-out form alike', async (returnUrl, expected) => {
        auth0();
        const html = await render({ error: 'email_unverified', returnUrl });
        expect(html).toContain(`href="/auth/auth0/login?${new URLSearchParams({ returnUrl: expected }).toString().replace(/&/g, '&amp;')}"`);
        expect(signOutForm(html)).toContain(`name="returnUrl" value="${expected.replace(/&/g, '&amp;')}"`);
        expect(html).not.toContain('evil.example');
    });

    it('after the sign-out round trip, the kept page is the destination again (refresh shows the same)', async () => {
        auth0();
        jar.value = kept('/app/browser');
        for (let i = 0; i < 2; i += 1) {
            const html = await render();
            expect(html).toContain('href="/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser"');
            expect(signOutForm(html)).toContain('value="/app/browser"');
            expect(html).not.toContain('role="alert"');
        }
    });

    it('a returnUrl in the link wins over the kept page', async () => {
        auth0();
        jar.value = kept('/app/browser');
        expect(await render({ returnUrl: '/app/code' })).toContain('href="/auth/auth0/login?returnUrl=%2Fapp%2Fcode"');
    });

    it.each([
        ['a hostile kept page', kept('//evil.example'), '/computers'],
        ['an undecodable cookie', 'not base64!', '/os'],
        ['an over-long cookie', 'a'.repeat(5000), '/os'],
    ])('%s is narrowed or ignored', async (_label, value, expected) => {
        auth0();
        jar.value = value;
        const html = await render();
        expect(html).toContain(`href="/auth/auth0/login?${new URLSearchParams({ returnUrl: expected })}"`);
        expect(html).not.toContain('evil.example');
    });

    it('a cookie store that cannot be read falls back to the plain destination', async () => {
        auth0();
        jar.throws = true;
        expect(await render()).toContain('href="/auth/auth0/login?returnUrl=%2Fos"');
    });
});
