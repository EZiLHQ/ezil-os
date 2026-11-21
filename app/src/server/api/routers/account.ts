import { asc } from 'drizzle-orm';
import { z } from 'zod';

import { getBillingDeps } from '@/server/billing/deps';
import type { SizeCode } from '@/server/billing/v2/contract';
import { loadComputeBillingState } from '@/server/billing/v2/compute-access';
import { waitingCredits } from '@/server/billing/v3/summary';
import { computers } from '@/server/db/schema';
import type { PlacementDb } from '@/server/lib/compute/placement';

import { ACCOUNT_SETTINGS_PROCEDURE, requireOnboardingCaller } from '../onboarding-delegation';
import { completeMcpConnection, mcpIdentityProof } from '../mcp-identity-bootstrap';
import {
    allowedComputerSizes, applySetting, requireSettingsWriteCaller, SETTINGS_WRITE_PROCEDURE, settingsWriteInput,
} from '../settings-write-delegation';
import { controlCall } from '../control-call';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc';
import { readSettingsAiBalance } from './account-ai-balance';
import { liveComputersOf, MAX_COMPUTERS_PER_USER } from './computer-store';

export const accountRouter = createTRPCRouter({
    completeMcpConnection: publicProcedure.input(mcpIdentityProof).mutation(({ ctx, input }) => completeMcpConnection(ctx, input)),
    /**
     * The EZiL MCP `set_setting` (`ezil:settings:write`): a rename, a size within the allowed sizes, or the link that
     * confirms a plan change. The gate runs before the input is read; billing is never previewed, confirmed or written.
     */
    mcpSetSetting: protectedProcedure
        .use(({ ctx, next }) => {
            requireSettingsWriteCaller(ctx);
            return next();
        })
        .input(settingsWriteInput)
        .mutation(({ ctx, input }) => controlCall(ctx, SETTINGS_WRITE_PROCEDURE, input.idempotencyKey, () => applySetting({
            db: ctx.db,
            allowedSizes: async () => {
                const deps = getBillingDeps();
                return allowedComputerSizes(await loadComputeBillingState(deps, ctx.user.id, deps.now()).catch(() => null));
            },
            switchSize: async (computerId, size, requestId) => {
                // Loaded on use: dispatch pulls in the providers, which validate the server env at import.
                const { switchComputerConfiguration } = await import('./compute-dispatch');
                return switchComputerConfiguration(ctx.db as unknown as PlacementDb, { userId: ctx.user.id, computerId },
                    { size: size as SizeCode, requestId });
            },
        }, ctx.user.id, input))),
    mcpSettings: protectedProcedure.input(z.object({}).strict()).query(async ({ ctx, signal }) => {
        requireOnboardingCaller(ctx, ACCOUNT_SETTINGS_PROCEDURE);
        const userId = ctx.user.id;
        const deps = getBillingDeps();
        const now = deps.now();
        const [owned, billing, receipts] = await Promise.all([
            ctx.db.query.computers.findMany({
                where: liveComputersOf(userId),
                columns: { id: true, name: true, slot: true },
                orderBy: asc(computers.slot),
                limit: MAX_COMPUTERS_PER_USER,
            }),
            loadComputeBillingState(deps, userId, now).catch(() => null),
            deps.aiCredits?.receiptsFor?.(userId).catch(() => null) ?? null,
        ]);
        const pendingDeliveryCredits = receipts === null ? null : waitingCredits(receipts, now)?.credits ?? 0;
        const observedBalance = await readSettingsAiBalance(ctx.db, userId, owned.map(computer => computer.id), signal);
        const balance = observedBalance?.balanceMicro === '0' && (pendingDeliveryCredits ?? 0) > 0
            ? null : observedBalance;
        return {
            account: { id: userId },
            computers: owned,
            entitlements: {
                planSku: billing?.planSku ?? null,
                allowedComputerSizes: allowedComputerSizes(billing),
            },
            usage: {
                compute: billing && {
                    startsAt: billing.window.start,
                    resetsAt: billing.window.end,
                    usedStandardSeconds: billing.usedStdSeconds,
                    allowanceStandardSeconds: billing.allowanceStdSeconds,
                    remainingStandardSeconds: Math.max(0, billing.allowanceStdSeconds - billing.usedStdSeconds),
                },
            },
            credits: {
                state: balance ? 'available' as const : 'unavailable' as const,
                balanceMicro: balance?.balanceMicro ?? null,
                heldMicro: balance?.heldMicro ?? null,
                pendingDeliveryCredits,
            },
        };
    }),
});
