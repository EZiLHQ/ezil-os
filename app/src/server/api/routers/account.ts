import { asc } from 'drizzle-orm';
import { z } from 'zod';

import { getBillingDeps } from '@/server/billing/deps';
import { loadComputeBillingState } from '@/server/billing/v2/compute-access';
import { waitingCredits } from '@/server/billing/v3/summary';
import { computers } from '@/server/db/schema';

import { ACCOUNT_SETTINGS_PROCEDURE, requireOnboardingCaller } from '../onboarding-delegation';
import { createTRPCRouter, protectedProcedure } from '../trpc';
import { liveComputersOf, MAX_COMPUTERS_PER_USER } from './computer-store';

export const accountRouter = createTRPCRouter({
    mcpSettings: protectedProcedure.input(z.object({}).strict()).query(async ({ ctx }) => {
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
        return {
            account: { id: userId },
            computers: owned,
            entitlements: {
                planSku: billing?.planSku ?? null,
                allowedComputerSizes: !billing ? null
                    : billing.summary.version === 3 ? billing.summary.computer.machineChoice.map(option => option.size)
                    : [billing.entitledSize],
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
            // The OS assertion is scoped to OS. The Gateway balance reader requires
            // the owner's Gateway credential, which this delegation does not carry.
            credits: {
                state: 'unavailable' as const,
                balanceMicro: null,
                heldMicro: null,
                pendingDeliveryCredits: receipts === null ? null : waitingCredits(receipts, now)?.credits ?? 0,
            },
        };
    }),
});
