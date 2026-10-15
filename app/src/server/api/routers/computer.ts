/**
 * "Computers" tRPC Router
 *
 * A computer is the top-level unit of EZiL OS: login -> up to
 * `MAX_COMPUTERS_PER_USER` computers -> open one -> the streamed Linux
 * desktop. Projects (if any, later) are plain folders inside a computer's
 * workspace — no separate data model for them.
 *
 * A computer's `id` occupies the same "scope id" slot the Cloudflare
 * Guacamole/Neko desktop stack already treats as an opaque UUID (see
 * `server/lib/cloudflare-guacamole-provider.ts` and
 * `worker/src/index.ts`'s `deriveSandboxId` / `ensureWorkspaceMount`).
 *
 * Procedures: list / create / get / rename / touch / delete. `delete` is
 * SOFT delete only — it stamps `deleted_at` and never issues a SQL DELETE;
 * see `./computer-store.ts` for the full rationale and the type-level
 * guarantee that enforces it.
 *
 * Carried near-verbatim from EBuilder's
 * `apps/web/client/src/server/api/routers/computer.ts` (authored
 * post-Onlook-import, listed as safe to carry). Adapted only for this
 * repo's own db schema import path and its own (smaller)
 * `isUniqueViolation` helper — EBuilder's version lived in
 * `server/api/routers/project/access.ts`, which is Onlook-derived
 * scaffolding this repo does not carry, so the tiny helper is reproduced
 * fresh below instead of imported.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { computers } from '@/server/db/schema';
import { newCorrelationId, resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import type { CloudflareComputeProvider } from '@/server/lib/compute/cloudflare';
import { AWS_RETIREMENT_UNDERWAY } from '@/server/lib/compute/aws-ec2';
import type { PlacementExecutor } from '@/server/lib/compute/placement';
import type { ComputeProvider, ComputerRef } from '@/server/lib/compute/provider';
import { readSystemInfo } from '@/server/lib/compute/system-info';
import { routeComputer } from './compute-dispatch';
import { computerCreateError } from './computer-errors';
import {
    createComputerInLowestFreeSlot,
    getOrCreateDefaultComputer,
    liveComputersOf,
    liveOwnedComputer,
    MAX_COMPUTERS_PER_USER,
    pickFreeSlot,
    softDeleteComputer,
} from './computer-store';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * Re-exported from `./computer-store.ts` (which owns them, so the row-level
 * rules stay importable without pulling in `../trpc` -> `@/server/db` ->
 * `@/env`). These two import paths are long-standing public API of this
 * module, so they keep working unchanged.
 */
export { MAX_COMPUTERS_PER_USER, pickFreeSlot };

/**
 * Ask the desktop Worker to tear down this computer's sandbox.
 *
 * Throws when the Worker did not CONFIRM the teardown (rejected the signed
 * request, answered `still_running`/`destroy_failed`, or was unreachable) —
 * `softDeleteComputer`'s try/catch (see `./computer-store.ts`) turns that
 * into `sandboxTerminated: false` and logs it, while the soft delete itself
 * still proceeds. A provider that isn't configured at all is a no-op rather
 * than a failure, since there is no sandbox to tear down.
 */
async function terminateComputerSandbox(provider: CloudflareComputeProvider, computer: ComputerRef): Promise<void> {
    const config = resolveCloudflareGuacamoleConfig();
    if (!config.isConfigured) return;
    const result = await provider.terminate({ correlationId: newCorrelationId() }, computer);
    if (!result.ok) {
        throw new Error(`sandbox_terminate_not_confirmed: ${result.error ?? result.outcome ?? 'unknown'}`);
    }
}

