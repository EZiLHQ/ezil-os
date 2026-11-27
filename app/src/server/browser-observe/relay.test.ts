import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ db: 0, fetch: 0 }));
vi.mock('@/server/db', () => ({ db: new Proxy({}, { get: () => { calls.db++; throw new Error('db_not_expected'); } }) }));

import { BROWSER_DEPLOYMENTS, browserDeployment } from './contract';
import { BROWSER_OBSERVE_POLICY, browserObserveRelay, browserObserveSwitches } from './relay';

const PRODUCTION = {
    EZIL_DELEGATION_ISSUER: 'https://connect.ezil.work',
    EZIL_DELEGATION_AUDIENCE: 'https://os.ezil.work',
    CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://api-desktop.ezil.org',
    CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'fixture-secret-not-real',
};
const STAGING = {
    EZIL_DELEGATION_ISSUER: 'https://connect-staging.ezil.work',
    EZIL_DELEGATION_AUDIENCE: 'https://os-staging.ezil.work',
    CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://api-desktop-staging.ezil.work/',
    CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'fixture-secret-not-real',
};
const ON = { EZIL_DELEGATED_BROWSER_OBSERVE: 'enabled', EZIL_DELEGATED_BROWSER_CONTROL: 'enabled' };

afterEach(() => { vi.unstubAllGlobals(); calls.db = 0; calls.fetch = 0; });

describe('Browser observation deployment pairing', () => {
    it('is off by default on a fully configured production deployment', () => {
        expect(browserObserveSwitches(PRODUCTION)).toMatchObject({ enabled: false, controlEnabled: false });
        expect(browserObserveSwitches(STAGING)).toMatchObject({ enabled: false, controlEnabled: false });
    });

    it('accepts exactly the two known triples, with or without a trailing Worker slash', () => {
        expect(browserDeployment(PRODUCTION)).toEqual(BROWSER_DEPLOYMENTS[1]);
        expect(browserDeployment(STAGING)).toEqual(BROWSER_DEPLOYMENTS[0]);
        expect(browserObserveSwitches({ ...PRODUCTION, ...ON })).toMatchObject({ enabled: true, controlEnabled: true });
        expect(browserObserveSwitches({ ...PRODUCTION, ...ON }).deployment?.worker).toBe('https://api-desktop.ezil.org');
    });

    it('keeps observation and page control independent', () => {
        const observe = browserObserveSwitches({ ...PRODUCTION, EZIL_DELEGATED_BROWSER_OBSERVE: 'enabled' });
        const control = browserObserveSwitches({ ...PRODUCTION, EZIL_DELEGATED_BROWSER_CONTROL: 'enabled' });
        expect(observe).toMatchObject({ enabled: true, controlEnabled: false });
        expect(control).toMatchObject({ enabled: false, controlEnabled: true });
        for (const value of ['1', 'true', 'ENABLED', ' enabled', 'on', '']) {
            expect(browserObserveSwitches({ ...PRODUCTION, EZIL_DELEGATED_BROWSER_OBSERVE: value }).enabled).toBe(false);
        }
    });

    it('refuses every mixed or foreign triple, including a staging connector with the production Worker', () => {
        const keys = ['EZIL_DELEGATION_ISSUER', 'EZIL_DELEGATION_AUDIENCE', 'CLOUDFLARE_GUACAMOLE_WORKER_URL'] as const;
        for (let mask = 1; mask < 7; mask++) {
            const mixed: Record<string, string> = { ...PRODUCTION, ...ON };
            keys.forEach((key, i) => { if (mask & (1 << i)) mixed[key] = STAGING[key]; });
            expect(browserDeployment(mixed)).toBeUndefined();
            expect(browserObserveSwitches(mixed)).toMatchObject({ enabled: false, controlEnabled: false, deployment: undefined });
        }
        for (const [key, value] of [
            ['CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://api-desktop.ezil.work'],
            ['CLOUDFLARE_GUACAMOLE_WORKER_URL', 'http://api-desktop.ezil.org'],
            ['EZIL_DELEGATION_AUDIENCE', 'https://os.ezil.org'],
            ['EZIL_DELEGATION_AUDIENCE', 'https://os-prod.ezil.work'],
            ['EZIL_DELEGATION_ISSUER', 'https://connect.ezil.work/'],
            ['EZIL_DELEGATION_ISSUER', undefined],
        ] as const) {
            expect(browserObserveSwitches({ ...PRODUCTION, ...ON, [key]: value })).toMatchObject({ enabled: false, controlEnabled: false });
        }
    });

    it('refuses a missing or blank Worker secret', () => {
        for (const secret of [undefined, '', '   ']) {
            const env = { ...PRODUCTION, ...ON, CLOUDFLARE_GUACAMOLE_HMAC_SECRET: secret };
            expect(browserObserveSwitches(env)).toMatchObject({ enabled: false, controlEnabled: false, secret: undefined });
        }
    });
});

