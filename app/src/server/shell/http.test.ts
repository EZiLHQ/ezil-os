/**
 * Tests for the shell Route Handlers' response layer.
 *
 * The property that matters: a typed, actionable refusal reaches the shell
 * intact (it has to — `computer_limit_reached` is a string the client
 * switches on), while a 5xx reaches it as nothing but a status code — plus,
 * since FEEDBACK-DIAG, an allowlisted `reason` and the `correlationId` on its
 * server log line, each a separate validated field. An INTERNAL_SERVER_ERROR
 * MESSAGE in this codebase can carry a Postgres error or a connection detail,
 * and a browser is the wrong place for either.
 */

import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FailureDiagnosticsError } from '@/server/lib/failure-diagnostics';

import { shellErrorResponse, shellJson, shellUnauthenticated } from './http';

beforeEach(() => {
    vi.restoreAllMocks();
});

async function body(res: Response): Promise<{ error?: { code: string; message: string; reason?: string; correlationId?: string } }> {
    return res.json();
}

describe('shellJson', () => {
    it('is JSON and is never cached — the payload is per-user and can create a row', async () => {
        const res = shellJson({ ok: true });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(res.headers.get('cache-control')).toContain('no-store');
        expect(await res.json()).toEqual({ ok: true });
    });
});

describe('shellErrorResponse', () => {
    it('reuses tRPC\'s own code -> status table, so these routes and /api/trpc agree', () => {
        expect(shellErrorResponse(new TRPCError({ code: 'UNAUTHORIZED' }), 'r').status).toBe(401);
        expect(shellErrorResponse(new TRPCError({ code: 'FORBIDDEN' }), 'r').status).toBe(403);
        expect(shellErrorResponse(new TRPCError({ code: 'NOT_FOUND' }), 'r').status).toBe(404);
        expect(shellErrorResponse(new TRPCError({ code: 'BAD_REQUEST' }), 'r').status).toBe(400);
    });

    it('passes a typed refusal through unchanged — the shell switches on it', async () => {
        const res = shellErrorResponse(
            new TRPCError({ code: 'FORBIDDEN', message: 'computer_limit_reached' }),
            'POST /api/shell/session',
        );

        expect(res.status).toBe(403);
        expect(await body(res)).toEqual({
            error: { code: 'FORBIDDEN', message: 'computer_limit_reached' },
        });
    });

    it('replaces a 5xx message with a generic one, and logs the real text server-side', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = shellErrorResponse(
            new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'connection to postgres://user:pw@host failed',
            }),
            'GET /api/shell/session',
        );

        expect(res.status).toBe(500);
        const parsed = await body(res);
        expect(parsed.error!.code).toBe('INTERNAL_SERVER_ERROR');
        expect(parsed.error!.message).not.toContain('postgres');
        expect(parsed.error!.message).toBe('Something went wrong on our side.');
        // Lost to the browser, kept in the logs — where `wrangler tail` /
        // platform logs are the only observability there is (PLATFORM-NOTES §11).
        expect(consoleError).toHaveBeenCalled();
        expect(JSON.stringify(consoleError.mock.calls)).toContain('postgres');
    });

    it('does the same for BAD_GATEWAY — every 5xx, not just 500', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = shellErrorResponse(
            new TRPCError({ code: 'BAD_GATEWAY', message: 'Desktop Worker returned correlationId=abc' }),
            'POST /api/shell/desktop',
        );

        expect(res.status).toBe(502);
        expect((await body(res)).error!.message).toBe('Something went wrong on our side.');
    });

    it('turns a non-tRPC throw into a 500 without echoing it', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = shellErrorResponse(new Error('ECONNREFUSED 10.0.0.1:5432'), 'GET /api/shell/desktop');

        expect(res.status).toBe(500);
        expect((await body(res)).error!.message).not.toContain('10.0.0.1');
        expect(consoleError).toHaveBeenCalled();
    });
});

describe('shellErrorResponse — FEEDBACK-DIAG fields', () => {
    const CORRELATION = '550e8400-e29b-41d4-a716-446655440000';

    it('keeps a thrown failure\'s reason and correlation id beside the generic 5xx message, and logs both', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = shellErrorResponse(new TRPCError({
            code: 'BAD_GATEWAY',
            message: `Desktop Worker returned an error (correlationId=${CORRELATION}).`,
            cause: new FailureDiagnosticsError({ reason: 'worker_http_502:desktop_failed_to_start', correlationId: CORRELATION }),
        }), 'POST /api/shell/desktop');

        expect(res.status).toBe(502);
        expect(await body(res)).toEqual({ error: {
            code: 'BAD_GATEWAY', message: 'Something went wrong on our side.',
            reason: 'worker_http_502:desktop_failed_to_start', correlationId: CORRELATION,
        } });
        const logged = JSON.stringify(consoleError.mock.calls);
        expect(logged).toContain(CORRELATION);
        expect(logged).toContain('worker_http_502:desktop_failed_to_start');
    });

    it('mints, logs and returns a short id for a 5xx that had none', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = shellErrorResponse(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'postgres://u:pw@h' }), 'r');
        const { error } = await body(res);
        expect(error!.correlationId).toMatch(/^srv_[0-9a-f]{12}$/);
        expect(error!.reason).toBeUndefined();
        expect(JSON.stringify(consoleError.mock.calls)).toContain(error!.correlationId);
    });

    it('does the same for a non-tRPC throw, without echoing it', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = shellErrorResponse(new Error('ECONNREFUSED 10.0.0.1:5432'), 'GET /api/shell/desktop');
        const parsed = await body(res);
        expect(parsed.error!.correlationId).toMatch(/^srv_[0-9a-f]{12}$/);
        expect(JSON.stringify(parsed)).not.toContain('10.0.0.1');
        expect(JSON.stringify(consoleError.mock.calls)).toContain(parsed.error!.correlationId);
    });

    it('drops a cause\'s fields that fail the allowlist, never repairs them', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = shellErrorResponse(new TRPCError({
            code: 'BAD_GATEWAY', message: 'x',
            cause: new FailureDiagnosticsError({ reason: 'https://worker.example.test/?token=abc', correlationId: 'Bearer abc' }),
        }), 'r');
        const { error } = await body(res);
        expect(error!.reason).toBeUndefined();
        expect(error!.correlationId).toMatch(/^srv_[0-9a-f]{12}$/);
        expect(JSON.stringify(error)).not.toMatch(/token|Bearer/);
    });

    it('ignores a plain-object cause that merely looks like diagnostics', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = shellErrorResponse(new TRPCError({
            code: 'BAD_GATEWAY', message: 'x', cause: { fields: { reason: 'worker_http_401' } } as unknown as Error,
        }), 'r');
        expect((await body(res)).error!.reason).toBeUndefined();
    });

    it('a typed sub-500 refusal is unchanged when it carries no diagnostics', async () => {
        const res = shellErrorResponse(new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' }), 'r');
        expect(await body(res)).toEqual({ error: { code: 'NOT_FOUND', message: 'Computer not found' } });
    });
});

describe('shellUnauthenticated', () => {
    it('is one 401 shape, so the shell has one thing to detect', async () => {
        const res = shellUnauthenticated();

        expect(res.status).toBe(401);
        expect(await body(res)).toEqual({
            error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.', reason: 'session_missing' },
        });
    });
});
