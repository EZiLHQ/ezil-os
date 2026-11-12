import modelPolicy from '@/shared/ai-model-policy.json';
import { getBillingDeps } from '../deps';
import type { BillingDeps } from '../ports';
import { billingMeteringActive, loadComputeBillingState } from '../v2/compute-access';
import { CATALOG_V2, type PlanSku } from '../v2/contract';
import type { PlanSkuV3 } from './contract';

/** Free keeps its curated fallback set. Standard uses the actual registered lower-tier aliases; Max/Premium includes all.
 * An included alias does not enable a disabled Gateway model. New aliases stay outside Standard until explicitly reviewed.
 * Carbon is known but not registered; Fable has no confirmed alias and is not invented or registered here.
 */
export const FREE_AI_MODELS: readonly string[] = Object.freeze(['gemini-3.8-flash', 'qwen.qwen3-coder-next', 'us.moonshotai.kimi-k3']);
export const STANDARD_AI_MODELS: readonly string[] = Object.freeze([...modelPolicy.standardIncludedModels]);
export const PREMIUM_ONLY_AI_MODELS: readonly string[] = Object.freeze([...modelPolicy.premiumOnlyModels]);

/** The effective plan, including paid legacy tiers: only confirmed Max/Premium is unrestricted. */
export function aiIncludedModels(planSku: PlanSku | PlanSkuV3): readonly string[] | null {
    if (planSku === 'premium_monthly_v3') return null;
    if (planSku === 'standard_monthly_v3') return STANDARD_AI_MODELS;
    if (Object.hasOwn(CATALOG_V2, planSku)) return CATALOG_V2[planSku as PlanSku].family === 'free' ? FREE_AI_MODELS : STANDARD_AI_MODELS;
    return FREE_AI_MODELS;
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
