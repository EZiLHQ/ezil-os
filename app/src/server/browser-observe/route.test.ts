import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The observe route's own bounds at browser verbs v2: what it reads from the MCP, what it forwards to the Worker and
 * what it reads back. Delegation, placement and the database are replaced; the receiver, the contract and the
 * Worker signature are real, and the Worker is a stubbed `fetch`.
 */
const accounts = vi.hoisted(() => ({ verdict: { kind: 'accepted', call: { userId: 'owner-test', clientId: 'client-test' } } as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/api/delegation-store', () => ({ consumeDelegationJti: vi.fn(), findDelegatedAccount: vi.fn() }));
vi.mock('@/server/api/delegation-auth', () => {
    const authenticate = vi.fn(async () => accounts.verdict);
    return {
        delegationConfig: vi.fn(async () => ({})),
        authenticateBrowserDelegation: authenticate, authenticateBrowserPageDelegation: authenticate,
        authenticateBrowserControlDelegation: authenticate,
    };
});
vi.mock('@/server/browser-observe/target', () => ({
    awsBrowserTargetAdmitted: () => false,
    resolveAwsBrowserTarget: vi.fn(async () => null),
    resolveCloudflareBrowserTarget: vi.fn(async () => ({ sandboxId: 'guac-0000000000000000-1111111111111111', binding: 'b'.repeat(64) })),
    browserTargetClaims: () => ({ provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0 }),
}));

import { BROWSER_STAGING_MCP, BROWSER_STAGING_OS, BROWSER_STAGING_WORKER, BROWSER_UI_RESULT_MAX_BYTES } from './contract';

const computer = '11111111-1111-4111-8111-111111111111';
const path = '/api/mcp/browser-sessions/' + computer + '/observe';
const browserSessionId = 'a'.repeat(43);
const requestId = '7bb70a50-cd7d-40f8-9539-45aee597ea48';

function post(raw: string) {
    return new Request(BROWSER_STAGING_OS + path, {
        method: 'POST', body: raw, headers: { 'content-type': 'application/json', authorization: 'EZiL-Delegation synthetic' },
    });
}
/** A valid owner-app answer padded with select options to about `bytes` long. */
function ownerAnswer(bytes: number) {
    const base = {
        ok: true, browserSessionId, expiresAt: new Date(Date.now() + 100_000).toISOString(), observed: 'owner_app_page',
        profileHeadingVisible: false, universeIdentity: 'unverified', pageUrl: 'https://universe-staging.ezil.work/builder/big',
        pageTitle: 'Big', elements: [] as unknown[], viewerFrame: null, ownerAppAccountEmail: null,
    };
    // Three-byte options, so fewer than 64 elements reach the size (an element is about 4.9 KB).
    const option = String.fromCharCode(0x20ac).repeat(80);
    for (let n = 0; Buffer.byteLength(JSON.stringify(base)) < bytes - 5000; n++) {
        base.elements.push({ ref: String(n).padStart(22, 'h'), kind: 'select', label: 'S' + n, options: Array(20).fill(option) });
    }
    return base;
}

describe('the observe route at browser verbs v2', () => {
    let worker: ReturnType<typeof vi.fn>;
    let reply: () => Response;
    beforeEach(() => {
        for (const [key, value] of Object.entries({
            EZIL_DELEGATION_ISSUER: BROWSER_STAGING_MCP, EZIL_DELEGATION_AUDIENCE: BROWSER_STAGING_OS,
            CLOUDFLARE_GUACAMOLE_WORKER_URL: BROWSER_STAGING_WORKER, CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'synthetic-worker-key',
            EZIL_DELEGATED_BROWSER_OBSERVE: 'enabled', EZIL_DELEGATED_BROWSER_CONTROL: 'enabled',
        })) vi.stubEnv(key, value);
        reply = () => Response.json(ownerAnswer(2000));
        worker = vi.fn(async () => reply());
        vi.stubGlobal('fetch', worker);
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    const route = async () => (await import('@/app/api/mcp/browser-sessions/[computerId]/observe/route')).POST;

    it('forwards a 20-field fill_form at its largest spelling, exactly, with the binding and the Worker signature', async () => {
        const text = String.fromCharCode(0xd800).repeat(4000);
        const fields = Array.from({ length: 20 }, (_, n) => ({ ref: String(n).padStart(22, 'f'), text }));
        const raw = JSON.stringify({ browserSessionId, requestId, action: { kind: 'fill_form', fields } });
        expect(Buffer.byteLength(raw)).toBeGreaterThan(470_000);
        const response = await (await route())(post(raw));
        expect(response.status).toBe(200);
        expect(worker).toHaveBeenCalledTimes(1);
        const [url, init] = worker.mock.calls[0] as [URL, RequestInit];
        expect(String(url)).toBe(BROWSER_STAGING_WORKER + '/sandbox/guac-0000000000000000-1111111111111111/browser-observe');
        expect(JSON.parse(String(init.body))).toEqual({ binding: 'b'.repeat(64), ...JSON.parse(raw) });
        expect(new Headers(init.headers).get('x-ezil-auth')).toBeTruthy();
    });

    it('reads a modern Worker answer up to 160 KiB and refuses one byte more', async () => {
        const fits = ownerAnswer(BROWSER_UI_RESULT_MAX_BYTES - 600);
        const text = JSON.stringify(fits);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(BROWSER_UI_RESULT_MAX_BYTES);
        expect(Buffer.byteLength(text)).toBeGreaterThan(150 * 1024);
        expect(fits.elements.length).toBeLessThanOrEqual(64);
        reply = () => new Response(text, { headers: { 'content-type': 'application/json' } });
        const read = JSON.stringify({ browserSessionId, action: { kind: 'read' } });
        const answered = await (await route())(post(read));
        expect(answered.status).toBe(200);
        expect(await answered.json()).toEqual(fits);
        reply = () => new Response(text + ' '.repeat(BROWSER_UI_RESULT_MAX_BYTES + 1 - Buffer.byteLength(text)),
            { headers: { 'content-type': 'application/json' } });
        const refused = await (await route())(post(read));
        expect([refused.status, await refused.json()]).toEqual([503, { ok: false, error: 'browser_unavailable' }]);
        // A mutation whose answer cannot be read is uncertain, not refused.
        const acted = await (await route())(post(JSON.stringify({ browserSessionId, requestId, action: { kind: 'press', key: 'Enter' } })));
        expect([acted.status, await acted.json()]).toEqual([503, { ok: false, error: 'browser_action_uncertain' }]);
    });

    it('keeps the legacy read at its 1024-byte request and 2048-byte answer bounds', async () => {
        const legacy = { ok: true, browserSessionId, expiresAt: new Date(Date.now() + 100_000).toISOString(),
            observed: 'profile_builder', profileHeadingVisible: true, universeIdentity: 'unverified' };
        reply = () => Response.json(legacy);
        expect((await (await route())(post(JSON.stringify({ browserSessionId })))).status).toBe(200);
        reply = () => new Response(JSON.stringify(legacy) + ' '.repeat(2049), { headers: { 'content-type': 'application/json' } });
        expect((await (await route())(post(JSON.stringify({ browserSessionId })))).status).toBe(503);
        expect((await (await route())(post(JSON.stringify({ browserSessionId }) + ' '.repeat(1100)))).status).toBe(400);
    });
});
