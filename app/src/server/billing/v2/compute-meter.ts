import { getBillingDeps } from '../deps';
import type { BillingDeps } from '../ports';
import { billingMeteringActive, openComputeEpochAtReady } from './compute-access';
import type { EpochEndReason, SizeCode } from './contract';
import { epochSeconds } from './time';

export interface ComputeMeter {
    ready(input: { userId: string; computerId: string; size: SizeCode; readyAt: Date; overheadSeconds: number }): Promise<void>;
    stopped(input: { userId: string; computerId: string; endedAt: Date; reason: EpochEndReason; overheadSeconds?: number }): Promise<void>;
    heartbeat(input: { userId: string; computerId: string; at: Date }): Promise<void>;
}

export const noopComputeMeter: ComputeMeter = {
    async ready() {},
    async stopped() {},
    async heartbeat() {},
};

export function billingComputeMeter(getDeps: () => BillingDeps = getBillingDeps): ComputeMeter {
    return {
        async ready(input) {
            try {
                const deps = getDeps();
                if (!billingMeteringActive(deps.config)) return;
                const result = await openComputeEpochAtReady({ deps, ...input });
                if (result === 'error') console.warn('[billing.meter] ready failed', { computerId: input.computerId });
            } catch (error) {
                console.warn('[billing.meter] ready failed', { computerId: input.computerId, error });
            }
        },
        async stopped(input) {
            try {
                const deps = getDeps();
                if (!billingMeteringActive(deps.config)) return;
                await deps.store.closeEpoch({
                    computerId: input.computerId, endedAt: new Date(epochSeconds(input.endedAt) * 1000),
                    reason: input.reason, overheadSeconds: input.overheadSeconds,
                });
            } catch (error) {
                console.warn('[billing.meter] stopped failed', { computerId: input.computerId, error });
            }
        },
        async heartbeat(input) {
            try {
                const deps = getDeps();
                if (!billingMeteringActive(deps.config)) return;
                await deps.store.touchEpoch(input.computerId, input.at);
            } catch (error) {
                console.warn('[billing.meter] heartbeat failed', { computerId: input.computerId, error });
            }
        },
    };
}