/**
 * An AWS computer's retirement is under way before its row is soft-deleted: the
 * provider's `terminate` is retire (C-3: the data volume is kept for the 14-day
 * retention window, §6 / F6 — nothing is deleted). One user delete is enough:
 * once a lifecycle job that ends the instance is durably recorded on the placement
 * (`AWS_RETIREMENT_UNDERWAY`), or the computer is already RETIRED, the row is
 * soft-deleted and the sandbox-reap cron's background reconcile drives the
 * placement to RETIRED. Any other answer REFUSES THE DELETE: soft-deleting while
 * nothing will end the instance would leave AWS resources no flow can reach, and
 * falling back to the Cloudflare teardown would address a sandbox that does not
 * exist. Ownership of the live row is checked first, so a foreign id is NOT_FOUND
 * before any provider call.
 */
async function retireAwsComputerBeforeDelete(
    db: Parameters<typeof softDeleteComputer>[0],
    provider: ComputeProvider,
    computer: ComputerRef,
): Promise<void> {
    const owned = await db.query.computers.findFirst({
        where: liveOwnedComputer(computer.userId, computer.computerId),
        columns: { id: true },
    });
    if (!owned) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
    const result = await provider.terminate({ correlationId: newCorrelationId() }, computer);
    if (!result.ok && !AWS_RETIREMENT_UNDERWAY.includes(result.outcome ?? '')) {
        throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `aws_retire_unavailable: ${result.outcome ?? result.error ?? 'unknown'}`,
        });
    }
}

