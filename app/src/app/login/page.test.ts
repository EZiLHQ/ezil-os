import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// EZiL ID is configured by default here; the "not configured" case unsets it.
beforeEach(() => { vi.stubEnv('AUTH0_CLIENT_ID', 'client'); vi.stubEnv('AUTH0_SECRET_ID', 'private-test-secret'); });
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

const UNAVAILABLE = 'Sign-in is unavailable right now.';

/** Every other way in that this page used to offer, or that a regression could bring back. */
function expectNoOtherSignIn(html: string) {
    // Visible text only: the EZiL ID link keeps the `ezil-lock-google` class name.
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).toContain('Sign in with your EZiL ID.');
    expect(text).not.toMatch(/Google/i);
    expect(text).not.toMatch(/password|sign up|magic link|forgot/i);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('email-sign-in');
    expect(html).not.toContain('/auth/callback');
}

describe('EZiL ID is the only sign-in', () => {
    it('renders exactly one action, the EZiL ID document link', async () => {
        const html = await render();
        expect(html).toContain('Sign in with your EZiL ID.');
        expect(html.match(/<a class="ezil-lock-google" href="\/auth\/auth0\/login\?returnUrl=[^"]*">Continue with EZiL ID<\/a>/g)).toHaveLength(1);
        // The only links besides it are the logo and the legal footer.
        const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
        expect(hrefs.filter(href => !['/', '/terms', '/privacy', '/pricing'].includes(href))).toEqual([expect.stringMatching(/^\/auth\/auth0\/login\?/)]);
        expectNoOtherSignIn(html);
        expect(html).not.toContain('role="alert"');
        expect(html).not.toContain('private-test-secret');
    });

    it('ignores the old ?method=email link instead of opening a password form', async () => {
        const html = await render({ method: 'email' });
        expect(html).toContain('>Continue with EZiL ID</a>');
        expectNoOtherSignIn(html);
    });

    it('carries a safe destination through EZiL ID', async () => {
        const html = await render({ returnUrl: '/os?computer=one' });
        expect(html).toContain('href="/auth/auth0/login?returnUrl=%2Fos%3Fcomputer%3Done"');
    });

    it.each(['https://untrusted.example/', '//evil.example'])('rejects the foreign return URL %j before it reaches the link', async returnUrl => {
        const html = await render({ returnUrl });
        expect(html).toContain('href="/auth/auth0/login?returnUrl=%2Fcomputers"');
        expect(html).not.toMatch(/untrusted\.example|evil\.example/);
    });

    it.each(['auth_callback_failed', '<script>provider failure</script>', ['private detail', 'other detail']])(
        'shows a generic, accessible callback failure for %j', async error => {
            const html = await render({ error });
            expect(html.match(/role="alert"/g)).toHaveLength(1);
            expect(html).toContain('Please try again.');
            for (const value of [error].flat()) expect(html).not.toContain(value);
            // The button stays: a failed attempt is retried the same way.
            expect(html).toContain('>Continue with EZiL ID</a>');
        },
    );
});

describe('without the EZiL ID settings', () => {
    it.each([
        ['neither setting', {}],
        ['only the client id', { AUTH0_CLIENT_ID: 'client' }],
        ['only the secret', { AUTH0_SECRET_ID: 'secret' }],
    ])('with %s it says sign-in is unavailable and offers nothing else', async (_name, env: Record<string, string>) => {
        vi.stubEnv('AUTH0_CLIENT_ID', env.AUTH0_CLIENT_ID ?? '');
        vi.stubEnv('AUTH0_SECRET_ID', env.AUTH0_SECRET_ID ?? '');
        const html = await render({ error: 'auth_callback_failed', method: 'email' });
        expect(html.match(/role="alert"/g)).toHaveLength(1);
        expect(html).toContain(UNAVAILABLE);
        expect(html).not.toContain('Continue with EZiL ID');
        expect(html).not.toContain('/auth/auth0/login');
        expectNoOtherSignIn(html);
    });

    it('a route that found EZiL ID disabled gets the same honest message', async () => {
        const html = await render({ error: 'auth0_disabled' });
        expect(html).toContain(UNAVAILABLE);
        expect(html.match(/role="alert"/g)).toHaveLength(1);
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
        expect(form).toContain('<span id="switch-account-hint" class="sr-only">');
        // Not the email disclosure's class: `.ezil-lock-disclosure` is that toggle (e2e/login-layout.mjs selects it).
        expect(form).not.toContain('ezil-lock-disclosure');
        // Order: Continue with EZiL ID, then the sign-out (EZiL ID only: no email/password form, no Google form).
        expect(html.indexOf('Continue with EZiL ID</a>')).toBeLessThan(html.indexOf(form!));
        expect(html).not.toContain('Continue with Google');
        expect(html).not.toContain('private-test-secret');
    });

    it.each(['account_conflict', 'auth0_failed', 'invalid_transaction', '<script>x</script>'])('offers the same sign-out with every refusal (error %j)', async error => {
        auth0();
        const html = await render({ error });
        expect(signOutForm(html)).toContain('name="returnUrl" value="/os"');
    });

    it('the plain lock screen (no refusal) keeps its height: no sign-out control', async () => {
        auth0();
        expect(await render()).not.toContain('/auth/signout');
        expect(await render({ returnUrl: '/app/browser' })).not.toContain('/auth/signout');
    });

    it('never without Auth0: there is no id.ezil.work session to leave', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', ''); vi.stubEnv('AUTH0_SECRET_ID', '');
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
            expect(html).not.toContain('role="alert"');
        }
        // A refusal on the next attempt offers the sign-out again, for the same page.
        expect(signOutForm(await render({ error: 'email_unverified' }))).toContain('value="/app/browser"');
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
