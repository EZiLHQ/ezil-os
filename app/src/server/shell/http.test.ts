/**
 * Tests for the shell Route Handlers' response layer.
 *
 * The property that matters: a typed, actionable refusal reaches the shell
 * intact (it has to — `computer_limit_reached` is a string the client
 * switches on), while a 5xx reaches it as nothing but a status code. An
 * INTERNAL_SERVER_ERROR message in this codebase can carry a Postgres error,
 * a correlation id or a connection detail, and a browser is the wrong place
 * for all three.
 */

import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { shellErrorResponse, shellJson, shellUnauthenticated } from './http';

beforeEach(() => {
    vi.restoreAllMocks();
});

async function body(res: Response): Promise<{ error?: { code: string; message: string } }> {
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

describe('shellUnauthenticated', () => {
    it('is one 401 shape, so the shell has one thing to detect', async () => {
        const res = shellUnauthenticated();

        expect(res.status).toBe(401);
        expect(await body(res)).toEqual({
            error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' },
        });
    });
});