export const computerRouter = createTRPCRouter({
    /**
     * List the authenticated user's live computers, lowest slot first.
     * Soft-deleted rows are excluded by `liveComputersOf`'s `deleted_at IS
     * NULL` half — a deleted computer is gone from this list immediately.
     */
    list: protectedProcedure.query(async ({ ctx }) => {
        return ctx.db.query.computers.findMany({
            where: liveComputersOf(ctx.user.id),
            orderBy: (row, { asc }) => [asc(row.slot)],
        });
    }),

    /**
     * Create a new computer in the caller's lowest free slot. Throws the
     * typed `computer_limit_reached` FORBIDDEN error once the user already
     * has `MAX_COMPUTERS_PER_USER` live computers — including the race case
     * where a concurrent duplicate request (e.g. a double-click) wins the
     * same slot first: the partial unique index on `(user_id, slot) WHERE
     * deleted_at IS NULL` turns that race into a Postgres unique violation,
     * which `createComputerInLowestFreeSlot` converts to the SAME typed
     * reason rather than surfacing as a raw 500.
     *
     * The body moved to `./computer-store.ts` unchanged when
     * `getOrCreateDefault` below needed the identical slot-pick + race
     * handling; one implementation, so the two entry points cannot drift.
     */
    create: protectedProcedure
        .input(
            z.object({
                name: z.string().trim().min(1).max(200).optional(),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            const outcome = await createComputerInLowestFreeSlot(ctx.db, {
                userId: ctx.user.id,
                name: input.name,
            });

            if (!outcome.ok) {
                throw computerCreateError(outcome.reason);
            }

            return outcome.computer;
        }),

    /**
     * Return the caller's LOWEST-slot live computer, creating one only if
     * they have none. This is how the EZiL OS shell (`/os`) boots: a user
     * arrives and gets a computer, without ever being shown a list or a
     * "create" button.
     *
     * A mutation because it can write. `/os` calls it during render anyway
     * (see `src/app/os/page.tsx`) — that is safe precisely because it is
     * idempotent: a user with a computer gets it back after ONE indexed
     * read, so a repeat render, a refresh or a route prefetch can never
     * produce a second row.
     *
     * `created` reports what actually happened, never an assumption. See
     * `getOrCreateDefaultComputer` for the concurrent-double-create race:
     * the loser of the slot race re-reads and returns the winner's row, and
     * only a re-read that still finds nothing raises the same typed
     * `computer_limit_reached` this router has always raised.
     *
     * Takes no input on purpose — a computer created here is named with the
     * same default `create` uses, and the shell has no name to offer at boot.
     */
    getOrCreateDefault: protectedProcedure.mutation(async ({ ctx }) => {
        const outcome = await getOrCreateDefaultComputer(ctx.db, { userId: ctx.user.id });

        if (!outcome.ok) {
            throw computerCreateError(outcome.reason);
        }

        return { computer: outcome.computer, created: outcome.created };
    }),

    /** Fetch a single computer by id. Ownership-scoped: never returns another user's row. */
    get: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .query(async ({ ctx, input }) => {
            const computer = await ctx.db.query.computers.findFirst({
                where: liveOwnedComputer(ctx.user.id, input.id),
            });

            if (!computer) {
                // NOT_FOUND (never a distinguishing FORBIDDEN) so a caller
                // cannot use the response code to probe for the existence
                // of another user's computer.
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return computer;
        }),

    /**
     * What Settings → System may say about the machine behind a computer: its
     * recorded provider, the configured size of that machine, and its lifecycle
     * state. READ ONLY — reads the placement, never creates or pins one (see
     * `server/lib/compute/system-info.ts`). Ownership-scoped twice: the live row
     * must be the caller's, and so must any recorded placement. Both misses are
     * NOT_FOUND, never FORBIDDEN.
     */
    systemInfo: protectedProcedure
        .input(z.object({ computerId: z.string().uuid() }))
        .query(async ({ ctx, input }) => {
            const owned = await ctx.db.query.computers.findFirst({
                where: liveOwnedComputer(ctx.user.id, input.computerId),
                columns: { id: true },
            });
            if (!owned) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            const info = await readSystemInfo(ctx.db as unknown as PlacementExecutor, { computerId: input.computerId, userId: ctx.user.id });
            if (!info) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            return info;
        }),

    /** Rename a computer. Ownership-scoped. */
    rename: protectedProcedure
        .input(
            z.object({
                id: z.string().uuid(),
                name: z.string().trim().min(1).max(200),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            const [updated] = await ctx.db
                .update(computers)
                .set({ name: input.name.trim() })
                .where(liveOwnedComputer(ctx.user.id, input.id))
                .returning();

            if (!updated) {
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return updated;
        }),

    /**
     * Stamp `lastOpenedAt = now()`. Called when the user opens a computer
     * into the EZiL OS desktop, so `list` can order/surface "recently used"
     * later.
     */
    touch: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
            const [updated] = await ctx.db
                .update(computers)
                .set({ lastOpenedAt: new Date() })
                .where(liveOwnedComputer(ctx.user.id, input.id))
                .returning();

            if (!updated) {
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return updated;
        }),

    /**
     * SOFT delete a computer, freeing its slot.
     *
     * Without this, a user who has created `MAX_COMPUTERS_PER_USER`
     * computers is permanently stuck: `create` refuses a third and nothing
     * can release a slot.
     *
     * Order matters and is enforced in `softDeleteComputer`: ownership check
     * -> terminate the sandbox (which flushes the workspace to R2 and only
     * then destroys the container) -> stamp `deleted_at`. Freeing the slot
     * falls out of the stamp via the partial unique index; nothing else is
     * written, and **no SQL DELETE is ever issued** — the row id IS the R2
     * workspace prefix, so removing the row would orphan the user's files
     * forever (see `./computer-store.ts`).
     */
    delete: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
            const computer = { userId: ctx.user.id, computerId: input.id };
            // P3: the provider this computer lives on. A foreign AWS placement is NOT_FOUND here.
            const routed = await routeComputer(ctx.db, computer);
            if (routed.kind === 'aws-ec2') await retireAwsComputerBeforeDelete(ctx.db, routed.provider, computer);
            const deleted = await softDeleteComputer(ctx.db, {
                userId: ctx.user.id,
                computerId: input.id,
                terminateSandbox: routed.kind === 'cloudflare'
                    ? () => terminateComputerSandbox(routed.provider, computer)
                    // Retired (and confirmed) above; there is no Cloudflare sandbox to tear down.
                    : async () => {},
            });

            if (!deleted) {
                // Missing, already deleted, or someone else's — one
                // indistinguishable NOT_FOUND, same anti-enumeration
                // contract as `get`.
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return deleted;
        }),
});
