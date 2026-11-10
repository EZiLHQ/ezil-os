import { getBillingDeps } from '../deps';
import type { BillingDeps } from '../ports';
import { loadComputeBillingState } from '../v2/compute-access';
import { CATALOG_V2, type PlanSku } from '../v2/contract';
import { CATALOG_V3, type PlanSkuV3 } from './contract';

/**
 * The EZiL AI models a plan includes (founder decision 2026-11-09): Free includes Gemini 3.8 Flash only, which
 * spends Free's own credits (`CATALOG_V3.free_v3.aiCredits`); Standard and Premium include every model the Gateway
 * serves the account. No credit amount or price changes. The Worker's AI proxy enforces the list
 * (worker/src/ai-proxy.ts: any other model is refused before the Gateway) and Code shows the other models locked.
 */
export const FREE_AI_MODELS: readonly string[] = Object.freeze(['gemini-3.8-flash']);

/** The models included by a recognized plan: `null` is every model; unknown SKUs never widen access. */
export function aiIncludedModels(planSku: PlanSku | PlanSkuV3): readonly string[] | null | undefined {
    if (!Object.hasOwn(CATALOG_V2, planSku) && !Object.hasOwn(CATALOG_V3, planSku)) return undefined;
    return planSku === 'free_v3' || CATALOG_V2[planSku as PlanSku]?.family === 'free' ? FREE_AI_MODELS : null;
}

/**
 * For the AI credential push: the owner's models from the same effective plan the computer start gate uses
 * (`loadComputeBillingState`: a plan without paid access, such as one past its payment grace, runs as Free).
 * Model policy is independent of compute metering flags: always resolve the owner's effective plan.
 * A failed read: `undefined`, so the Worker keeps the list only until its original expiry. Never throws.
 */
export async function aiIncludedModelsFor(userId: string, getDeps: () => BillingDeps = getBillingDeps): Promise<readonly string[] | null | undefined> {
    try {
        const deps = getDeps();
        return aiIncludedModels((await loadComputeBillingState(deps, userId, deps.now())).planSku);
    } catch {
        console.warn('[billing.ai-models] plan read failed', { userId });
        return undefined;
    }
}
