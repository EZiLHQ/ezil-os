import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { AWS_BROWSER_ROUTE_TOKEN, requestAwsPreview } from './aws-preview';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import type { EnsureOptions } from './provider';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const sandboxId = deriveGuacamoleSandboxId(userId, computerId);
const config = { workerUrl: 'https://worker.preview.example/', isConfigured: true, hasHmacSecret: true };
const options = { sessionId: 'session', desktopMode: 'neko' as const };
const failure = { ok: false, error: 'aws_preview_unavailable', errorCode: 'aws_preview_unavailable' };
const row = (over: Record<string, unknown> = {}) => placementRow({
    computer_id: computerId, owner_user_id: userId, state: 'RUNNING', generation: 7, lease_epoch: 11, ...over,
});
const url = (port: number) =>
    `https://aws-${port}-${sandboxId}-aws.preview.example/preview-bootstrap?token=opaque%2Etoken&path=%2F`;
const ready = () => ({
    ok: true, provider: 'aws-ec2', mode: 'neko', sandboxId, generation: 7, leaseEpoch: 11,
    guacamoleUrl: url(8181), appPreviewUrl: url(3002), codePreviewUrl: url(8443),
    expiresAt: NOW + 3_600_000,
    relay: { runtimeId: 'a'.repeat(32), expiresAt: NOW + 600_000 }, turnRelay: true,
});
function setup(placements = [row()]) {
    const fake = createFakePlacementDb({ placements });
    return {
        fake,
        open: (cfg = config, secret = 'test-secret', opts: EnsureOptions = options) =>
            requestAwsPreview(fake.db, { userId, computerId: computerId.toUpperCase() }, opts, cfg, secret, 'corr'),
    };
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('EZIL_PREVIEW_TOKEN_V2', '0');
    vi.stubEnv('EZIL_AWS_BROWSER_ZONE', 'preview.example');
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(ready()));
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('AWS preview handoff', () => {
    it('signs the exact POST body with current placement claims even when Cloudflare v2 is off', async () => {
        const { open, fake } = setup();
        const screen = { width: 1280, height: 800 };
        await expect(open(config, 'test-secret', { ...options, screen })).resolves.toEqual({
            ...ready(), correlationId: 'corr', frame: undefined,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [endpoint, init] = fetchMock.mock.calls[0]!;
        expect(endpoint).toBe('https://worker.preview.example/sandbox/preview');
        const body = JSON.stringify({ sessionId: 'session', userId, projectId: computerId, desktopMode: 'neko', screen });
        expect(init).toMatchObject({ method: 'POST', body, redirect: 'error' });
        expect(init!.signal).toBeInstanceOf(AbortSignal);
        const headers = new Headers(init!.headers);
        expect(headers.get('content-type')).toBe('application/json');
        expect(headers.get('x-correlation-id')).toBe('corr');
        const [version, encoded, signature] = headers.get('x-ezil-auth')!.split('.');
        expect(version).toBe('v2');
        expect(JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))).toEqual({
            ts: NOW, sandboxId, computerId, userId, provider: 'aws-ec2', store: '', generation: 7, leaseEpoch: 11,
        });
        const digest = createHash('sha256').update(body).digest('hex');
        expect(signature).toBe(createHmac('sha256', 'test-secret').update([
            'v2', NOW, 'POST', '/sandbox/preview', sandboxId, computerId, userId, 'aws-ec2', '', 7, 11, digest,
        ].join('|')).digest('hex'));
        expect(fake.statements).toHaveLength(1);
        expect(fake.statements[0]!.sql).toContain('placement:read');
    });

    it('omits absent screen and v1 token, and strips unknown Worker and relay fields', async () => {
        fetchMock.mockResolvedValue(Response.json({
            ...ready(), internal: 'LEAK', error: 'LEAK',
            relay: { ...ready().relay, credential: 'LEAK' },
        }));
        await expect(setup().open()).resolves.toEqual({ ...ready(), correlationId: 'corr', frame: undefined });
        expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
            sessionId: 'session', userId, projectId: computerId, desktopMode: 'neko',
        });
    });

    it('accepts a ready answer without optional relay metadata', async () => {
        fetchMock.mockResolvedValue(Response.json({ ...ready(), relay: undefined, turnRelay: undefined }));
        const out = await setup().open();
        expect(out.ok).toBe(true);
        expect(out).not.toHaveProperty('relay');
        expect(out).not.toHaveProperty('turnRelay');
    });

    it.each([
        [{ ...config, isConfigured: false }, 'test-secret'],
        [config, '   '],
    ] as const)('refuses missing configuration before any placement read', async (cfg, secret) => {
        const { open, fake } = setup();
        await expect(open(cfg, secret)).resolves.toEqual(failure);
        expect(fake.statements).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', []],
        ['foreign', [row({ owner_user_id: '22222222-2222-4222-8222-222222222222' })]],
        ['cloudflare', [row({ provider: 'cloudflare', workspace_store: 'r2' })]],
        ['stopping', [row({ state: 'STOPPING' })]],
        ['zero generation', [row({ generation: 0 })]],
        ['zero lease', [row({ lease_epoch: 0 })]],
        ['duplicate', [row(), row()]],
    ] as const)('refuses a %s placement before fetch', async (_name, placements) => {
        await expect(setup([...placements]).open()).resolves.toEqual(failure);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads the current epoch on every handoff', async () => {
        const { open, fake } = setup();
        await open();
        fake.placements[0]!.generation = 8;
        fake.placements[0]!.lease_epoch = 12;
        fetchMock.mockResolvedValue(Response.json({ ...ready(), generation: 8, leaseEpoch: 12 }));
        await expect(open()).resolves.toMatchObject({ ok: true, generation: 8, leaseEpoch: 12 });
        const token = new Headers(fetchMock.mock.calls[1]![1]!.headers).get('x-ezil-auth')!;
        expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({
            generation: 8, leaseEpoch: 12,
        });
    });

    it.each(['?unsigned=1', '#unsigned'])('refuses unsigned URL components: %s', async (suffix) => {
        await expect(setup().open({ ...config, workerUrl: config.workerUrl + suffix })).resolves.toEqual(failure);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['aws_desktop_starting', 'aws_origin_starting'])('maps only HTTP 503 %s to waking', async (error) => {
        fetchMock.mockResolvedValue(Response.json({ ok: false, error, reason: 'LEAK' }, { status: 503 }));
        await expect(setup().open()).resolves.toEqual({
            ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting',
        });
        fetchMock.mockResolvedValue(Response.json({ ok: false, error }, { status: 502 }));
        await expect(setup().open()).resolves.toEqual(failure);
    });

    it.each([201, 401, 403, 404, 500, 502, 503])('refuses HTTP %s even with a success-shaped body', async (status) => {
        fetchMock.mockResolvedValue(Response.json({ ...ready(), error: 'LEAK' }, { status }));
        await expect(setup().open()).resolves.toEqual(failure);
    });

    it.each([
        { ok: false, error: 'aws_desktop_starting' },
        { provider: 'cloudflare' }, { mode: 'production' }, { sandboxId: 'guac-other-computer' },
        { generation: 6 }, { leaseEpoch: 10 }, { expiresAt: NOW },
        { guacamoleUrl: undefined }, { appPreviewUrl: null }, { codePreviewUrl: '' },
        { appPreviewUrl: url(8443) }, { codePreviewUrl: url(3002) },
        { relay: { runtimeId: 'LEAK', expiresAt: NOW + 600_000 } },
        { relay: { runtimeId: 'a'.repeat(32), expiresAt: NOW } }, { turnRelay: 'LEAK' },
    ])('refuses malformed or stale success fields: %j', async (over) => {
        fetchMock.mockResolvedValue(Response.json({ ...ready(), ...over, internal: 'LEAK' }));
        await expect(setup().open()).resolves.toEqual(failure);
    });

    it.each([
        url(8181).replace('https:', 'http:'),
        url(8181).replace('https://', 'https://user@'),
        url(8181).replace('https://', 'https://:password@'),
        url(8181).replace('.example/', '.example:8443/'),
        url(8080),
        url(8181).replace(sandboxId, 'guac-other-computer'),
        url(8181).replace('/preview-bootstrap', '/'),
        url(8181).replace('token=', 'other='),
        'LEAK',
    ])('refuses an invalid desktop bootstrap URL: %s', async (guacamoleUrl) => {
        fetchMock.mockResolvedValue(Response.json({ ...ready(), guacamoleUrl }));
        await expect(setup().open()).resolves.toEqual(failure);
    });

    it.each(['fetch', 'timeout', 'json', 'null', 'array', 'database'])('sanitizes %s failures', async (kind) => {
        const { open, fake } = setup();
        if (kind === 'database') vi.spyOn(fake.db, 'execute').mockRejectedValue(new Error('LEAK'));
        else if (kind === 'fetch') fetchMock.mockRejectedValue(new Error('LEAK'));
        else if (kind === 'timeout') fetchMock.mockRejectedValue(new DOMException('LEAK', 'TimeoutError'));
        else fetchMock.mockResolvedValue(kind === 'json' ? new Response('LEAK') : Response.json(kind === 'null' ? null : []));
        await expect(open()).resolves.toEqual(failure);
    });
});

