import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { getActivePlan, HttpEntitlementSource, type EntitlementSource } from '@/server/lib/pool/entitlement-source';
import { assertShapeEligible, ShapeEligibilityError, shapesForPlan } from '@/server/lib/pool/shapes';
import { createTRPCRouter, protectedProcedure } from '../trpc';

export function createComputeRouter(entitlements: EntitlementSource = new HttpEntitlementSource()) {
    return createTRPCRouter({
        shapes: protectedProcedure.query(async ({ ctx }) => shapesForPlan(await getActivePlan(entitlements, ctx.user.id))),
        // Validation only: start/claim must recheck the plan; this grants no durable entitlement.
        requestShape: protectedProcedure.input(z.object({ shape: z.enum(['standard', 'performance']) }).strict())
            .mutation(async ({ ctx, input }) => {
                const plan = await getActivePlan(entitlements, ctx.user.id);
                try {
                    return assertShapeEligible(input.shape, plan);
                } catch (error) {
                    if (error instanceof ShapeEligibilityError) {
                        throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
                    }
                    throw error;
                }
            }),
    });
}

export const computeRouter = createComputeRouter();
