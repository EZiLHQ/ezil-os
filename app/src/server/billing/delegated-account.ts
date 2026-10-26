import 'server-only';

/** Customer delegation v1.1. Gateway alone verifies the Auth0 RFC 9068 access proof. */
export type DelegationEnvironment = 'staging' | 'production';
export interface VerifiedDelegatedAccount {
    environment: DelegationEnvironment;
    identity: { issuer: string; subject: string; account_public_id: string };
    wallet: {
        state: 'ok' | 'exhausted' | 'paused_reconciliation' | 'paused_operations';
        available_micro: string;
        held_micro: string;
    };
}

export interface DelegatedAccountConfig {
    fundingUrl?: string;
    serviceToken?: string;
    policyId?: string;
    environment: DelegationEnvironment;
    /** Exact OS local Supabase auth namespace; never inferred from a customer token. */
    supabaseIssuer?: string;
    /** Production is disabled unless composition explicitly pins both values. */
    production?: { fundingUrl: string; supabaseIssuer: string };
}

export interface DelegatedAccountDeps {
    config: DelegatedAccountConfig;
    fetch?: typeof fetch;
    now?: () => Date;
    /** Tests may shorten, but never extend, the total exchange + self-read deadline. */
    timeoutMs?: number;
}

export type DelegatedAccountResult = { ok: true; account: VerifiedDelegatedAccount }
    | { ok: false; status: 401; error: 'delegated_auth_required' }
    | { ok: false; status: 503; error: 'delegated_account_unavailable' };

const STAGING_ORIGIN = 'https://ai-staging.ezil.work';
const LEGACY_PRODUCTION_ISSUER = 'https://btgqfmnzycdecmeyqubx.supabase.co/auth/v1';
const TOTAL_DEADLINE_MS = 3_000;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_RESPONSE_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MICRO = /^\d{1,100}$/;
const unavailable = (): DelegatedAccountResult => ({ ok: false, status: 503, error: 'delegated_account_unavailable' });

function origin(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2_048) return null;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port
            && parsed.origin === value ? value : null;
    } catch { return null; }
}

function issuer(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2_048) return null;
    try {
        const parsed = new URL(value);
        return origin(parsed.origin) !== null && parsed.href === value && parsed.pathname === '/auth/v1'
            && !parsed.search && !parsed.hash && !parsed.username && !parsed.password && !parsed.port ? value : null;
    } catch { return null; }
}

/** Server-only seam pending the lead's shared config wiring; no credential defaults. */
export function readDelegatedAccountConfig(env: Record<string, string | undefined> = process.env): DelegatedAccountConfig {
    const localOrigin = origin(env.NEXT_PUBLIC_SUPABASE_URL);
    return {
        fundingUrl: env.BILLING_FUNDING_URL,
        serviceToken: env.BILLING_AI_READ_SERVICE_TOKEN,
        policyId: env.BILLING_AI_READ_POLICY_ID,
        environment: 'staging',
        supabaseIssuer: localOrigin === null ? undefined : `${localOrigin}/auth/v1`,
    };
}

function configured(config: DelegatedAccountConfig): config is DelegatedAccountConfig & {
    fundingUrl: string; serviceToken: string; policyId: string; supabaseIssuer: string;
} {
    if (!origin(config.fundingUrl) || !issuer(config.supabaseIssuer)
        || typeof config.serviceToken !== 'string' || config.serviceToken.length > MAX_TOKEN_LENGTH
        || !/^ezs_[A-Za-z0-9_-]+$/.test(config.serviceToken)
        || typeof config.policyId !== 'string' || !UUID.test(config.policyId)) return false;
    if (config.environment === 'staging') return config.fundingUrl === STAGING_ORIGIN
        && config.supabaseIssuer !== LEGACY_PRODUCTION_ISSUER;
    return config.environment === 'production' && config.fundingUrl !== STAGING_ORIGIN
        && config.production !== undefined && config.production.fundingUrl === config.fundingUrl
        && config.production.supabaseIssuer === config.supabaseIssuer;
}

function objectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function expiry(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!parts || (parts[2] !== 'Z' && (Number(parts[3]) > 23 || Number(parts[4]) > 59))) return null;
    // Validate the local calendar separately: Date.parse normalizes February 30 and 24:00.
    const calendar = new Date(`${parts[1]}Z`);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString() !== `${parts[1]}.000Z`) return null;
    // PostgreSQL emits timezone offsets and microseconds. Keep accepting its ISO wire form;
    // sub-millisecond truncation expires conservatively, never extending the grant's validity.
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
}

function cancelBody(response: Response): void {
    // Cancellation itself is not allowed to extend the caller's deadline.
    try { void response.body?.cancel().catch(() => undefined); } catch { /* already locked/closed */ }
}

/** Bound decoded bytes while streaming; Content-Length is only an early rejection. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (response.redirected || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')
        || response.body === null) {
        cancelBody(response);
        throw new Error('delegation_unavailable');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
        cancelBody(response);
        throw new Error('delegation_unavailable');
    }
    const reader = response.body.getReader();
    const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* closed */ } };
    signal.addEventListener('abort', cancel, { once: true });
    let complete = false;
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0, text = '';
        while (true) {
            if (signal.aborted) throw new Error('delegation_unavailable');
            const chunk = await reader.read();
            if (signal.aborted) throw new Error('delegation_unavailable');
            if (chunk.done) { complete = true; break; }
            bytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new Error('delegation_unavailable');
            text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text) as unknown;
    } finally {
        signal.removeEventListener('abort', cancel);
        if (!complete) cancel();
        reader.releaseLock();
    }
}

