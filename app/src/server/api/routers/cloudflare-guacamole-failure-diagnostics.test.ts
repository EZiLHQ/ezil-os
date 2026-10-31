/**
 * FEEDBACK-DIAG, end to end on the server: a Cloudflare preview failure
 * reaches the shell with an allowlisted `reason` and the SAME correlation id
 * the router logged and sent to the Worker — on the value path (the production
 * `unauthorized` / `hmac_signature_mismatch` case) and on the thrown path,
 * through `createCaller` and `shellErrorResponse`.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shellErrorResponse } from '@/server/shell/http';

const mocks = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure };
});
vi.mock('./compute-dispatch', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(), routeComputer: mocks.route,
}));
vi.mock('./computer-store', () => ({ stampOpened: vi.fn(async () => {}) }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ config: { enforcementEnabled: false, tabEnabled: false }, now: () => new Date() }) }));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: vi.fn(async () => {}) }));
vi.mock('@/server/lib/compute/aws-clients', () => ({
    sharedAwsSdkCollaborators: () => { throw new Error('Unexpected AWS client construction'); },
}));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ workerUrl: 'https://worker.example.test', isConfigured: true, hasHmacSecret: true }),
}));

import { CORRELATION_HEADER, requestGuacamolePreview } from '@/server/lib/cloudflare-guacamole-provider';
import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let fetchMock: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The REAL Cloudflare client, against a stubbed Worker.
    mocks.route.mockReset().mockResolvedValue({ kind: 'cloudflare', provider: {
        ensure: (ctx: { correlationId: string }, c: { userId: string; computerId: string }, opts: { sessionId: string }) =>
            requestGuacamolePreview(
                { workerUrl: 'https://worker.example.test', isConfigured: true, hasHmacSecret: true }, 'secret',
                { sessionId: opts.sessionId, userId: c.userId, projectId: c.computerId, desktopMode: 'neko' }, ctx.correlationId,
            ),
    } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const caller = () => cloudflareGuacamoleRouter.createCaller({ user: { id: userId }, db: {
    query: { computers: { findFirst: async () => ({ id: computerId }) } },
} } as never);
const sentCorrelationId = () => (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers[CORRELATION_HEADER];

describe('FEEDBACK-DIAG: a Worker HMAC 401 is no longer just `unauthorized`', () => {
    it.each(['previewUrl', 'codePreviewUrl', 'appPreviewUrl'] as const)('%s answers the reason and the logged, Worker-sent correlation id', async (surface) => {
        fetchMock.mockResolvedValue(new Response('{"ok":false,"error":"hmac_signature_mismatch"}', { status: 401 }));
        const out = surface === 'previewUrl'
            ? await caller().previewUrl({ computerId, sessionId: computerId })
            : await caller()[surface]({ computerId });

        expect(out).toMatchObject({ ok: false, errorCode: 'unauthorized', reason: 'worker_http_401:hmac_signature_mismatch' });
        const { correlationId } = out as { correlationId?: string };
        expect(correlationId).toMatch(UUID);
        // The id support greps for is the one on the server line and on the Worker call.
        expect(sentCorrelationId()).toBe(correlationId);
        const line = consoleError.mock.calls.find(call => String(call[0]).includes('worker error'));
        expect(line?.[1]).toMatchObject({ correlationId, reason: 'worker_http_401:hmac_signature_mismatch' });
        // Nothing beyond the allowlisted code leaks into the new fields.
        expect(JSON.stringify({ reason: (out as { reason?: string }).reason, correlationId })).not.toMatch(/:\/\/|secret|token|bearer/i);
    });
});

describe('FEEDBACK-DIAG: a thrown 502 keeps its diagnostics through createCaller and shellErrorResponse', () => {
    it('surfaces reason + correlation id with the generic message', async () => {
        fetchMock.mockResolvedValue(new Response('{"ok":false,"error":"desktop_failed_to_start"}', { status: 502 }));
        let thrown: unknown;
        try {
            await caller().previewUrl({ computerId, sessionId: computerId });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(TRPCError);

        const res = shellErrorResponse(thrown, 'POST /api/shell/desktop');
        expect(res.status).toBe(502);
        const { error } = await res.json() as { error: Record<string, string> };
        expect(error).toEqual({
            code: 'BAD_GATEWAY', message: 'Something went wrong on our side.',
            reason: 'worker_http_502:desktop_failed_to_start', correlationId: sentCorrelationId(),
        });
        expect(error.correlationId).toMatch(UUID);
    });
});
