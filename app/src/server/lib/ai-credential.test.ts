import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { deriveGuacamoleSandboxId } from './cloudflare-guacamole-provider';
import {
    AI_CREDENTIAL_REFRESH_BEFORE_MS,
    AI_LOGOUT_TIMEOUT_MS,
    AI_PLAN_REFRESH_BUDGET_MS,
    AI_PLAN_REFRESH_LIMIT,
    AI_PLAN_REFRESH_MIN_REACH,
    aiPlanRefreshSlice,
    deleteAiCredential,
    revokeAiCredentialsOnSignout,
    currentAccessToken,
    mintAiCredentialSignature,
    pushAiCredential,
    readAccessTokenClaims,
    refreshAiPlans,
    syncAiCredential,
    type SessionSource,
} from './ai-credential';

const USER = 'abcdef01-2345-6789-abcd-ef0123456789';
const SANDBOX = 'guac-abcdef0123456789-fedcba9876543210';
const SECRET = 'test-hmac-secret';
const CONFIG = { workerUrl: 'https://api-desktop.ezil.org', hasHmacSecret: true, isConfigured: true };

function jwt(claims: Record<string, unknown>): string {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${enc({ alg: 'ES256' })}.${enc(claims)}.sig`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const builderToken = (exp = inAnHour(), sub = USER) =>
    jwt({ sub, exp, role: 'authenticated', app_metadata: { ezil_role: 'builder' } });

function session(token: string | null, refreshed: string | null = null): SessionSource & { refreshes: number } {
    const source = {
        refreshes: 0,
        auth: {
            getSession: async () => ({ data: { session: token === null ? null : { access_token: token } } }),
            refreshSession: async () => {
                source.refreshes += 1;
                return { data: { session: refreshed === null ? null : { access_token: refreshed } }, error: refreshed === null ? new Error('x') : null };
            },
        },
    };
    return source;
}

describe('mintAiCredentialSignature', () => {
    it('signs timestamp, sandbox id and the SHA-256 of the exact body (the Worker contract)', () => {
        const body = '{"accessToken":"a.b.c"}';
        const sig = mintAiCredentialSignature(SECRET, SANDBOX, body, 1_700_000_000_000);
        const hash = createHash('sha256').update(body).digest('hex');
        const expected = createHmac('sha256', SECRET).update(`1700000000000.POST./sandbox/${SANDBOX}/ai-credential.${hash}`).digest('hex');
        expect(sig).toBe(`t=1700000000000,v1=${expected}`);
    });
});

describe('readAccessTokenClaims', () => {
    it('reads sub, exp and the ezil role claim without verifying', () => {
        expect(readAccessTokenClaims(builderToken(2_000_000_000))).toEqual({ sub: USER, expiresAt: 2_000_000_000_000, ezilRole: 'builder' });
        expect(readAccessTokenClaims(jwt({ sub: USER, exp: 1 }))?.ezilRole).toBeNull();
        expect(readAccessTokenClaims('nope')).toBeNull();
        expect(readAccessTokenClaims('a.%%%.c')).toBeNull();
    });
});

describe('currentAccessToken', () => {
    it('returns the cookie session token for the same user', async () => {
        const token = builderToken();
        expect(await currentAccessToken(USER, new Headers(), session(token))).toBe(token);
    });

    it('refuses bearer callers, missing sessions and another user’s session', async () => {
        expect(await currentAccessToken(USER, new Headers({ authorization: 'Bearer x' }), session(builderToken()))).toBeNull();
        expect(await currentAccessToken(USER, new Headers(), session(null))).toBeNull();
        expect(await currentAccessToken(USER, new Headers(), session(builderToken(inAnHour(), '00000000-0000-0000-0000-000000000000')))).toBeNull();
    });

    it('refreshes first when the token is about to expire', async () => {
        const soon = Math.floor((Date.now() + AI_CREDENTIAL_REFRESH_BEFORE_MS - 60_000) / 1000);
        const fresh = builderToken();
        const source = session(builderToken(soon), fresh);
        expect(await currentAccessToken(USER, new Headers(), source)).toBe(fresh);
        expect(source.refreshes).toBe(1);
    });

    it('keeps a still-valid token when the refresh fails, and drops an expired one', async () => {
        const soon = Math.floor((Date.now() + 120_000) / 1000);
        const nearly = builderToken(soon);
        expect(await currentAccessToken(USER, new Headers(), session(nearly, null))).toBe(nearly);
        const expired = builderToken(Math.floor(Date.now() / 1000) - 10);
        expect(await currentAccessToken(USER, new Headers(), session(expired, null))).toBeNull();
    });
});

describe('pushAiCredential', () => {
    it('POSTs the token in the body with a body-bound signature, never in a header', async () => {
        const token = builderToken();
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, stored: true }), { status: 200 }));
        const result = await pushAiCredential(CONFIG, SECRET, SANDBOX, token, fetchImpl as unknown as typeof fetch);
        expect(result).toEqual({ ok: true, stored: true });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`https://api-desktop.ezil.org/sandbox/${SANDBOX}/ai-credential`);
        const headers = init.headers as Record<string, string>;
        expect(Object.values(headers).join(' ')).not.toContain(token);
        expect(JSON.parse(init.body as string)).toEqual({ accessToken: token });
        const ts = Number(/^t=(\d+),/.exec(headers['x-ezil-signature']!)![1]);
        expect(headers['x-ezil-signature']).toBe(mintAiCredentialSignature(SECRET, SANDBOX, init.body as string, ts));
    });

    it('skips without a request when unconfigured, unsigned, sessionless or role-less', async () => {
        const fetchImpl = vi.fn();
        const f = fetchImpl as unknown as typeof fetch;
        expect(await pushAiCredential({ ...CONFIG, isConfigured: false }, SECRET, SANDBOX, builderToken(), f)).toMatchObject({ skipped: 'not_configured' });
        expect(await pushAiCredential(CONFIG, '', SANDBOX, builderToken(), f)).toMatchObject({ skipped: 'not_configured' });
        expect(await pushAiCredential(CONFIG, SECRET, SANDBOX, null, f)).toMatchObject({ skipped: 'no_session' });
        expect(await pushAiCredential(CONFIG, SECRET, SANDBOX, jwt({ sub: USER, exp: inAnHour() }), f)).toMatchObject({ skipped: 'no_ezil_role' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports a rejection or network failure as a value and never logs the token', async () => {
        const token = builderToken();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const rejected = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'access_token_wrong_user' }), { status: 400 }));
        expect(await pushAiCredential(CONFIG, SECRET, SANDBOX, token, rejected as unknown as typeof fetch)).toEqual({ ok: false, error: 'worker_http_400' });
        const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
        expect(await pushAiCredential(CONFIG, SECRET, SANDBOX, token, down as unknown as typeof fetch)).toEqual({ ok: false, error: 'push_failed' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
        warn.mockRestore();
    });
});

