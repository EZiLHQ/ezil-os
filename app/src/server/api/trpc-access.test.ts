/**
 * The EZiL OS access gate, as `protectedProcedure` actually enforces it.
 *
 * `./os-access.test.ts` (row A1) proves the DECISION — who is allowed, and
 * why. This file proves the ENFORCEMENT: that the decision is reached once per
 * request, that a refused caller gets `FORBIDDEN` rather than `UNAUTHORIZED`,
 * and — the part that matters most — that **nothing downstream of the gate
 * runs for a refused principal**. `/os` calls `computer.getOrCreateDefault`,
 * which CREATES A ROW. A gate that refuses after that call has already written
 * a computer for someone who may not use the product.
 *
 * ── Why the database is `drizzle-orm/pg-proxy` and throws ────────────────────
 * The fake below serves exactly one query — the `ezil_os_access` lookup — and
 * throws on any other statement. That is not tidiness: it is the assertion.
 * Deleting the access check from `protectedProcedure` makes the computer
 * router's own query reach this fake, which throws, and the FORBIDDEN
 * expectations turn red. The proof that no write was attempted is therefore
 * observable, not asserted by inspection.
 *
 * ── Why this file can import `./trpc` at all ─────────────────────────────────
 * `./trpc` imports `@/env`, which validates the entire server environment
 * eagerly at import time. `vi.hoisted` runs before the import graph is
 * evaluated, so the three required variables are set first. `@/server/db`'s
 * `postgres()` pool is constructed but never connects: nothing in these tests
 * goes through it — `buildTRPCContext` takes the database as a parameter.
 */
import { describe, expect, it, vi } from 'vitest';

