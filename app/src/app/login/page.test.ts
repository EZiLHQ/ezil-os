import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// EZiL ID is configured by default here; the "not configured" case unsets it.
beforeEach(() => { vi.stubEnv('AUTH0_CLIENT_ID', 'client'); vi.stubEnv('AUTH0_SECRET_ID', 'private-test-secret'); });
afterEach(() => vi.unstubAllEnvs());

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