function verifiedSelf(value: unknown, config: DelegatedAccountConfig): VerifiedDelegatedAccount | null {
    if (!objectWithKeys(value, ['object', 'environment', 'identity', 'wallet'])
        || value.object !== 'delegated_self' || value.environment !== config.environment
        || !objectWithKeys(value.identity, ['issuer', 'subject', 'account_public_id'])
        || value.identity.issuer !== config.supabaseIssuer
        || typeof value.identity.subject !== 'string' || !UUID.test(value.identity.subject)
        || typeof value.identity.account_public_id !== 'string' || !UUID.test(value.identity.account_public_id)
        || !objectWithKeys(value.wallet, ['state', 'available_micro', 'held_micro'])
        || !['ok', 'exhausted', 'paused_reconciliation', 'paused_operations'].includes(value.wallet.state as string)
        || typeof value.wallet.available_micro !== 'string' || !MICRO.test(value.wallet.available_micro)
        || typeof value.wallet.held_micro !== 'string' || !MICRO.test(value.wallet.held_micro)) return null;
    // A contradictory exhaustion state is not a canonical account snapshot.
    const empty = BigInt(value.wallet.available_micro) === BigInt(0);
    if ((value.wallet.state === 'ok' && empty) || (value.wallet.state === 'exhausted' && !empty)) return null;
    return {
        environment: config.environment,
        identity: { issuer: config.supabaseIssuer!, subject: value.identity.subject, account_public_id: value.identity.account_public_id },
        wallet: { state: value.wallet.state as VerifiedDelegatedAccount['wallet']['state'],
            available_micro: value.wallet.available_micro, held_micro: value.wallet.held_micro },
    };
}

/**
 * No cookies, identity-claim decoding, provisioning, local lookups or cross-user selectors.
 * The configured service policy must be user-funded with endpoints exactly ['billing_read'];
 * Gateway enforces that policy and API audience urn:ezil:account-api:staging or
 * urn:ezil:account-api:production. C1 operator ID tokens are a separate flow.
 */
export async function verifiedDelegatedAccount(request: Request, deps: DelegatedAccountDeps): Promise<DelegatedAccountResult> {
    const authorization = request.headers.get('authorization');
    const bearer = authorization !== null && authorization.length <= MAX_TOKEN_LENGTH + 7
        ? /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization)?.[1] : undefined;
    if (!bearer || bearer.length > MAX_TOKEN_LENGTH) return { ok: false, status: 401, error: 'delegated_auth_required' };
    // Capture trusted configuration per request, just as the proof and grant are request-local.
    const config = { ...deps.config, production: deps.config.production ? { ...deps.config.production } : undefined };
    if (request.signal.aborted || !configured(config)) return unavailable();
    const timeout = deps.timeoutMs ?? TOTAL_DEADLINE_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > TOTAL_DEADLINE_MS) return unavailable();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); reject(new Error('delegation_unavailable')); };
        request.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, timeout);
        if (request.signal.aborted) abort();
    });
    const clock = deps.now ?? (() => new Date());
    const now = () => clock().getTime();
    const fetcher = deps.fetch ?? fetch;
    const send = async (path: string, init: RequestInit, status: number): Promise<unknown> => {
        if (controller.signal.aborted) throw new Error('delegation_unavailable');
        const url = `${config.fundingUrl}${path}`;
        const response = await fetcher(url, {
            ...init, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
        });
        if (controller.signal.aborted || response.status !== status || response.redirected
            || (response.url !== '' && response.url !== url)) {
            cancelBody(response);
            throw new Error('delegation_unavailable');
        }
        return boundedJson(response, controller.signal);
    };
    try {
        const operation = (async (): Promise<DelegatedAccountResult> => {
            const exchange = await send('/v1/token/exchange', {
                method: 'POST', headers: { Authorization: `Bearer ${config.serviceToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ policyId: config.policyId, proofKind: 'auth0_access', subjectToken: bearer }),
            }, 201);
            if (!objectWithKeys(exchange, ['token_type', 'access_token', 'grant_id', 'expires_at'])
                || exchange.token_type !== 'Bearer' || typeof exchange.access_token !== 'string'
                || exchange.access_token.length > MAX_TOKEN_LENGTH || !/^ezg_[A-Za-z0-9_-]+$/.test(exchange.access_token)
                || typeof exchange.grant_id !== 'string' || !UUID.test(exchange.grant_id)) return unavailable();
            const expires = expiry(exchange.expires_at);
            if (expires === null || !Number.isFinite(now()) || expires <= now()) return unavailable();
            const self = await send('/v1/delegation/me', {
                method: 'GET', headers: { Authorization: `Bearer ${exchange.access_token}`, Accept: 'application/json' },
            }, 200);
            const account = verifiedSelf(self, config);
            return account !== null && !controller.signal.aborted && Number.isFinite(now()) && expires > now()
                ? { ok: true, account } : unavailable();
        })();
        return await Promise.race([operation, stopped]);
    } catch { return unavailable(); }
    finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abort);
        controller.abort();
    }
}
