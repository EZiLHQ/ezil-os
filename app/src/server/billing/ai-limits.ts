import { count, createAiReader, microString, record, type AiReadInput, type AiReader } from './ai-read';

export interface AiPolicy {
    rpm: number | null; tpm: number | null; concurrency: number | null; maxOutputTokens: number | null;
    dailyBudgetMicro: string | null; monthlyBudgetMicro: string | null; allowedModels: string[] | null;
}
export type PauseScope = 'user' | 'account' | 'role' | 'model' | 'client';
export interface AiLimits {
    policy: AiPolicy | null;
    models: Record<string, AiPolicy> | null;
    ceilings: { rpm: number | null; concurrency: number | null } | null;
    counters: { rpm: number | null; tpm: number | null; inflight: number | null; pending: number | null;
        openMicro: string | null; dayMicro: string | null; monthMicro: string | null } | null;
    pauses: { scope: PauseScope }[] | null;
    entitlement: { required: boolean; basis: 'subscription' | 'entitlement_grant' | 'operations' | 'not_required' | null } | null;
}
export interface AiLimitsResult { state: 'available' | 'unavailable'; limits: AiLimits | null; }

function policy(value: unknown): AiPolicy | null {
    const wrapper = record(value), p = record(wrapper?.policy);
    if (!p || wrapper?.ambiguous === true) return null;
    return { rpm: count(p.rpm), tpm: count(p.tpm), concurrency: count(p.concurrency), maxOutputTokens: count(p.max_output_tokens),
        dailyBudgetMicro: microString(p.daily_budget_micro), monthlyBudgetMicro: microString(p.monthly_budget_micro),
        allowedModels: Array.isArray(p.allowed_models) && p.allowed_models.every(m => typeof m === 'string' && /^[\w.-]{1,128}$/.test(m))
            ? p.allowed_models : null };
}

export function parseAiLimits(body: unknown): AiLimitsResult {
    const b = record(body);
    if (!b || !['policy', 'models', 'ceilings', 'counters', 'pauses', 'entitlement'].some(key => key in b)) {
        return { state: 'unavailable', limits: null };
    }
    const ceilings = record(b.ceilings), counters = record(b.counters), entitlement = record(b.entitlement), models = record(b.models);
    const modelPolicies: Record<string, AiPolicy> = Object.create(null);
    if (models) for (const [name, value] of Object.entries(models)) {
        const parsed = policy(value);
        if (/^[\w.-]{1,128}$/.test(name) && parsed) modelPolicies[name] = parsed;
    }
    const limits: AiLimits = {
        policy: policy(b.policy), models: models ? modelPolicies : null,
        ceilings: ceilings ? { rpm: count(ceilings.rpm), concurrency: count(ceilings.concurrency) } : null,
        counters: counters ? { rpm: count(counters.rpm), tpm: count(counters.tpm), inflight: count(counters.inflight), pending: count(counters.pending),
            openMicro: microString(counters.open_micro), dayMicro: microString(counters.day_micro), monthMicro: microString(counters.month_micro) } : null,
        pauses: Array.isArray(b.pauses) && b.pauses.every(p => typeof record(p)?.scope === 'string'
            && ['user', 'account', 'role', 'model', 'client'].includes(record(p)!.scope as string))
            ? b.pauses.map(p => ({ scope: (p as { scope: PauseScope }).scope })) : null,
        entitlement: entitlement && typeof entitlement.required === 'boolean'
            && (entitlement.basis === null || (typeof entitlement.basis === 'string'
                && ['subscription', 'entitlement_grant', 'operations', 'not_required'].includes(entitlement.basis)))
            ? { required: entitlement.required, basis: entitlement.basis as NonNullable<AiLimits['entitlement']>['basis'] } : null,
    };
    return Object.values(limits).some(v => v !== null) ? { state: 'available', limits } : { state: 'unavailable', limits: null };
}

export async function readAiLimits(input: AiReadInput, read: AiReader = createAiReader(input)): Promise<AiLimitsResult> {
    return parseAiLimits(await read('/v1/me/limits'));
}
