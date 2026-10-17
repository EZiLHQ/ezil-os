import type { Plan } from './shapes';

export interface EntitlementSource {
    getPlan(userId: string): Promise<{ plan: Plan; periodEnd: string | null }>;
}

type PlanResult = Awaited<ReturnType<EntitlementSource['getPlan']>>;
const free = (): PlanResult => ({ plan: 'free', periodEnd: null });

export function activePlan(value: PlanResult, now = Date.now()): Plan {
    return value.plan === 'subscriber' && value.periodEnd !== null && Date.parse(value.periodEnd) > now
        ? 'subscriber' : 'free';
}

export async function getActivePlan(source: EntitlementSource, userId: string): Promise<Plan> {
    try {
        return activePlan(await source.getPlan(userId));
    } catch {
        return 'free';
    }
}

export type HttpEntitlementOptions = {
    baseUrl?: string;
    /** Must resolve the authenticated user's token, never a shared service token. */
    getAccessToken?: (userId: string) => Promise<string | null>;
    fetch?: typeof fetch;
    now?: () => number;
};

/** Unconfigured by default. The gateway's /me identity comes from its bearer token. */
export class HttpEntitlementSource implements EntitlementSource {
    constructor(private readonly options: HttpEntitlementOptions = {}) {}

    async getPlan(userId: string): Promise<PlanResult> {
        try {
            if (!userId || !this.options.baseUrl || !this.options.getAccessToken) return free();
            const token = await this.options.getAccessToken(userId);
            if (!token) return free();
            const response = await (this.options.fetch ?? fetch)(new URL('/v1/me/plan', this.options.baseUrl), {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                cache: 'no-store',
                redirect: 'error',
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) return free();
            const body: unknown = await response.json();
            if (!body || typeof body !== 'object' || !('plan' in body) || !('periodEnd' in body)) return free();
            if (body.plan !== 'subscriber' || typeof body.periodEnd !== 'string') return free();
            const result: PlanResult = { plan: 'subscriber', periodEnd: body.periodEnd };
            return activePlan(result, (this.options.now ?? Date.now)()) === 'subscriber' ? result : free();
        } catch {
            return free();
        }
    }
}
