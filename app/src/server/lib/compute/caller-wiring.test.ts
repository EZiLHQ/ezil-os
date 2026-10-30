/**
 * P1 caller wiring: each lifecycle caller that now goes through the seam still
 * addresses the OWNER-DERIVED sandbox, with the same method and path as
 * before. Complements `cloudflare.test.ts` (adapter ≡ direct call) by proving
 * the callers hand the adapter the right computer.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { initTRPC, TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ reapDeps: undefined as unknown, softDelete: undefined as unknown }));

// Billing effects are exercised in compute-dispatch.test.ts.
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date() }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({
    billingV2EntitlementReader: () => ({ read: async () => null }),
    gateComputerStart: async () => ({ allowed: true }),
}));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string } | null; db: unknown }>().create();
    return {
        createTRPCRouter: t.router,
        protectedProcedure: t.procedure.use(({ ctx, next }) => {
            if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
            return next({ ctx: { ...ctx, user: ctx.user } });
        }),
    };
});
vi.mock('@/server/api/routers/computer-store', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        stampOpened: vi.fn(async () => {}),
        softDeleteComputer: vi.fn(async (_db: unknown, args: { terminateSandbox: () => Promise<void> }) => {
            captured.softDelete = args;
            return { id: 'x' };
        }),
    };
});
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: { CRON_SECRET: 'cron', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: ' env-secret ' } }));
vi.mock('@/app/api/cron/sandbox-reap/handler', () => ({
    handleSandboxReap: vi.fn(async (_req: Request, deps: unknown) => {
        captured.reapDeps = deps;
        return new Response(null);
    }),
}));

import { GET as reapGET } from '@/app/api/cron/sandbox-reap/route';
import { cloudflareGuacamoleRouter } from '@/server/api/routers/cloudflare-guacamole';
import { computerRouter } from '@/server/api/routers/computer';
import {
    deriveGuacamoleSandboxId,
    mintSandboxPreviewToken,
    resolveScreenRequest,
} from '@/server/lib/cloudflare-guacamole-provider';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const sandbox = deriveGuacamoleSandboxId(userId, computerId);
const base = 'https://worker.example';

describe('every lifecycle router call inherits the billing reader', () => {
    it.each([
        // Status also re-reads dispatch if a migration fence races its first read.
        ['server/api/routers/cloudflare-guacamole.ts', 7, './compute-dispatch'],
        ['server/api/routers/computer.ts', 1, './compute-dispatch'],
        ['server/lib/compute/stop-policy.ts', 1, '@/server/api/routers/compute-dispatch'],
        // isStillRunning plus the round-3 awsStopProof (both take the dispatch default).
        ['app/api/cron/billing-session-sweep/route.ts', 2, '@/server/api/routers/compute-dispatch'],
    ] as const)('%s uses the dispatch default on every routeComputer call', (file, expectedCalls, dispatchImport) => {
        const source = ts.createSourceFile(file, readFileSync(path.resolve(__dirname, '../../..', file), 'utf8'), ts.ScriptTarget.Latest, true);
        const calls: ts.CallExpression[] = [];
        const isDispatch = (node: ts.Expression): boolean => {
            if (ts.isIdentifier(node)) return node.text === 'routeComputer';
            if (ts.isParenthesizedExpression(node)) return isDispatch(node.expression);
            return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
                && isDispatch(node.right);
        };
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && isDispatch(node.expression)) calls.push(node);
            ts.forEachChild(node, visit);
        };
        visit(source);
        expect(calls).toHaveLength(expectedCalls);
        expect(source.statements.some(node => ts.isImportDeclaration(node)
            && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === dispatchImport
            && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
            && node.importClause.namedBindings.elements.some(element => element.name.text === 'routeComputer'))).toBe(true);
        for (const call of calls) {
            const options = call.arguments[2];
            if (!options) continue;
            // No spread/opaque options may replace the tested dispatch default.
            expect(ts.isObjectLiteralExpression(options)).toBe(true);
            if (!ts.isObjectLiteralExpression(options)) continue;
            for (const property of options.properties) {
                expect(ts.isPropertyAssignment(property)).toBe(true);
                if (ts.isPropertyAssignment(property)) expect(property.name.getText(source)).not.toBe('entitlements');
            }
        }
    });
});

let calls: { method: string; url: string; auth: string | undefined; body?: string }[] = [];
let reply: unknown = { ok: true };

beforeEach(() => {
    calls = [];
    reply = { ok: true };
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', base);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'router-secret');
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit = {}) => {
            const headers = (init.headers ?? {}) as Record<string, string>;
            calls.push({
                method: init.method ?? 'GET',
                url: String(url),
                auth: headers.Authorization,
                ...(typeof init.body === 'string' ? { body: init.body } : {}),
            });
            return Response.json(reply);
        }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const owner = () =>
    cloudflareGuacamoleRouter.createCaller({
        user: { id: userId },
        db: { query: { computers: { findFirst: async () => ({ id: computerId }) } } },
    } as never);

describe('router lifecycle procedures address the owner-derived sandbox', () => {
    it('status → GET /sandbox/:name/status', async () => {
        reply = { ok: true, guacamoleRunning: true };
        const out = await owner().status({ computerId });
        expect(calls).toEqual([{ method: 'GET', url: `${base}/sandbox/${sandbox}/status`, auth: undefined }]);
        expect(out).toMatchObject({ ok: true, guacamoleRunning: true, sandboxName: sandbox });
    });

    it('terminate → DELETE /sandbox/:name, signed', async () => {
        reply = { ok: true, terminated: true, outcome: 'destroyed' };
        const out = await owner().terminate({ computerId });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: 'DELETE', url: `${base}/sandbox/${sandbox}` });
        expect(calls[0]?.auth).toMatch(/^Bearer t=\d+,v1=[0-9a-f]{64}$/);
        expect(out).toMatchObject({ ok: true, terminated: true, outcome: 'destroyed', sandboxName: sandbox });
    });

    it('reportActivity → POST /sandbox/:name/activity', async () => {
        await owner().reportActivity({ computerId, lastInputAgoMs: 10 });
        expect(calls).toMatchObject([{ method: 'POST', url: `${base}/sandbox/${sandbox}/activity` }]);
    });

    it('restartDesktop → POST /sandbox/:name/restart', async () => {
        reply = { ok: true, outcome: 'restarted', wasRunning: true };
        const out = await owner().restartDesktop({ computerId });
        expect(calls).toMatchObject([{ method: 'POST', url: `${base}/sandbox/${sandbox}/restart` }]);
        expect(out).toMatchObject({ ok: true, outcome: 'restarted', wasRunning: true });
    });

    /** The preview body minus its time-dependent HMAC token. */
    const previewBody = () => {
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: 'POST', url: `${base}/sandbox/preview` });
        const { token, ...rest } = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
        expect(typeof token).toBe('string');
        return rest;
    };
    const sessionId = '33333333-3333-4333-8333-333333333333';

    it('previewUrl WITH a usable screen → the snapped screen reaches the Worker body', async () => {
        reply = { ok: false, error: 'stop here', errorCode: 'unknown' };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const requested = { width: 1280, height: 800 };
        const snapped = resolveScreenRequest(requested);
        expect(snapped.source).not.toBe('default'); // the case must exercise the spread
        await owner().previewUrl({ sessionId, computerId, screen: requested }).catch(() => undefined);
        expect(previewBody()).toEqual({
            sessionId,
            userId,
            projectId: computerId,
            desktopMode: 'neko',
            screen: { width: snapped.width, height: snapped.height },
        });
    });

    it('previewUrl WITHOUT a screen → `screen` is omitted, not defaulted', async () => {
        reply = { ok: false, error: 'stop here', errorCode: 'unknown' };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await owner().previewUrl({ sessionId, computerId }).catch(() => undefined);
        expect(previewBody()).toEqual({ sessionId, userId, projectId: computerId, desktopMode: 'neko' });
    });

    it('codePreviewUrl → POST /sandbox/preview keyed by the computer, no screen', async () => {
        reply = { ok: false, error: 'stop here', errorCode: 'unknown' };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await owner().codePreviewUrl({ computerId }).catch(() => undefined);
        expect(previewBody()).toEqual({ sessionId: computerId, userId, projectId: computerId, desktopMode: 'neko' });
    });

    it('appPreviewUrl → POST /sandbox/preview with this owner and computer in the body', async () => {
        reply = { ok: false, error: 'stop here', errorCode: 'unknown' };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await owner().appPreviewUrl({ computerId }).catch(() => undefined);
        expect(previewBody()).toEqual({ sessionId: computerId, userId, projectId: computerId, desktopMode: 'neko' });
    });
});

