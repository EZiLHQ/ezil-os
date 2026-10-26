import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDelegatedAccountConfig, verifiedDelegatedAccount, type DelegatedAccountConfig } from './delegated-account';

vi.mock('server-only', () => ({}));

// Offline fixtures only. Auth0 proof validation belongs to the Gateway, never this caller.
const now = new Date('2026-10-26T12:00:00.000Z');
const issuer = 'https://stage-fixture.supabase.co/auth/v1';
const subject = '11111111-2222-4333-8444-555555555555';
const accountPublicId = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const otherSubject = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const callerToken = 'opaque.fixture-api-access-token';
const serviceToken = 'ezs_fixture-service';
const grantToken = 'ezg_fixture-grant';
const config: DelegatedAccountConfig = {
    fundingUrl: 'https://ai-staging.ezil.work', serviceToken, policyId: 'abcdef01-2345-4678-9abc-def012345678',
    environment: 'staging', supabaseIssuer: issuer,
};
const authRequired = { ok: false, status: 401, error: 'delegated_auth_required' };
const unavailable = { ok: false, status: 503, error: 'delegated_account_unavailable' };

function exchangeBody() {
    return { token_type: 'Bearer', access_token: grantToken,
        grant_id: '01234567-89ab-4cde-8f01-23456789abcd', expires_at: '2026-10-26T12:05:00.000Z' };
}
function meBody() {
    return { object: 'delegated_self', environment: 'staging',
        identity: { issuer, subject, account_public_id: accountPublicId },
        wallet: { state: 'ok', available_micro: '1000001', held_micro: '0' } };
}
function request(authorization: string | null = `Bearer ${callerToken}`, signal?: AbortSignal) {
    const headers = new Headers({ cookie: 'sb-fixture-auth-token=another-users-cookie' });
    if (authorization !== null) headers.set('authorization', authorization);
    return new Request(`https://os.example.test/api/billing/v3/entitlement?userId=${otherSubject}&subject=${otherSubject}`, { headers, signal });
}
function fetchReplies(first: unknown = exchangeBody(), second: unknown = meBody()) {
    return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(first, { status: 201 }))
        .mockResolvedValueOnce(Response.json(second));
}
function verify(fetcher = fetchReplies(), input = request(), settings = config) {
    return verifiedDelegatedAccount(input, { config: settings, fetch: fetcher, now: () => now });
}
function stalledBody() {
    const cancel = vi.fn();
    return { cancel, response: new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { 'content-type': 'application/json' },
    }) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('delegated account proof boundary', () => {
    it('exchanges exactly the caller proof, then reads self using only the delegated grant', async () => {
        const fetcher = fetchReplies();
        expect(await verify(fetcher)).toEqual({ ok: true, account: {
            environment: 'staging', identity: meBody().identity, wallet: meBody().wallet,
        } });
        expect(fetcher).toHaveBeenCalledTimes(2);
        const [exchangeUrl, exchange] = fetcher.mock.calls[0]!;
        expect(exchangeUrl).toBe('https://ai-staging.ezil.work/v1/token/exchange');
        expect(exchange).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) });
        expect(new Headers(exchange?.headers).get('authorization')).toBe(`Bearer ${serviceToken}`);
        expect(new Headers(exchange?.headers).get('content-type')).toBe('application/json');
        expect(JSON.parse(exchange!.body as string)).toEqual({ policyId: config.policyId,
            proofKind: 'auth0_access', subjectToken: callerToken });
        const [meUrl, me] = fetcher.mock.calls[1]!;
        expect(meUrl).toBe('https://ai-staging.ezil.work/v1/delegation/me');
        expect(me).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) });
        expect(new Headers(me?.headers).get('authorization')).toBe(`Bearer ${grantToken}`);
        expect(me?.body).toBeUndefined();
        for (const [, init] of fetcher.mock.calls) {
            const headers = new Headers(init?.headers);
            expect(headers.has('cookie')).toBe(false);
            expect(headers.has('x-ezil-signature')).toBe(false);
            expect(headers.has('x-ezil-timestamp')).toBe(false);
            expect(headers.has('x-user-id')).toBe(false);
        }
    });

    it.each([null, '', 'Basic token', 'Bearer', 'Bearer ', 'Bearer one two', 'Bearer\tone',
        'Bearer  one', 'Bearer one,Bearer two', 'Bearer one, two', 'Bearer "token"',
        'Bearer bad%token', 'Bearer bad:token', `Bearer ${'x'.repeat(8193)}`])
    ('refuses invalid single Bearer %j without a cookie fallback', async authorization => {
        const fetcher = fetchReplies();
        expect(await verify(fetcher, request(authorization))).toEqual(authRequired);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects duplicate Authorization headers joined by the Request implementation', async () => {
        const headers = new Headers();
        headers.append('authorization', `Bearer ${callerToken}`);
        headers.append('authorization', 'Bearer other-token');
        const fetcher = fetchReplies();
        expect(await verify(fetcher, new Request('https://os.example.test', { headers }))).toEqual(authRequired);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('forwards an opaque, syntactically valid proof without decoding identity claims', async () => {
        const token = 'not-a-jwt.ABC_def-123+/==';
        const fetcher = fetchReplies();
        expect(await verify(fetcher, request(`bEaReR ${token}`))).toMatchObject({ ok: true, account: { identity: { subject } } });
        expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).subjectToken).toBe(token);
    });

    it('accepts the bounded maximum Bearer length without truncating the proof', async () => {
        const token = 'a'.repeat(8192), fetcher = fetchReplies();
        expect(await verify(fetcher, request(`Bearer ${token}`))).toMatchObject({ ok: true });
        expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).subjectToken).toBe(token);
    });

    it('does not accept a caller-supplied grant in place of Gateway verification', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'invalid_proof' }, { status: 403 }));
        expect(await verify(fetcher, request(`Bearer ${grantToken}`))).toEqual(unavailable);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).proofKind).toBe('auth0_access');
    });

    it('does not leak any service, caller or grant credential through its result', async () => {
        const serialized = JSON.stringify(await verify());
        for (const secret of [serviceToken, callerToken, grantToken, config.policyId!]) expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain('grant_id');
        expect(serialized).not.toContain(otherSubject);
    });

    it('keeps each request proof and verified UUID isolated with no shared credential cache', async () => {
        const secondIdentity = { ...meBody().identity, subject: otherSubject };
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(exchangeBody(), { status: 201 }))
            .mockResolvedValueOnce(Response.json(meBody()))
            .mockResolvedValueOnce(Response.json({ ...exchangeBody(), access_token: 'ezg_second-request' }, { status: 201 }))
            .mockResolvedValueOnce(Response.json({ ...meBody(), identity: secondIdentity }));
        expect(await verify(fetcher)).toMatchObject({ ok: true, account: { identity: { subject } } });
        expect(await verify(fetcher, request('Bearer second-caller-proof'))).toMatchObject({ ok: true, account: { identity: secondIdentity } });
        expect(JSON.parse(fetcher.mock.calls[2]![1]!.body as string).subjectToken).toBe('second-caller-proof');
        expect(new Headers(fetcher.mock.calls[3]![1]?.headers).get('authorization')).toBe('Bearer ezg_second-request');
    });
});

