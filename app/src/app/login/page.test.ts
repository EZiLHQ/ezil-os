import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
beforeEach(() => { vi.stubEnv('AUTH0_CLIENT_ID', ''); vi.stubEnv('AUTH0_SECRET_ID', ''); });
afterEach(() => vi.unstubAllEnvs());

// Rendering login must not need a session, database, or OAuth request.
vi.mock('./actions', () => ({ signInWithGoogle: vi.fn(), signInWithPassword: vi.fn() }));

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