describe('AWS browser host (Codex P1: the Worker appends the -aws route token)', () => {
    const host = (h: string) => `https://${h}/preview-bootstrap?token=opaque%2Etoken&path=%2F`;
    const answer = (guacamoleUrl: string) => Response.json({ ...ready(), guacamoleUrl });

    it('accepts the Worker host on the configured browser zone', async () => {
        const h = `aws-8181-${sandboxId}-aws.preview.example`;
        fetchMock.mockResolvedValue(answer(host(h)));
        await expect(setup().open()).resolves.toMatchObject({ ok: true, guacamoleUrl: host(h) });
    });

    it.each([
        ['suffixless (the zone catch-all owns it)', `aws-8181-${sandboxId}.preview.example`],
        ['a foreign zone', `aws-8181-${sandboxId}-aws.other.example`],
        ['a zone suffix lookalike', `aws-8181-${sandboxId}-aws.preview.example.evil.example`],
        ['another port in the desktop field', `aws-3002-${sandboxId}-aws.preview.example`],
        ['another sandbox', `aws-8181-guac-0000000000000000-0000000000000000-aws.preview.example`],
        ['a different route token', `aws-8181-${sandboxId}-awsx.preview.example`],
        // Never derived from the Worker's host: its own host is not the configured zone.
        ['the Worker host itself (not the configured zone)', `aws-8181-${sandboxId}-aws.worker.preview.example`],
    ])('refuses %s', async (_name, h) => {
        fetchMock.mockResolvedValue(answer(host(h)));
        await expect(setup().open()).resolves.toEqual(failure);
    });
});