const testEnv = vi.hoisted(() => {
    process.env.SUPABASE_DATABASE_URL ??= 'postgres://a2-gate-test@127.0.0.1:5432/none';
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://a2-gate-test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'a2-gate-test-anon-key';
    // Deliberately unset: the default is part of the gate (see `@/env`).
    delete process.env.EZIL_OS_ACCESS_MODE;
    return { modeInEnv: process.env.EZIL_OS_ACCESS_MODE };
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { TRPCError } from '@trpc/server';
import { drizzle } from 'drizzle-orm/pg-proxy';

import type { User } from '@supabase/supabase-js';

import { appRouter } from '@/server/api/root';
import * as schema from '@/server/db/schema';

import { OS_ACCESS_NOT_INVITED } from './os-access';
import { buildTRPCContext, createCallerFactory, createTRPCRouter, protectedProcedure, publicProcedure } from './trpc';

const ALICE = { id: 'alice-uuid', email: 'alice@example.com' } as User;
const MALLORY = { id: 'mallory-uuid', email: 'mallory@example.com' } as User;
const STRANGER = { id: 'stranger-uuid', email: 'stranger@example.com' } as User;
/** An OAuth identity with no address at all — `no_email`, a denial. */
const NAMELESS = { id: 'nameless-uuid' } as User;

/**
 * 🔴 Rows are POSITIONAL ARRAYS in the select's column order — that is what
 * `pg-proxy` hands to Drizzle's own field mappers (measured in
 * `./os-access.test.ts`; an object row maps to `{}`).
 */
const allowRow = (email: string) => [email, null];
const revokedRow = (email: string) => [email, '2026-01-01 00:00:00+00'];

/**
 * A database that answers the allow-list lookup and REFUSES everything else.
 * `statements` is the record of what the request actually asked the database.
 */
function accessOnlyDb(rows: unknown[]) {
    const statements: string[] = [];
    const db = drizzle(
        async (sql: string) => {
            statements.push(sql);
            if (!/ezil_os_access/.test(sql)) {
                throw new Error(`the gate let a non-allow-list query through: ${sql}`);
            }
            return { rows };
        },
        { schema },
    );
    return { db: db as unknown as Parameters<typeof buildTRPCContext>[0]['db'], statements };
}

const contextFor = (
    user: User | null,
    { rows = [] as unknown[], mode = 'invite' as const } = {},
) => {
    const { db, statements } = accessOnlyDb(rows);
    return { ctx: buildTRPCContext({ db, user, headers: new Headers(), mode }), statements };
};

/** A router built from the SHIPPED `protectedProcedure`, with no resolver work of its own. */
const probeRouter = createTRPCRouter({
    whoami: protectedProcedure.query(({ ctx }) => ({ id: ctx.user.id, reason: ctx.access.reason })),
    ping: publicProcedure.query(() => 'pong'),
});
const probeCaller = createCallerFactory(probeRouter);

// ── The decision, reached once per request ──────────────────────────────────

describe('ctx.access() — one lookup per request, lazily', () => {
    it('does not touch the database until something asks', async () => {
        const { ctx, statements } = contextFor(ALICE, { rows: [allowRow('alice@example.com')] });
        expect(statements).toEqual([]);
        await ctx.access();
        expect(statements).toHaveLength(1);
    });

    it('🔴 memoises: three procedures on one context are still ONE lookup', async () => {
        const { ctx, statements } = contextFor(ALICE, { rows: [allowRow('alice@example.com')] });
        const [a, b, c] = await Promise.all([ctx.access(), ctx.access(), ctx.access()]);
        expect(statements).toHaveLength(1);
        expect(a).toEqual({ allowed: true, reason: 'invited' });
        expect(b).toBe(a);
        expect(c).toBe(a);
    });

    it('in `open` mode it never queries at all', async () => {
        const { ctx, statements } = contextFor(STRANGER, { mode: 'open' as never });
        await expect(ctx.access()).resolves.toEqual({ allowed: true, reason: 'open' });
        expect(statements).toEqual([]);
    });

    it('🔴 a lookup failure is a failure, never an allow', async () => {
        const db = drizzle(async () => {
            throw new Error('connection refused');
        }, { schema }) as unknown as Parameters<typeof buildTRPCContext>[0]['db'];
        const ctx = buildTRPCContext({ db, user: ALICE, headers: new Headers(), mode: 'invite' });
        // Drizzle wraps the driver error, so the assertion is on the query it
        // names — the allow-list lookup — not on the driver's own words.
        await expect(ctx.access()).rejects.toThrow(/ezil_os_access/);
    });

    it('and that failure reaches the procedure as a throw, not as an allow', async () => {
        const db = drizzle(async () => {
            throw new Error('connection refused');
        }, { schema }) as unknown as Parameters<typeof buildTRPCContext>[0]['db'];
        const ctx = buildTRPCContext({ db, user: ALICE, headers: new Headers(), mode: 'invite' });
        const error = await probeCaller(ctx)
            .whoami()
            .then(() => 'ALLOWED THROUGH', (err: unknown) => err);
        expect(error).not.toBe('ALLOWED THROUGH');
        expect((error as Error).message).toMatch(/ezil_os_access/);
    });
});

// ── protectedProcedure ──────────────────────────────────────────────────────

describe('protectedProcedure — authenticated is not the same as allowed', () => {
    it('lets an invited user through, and narrows ctx.user + ctx.access', async () => {
        const { ctx } = contextFor(ALICE, { rows: [allowRow('alice@example.com')] });
        await expect(probeCaller(ctx).whoami()).resolves.toEqual({
            id: 'alice-uuid',
            reason: 'invited',
        });
    });

    it.each([
        ['never invited', STRANGER, [] as unknown[]],
        ['revoked', MALLORY, [revokedRow('mallory@example.com')]],
        ['an identity with no email', NAMELESS, [] as unknown[]],
    ])('🔴 refuses %s with FORBIDDEN and the one message', async (_label, user, rows) => {
        const { ctx } = contextFor(user, { rows });
        const error = await probeCaller(ctx)
            .whoami()
            .then(() => null, (err: unknown) => err);

        expect(error).toBeInstanceOf(TRPCError);
        expect((error as TRPCError).code).toBe('FORBIDDEN');
        expect((error as TRPCError).message).toBe(OS_ACCESS_NOT_INVITED);
        // 🔴 Not UNAUTHORIZED. This caller proved who they are; telling them to
        // sign in again would loop them forever.
        expect((error as TRPCError).code).not.toBe('UNAUTHORIZED');
    });

    it('a caller with no user is still UNAUTHORIZED, not FORBIDDEN — the positive control', async () => {
        const { ctx, statements } = contextFor(null);
        const error = await probeCaller(ctx)
            .whoami()
            .then(() => null, (err: unknown) => err);

        expect((error as TRPCError).code).toBe('UNAUTHORIZED');
        // And the allow-list was never consulted: there is nobody to look up.
        expect(statements).toEqual([]);
    });

    it('publicProcedure is untouched by the gate — a refused principal can still call it', async () => {
        const { ctx, statements } = contextFor(STRANGER);
        await expect(probeCaller(ctx).ping()).resolves.toBe('pong');
        expect(statements).toEqual([]);
    });
});

// ── The bearer half. Same refusal, no bearer-specific code. ─────────────────

describe('a bearer caller (sdk/, mcp/) is refused by the same gate', () => {
    // `createTRPCContext` resolves the cookie user and the bearer user into ONE
    // `user` and calls `buildTRPCContext` once (source-pinned below), so this
    // is the bearer path: the same context, built from a user that arrived on
    // an `Authorization` header instead of a cookie.
    it('🔴 an authenticated bearer that is not on the allow-list gets FORBIDDEN', async () => {
        const { ctx } = contextFor(STRANGER, { rows: [] });
        const error = await probeCaller(ctx)
            .whoami()
            .then(() => null, (err: unknown) => err);

        expect((error as TRPCError).code).toBe('FORBIDDEN');
        expect((error as TRPCError).message).toBe(OS_ACCESS_NOT_INVITED);
    });

    it('and an invited bearer is let through — the positive control', async () => {
        const { ctx } = contextFor(ALICE, { rows: [allowRow('alice@example.com')] });
        await expect(probeCaller(ctx).whoami()).resolves.toMatchObject({ id: 'alice-uuid' });
    });
});

// ── 🔴 Nothing downstream runs for a refused principal ──────────────────────

describe('the refused principal never reaches the computer-creating call', () => {
    it('🔴 computer.getOrCreateDefault is refused BEFORE it writes anything', async () => {
        const { ctx, statements } = contextFor(STRANGER, { rows: [] });
        const caller = appRouter.createCaller(ctx);

        const error = await caller.computer
            .getOrCreateDefault()
            .then(() => null, (err: unknown) => err);

        expect((error as TRPCError).code).toBe('FORBIDDEN');
        // The whole proof: ONE statement reached the database, and it was the
        // allow-list read. No `computers` select, no insert. If the check in
        // `protectedProcedure` is removed, the router's own query arrives here
        // instead and the fake throws — see this file's header.
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/ezil_os_access/);
        expect(statements.join('\n')).not.toMatch(/insert into/i);
        expect(statements.join('\n')).not.toMatch(/"computers"/);
    });

    it('a revoked user is refused there too', async () => {
        const { ctx, statements } = contextFor(MALLORY, {
            rows: [revokedRow('mallory@example.com')],
        });
        const error = await appRouter
            .createCaller(ctx)
            .computer.getOrCreateDefault()
            .then(() => null, (err: unknown) => err);

        expect((error as TRPCError).code).toBe('FORBIDDEN');
        expect(statements).toHaveLength(1);
    });
});

// ── Source pins: the properties no runtime assertion can see ────────────────

const here = path.dirname(new URL(import.meta.url).pathname);
const trpcSource = readFileSync(path.resolve(here, './trpc.ts'), 'utf8').replace(/\r\n/g, '\n');
/** Strip comments, so documenting a trap does not read as falling into it. */
const code = (source: string) =>
    source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');

describe('authorization has exactly one implementation', () => {
    it('🔴 createTRPCContext builds the context in exactly one place', () => {
        // The bearer refusal above is only "no extra code" if there is no
        // second context builder for a second credential to be assembled by.
        const calls = code(trpcSource).match(/buildTRPCContext\(/g) ?? [];
        expect(calls).toHaveLength(2); // the declaration, and its one call
    });

    it('🔴 the access decision is computed in exactly one place', () => {
        expect(code(trpcSource).match(/osAccessFor\(/g) ?? []).toHaveLength(1);
    });

    it('🔴 the decision is never swallowed — no try/catch around access()', () => {
        expect(code(trpcSource)).not.toMatch(/try\s*\{/);
    });

    it('refuses with FORBIDDEN, never UNAUTHORIZED, for a denied allow-list', () => {
        const body = code(trpcSource).slice(code(trpcSource).indexOf('export const protectedProcedure'));
        expect(body).toMatch(/code: 'FORBIDDEN', message: OS_ACCESS_NOT_INVITED/);
    });

    it('an environment that never heard of EZIL_OS_ACCESS_MODE is invite-only', async () => {
        // The fail-closed default, observed through the real `@/env` rather
        // than restated. `testEnv.modeInEnv` records that nothing was set.
        expect(testEnv.modeInEnv).toBeUndefined();
        const { env } = await import('@/env');
        expect(env.EZIL_OS_ACCESS_MODE).toBe('invite');
    });
});
