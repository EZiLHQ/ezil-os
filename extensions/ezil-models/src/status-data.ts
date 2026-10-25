import type { ResolvedProvider } from './config';

type Result<T> = { value: T; code?: never } | { value?: never; code: string };
export type CreditWindow = { seconds: number; budget_micro: string; used_micro: string; remaining_micro: string; started_at: string | null; resets_at: string | null };
export type Balance = { available_micro: number; held_micro: number; window?: CreditWindow | null };
export type UsageRow = { model: string; created_at: string; status: string; cost_micro: number | null; uncollected_micro: number | null };
export type AIStatus = { balance: Result<Balance>; usage: Result<UsageRow[]> };
export const AI_NOTICE = 'AI responses may be inaccurate. Review changes before applying them.';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const micro = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function credits(value: number | string): string {
    if (typeof value === 'number') return (value / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6 });
    // Window amounts are decimal strings; retain all six places even beyond Number's safe range.
    const amount = BigInt(value);
    const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return (amount / 1_000_000n).toLocaleString('en-US') + (fraction ? `.${fraction}` : '');
}

export const localResetTime = (date: string | Date): string => new Date(date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const windowLength = (seconds: number): string => seconds % 3600 === 0 ? `${seconds / 3600}-hour` : seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`;
const decimalMicro = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
const timestamp = (value: unknown): value is string | null => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

function parseBalance(value: unknown): Balance | undefined {
    if (!record(value) || !micro(value.available_micro) || !micro(value.held_micro)) return undefined;
    const window = value.window;
    if (window !== undefined && window !== null && (!record(window)
        || !Number.isInteger(window.seconds) || (window.seconds as number) < 600 || (window.seconds as number) > 86400
        || !decimalMicro(window.budget_micro) || !decimalMicro(window.used_micro) || !decimalMicro(window.remaining_micro)
        || !timestamp(window.started_at) || !timestamp(window.resets_at))) return undefined;
    return { available_micro: value.available_micro, held_micro: value.held_micro, window: window as CreditWindow | null | undefined };
}

async function get<T>(provider: ResolvedProvider, path: string, parse: (value: unknown) => T | undefined, doFetch: typeof fetch, signal?: AbortSignal): Promise<Result<T>> {
    const timeout = AbortSignal.timeout(5_000);
    try {
        const response = await doFetch(`${provider.baseUrl!.replace(/\/+$/, '')}${path}`, {
            method: 'GET', headers: { authorization: `Bearer ${provider.apiKey ?? ''}` },
            redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
            const code = record(body) && record(body.error) && typeof body.error.code === 'string' && /^[a-z0-9_]{1,64}$/.test(body.error.code) ? body.error.code : `http_${response.status}`;
            return { code };
        }
        const value = parse(body);
        return value === undefined ? { code: 'invalid_response' } : { value };
    } catch {
        return { code: timeout.aborted ? 'request_timeout' : signal?.aborted ? 'request_cancelled' : 'network_error' };
    }
}

export async function readAIStatus(provider: ResolvedProvider | undefined, doFetch: typeof fetch = fetch, signal?: AbortSignal): Promise<AIStatus> {
    if (provider?.type !== 'ezil-gateway' || !provider.baseUrl) return { balance: { code: 'not_configured' }, usage: { code: 'not_configured' } };
    const [balance, usage] = await Promise.all([
        get(provider, '/me/balance', parseBalance, doFetch, signal),
        get(provider, '/me/usage?limit=5', value => {
            if (!record(value) || !Array.isArray(value.data) || value.data.some(row => !record(row)
                || typeof row.model !== 'string' || typeof row.created_at !== 'string' || typeof row.status !== 'string'
                || !(row.cost_micro === null || micro(row.cost_micro))
                || !(row.uncollected_micro === null || micro(row.uncollected_micro))
                || (micro(row.cost_micro) && (!micro(row.uncollected_micro) || row.uncollected_micro > row.cost_micro)))) return undefined;
            return value.data.slice(0, 5) as UsageRow[];
        }, doFetch, signal),
    ]);
    return { balance, usage };
}

/** Plain text only; callers must not interpret Gateway fields as Markdown or HTML. */
export function statusView(state?: AIStatus): { text: string; lines: string[] } {
    if (!state) return { text: 'EZiL AI · Loading…', lines: ['EZiL AI', 'Loading credits and recent usage…', AI_NOTICE] };
    const balance = state.balance.value;
    const window = balance?.window;
    const reset = window?.resets_at ? localResetTime(window.resets_at) : undefined;
    const text = window ? `EZiL AI · ${credits(window.remaining_micro)} credits left${reset ? ` · resets ${reset}` : ''}`
        : balance ? `EZiL AI · ${credits(balance.available_micro)} credits` : `EZiL AI · ${state.balance.code}`;
    const lines = ['EZiL AI', balance ? `Available credits: ${credits(balance.available_micro)}` : `Credits unavailable (${state.balance.code})`];
    if (balance) lines.push(`Held credits: ${credits(balance.held_micro)}`);
    if (window) {
        lines.push(`${windowLength(window.seconds)} window: ${credits(window.remaining_micro)} credits left of ${credits(window.budget_micro)}`);
        lines.push(`Window used (held + settled): ${credits(window.used_micro)} credits`);
        lines.push(reset ? `Resets at ${reset} (local time)` : 'Window starts with your next admitted request.');
    }
    lines.push('Recent usage (up to 5 requests)');
    if (state.usage.value) {
        if (!state.usage.value.length) lines.push('No recent usage.');
        for (const row of state.usage.value) lines.push(`${row.created_at} · ${row.model} · ${row.status} · ${row.cost_micro === null ? 'charge pending' : `${credits(row.cost_micro - row.uncollected_micro!)} credits`}`);
    } else lines.push(`Usage unavailable (${state.usage.code})`);
    lines.push(AI_NOTICE);
    return { text, lines };
}
