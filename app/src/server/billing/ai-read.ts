import type { BillingConfig } from './config';
import { withAiTimeout } from './ai-gateway-client';

type Session = { access_token: string; user: { id: string } } | null;
export interface AiReadInput {
    config: Pick<BillingConfig, 'fundingUrl'>;
    /** Already authenticated by the normal Supabase tRPC context. */
    userId: string;
    headers: Headers;
    session?: () => Promise<Session>;
    fetch?: typeof fetch;
    signal?: AbortSignal;
}
export type AiReader = (path: string) => Promise<unknown>;

export function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** JSON numbers must already be exact. Decimal strings retain all microcredits. */
export function microString(value: unknown): string | null {
    if (typeof value === 'number') return count(value) === null ? null : String(value);
    return typeof value === 'string' && /^\d{1,100}$/.test(value) ? BigInt(value).toString() : null;
}

export function creditNumber(micro: string | null): number | null {
    if (micro === null) return null;
    const n = BigInt(micro);
    const decimal = `${n / BigInt(1_000_000)}.${String(n % BigInt(1_000_000)).padStart(6, '0')}`;
    const credits = Number(decimal);
    // When a Number would lose a microcredit, the exact string remains usable.
    return Number.isFinite(credits) && credits <= Number.MAX_SAFE_INTEGER && credits.toFixed(6) === decimal ? credits : null;
}

export function isoTimestamp(value: unknown): string | null {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
        ? new Date(value).toISOString() : null;
}

async function currentSession(): Promise<Session> {
    const { createClient } = await import('@/utils/supabase/server');
    const { data, error } = await (await createClient()).auth.getSession();
    return error ? null : data.session;
}

/** Request-local credential capture; never cache a user's token between requests. */
export function createAiReader(input: AiReadInput): AiReader {
    let token: Promise<string | null> | undefined;
    const credential = () => token ??= (async () => {
        const authorization = input.headers.get('authorization');
        if (authorization !== null) return /^Bearer[ \t]+([^\s,]+)$/i.exec(authorization.trim())?.[1] ?? null;
        const session = await (input.session ?? currentSession)();
        return session?.user.id === input.userId ? session.access_token : null;
    })();
    return async path => {
        if (!input.config.fundingUrl || input.signal?.aborted) return null;
        const canceled = new AbortController();
        let abort: (() => void) | undefined;
        try {
            const origin = new URL(input.config.fundingUrl);
            if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) return null;
            return await withAiTimeout(3_000, async timeout => {
                const signal = AbortSignal.any([timeout, canceled.signal]);
                const operation = (async () => {
                    const bearer = await credential();
                    if (!bearer || signal.aborted) return null;
                    const response = await (input.fetch ?? fetch)(`${origin.href.replace(/\/$/, '')}${path}`, {
                        method: 'GET', redirect: 'error', cache: 'no-store', signal,
                        headers: { Authorization: `Bearer ${bearer}` },
                    });
                    return response.ok ? await response.json() : null;
                })();
                if (!input.signal) return await operation;
                return await Promise.race([operation, new Promise<null>(resolve => {
                    abort = () => { canceled.abort(); resolve(null); };
                    input.signal!.addEventListener('abort', abort, { once: true });
                    if (input.signal!.aborted) abort();
                })]);
            });
        } catch { return null; }
        finally {
            canceled.abort();
            if (abort) input.signal?.removeEventListener('abort', abort);
        }
    };
}
