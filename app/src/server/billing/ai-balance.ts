import type { BillingConfig } from './config';
import type { BillingStore } from './ports';
import type { BillingSummaryV3 } from './v3/contract';
import { aiCreditEntitlement, aiCreditOutboxItem } from './ai-credits';
import { withAiTimeout } from './ai-gateway-client';

/** Gateway test/app.test.ts exposes available_micro (1 credit = 1,000,000 microcredits). */
export function parseAiBalance(body: unknown): number | null {
    if (!body || typeof body !== 'object') return null;
    const value = body as Record<string, unknown>;
    if ('available_micro' in value) {
        const micro = value.available_micro;
        if (!(typeof micro === 'string' && /^\d+$/.test(micro))
            && !(typeof micro === 'number' && Number.isSafeInteger(micro) && micro >= 0)) return null;
        const credits = Number(BigInt(micro as string | number) / BigInt(1_000_000));
        return Number.isSafeInteger(credits) ? credits : null;
    }
    return typeof value.credits === 'number' && Number.isSafeInteger(value.credits) && value.credits >= 0 ? value.credits : null;
}

export function aiBalanceState(balance: number | null, grant: number): BillingSummaryV3['ai']['state'] {
    return balance === null ? 'unavailable' : balance === 0 ? 'exhausted' : balance <= grant * 0.1 ? 'low' : 'ok';
}

type Session = { access_token: string; user: { id: string } } | null;
async function currentSession(): Promise<Session> {
    const { createClient } = await import('@/utils/supabase/server');
    const { data, error } = await (await createClient()).auth.getSession();
    return error ? null : data.session;
}

/** ctx.user has already been authenticated; a cookie session must still match that user. */
export async function readAiBalance(input: {
    config: Pick<BillingConfig, 'fundingUrl'>; userId: string; headers: Headers;
    session?: () => Promise<Session>; fetch?: typeof fetch;
}): Promise<number | null> {
    if (!input.config.fundingUrl) return null;
    try {
        return await withAiTimeout(3_000, async signal => {
            const authorization = input.headers.get('authorization');
            let token: string | undefined;
            if (authorization !== null) token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
            else {
                const session = await (input.session ?? currentSession)();
                if (session?.user.id === input.userId) token = session.access_token;
            }
            if (!token || signal.aborted) return null;
            const response = await (input.fetch ?? fetch)(`${input.config.fundingUrl!.replace(/\/$/, '')}/v1/me/balance`, {
                method: 'GET', redirect: 'error', signal, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
            });
            return response.ok ? parseAiBalance(await response.json()) : null;
        });
    } catch { return null; }
}

export async function enqueueFreeAiCredits(store: Pick<BillingStore, 'enqueueOutbox'>, userId: string, sku: string, now: Date): Promise<void> {
    if (sku !== 'free_v3') return;
    try {
        const entitlement = aiCreditEntitlement({ userId, sku, subscriptionId: null, periodStart: now, periodEnd: null, invoiceId: null });
        // ON CONFLICT DO NOTHING preserves the first grant instant and expiry across summary reads.
        await store.enqueueOutbox(aiCreditOutboxItem(userId, entitlement, 'grant', null));
    } catch { console.warn('[billing.ai] free grant enqueue unavailable'); }
}