describe('Browser observation relay', () => {
    it('gives each procedure exactly one scope', () => {
        expect([...BROWSER_OBSERVE_POLICY.scopeByProcedure]).toEqual([
            ['browserSession.observe', 'ezil:browser:read'],
            ['browserSession.readPage', 'ezil:browser:page:read'],
            ['browserSession.control', 'ezil:browser:control'],
        ]);
    });

    it('refuses a procedure/scope pair the policy does not name before any verification I/O', async () => {
        const relay = browserObserveRelay({ ...PRODUCTION, ...ON });
        const headers = new Headers({ authorization: 'EZiL-Delegation a.b.c' });
        expect(await relay.verify(headers, '{}', 'browserSession.control', 'ezil:browser:read')).toBeNull();
        expect(await relay.verify(headers, '{}', 'browserSession.openUrl', 'ezil:browser:navigate')).toBeNull();
        expect(await relay.verify(headers, '{}', 'computer.list', 'ezil:computers:read')).toBeNull();
        expect(calls.db).toBe(0);
    });

    it('never verifies or calls a Worker when the deployment pairing is unknown', async () => {
        const fetchMock = vi.fn(async () => { calls.fetch++; return new Response('{}'); });
        vi.stubGlobal('fetch', fetchMock);
        const relay = browserObserveRelay({ ...PRODUCTION, ...ON, CLOUDFLARE_GUACAMOLE_WORKER_URL: STAGING.CLOUDFLARE_GUACAMOLE_WORKER_URL });
        expect(relay.enabled || relay.controlEnabled).toBe(false);
        const headers = new Headers({ authorization: 'EZiL-Delegation a.b.c' });
        expect(await relay.verify(headers, '{}', 'browserSession.observe', 'ezil:browser:read')).toBeNull();
        const out = await relay.observe({ userId: 'u', clientId: 'c' }, 'id', { sandboxId: 's', binding: 'b' }, {});
        expect(out).toEqual({ ok: false, error: 'browser_unavailable' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(calls.db).toBe(0);
    });

    it('signs the exact body for the paired Worker only and refuses redirects', async () => {
        const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify({ ok: false, error: 'browser_unavailable' }),
            { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        const relay = browserObserveRelay({ ...PRODUCTION, ...ON });
        const sandboxId = 'guac-0123456789abcdef-0123456789abcdef';
        await relay.observe({ userId: '22222222-2222-4222-8222-222222222222', clientId: 'c' },
            '11111111-1111-4111-8111-111111111111', { sandboxId, binding: 'f'.repeat(64) }, {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(String(url)).toBe('https://api-desktop.ezil.org/sandbox/' + sandboxId + '/browser-observe');
        expect(init.redirect).toBe('error');
        expect(init.body).toBe(JSON.stringify({ binding: 'f'.repeat(64) }));
        expect(new Headers(init.headers).get('x-ezil-auth')).toBeTruthy();
    });
});