describe('computer.delete terminates through the seam', () => {
    it('DELETE /sandbox/:name for the caller’s computer; unconfirmed teardown still throws', async () => {
        const caller = computerRouter.createCaller({ user: { id: userId }, db: {} } as never);
        await caller.delete({ id: computerId }).catch(() => undefined);
        const args = captured.softDelete as { terminateSandbox: () => Promise<void> };
        reply = { ok: true, terminated: true, outcome: 'destroyed' };
        await args.terminateSandbox();
        expect(calls).toMatchObject([{ method: 'DELETE', url: `${base}/sandbox/${sandbox}` }]);
        reply = { ok: false, outcome: 'still_running' };
        await expect(args.terminateSandbox()).rejects.toThrow(/sandbox_terminate_not_confirmed/);
    });
});

describe('sandbox-reap route maps handler sandbox names back to computers', () => {
    it('checkRunning/terminate hit the derived sandbox, signed with env (not process.env)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
        await reapGET(new Request('https://app.example/api/cron/sandbox-reap'));
        const deps = captured.reapDeps as {
            deriveSandboxName(u: string, c: string): string;
            checkRunning(n: string): Promise<boolean>;
            terminate(n: string): Promise<{ ok: boolean; terminated: boolean }>;
        };
        const name = deps.deriveSandboxName(userId, computerId);
        expect(name).toBe(sandbox);
        reply = { ok: true, guacamoleRunning: true };
        await expect(deps.checkRunning(name)).resolves.toBe(true);
        reply = { ok: true, terminated: true, outcome: 'destroyed' };
        await expect(deps.terminate(name)).resolves.toMatchObject({ ok: true, terminated: true });
        expect(calls.map((c) => [c.method, c.url])).toEqual([
            ['GET', `${base}/sandbox/${sandbox}/status`],
            ['DELETE', `${base}/sandbox/${sandbox}`],
        ]);
        expect(calls[1]?.auth).toBe(`Bearer ${mintSandboxPreviewToken('env-secret')}`);
        expect(() => deps.checkRunning('guac-never-derived')).toThrow(/sandbox_name_not_derived_this_run/);
        vi.useRealTimers();
    });
});

describe('P3: sandbox-reap asks each candidate\'s placement only when placement reads are on', () => {
    it('reads OFF → no providerOf (every candidate Cloudflare, as before); reads ON → providerOf wired', async () => {
        await reapGET(new Request('https://app.example/api/cron/sandbox-reap'));
        expect((captured.reapDeps as { providerOf?: unknown }).providerOf).toBeUndefined();
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        await reapGET(new Request('https://app.example/api/cron/sandbox-reap'));
        expect(typeof (captured.reapDeps as { providerOf?: unknown }).providerOf).toBe('function');
    });
});
