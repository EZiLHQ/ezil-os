import { afterEach, describe, expect, it, vi } from 'vitest';

import { forwardedHost, forwardedProto, withoutDefaultPort } from './forwarded';

const h = (headers: Record<string, string>) => new Headers(headers);

describe('forwardedProto', () => {
    it('reads the first hop only, case-insensitively', () => {
        expect(forwardedProto(h({ 'x-forwarded-proto': 'https' }))).toBe('https');
        expect(forwardedProto(h({ 'x-forwarded-proto': 'HTTPS' }))).toBe('https');
        // The chain that used to build a redirect URL starting "https, http".
        expect(forwardedProto(h({ 'x-forwarded-proto': 'https, http' }))).toBe('https');
        expect(forwardedProto(h({ 'x-forwarded-proto': 'http' }))).toBe('http');
    });

    it('is null when nothing in front said, or said something else', () => {
        expect(forwardedProto(h({}))).toBeNull();
        expect(forwardedProto(h({ 'x-forwarded-proto': 'ws' }))).toBeNull();
    });
});

describe('forwardedHost', () => {
    it('prefers x-forwarded-host (the public host behind Vercel) over host', () => {
        expect(forwardedHost(h({ host: 'ezil-os.vercel.app', 'x-forwarded-host': 'os.ezil.org' }))).toBe('os.ezil.org');
        expect(forwardedHost(h({ host: 'os.ezil.org' }))).toBe('os.ezil.org');
    });

    it('drops the default port for the scheme, keeps any other', () => {
        expect(forwardedHost(h({ host: 'os.ezil.org:443', 'x-forwarded-proto': 'https' }))).toBe('os.ezil.org');
        expect(forwardedHost(h({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }))).toBe('localhost:3000');
        expect(forwardedHost(h({ host: 'OS.EZIL.ORG' }))).toBe('os.ezil.org');
    });

    it('is null with no host at all', () => {
        expect(forwardedHost(h({}))).toBeNull();
    });
});

describe('withoutDefaultPort', () => {
    it('only strips the port that is the default for that scheme', () => {
        expect(withoutDefaultPort('os.ezil.org:443', 'https')).toBe('os.ezil.org');
        expect(withoutDefaultPort('os.ezil.org:443', 'http')).toBe('os.ezil.org:443');
        expect(withoutDefaultPort('os.ezil.org:80', 'http')).toBe('os.ezil.org');
        expect(withoutDefaultPort('os.ezil.org:80', 'https')).toBe('os.ezil.org:80');
    });
});

describe('publicOrigin', () => {
    it('uses the forwarded host and scheme, never the loopback listener', async () => {
        const { publicOrigin } = await import('./forwarded');
        const h = new Headers({ host: 'localhost:3000', 'x-forwarded-host': 'os-staging.ezil.work', 'x-forwarded-proto': 'https' });
        expect(publicOrigin(h, 'https://localhost:3000/auth/auth0/login')).toBe('https://os-staging.ezil.work');
    });
    it('falls back to the Host header, then to the request URL', async () => {
        const { publicOrigin } = await import('./forwarded');
        expect(publicOrigin(new Headers({ host: 'os.ezil.work', 'x-forwarded-proto': 'https' }), 'http://x/')).toBe('https://os.ezil.work');
        expect(publicOrigin(new Headers(), 'https://os.ezil.org/a?b=1')).toBe('https://os.ezil.org');
    });
});

describe('ownedPublicOrigin', () => {
    it('keeps an owned forwarded origin', async () => {
        const { ownedPublicOrigin } = await import('./forwarded');
        const h = new Headers({ host: 'localhost:3000', 'x-forwarded-host': 'os-staging.ezil.work', 'x-forwarded-proto': 'https' });
        expect(ownedPublicOrigin(h, 'https://localhost:3000/')).toBe('https://os-staging.ezil.work');
    });
    it.each(['evil.example', 'x.vercel.app', 'evil-app.ezil.org', 'os-staging.ezil.work.evil.example'])('replaces a spoofed host %s with the canonical origin', async host => {
        const { ownedPublicOrigin } = await import('./forwarded');
        const h = new Headers({ 'x-forwarded-host': host, 'x-forwarded-proto': 'https' });
        expect(ownedPublicOrigin(h, 'https://localhost:3000/')).toBe('https://os.ezil.org');
    });
});

describe('PR preview slot origin', () => {
    afterEach(() => vi.unstubAllEnvs());
    const slot = (host: string) => new Headers({ 'x-forwarded-host': host, 'x-forwarded-proto': 'https' });
    const preview = (origin: string) => {
        vi.stubEnv('EZIL_DEPLOY_ENV', 'pr-preview');
        vi.stubEnv('EZIL_PR_PREVIEW_ORIGIN', origin);
    };

    it('keeps the container\'s own slot origin, so the Auth0 callback stays on the preview', async () => {
        const { ownedPublicOrigin, prPreviewOrigin } = await import('./forwarded');
        preview('https://os-pv1.ezil.work');
        expect(prPreviewOrigin()).toBe('https://os-pv1.ezil.work');
        expect(ownedPublicOrigin(slot('os-pv1.ezil.work'), 'http://127.0.0.1:3101/')).toBe('https://os-pv1.ezil.work');
    });

    it('sends an unowned host to its own slot, never to production', async () => {
        const { ownedPublicOrigin } = await import('./forwarded');
        preview('https://os-pv2.ezil.work');
        expect(ownedPublicOrigin(slot('evil-app.ezil.work'), 'http://127.0.0.1:3102/')).toBe('https://os-pv2.ezil.work');
        // Another slot is another lane: it is not owned by this container.
        expect(ownedPublicOrigin(slot('os-pv1.ezil.work'), 'http://127.0.0.1:3102/')).toBe('https://os-pv2.ezil.work');
    });

    it('ignores the origin outside the pr-preview deploy env', async () => {
        const { ownedPublicOrigin, prPreviewOrigin } = await import('./forwarded');
        for (const env of [undefined, '', 'staging', 'production', 'PR-PREVIEW']) {
            vi.stubEnv('EZIL_DEPLOY_ENV', env);
            vi.stubEnv('EZIL_PR_PREVIEW_ORIGIN', 'https://os-pv1.ezil.work');
            expect(prPreviewOrigin()).toBeNull();
            expect(ownedPublicOrigin(slot('os-pv1.ezil.work'), 'https://localhost:3000/')).toBe('https://os.ezil.org');
        }
    });

    it.each([
        'https://os-pv0.ezil.work', 'https://os-pv10.ezil.work', 'https://os-pv1.ezil.work.evil.example',
        'https://evil.os-pv1.ezil.work', 'http://os-pv1.ezil.work', 'https://os-pv1.ezil.work/',
        'https://os-pv1.ezil.work:443', 'https://OS-PV1.ezil.work', ' https://os-pv1.ezil.work',
        'https://os-pv1.ezil.work\n', 'https://os-pv1-app.ezil.work', 'https://os-staging.ezil.work.', '',
    ])('refuses a configured value that is not exactly a slot origin %#', async origin => {
        const { isOwnedAppOrigin, prPreviewOrigin } = await import('./forwarded');
        preview(origin);
        expect(prPreviewOrigin()).toBeNull();
        expect(isOwnedAppOrigin(origin)).toBe(false);
    });
});