describe('AWS browser zone comes from EZIL_AWS_BROWSER_ZONE, never the Worker host (Codex 4278276844)', () => {
    const answerOn = (zone: string) => Response.json({
        ...ready(),
        guacamoleUrl: `https://aws-8181-${sandboxId}-aws.${zone}/preview-bootstrap?token=t&path=%2F`,
        appPreviewUrl: `https://aws-3002-${sandboxId}-aws.${zone}/preview-bootstrap?token=t&path=%2F`,
        codePreviewUrl: `https://aws-8443-${sandboxId}-aws.${zone}/preview-bootstrap?token=t&path=%2F`,
    });

    it.each([
        // Staging: the Worker host has the zone below a hyphenated label.
        ['staging', 'https://api-desktop-staging.ezil.work/', 'ezil.work'],
        // Production.
        ['production', 'https://api-desktop.ezil.org/', 'ezil.org'],
        // A Worker host two labels below its zone: "host minus one label" would be wrong here.
        ['a deeper Worker host', 'https://api.desktop-staging.ezil.work/', 'ezil.work'],
    ])('%s: %s serves AWS hosts on %s', async (_name, workerUrl, zone) => {
        vi.stubEnv('EZIL_AWS_BROWSER_ZONE', zone);
        fetchMock.mockResolvedValue(answerOn(zone));
        await expect(setup().open({ ...config, workerUrl })).resolves.toMatchObject({ ok: true });
    });

    it.each([['unset', ''], ['malformed', 'not a zone'], ['a bare label', 'example']])(
        'fails closed (no Worker call) when the zone is %s', async (_name, value) => {
            vi.stubEnv('EZIL_AWS_BROWSER_ZONE', value);
            await expect(setup().open()).resolves.toEqual(failure);
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );
});

describe('AWS browser route token', () => {
    it('pins the route token to the Worker source', () => {
        const worker = readFileSync(path.resolve(__dirname, '../../../../../worker/src/aws-origin.ts'), 'utf8');
        expect(worker).toContain(`export const AWS_BROWSER_ROUTE_TOKEN = '${AWS_BROWSER_ROUTE_TOKEN}';`);
        expect(worker).toContain('https://aws-${port}-${sandboxId}-${AWS_BROWSER_ROUTE_TOKEN}.${zoneRoot}/preview-bootstrap');
    });
});