describe('delegation configuration and canonical namespaces', () => {
    it('reads only the dedicated server service credential and the local Supabase namespace', () => {
        expect(readDelegatedAccountConfig({ BILLING_FUNDING_URL: config.fundingUrl,
            BILLING_AI_READ_SERVICE_TOKEN: serviceToken, BILLING_AI_READ_POLICY_ID: config.policyId,
            NEXT_PUBLIC_SUPABASE_URL: 'https://stage-fixture.supabase.co',
            ENTITLEMENT_HMAC_SECRET: 'forbidden-hmac', SUPABASE_SERVICE_ROLE_KEY: 'forbidden-admin',
        })).toMatchObject(config);
        expect(readDelegatedAccountConfig({ ENTITLEMENT_HMAC_SECRET: 'forbidden-hmac',
            BILLING_FUNDING_HMAC_SECRET: 'forbidden-funding-hmac', SUPABASE_SERVICE_ROLE_KEY: 'forbidden-admin',
        }).serviceToken).toBeUndefined();
    });

    it.each([
        { serviceToken: undefined }, { serviceToken: '' }, { serviceToken: 'ezg_wrong-kind' },
        { serviceToken: 'plain-service' }, { serviceToken: 'ezs_two tokens' },
        { serviceToken: `ezs_${'x'.repeat(8193)}` }, { policyId: undefined }, { policyId: '' }, { policyId: 'not-a-policy-uuid' },
        { supabaseIssuer: undefined }, { supabaseIssuer: `${issuer}/` },
        { supabaseIssuer: 'http://stage-fixture.supabase.co/auth/v1' },
    ])('fails closed for incomplete or invalid server configuration %j', async override => {
        const fetcher = fetchReplies();
        expect(await verify(fetcher, request(), { ...config, ...override })).toEqual(unavailable);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([undefined, '', 'http://ai-staging.ezil.work', 'https://ai-staging.ezil.work.evil.test',
        'https://user:pass@ai-staging.ezil.work', 'https://ai-staging.ezil.work?route=x',
        'https://ai-staging.ezil.work#fragment', 'https://ai-staging.ezil.work/v1',
        'https://ai-staging.ezil.work:444', 'https://ai-staging.ezil.work:443',
        'https://AI-STAGING.ezil.work', 'https://ai-staging.ezil.work/', 'https://attacker.example.test'])
    ('refuses an unapproved funding origin %j before exposing credentials', async fundingUrl => {
        const fetcher = fetchReplies();
        expect(await verify(fetcher, request(), { ...config, fundingUrl })).toEqual(unavailable);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each(['https://other-project.supabase.co/auth/v1', `${issuer}/`, issuer.replace('/auth/v1', ''),
        'https://btgqfmnzycdecmeyqubx.supabase.co/auth/v1'])
    ('refuses a Gateway identity from a different exact namespace %s', async foreignIssuer => {
        const body = meBody(); body.identity.issuer = foreignIssuer;
        expect(await verify(fetchReplies(exchangeBody(), body))).toEqual(unavailable);
    });

    it('refuses staging/production environment mismatches even for an identical subject', async () => {
        const body = { ...meBody(), environment: 'production' };
        expect(await verify(fetchReplies(exchangeBody(), body))).toEqual(unavailable);
    });

    it('requires explicit matching production origin and issuer configuration', async () => {
        const productionIssuer = 'https://btgqfmnzycdecmeyqubx.supabase.co/auth/v1';
        const productionConfig: DelegatedAccountConfig = { ...config, environment: 'production',
            fundingUrl: 'https://ai.ezil.work', supabaseIssuer: productionIssuer };
        const fetcher = fetchReplies();
        expect(await verify(fetcher, request(), productionConfig)).toEqual(unavailable);
        expect(fetcher).not.toHaveBeenCalled();
        for (const production of [{ fundingUrl: config.fundingUrl!, supabaseIssuer: productionIssuer },
            { fundingUrl: 'https://ai.ezil.work', supabaseIssuer: issuer }]) {
            expect(await verify(fetcher, request(), { ...productionConfig, production })).toEqual(unavailable);
        }
        expect(fetcher).not.toHaveBeenCalled();
        const productionSubject = '12341234-5678-4abc-8def-123456789abc';
        const body = { ...meBody(), environment: 'production', identity: { ...meBody().identity, issuer: productionIssuer, subject: productionSubject } };
        const allowedFetcher = fetchReplies(exchangeBody(), body);
        expect(await verify(allowedFetcher, request(), { ...productionConfig,
            production: { fundingUrl: productionConfig.fundingUrl!, supabaseIssuer: productionIssuer },
        })).toMatchObject({ ok: true, account: { environment: 'production', identity: { issuer: productionIssuer, subject: productionSubject } } });
        expect(allowedFetcher.mock.calls[0]![0]).toBe('https://ai.ezil.work/v1/token/exchange');
    });
});

describe('strict Gateway response contracts', () => {
    it.each([200, 202, 204, 301, 302, 307, 308, 400, 401, 403, 404, 429, 500, 503])
    ('requires exactly 201 from exchange, refusing HTTP %s without a second request', async status => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
        expect(await verify(fetcher)).toEqual(unavailable);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([201, 202, 204, 301, 302, 307, 308, 400, 401, 403, 404, 429, 500, 503])
    ('requires exactly 200 from delegated self, refusing HTTP %s', async status => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(exchangeBody(), { status: 201 }))
            .mockResolvedValueOnce(new Response(null, { status }));
        expect(await verify(fetcher)).toEqual(unavailable);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each(['exchange', 'me'] as const)('rejects a followed redirect even if %s has a successful JSON body', async phase => {
        const first = Response.json(exchangeBody(), { status: 201 }), second = Response.json(meBody());
        Object.defineProperty(phase === 'exchange' ? first : second, 'redirected', { value: true });
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        expect(await verify(fetcher)).toEqual(unavailable);
        expect(fetcher).toHaveBeenCalledTimes(phase === 'exchange' ? 1 : 2);
    });

    it.each(['exchange', 'me'] as const)('refuses %s responses whose transport URL differs from the exact request', async phase => {
        const first = Response.json(exchangeBody(), { status: 201 }), second = Response.json(meBody());
        Object.defineProperty(phase === 'exchange' ? first : second, 'url', { value: 'https://foreign.example.test/redirected' });
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        expect(await verify(fetcher)).toEqual(unavailable);
    });

    it.each([
        null, [], {}, { ...exchangeBody(), extra: true }, { ...exchangeBody(), token_type: 'bearer' },
        { ...exchangeBody(), access_token: 'ezs_wrong-token' }, { ...exchangeBody(), access_token: 'ezg_two tokens' },
        { ...exchangeBody(), access_token: `ezg_${'x'.repeat(8193)}` },
        { ...exchangeBody(), grant_id: 'not-a-uuid' }, { ...exchangeBody(), grant_id: '01234567-89AB-4CDE-8F01-23456789ABCD' },
        { ...exchangeBody(), expires_at: '2026-10-26T12:00:00.000Z' }, { ...exchangeBody(), expires_at: '2026-10-25T12:00:00Z' },
        { ...exchangeBody(), expires_at: 'tomorrow' }, { ...exchangeBody(), expires_at: 1793016300000 },
        { ...exchangeBody(), expires_at: '2027-02-30T12:05:00Z' },
        { ...exchangeBody(), expires_at: '2026-13-26T12:05:00Z' }, { ...exchangeBody(), expires_at: '2026-10-26T24:05:00Z' },
        { ...exchangeBody(), expires_at: '2026-10-26T12:05:00+24:00' }, { ...exchangeBody(), expires_at: '2026-10-26T12:05:00+00:60' },
        { ...exchangeBody(), expires_at: '2026-10-26T12:05:00+0000' },
    ])('rejects a malformed exchange success %j', async body => {
        const fetcher = fetchReplies(body);
        expect(await verify(fetcher)).toEqual(unavailable);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each(['token_type', 'access_token', 'grant_id', 'expires_at'])('requires exchange field %s', async field => {
        const body: Record<string, unknown> = exchangeBody(); delete body[field];
        expect(await verify(fetchReplies(body))).toEqual(unavailable);
    });

    it.each(['2026-10-26T12:05:00Z', '2026-10-26T12:05:00+00:00', '2026-10-26T12:05:00.123456+00:00',
        '2026-10-26T17:35:00+05:30', '2026-10-27T01:05:00+13:00'])
    ('accepts the existing Gateway SQL ISO expiry %s', async expires_at => {
        expect(await verify(fetchReplies({ ...exchangeBody(), expires_at }))).toMatchObject({ ok: true });
    });

    it.each([
        null, [], {}, { ...meBody(), extra: true }, { ...meBody(), object: 'account' },
        { ...meBody(), environment: 'preview' }, { ...meBody(), identity: { ...meBody().identity, email: 'private@example.test' } },
        { ...meBody(), identity: { ...meBody().identity, subject: 'auth0|external-subject' } },
        { ...meBody(), identity: { ...meBody().identity, subject: '11111111-2222-4333-7444-555555555555' } },
        { ...meBody(), identity: { ...meBody().identity, account_public_id: 'works-not-a-uuid' } },
        { ...meBody(), identity: { ...meBody().identity, account_public_id: accountPublicId.toUpperCase() } },
        { ...meBody(), wallet: { ...meBody().wallet, extra: true } },
        { ...meBody(), wallet: { ...meBody().wallet, state: 'unknown' } },
    ])('rejects a malformed delegated self success %j', async body => {
        expect(await verify(fetchReplies(exchangeBody(), body))).toEqual(unavailable);
    });

    it.each(['available_micro', 'held_micro'] as const)('requires %s to be a bounded nonnegative integer string', async field => {
        for (const value of [undefined, null, 0, 1, -1, '-1', '1.5', '1e6', '+1', ' 1', '1 ', '', '9'.repeat(101)]) {
            const body = { ...meBody(), wallet: { ...meBody().wallet, [field]: value } };
            expect(await verify(fetchReplies(exchangeBody(), body))).toEqual(unavailable);
        }
    });

    it('requires every frozen delegated-self field without accepting partial identity or wallet objects', async () => {
        for (const field of ['object', 'environment', 'identity', 'wallet']) {
            const body: Record<string, unknown> = meBody(); delete body[field];
            expect(await verify(fetchReplies(exchangeBody(), body))).toEqual(unavailable);
        }
        for (const field of ['issuer', 'subject', 'account_public_id']) {
            const body = meBody(); delete (body.identity as Record<string, unknown>)[field];
            expect(await verify(fetchReplies(exchangeBody(), body))).toEqual(unavailable);
        }
        for (const field of ['state', 'available_micro', 'held_micro']) {
            const body = meBody(); delete (body.wallet as Record<string, unknown>)[field];
            expect(await verify(fetchReplies(exchangeBody(), body))).toEqual(unavailable);
        }
    });

    it.each(['ok', 'exhausted', 'paused_reconciliation', 'paused_operations'])('preserves the verified wallet state %s', async state => {
        const body = { ...meBody(), wallet: { state, available_micro: state === 'exhausted' ? '0' : '1', held_micro: '999999' } };
        expect(await verify(fetchReplies(exchangeBody(), body))).toMatchObject({ ok: true, account: { wallet: body.wallet } });
    });

    it.each([{ state: 'ok', available_micro: '0' }, { state: 'exhausted', available_micro: '1' }])
    ('refuses an internally contradictory canonical wallet %j', async wallet => {
        expect(await verify(fetchReplies(exchangeBody(), { ...meBody(), wallet: { ...wallet, held_micro: '0' } }))).toEqual(unavailable);
    });

    it('keeps exact large decimal microcredit strings without floating point coercion', async () => {
        const body = { ...meBody(), wallet: { ...meBody().wallet, available_micro: '9'.repeat(100), held_micro: '1' } };
        expect(await verify(fetchReplies(exchangeBody(), body))).toMatchObject({ ok: true, account: { wallet: body.wallet } });
    });
});

describe('bounded transport, cancellation and redaction', () => {
    it.each(['exchange', 'me'] as const)('refuses malformed JSON and wrong content types in %s', async phase => {
        for (const bad of [new Response('{', { headers: { 'content-type': 'application/json' } }),
            new Response('{}'), new Response('{}', { headers: { 'content-type': 'text/html' } })]) {
            const first = phase === 'exchange' ? new Response(bad.body, { status: 201, headers: bad.headers })
                : Response.json(exchangeBody(), { status: 201 });
            const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(bad);
            expect(await verify(fetcher)).toEqual(unavailable);
        }
    });

    it.each(['exchange', 'me'] as const)('bounds streamed UTF-8 bytes and cancels oversize %s bodies without Content-Length', async phase => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(new TextEncoder().encode('é'.repeat(8193)));
        }, cancel });
        const oversized = new Response(body, { status: phase === 'exchange' ? 201 : 200,
            headers: { 'content-type': 'application/json' } });
        const fetcher = phase === 'exchange' ? vi.fn<typeof fetch>().mockResolvedValue(oversized)
            : vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(exchangeBody(), { status: 201 })).mockResolvedValueOnce(oversized);
        expect(await verify(fetcher)).toEqual(unavailable);
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('rejects declared oversize before consuming any body and cancels it', async () => {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 201,
            headers: { 'content-type': 'application/json', 'content-length': '16385' } });
        expect(await verify(vi.fn<typeof fetch>().mockResolvedValue(response))).toEqual(unavailable);
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('rejects invalid UTF-8 bytes instead of replacing characters in a success response', async () => {
        const response = new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 201,
            headers: { 'content-type': 'application/json' } });
        expect(await verify(vi.fn<typeof fetch>().mockResolvedValue(response))).toEqual(unavailable);
    });

    it.each(['fetch', 'body'] as const)('enforces a total deadline on a stalled %s even when transport ignores abort', async stall => {
        vi.useFakeTimers();
        const stalled = stalledBody();
        const fetcher = vi.fn<typeof fetch>(async () => stall === 'fetch' ? new Promise<Response>(() => {})
            : new Response(stalled.response.body, { status: 201, headers: stalled.response.headers }));
        const pending = verify(fetcher);
        let finished = false; void pending.then(() => { finished = true; });
        await vi.advanceTimersByTimeAsync(2999); expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual(unavailable);
        expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        if (stall === 'body') expect(stalled.cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('shares one total deadline across exchange and self rather than restarting per request', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>(resolve => {
            setTimeout(() => resolve(Response.json(exchangeBody(), { status: 201 })), 1800);
        })).mockImplementationOnce(() => new Promise<Response>(() => {}));
        const pending = verify(fetcher);
        await vi.advanceTimersByTimeAsync(1800); expect(fetcher).toHaveBeenCalledTimes(2);
        let finished = false; void pending.then(() => { finished = true; });
        await vi.advanceTimersByTimeAsync(1199); expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual(unavailable);
        for (const [, init] of fetcher.mock.calls) expect(init?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('refuses a grant that expires while the delegated self response is pending', async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...exchangeBody(),
            expires_at: '2026-10-26T12:00:01.000Z' }, { status: 201 }))
            .mockImplementationOnce(() => new Promise<Response>(resolve => {
                setTimeout(() => resolve(Response.json(meBody())), 1500);
            }));
        const pending = verifiedDelegatedAccount(request(), { config, fetch: fetcher });
        await vi.advanceTimersByTimeAsync(1500);
        expect(await pending).toEqual(unavailable);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not fetch for an already canceled request', async () => {
        const controller = new AbortController(); controller.abort(); const fetcher = fetchReplies();
        expect(await verify(fetcher, request(undefined, controller.signal))).toEqual(unavailable);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('returns immediately on caller cancellation and never exchanges a late response into a self request', async () => {
        vi.useFakeTimers(); const controller = new AbortController();
        let resolve!: (response: Response) => void;
        const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(done => { resolve = done; }));
        const pending = verify(fetcher, request(undefined, controller.signal));
        await vi.advanceTimersByTimeAsync(1); controller.abort();
        expect(await pending).toEqual(unavailable);
        expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        resolve(Response.json(exchangeBody(), { status: 201 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a stalled self body and removes the shared deadline timer', async () => {
        vi.useFakeTimers(); const controller = new AbortController(), stalled = stalledBody();
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(exchangeBody(), { status: 201 }))
            .mockResolvedValueOnce(stalled.response);
        const pending = verify(fetcher, request(undefined, controller.signal));
        await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2); controller.abort();
        expect(await pending).toEqual(unavailable);
        expect(stalled.cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never logs or reflects vendor bodies or credential-bearing failures', async () => {
        const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method =>
            vi.spyOn(console, method as 'log').mockImplementation(() => {}));
        const privateText = `${serviceToken} ${callerToken} ${grantToken} private@example.test`;
        for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new Error(privateText)),
            vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: privateText }, { status: 403 })),
            fetchReplies({ ...exchangeBody(), extra: privateText })]) {
            expect(await verify(fetcher)).toEqual(unavailable);
        }
        for (const log of logs) expect(log).not.toHaveBeenCalled();
    });
});
