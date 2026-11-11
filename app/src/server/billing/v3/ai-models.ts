import { getBillingDeps } from '../deps';
import type { BillingDeps } from '../ports';
import { billingMeteringActive, loadComputeBillingState } from '../v2/compute-access';
import { CATALOG_V2, type PlanSku } from '../v2/contract';
import type { PlanSkuV3 } from './contract';

/**
 * The EZiL AI models a plan includes (founder decision 2026-11-09, widened 2026-11-11): Free includes Gemini 3.8
 * Flash plus two low-tier tool-calling fallbacks, so a new user can try a model when Flash is not available (it is
 * registered disabled on some Gateways). All spend Free's own credits (`CATALOG_V3.free_v3.aiCredits`); Standard and
 * Premium include every model the Gateway serves the account. No credit amount or price changes, and no higher
 * model or unrestricted policy is granted: at most 3 existing aliases, Flash first (Code's preferred default).
 * Listing an alias grants no availability: the Gateway's own per-model state still decides, and Code shows it.
 * The Worker's AI proxy enforces the list (worker/src/ai-proxy.ts: any other model is refused before the Gateway)
 * and Code shows the other models locked.
 */
export const FREE_AI_MODELS: readonly string[] = Object.freeze(['gemini-3.8-flash', 'qwen.qwen3-coder-next', 'us.moonshotai.kimi-k3']);

/** The models included by the plan a computer runs under: `null` is every model. */
export function aiIncludedModels(planSku: PlanSku | PlanSkuV3): readonly string[] | null {
    return planSku === 'free_v3' || CATALOG_V2[planSku as PlanSku]?.family === 'free' ? FREE_AI_MODELS : null;
}

/**
 * For the AI credential push: the owner's models from the same effective plan the computer start gate uses
 * (`loadComputeBillingState`: a plan without paid access, such as one past its payment grace, runs as Free).
 * Billing metering off: every model, as before this list existed. A failed read: `undefined`, so the Worker keeps
 * the list it has (it never widens on an error). Never throws.
 */
export async function aiIncludedModelsFor(userId: string, getDeps: () => BillingDeps = getBillingDeps): Promise<readonly string[] | null | undefined> {
    try {
        const deps = getDeps();
        if (!billingMeteringActive(deps.config)) return null;
        return aiIncludedModels((await loadComputeBillingState(deps, userId, deps.now())).planSku);
    } catch {
        console.warn('[billing.ai-models] plan read failed', { userId });
        return undefined;
    }
}