describe('syncAiCredential', () => {
    it('never throws, even when the session source does', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const result = await syncAiCredential({
            config: CONFIG,
            hmacSecret: SECRET,
            sandboxName: SANDBOX,
            userId: USER,
            headers: new Headers(),
            supabase: async () => { throw new Error('cookies() outside a request'); },
        });
        expect(result).toEqual({ ok: false, error: 'sync_failed' });
        warn.mockRestore();
    });

    it('signs the plan list into the same body; leaves it out when unknown, so the Worker keeps its list', async () => {
        const token = builderToken();
        const bodies: unknown[] = [];
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            const headers = init.headers as Record<string, string>;
            const ts = Number(/^t=(\d+),/.exec(headers['x-ezil-signature']!)![1]);
            expect(headers['x-ezil-signature']).toBe(mintAiCredentialSignature(SECRET, SANDBOX, init.body as string, ts));
            bodies.push(JSON.parse(init.body as string));
            return new Response(JSON.stringify({ ok: true, stored: true }), { status: 200 });
        }) as unknown as typeof fetch;
        const sync = (includedModels?: () => Promise<readonly string[] | null | undefined>) => syncAiCredential({
            config: CONFIG, hmacSecret: SECRET, sandboxName: SANDBOX, userId: USER, headers: new Headers(),
            supabase: async () => session(token), fetchImpl, ...(includedModels ? { includedModels } : {}),
        });
        await sync(async () => ['gemini-3.8-flash']);
        await sync(async () => null);
        await sync(async () => undefined);
        await sync(async () => { throw new Error('billing down'); });
        await sync();
        expect(bodies).toEqual([
            { accessToken: token, includedModels: ['gemini-3.8-flash'] },
            { accessToken: token, includedModels: null },
            { accessToken: token }, { accessToken: token }, { accessToken: token },
        ]);
    });

    it('reads the plan only for a push that will be sent', async () => {
        const includedModels = vi.fn(async () => ['gemini-3.8-flash']);
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        for (const token of [null, jwt({ sub: USER, exp: inAnHour() })]) {
            expect(await syncAiCredential({ config: CONFIG, hmacSecret: SECRET, sandboxName: SANDBOX, userId: USER, headers: new Headers(),
                supabase: async () => session(token), fetchImpl, includedModels })).toMatchObject({ ok: false });
        }
        expect(await syncAiCredential({ config: { ...CONFIG, isConfigured: false }, hmacSecret: SECRET, sandboxName: SANDBOX, userId: USER,
            headers: new Headers(), supabase: async () => session(builderToken()), fetchImpl, includedModels })).toMatchObject({ skipped: 'not_configured' });
        expect(includedModels).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('logout credential deletion', () => {
    it('signs DELETE with an empty body, drops response bodies and ignores transport errors', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}'));
        await deleteAiCredential(CONFIG, SECRET, SANDBOX, new AbortController().signal, fetchImpl as typeof fetch);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${CONFIG.workerUrl}/sandbox/${SANDBOX}/ai-credential`);
        expect(init.method).toBe('DELETE');
        expect(init.body).toBeUndefined();
        const signature = new Headers(init.headers).get('x-ezil-signature')!;
        const now = Number(/^t=(\d+),/.exec(signature)![1]);
        expect(signature).toBe(mintAiCredentialSignature(SECRET, SANDBOX, '', now, 'DELETE'));
        expect(signature).not.toBe(mintAiCredentialSignature(SECRET, SANDBOX, '', now, 'POST'));
        await expect(deleteAiCredential(CONFIG, SECRET, SANDBOX, new AbortController().signal, vi.fn(async () => { throw new Error('offline'); }) as typeof fetch)).resolves.toBeUndefined();
    });

    it('bounds the whole logout operation, aborts hanging fetches, and never retries', async () => {
        vi.useFakeTimers();
        try {
            const signals: AbortSignal[] = [];
            const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
                signals.push(init!.signal!);
                return new Promise<Response>(() => {});
            });
            const result = revokeAiCredentialsOnSignout({ config: CONFIG, hmacSecret: SECRET, getUserId: async () => USER,
                listComputerIds: async () => ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'], fetchImpl: fetchImpl as typeof fetch });
            await vi.advanceTimersByTimeAsync(AI_LOGOUT_TIMEOUT_MS);
            await expect(result).resolves.toBeUndefined();
            expect(fetchImpl).toHaveBeenCalledTimes(2);
            expect(signals.every((s) => s.aborted)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not start deletions after a slow identity lookup has exceeded the budget', async () => {
        vi.useFakeTimers();
        try {
            let identify!: (id: string) => void;
            const list = vi.fn(async () => ['computer']);
            const result = revokeAiCredentialsOnSignout({ config: CONFIG, hmacSecret: SECRET,
                getUserId: () => new Promise((resolve) => { identify = resolve; }), listComputerIds: list });
            await vi.advanceTimersByTimeAsync(AI_LOGOUT_TIMEOUT_MS);
            await result;
            identify(USER);
            await Promise.resolve();
            expect(list).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('refreshAiPlans (the server plan refresh, no browser)', () => {
    const FREE = ['gemini-3.8-flash'];
    const PAID = 'b0b0b0b0-0000-4000-8000-000000000000';
    const FREE_OWNER = 'f0f0f0f0-0000-4000-8000-000000000000';
    const BROKEN = 'e0e0e0e0-0000-4000-8000-000000000000';
    const C = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
    type Row = { userId: string; computerId: string };
    /** The route's source over an in-memory table, already in its stable order. */
    const source = (rows: readonly Row[]) => ({
        count: vi.fn(async () => rows.length),
        page: vi.fn(async (offset: number, limit: number) => rows.slice(offset, offset + limit)),
    });
    function worker(answer: (sandbox: string) => Response | Promise<Response> = () => Response.json({ ok: true, planStored: true })) {
        const sent: { sandbox: string; body: unknown; signature: string; raw: string }[] = [];
        const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
            const sandbox = decodeURIComponent(/\/sandbox\/([^/]+)\/ai-credential$/.exec(url)![1]!);
            const signature = (init.headers as Record<string, string>)['x-ezil-signature']!;
            sent.push({ sandbox, body: JSON.parse(init.body as string), signature, raw: init.body as string });
            expect(init.method).toBe('POST');
            return answer(sandbox);
        });
        return { sent, fetchImpl: fetchImpl as unknown as typeof fetch };
    }

    it("pushes each computer only its owner's current list, signed, with no token; one plan read per owner", async () => {
        const { sent, fetchImpl } = worker();
        const includedModelsFor = vi.fn(async (userId: string) => userId === FREE_OWNER ? FREE : null);
        const counts = await refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl, includedModelsFor, pass: 0,
            computers: source([{ userId: FREE_OWNER, computerId: C(1) }, { userId: PAID, computerId: C(2) }, { userId: FREE_OWNER, computerId: C(3) }]) });
        expect(counts).toEqual({ eligible: 3, computers: 3, pushed: 3, stored: 3, unknown: 0, failed: 0 });
        expect(includedModelsFor.mock.calls.map(([u]) => u).sort()).toEqual([FREE_OWNER, PAID].sort());
        const bySandbox = new Map(sent.map((s) => [s.sandbox, s]));
        expect(bySandbox.get(deriveGuacamoleSandboxId(FREE_OWNER, C(1)))!.body).toEqual({ includedModels: FREE });
        expect(bySandbox.get(deriveGuacamoleSandboxId(FREE_OWNER, C(3)))!.body).toEqual({ includedModels: FREE });
        expect(bySandbox.get(deriveGuacamoleSandboxId(PAID, C(2)))!.body).toEqual({ includedModels: null });
        for (const s of sent) {
            expect(Object.keys(s.body as object)).toEqual(['includedModels']);
            const ts = Number(/^t=(\d+),/.exec(s.signature)![1]);
            expect(s.signature).toBe(mintAiCredentialSignature(SECRET, s.sandbox, s.raw, ts));
        }
    });

    it('signs each push at its plan read, so a browser beat that read the plan later wins', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_800_000_000_000);
            const { sent, fetchImpl } = worker();
            const result = refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl, pass: 0,
                includedModelsFor: () => new Promise((resolve) => setTimeout(() => resolve(FREE), 3_000)),
                computers: source([{ userId: FREE_OWNER, computerId: C(1) }]) });
            await vi.advanceTimersByTimeAsync(3_000);
            await result;
            expect(sent).toHaveLength(1);
            expect(sent[0]!.signature).toBe(mintAiCredentialSignature(SECRET, sent[0]!.sandbox, sent[0]!.raw, 1_800_000_000_000));
        } finally {
            vi.useRealTimers();
        }
    });

    it('a plan that cannot be read sends nothing for that owner (never null), and other owners still refresh', async () => {
        const { sent, fetchImpl } = worker();
        const counts = await refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl, pass: 0,
            includedModelsFor: async (userId) => {
                if (userId === BROKEN) return undefined;
                if (userId === PAID) throw new Error('billing down');
                return FREE;
            },
            computers: source([{ userId: BROKEN, computerId: C(1) }, { userId: PAID, computerId: C(2) }, { userId: FREE_OWNER, computerId: C(3) }]) });
        expect(counts).toEqual({ eligible: 3, computers: 3, pushed: 1, stored: 1, unknown: 2, failed: 0 });
        expect(sent.map((s) => [s.sandbox, s.body])).toEqual([[deriveGuacamoleSandboxId(FREE_OWNER, C(3)), { includedModels: FREE }]]);
    });

    it('an older Worker refusing a token-less body (400) is counted and the pass carries on; a stale push stores nothing', async () => {
        const refused = deriveGuacamoleSandboxId(PAID, C(1));
        const { sent, fetchImpl } = worker((sandbox) => sandbox === refused
            ? Response.json({ ok: false, error: 'invalid_access_token' }, { status: 400 })
            : Response.json({ ok: true, planStored: false }));
        const counts = await refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl, includedModelsFor: async () => null, pass: 0,
            computers: source([{ userId: PAID, computerId: C(1) }, { userId: PAID, computerId: C(2) }]) });
        expect(counts).toEqual({ eligible: 2, computers: 2, pushed: 1, stored: 0, unknown: 0, failed: 1 });
        expect(sent).toHaveLength(2);
    });

    it('never throws, and sends nothing when unconfigured or the listing fails', async () => {
        const { sent, fetchImpl } = worker();
        const computers = source([{ userId: PAID, computerId: C(1) }]);
        const zero = { eligible: 0, computers: 0, pushed: 0, stored: 0, unknown: 0, failed: 0 };
        expect(await refreshAiPlans({ config: { ...CONFIG, isConfigured: false }, hmacSecret: SECRET, fetchImpl, computers, pass: 0, includedModelsFor: async () => null })).toEqual(zero);
        expect(await refreshAiPlans({ config: CONFIG, hmacSecret: '', fetchImpl, computers, pass: 0, includedModelsFor: async () => null })).toEqual(zero);
        expect(computers.count).not.toHaveBeenCalled();
        for (const broken of [{ ...computers, count: async () => { throw new Error('db down'); } },
            { ...computers, page: async () => { throw new Error('db down'); } }]) {
            expect(await refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl, includedModelsFor: async () => null, pass: 0, computers: broken }))
                .toMatchObject({ computers: 0, pushed: 0 });
        }
        const transport = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
        expect(await refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl: transport, computers, pass: 0, includedModelsFor: async () => null }))
            .toMatchObject({ computers: 1, pushed: 0, failed: 1 });
        expect(sent).toHaveLength(0);
    });

    it('is bounded: a hanging Worker is aborted at the budget and later computers are not started', async () => {
        vi.useFakeTimers();
        try {
            const signals: AbortSignal[] = [];
            const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
                signals.push(init!.signal!);
                return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
            });
            const listed = Array.from({ length: 200 }, (_, i) => ({ userId: PAID, computerId: C(i) }));
            const result = refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl: fetchImpl as unknown as typeof fetch,
                includedModelsFor: async () => null, computers: source(listed), pass: 0 });
            await vi.advanceTimersByTimeAsync(AI_PLAN_REFRESH_BUDGET_MS);
            await expect(result).resolves.toMatchObject({ computers: 200, pushed: 0 });
            // Every push hangs to its own 5 s timeout: 8 in flight, four rounds in the budget.
            expect(fetchImpl).toHaveBeenCalledTimes(AI_PLAN_REFRESH_MIN_REACH);
            expect(signals.every((s) => s.aborted)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(['count', 'page'] as const)('a listing (%s) that never answers settles at the budget, and pushes nothing when it answers late', async (stuck) => {
        vi.useFakeTimers();
        try {
            const { sent, fetchImpl } = worker();
            const rows = [{ userId: PAID, computerId: C(1) }];
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const computers = source(rows);
            if (stuck === 'count') computers.count.mockImplementation(async () => { await gate; return rows.length; });
            else computers.page.mockImplementation(async () => { await gate; return rows; });
            let settled = false;
            const result = refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl, includedModelsFor: async () => null, computers, pass: 0 })
                .then((counts) => { settled = true; return counts; });
            await vi.advanceTimersByTimeAsync(AI_PLAN_REFRESH_BUDGET_MS - 1);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            await expect(result).resolves.toMatchObject({ computers: 0, pushed: 0 });
            release();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(sent).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    describe('fair selection across passes (aiPlanRefreshSlice)', () => {
        /** Which rows the passes from `from` reach, when each pass reaches only its first `reach` rows. */
        const reached = (n: number, from: number, passes: number, reach: number) => {
            const seen = new Set<number>();
            for (let pass = from; pass < from + passes; pass++) {
                const { start, take } = aiPlanRefreshSlice(n, pass);
                for (let i = 0; i < Math.min(take, reach); i++) seen.add((start + i) % n);
            }
            return seen.size;
        };

        it('takes at most the limit; passes that finish reach all of up to 7,468 rows in any 15 in a row', () => {
            expect(aiPlanRefreshSlice(0, 5)).toEqual({ start: 0, take: 0, passes: 0 });
            expect(aiPlanRefreshSlice(1200, 0).take).toBe(AI_PLAN_REFRESH_LIMIT);
            for (const n of [1, 2, 31, 33, 100, 469, 501, 1200, 5000, 7467, 7468]) {
                expect(aiPlanRefreshSlice(n, 0).passes).toBe(15);
                for (const from of [0, 1, 7, 14, 15, 29_000_123, 1e9 + 7]) expect(reached(n, from, 15, AI_PLAN_REFRESH_LIMIT)).toBe(n);
            }
            // Above the bound a rotation takes ceil((N + 32) / 500) passes, never more.
            for (const n of [7469, 9001, 20_000]) {
                const { passes } = aiPlanRefreshSlice(n, 0);
                expect(passes).toBe(Math.ceil((n + AI_PLAN_REFRESH_MIN_REACH) / AI_PLAN_REFRESH_LIMIT));
                expect(reached(n, 3, passes - 1, AI_PLAN_REFRESH_LIMIT)).toBeLessThan(n);
                for (const from of [0, 3, 29_000_123]) expect(reached(n, from, passes, AI_PLAN_REFRESH_LIMIT)).toBe(n);
            }
        });

        it('rows a slow pass never reached lead a later pass: every row is reached even when each pass reaches only 32', () => {
            expect(AI_PLAN_REFRESH_MIN_REACH).toBe(32);
            for (const n of [33, 100, 501, 1200, 7468]) {
                const { passes } = aiPlanRefreshSlice(n, 0);
                const worst = passes * (Math.ceil(Math.ceil((n + AI_PLAN_REFRESH_MIN_REACH) / passes) / AI_PLAN_REFRESH_MIN_REACH) + 1);
                for (const from of [0, 11, 29_000_123]) expect(reached(n, from, worst, AI_PLAN_REFRESH_MIN_REACH)).toBe(n);
            }
        });

        it('over 1,200 computers, 15 real sweeps refresh every one, though 40 early ones hang every time', async () => {
            vi.useFakeTimers();
            try {
                const rows = Array.from({ length: 1200 }, (_, i) => ({ userId: PAID, computerId: C(i) }));
                const hanging = new Set(rows.slice(0, 40).map((r) => deriveGuacamoleSandboxId(r.userId, r.computerId)));
                const refreshed = new Set<string>();
                const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
                    const sandbox = decodeURIComponent(/\/sandbox\/([^/]+)\/ai-credential$/.exec(url)![1]!);
                    if (hanging.has(sandbox)) {
                        return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
                    }
                    refreshed.add(sandbox);
                    return Response.json({ ok: true, planStored: true });
                }) as unknown as typeof fetch;
                const computers = source(rows);
                for (let pass = 29_000_000; pass < 29_000_015; pass++) {
                    const result = refreshAiPlans({ config: CONFIG, hmacSecret: SECRET, fetchImpl, includedModelsFor: async () => null, computers, pass });
                    await vi.advanceTimersByTimeAsync(AI_PLAN_REFRESH_BUDGET_MS);
                    await result;
                }
                expect(refreshed.size).toBe(1200 - 40);
                expect(computers.page.mock.calls.every(([, limit]) => limit <= AI_PLAN_REFRESH_LIMIT)).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
