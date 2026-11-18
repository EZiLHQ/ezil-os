import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    NATIVE_EXCHANGE_RESPONSE_MAX_BYTES, NATIVE_EXCHANGE_TIMEOUT_MS, NATIVE_GATEWAY_EXCHANGE_URL, NativeExchangePreconditionError, exchangeNativeGrant,
    nativeExchangeConfig, nativeGrantCeiling, parseRfc3339, type NativeExchangeConfig,
} from './broker';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
// Synthetic c9-shaped secrets: prefix plus 32 bytes as 43 base64url characters. Not real credentials.
const opaque = (prefix: string, fill: number) => `${prefix}${Buffer.alloc(32, fill).toString('base64url')}`;
const SERVICE = opaque('ezs_', 0x5a);
const GRANT = opaque('ezg_', 0xa5);
const POLICY = '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b';
const GRANT_ID = '7d0c2b1e-3f4a-4b5c-8d6e-9f0a1b2c3d4e';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const proof = (expSeconds = NOW / 1000 + 3600) => `${b64({ alg: 'HS256' })}.${b64({ sub: 'u', exp: expSeconds })}.sig`;
const PROOF = proof();
const config = (overrides: Partial<NativeExchangeConfig> = {}): NativeExchangeConfig =>
    ({ policyId: POLICY, serviceCredential: SERVICE, serviceExpiresAt: new Date(NOW + 86_400_000), ...overrides });
/** Render an instant as PostgreSQL does in JSON: seconds, explicit numeric offset. */
const pgTimestamptz = (ms: number, offsetMinutes = 0) => {
    const local = new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 19);
    const sign = offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(offsetMinutes);
    return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};
const json = (body: unknown, status = 201, type = 'application/json; charset=utf-8') =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
const grantBody = (overrides: Record<string, unknown> = {}) =>
    ({ token_type: 'Bearer', access_token: GRANT, grant_id: GRANT_ID, expires_at: new Date(NOW + 240_000).toISOString(), ...overrides });

function harness(respond: (init: RequestInit) => Promise<Response> | Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return respond(init!);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl, run: (c = config(), token = PROOF, notAfter?: Date, timeoutMs?: number) =>
        exchangeNativeGrant(c, token, { fetchImpl, now: () => NOW, notAfter, timeoutMs }) };
}

afterEach(() => vi.restoreAllMocks());

describe('parseRfc3339', () => {
    it('accepts Z and explicit numeric offsets, including PostgreSQL +00:00, at the exact instant', () => {
        const instant = Date.parse('2026-11-16T17:30:00Z');
        for (const text of ['2026-11-16T17:30:00Z', '2026-11-16T17:30:00+00:00', '2026-11-16T23:00:00+05:30', '2026-11-16T12:30:00-05:00',
            '2026-11-16T17:30:00.000Z', '2026-11-16T17:30:00.000000+00:00']) {
            expect(parseRfc3339(text)?.getTime(), text).toBe(instant);
        }
        expect(parseRfc3339('2026-11-16T17:30:00.123456+00:00')?.getTime()).toBe(instant + 123);
        expect(parseRfc3339('2028-02-29T00:00:00Z')?.getTime()).toBe(Date.parse('2028-02-29T00:00:00Z'));
    });

    it('refuses impossible calendar values that Date.parse would normalise, and non-RFC 3339 shapes', () => {
        for (const text of ['2026-02-29T00:00:00Z', '2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z',
            '2026-11-16T24:00:00Z', '2026-11-16T23:60:00Z', '2026-11-16T23:59:60Z', '2026-11-16T17:30:00+24:00', '2026-11-16T17:30:00+05:60',
            '2026-11-16T17:30:00', '2026-11-16 17:30:00Z', '2026-11-16T17:30:00z', '2026-11-16T17:30Z', '2026-11-16T17:30:00+0000',
            '0099-01-01T00:00:00Z', String(Date.parse('2026-11-16T17:30:00Z')), '', ' 2026-11-16T17:30:00Z']) {
            expect(parseRfc3339(text), text).toBeNull();
        }
        expect(parseRfc3339(Date.parse('2026-11-16T17:30:00Z'))).toBeNull();
    });
});

describe('nativeExchangeConfig', () => {
    const env = { EZIL_NATIVE_GATEWAY_POLICY_ID: POLICY, EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: SERVICE,
        EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: '2026-11-17T00:00:00+00:00' };
    it('accepts only a complete, c9-shaped, unexpired sealed configuration', () => {
        expect(nativeExchangeConfig(env, NOW)).toEqual({ policyId: POLICY, serviceCredential: SERVICE, serviceExpiresAt: new Date('2026-11-17T00:00:00Z') });
        for (const broken of [{ EZIL_NATIVE_GATEWAY_POLICY_ID: undefined }, { EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: undefined },
            { EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: undefined }, { EZIL_NATIVE_GATEWAY_POLICY_ID: 'native-staging-v1' },
            { EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: GRANT }, { EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: `ezs_${'S'.repeat(40)}` },
            { EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: `${SERVICE}A` }, { EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: `${SERVICE.slice(0, -2)}\r\n` },
            { EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: '2026-11-16T11:59:59Z' }, { EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: '2026-02-30T00:00:00Z' },
            { EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: 'tomorrow' }]) {
            expect(nativeExchangeConfig({ ...env, ...broken }, NOW), JSON.stringify(broken)).toBeNull();
        }
    });

    it('reports the latest grant c9 can issue: the whole exchange budget plus five minutes, capped by proof and service', () => {
        expect(nativeGrantCeiling(config(), PROOF, NOW)).toEqual(new Date(NOW + NATIVE_EXCHANGE_TIMEOUT_MS + 300_000));
        expect(nativeGrantCeiling(config(), PROOF, NOW, 2_000)).toEqual(new Date(NOW + 302_000));
        expect(nativeGrantCeiling(config(), proof(NOW / 1000 + 120), NOW)).toEqual(new Date(NOW + 120_000));
        expect(nativeGrantCeiling(config({ serviceExpiresAt: new Date(NOW + 60_000) }), PROOF, NOW)).toEqual(new Date(NOW + 60_000));
        expect(nativeGrantCeiling(config(), proof(NOW / 1000 - 1), NOW)).toBeNull();
        expect(nativeGrantCeiling(config(), 'opaque', NOW)).toBeNull();
    });
});

describe('exchangeNativeGrant (Gateway c9 wire)', () => {
    it('sends exactly one fixed POST with the service bearer and the three-field body', async () => {
        const h = harness(() => json(grantBody()));
        const result = await h.run();
        expect(result).toEqual({ kind: 'granted', grant: { accessToken: GRANT, grantId: GRANT_ID, expiresAt: new Date(NOW + 240_000) } });
        expect(h.calls).toHaveLength(1);
        const { url, init } = h.calls[0]!;
        expect(url).toBe(NATIVE_GATEWAY_EXCHANGE_URL);
        expect(url).toBe('https://ai-staging.ezil.work/v1/token/exchange');
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit' });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.headers).toEqual({ accept: 'application/json', authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' });
        expect(JSON.parse(String(init.body))).toEqual({ policyId: POLICY, proofKind: 'supabase', subjectToken: PROOF });
        expect(Object.keys(JSON.parse(String(init.body)))).toEqual(['policyId', 'proofKind', 'subjectToken']);
    });

    it('bounds expiry by five minutes, the proof, the sealed service credential and notAfter', async () => {
        const at = (ms: number) => ({ expires_at: new Date(NOW + ms).toISOString() });
        const cases: [string, Record<string, unknown>, Partial<NativeExchangeConfig>, string, Date | undefined, boolean][] = [
            ['exactly five minutes', at(300_000), {}, PROOF, undefined, true],
            ['beyond five minutes', at(300_001), {}, PROOF, undefined, false],
            ['already expired', at(0), {}, PROOF, undefined, false],
            ['beyond the proof', at(120_000), {}, proof(NOW / 1000 + 60), undefined, false],
            ['within the proof', at(60_000), {}, proof(NOW / 1000 + 60), undefined, true],
            ['beyond the service credential', at(120_000), { serviceExpiresAt: new Date(NOW + 60_000) }, PROOF, undefined, false],
            // A lease too short for a c9 grant never reaches the wire (see the send-time re-admission test).
            ['within an admitted lease', at(240_000), {}, PROOF, new Date(NOW + 400_000), true],
        ];
        for (const [name, body, c, token, notAfter, ok] of cases) {
            const result = await harness(() => json(grantBody(body))).run(config(c), token, notAfter);
            expect(result.kind, name).toBe(ok ? 'granted' : 'unknown');
        }
    });

    it('accepts the c9 wire rendering of expires_at (PostgreSQL timestamptz, +00:00 or another offset) at its exact instant', async () => {
        for (const offset of [0, 330, -300]) {
            const expires_at = pgTimestamptz(NOW + 240_000, offset);
            const result = await harness(() => json(grantBody({ expires_at }))).run();
            expect(result, expires_at).toEqual({ kind: 'granted', grant: { accessToken: GRANT, grantId: GRANT_ID, expiresAt: new Date(NOW + 240_000) } });
        }
        expect(pgTimestamptz(Date.parse('2026-11-16T17:30:00Z'))).toBe('2026-11-16T17:30:00+00:00');
        for (const expires_at of [pgTimestamptz(NOW + 301_000), pgTimestamptz(NOW - 1000), '2026-11-16T12:04:00', '2026-02-30T12:04:00+00:00']) {
            expect(await harness(() => json(grantBody({ expires_at }))).run(), expires_at).toEqual({ kind: 'unknown', reason: 'gateway_invalid_response' });
        }
    });

    it('measures the five minutes from response receipt: c9 stamps expiry at issuance, after request latency', async () => {
        // The clock advances while the request is in flight; c9 issues at NOW+2s and returns issue + 300 s as +00:00.
        const delayed = (issueDelay: number, receiveDelay: number, overrides: { c?: Partial<NativeExchangeConfig>; token?: string; notAfter?: Date } = {}) => {
            let clock = NOW;
            const fetchImpl = vi.fn(async () => {
                clock = NOW + receiveDelay;
                return json(grantBody({ expires_at: pgTimestamptz(NOW + issueDelay + 300_000) }));
            }) as unknown as typeof fetch;
            return { fetchImpl, run: () => exchangeNativeGrant(config(overrides.c), overrides.token ?? PROOF,
                { fetchImpl, now: () => clock, notAfter: overrides.notAfter }) };
        };
        const ok = delayed(2_000, 2_000);
        expect(await ok.run()).toEqual({ kind: 'granted', grant: { accessToken: GRANT, grantId: GRANT_ID, expiresAt: new Date(NOW + 302_000) } });
        expect(ok.fetchImpl).toHaveBeenCalledTimes(1);
        // Issued before receipt (network delay on the way back): still within five minutes of receipt.
        expect((await delayed(1_000, 3_000).run()).kind).toBe('granted');

        const negatives: [string, ReturnType<typeof delayed>, string][] = [
            ['proof ends before the issued expiry', delayed(2_000, 2_000, { token: proof(NOW / 1000 + 301) }), 'gateway_invalid_response'],
            ['service credential ends before it', delayed(2_000, 2_000, { c: { serviceExpiresAt: new Date(NOW + 301_000) } }), 'gateway_invalid_response'],
            ['more than five minutes after receipt', delayed(4_000, 2_000), 'gateway_invalid_response'],
            ['answer later than the exchange budget', delayed(NATIVE_EXCHANGE_TIMEOUT_MS + 1_000, NATIVE_EXCHANGE_TIMEOUT_MS + 1_000), 'gateway_timeout'],
        ];
        for (const [name, d, reason] of negatives) {
            expect(await d.run(), name).toEqual({ kind: 'unknown', reason });
            expect(d.fetchImpl, name).toHaveBeenCalledTimes(1);
        }
    });

    it('re-admits on the send-time clock: an admitted lease that cannot hold budget plus five minutes is never sent', async () => {
        const ceiling = NOW + NATIVE_EXCHANGE_TIMEOUT_MS + 300_000;
        for (const notAfter of [ceiling, ceiling - 1, NOW + 301_000, NOW]) {
            const h = harness(() => json(grantBody()));
            const error = await h.run(config(), PROOF, new Date(notAfter)).catch(e => e);
            expect(error).toBeInstanceOf(NativeExchangePreconditionError);
            expect(error.reason).toBe('lease_boundary');
            expect(h.calls).toHaveLength(0);
        }
        const fits = harness(() => json(grantBody()));
        expect((await fits.run(config(), PROOF, new Date(ceiling + 1))).kind).toBe('granted');
        expect(fits.calls).toHaveLength(1);
    });

    it('treats every malformed 201 as unknown (a grant may exist) and never retries', async () => {
        const bad: [string, unknown, string?][] = [
            ['wrong token type', grantBody({ token_type: 'bearer' })], ['no ezg prefix', grantBody({ access_token: `abc_${'G'.repeat(40)}` })],
            ['service prefix', grantBody({ access_token: SERVICE })], ['echoed proof', grantBody({ access_token: PROOF })],
            ['short token', grantBody({ access_token: 'ezg_short' })], ['40-char token', grantBody({ access_token: `ezg_${'G'.repeat(40)}` })],
            ['44-char token', grantBody({ access_token: `${GRANT}A` })], ['bad grant id', grantBody({ grant_id: 'not-a-uuid' })],
            ['non-ISO expiry', grantBody({ expires_at: String(NOW + 60_000) })], ['impossible calendar', grantBody({ expires_at: '2026-11-31T12:02:00+00:00' })],
            ['extra field', { ...grantBody(), refresh_token: 'x' }], ['missing field', { token_type: 'Bearer', access_token: GRANT, grant_id: GRANT_ID }],
            ['array', [grantBody()]], ['not JSON', '{"token_type":'], ['wrong content type', grantBody(), 'text/plain'],
            ['oversized', { ...grantBody(), pad: 'x'.repeat(NATIVE_EXCHANGE_RESPONSE_MAX_BYTES) }],
        ];
        for (const [name, body, type] of bad) {
            const h = harness(() => json(body, 201, type));
            expect(await h.run(), name).toEqual({ kind: 'unknown', reason: 'gateway_invalid_response' });
            expect(h.calls, name).toHaveLength(1);
        }
    });

    it('maps a clean 4xx to a definite refusal without reading the body, and 5xx/redirect/network to unknown', async () => {
        for (const status of [400, 401, 403, 409, 429]) {
            const cancel = vi.fn();
            const body = new ReadableStream({ cancel });
            const h = harness(() => new Response(body, { status }));
            expect(await h.run()).toEqual({ kind: 'refused', status });
            expect(cancel).toHaveBeenCalled();
        }
        for (const status of [500, 502, 503]) expect(await harness(() => json({}, status)).run()).toEqual({ kind: 'unknown', reason: 'gateway_unavailable' });
        expect(await harness(() => json(grantBody(), 200)).run()).toEqual({ kind: 'unknown', reason: 'gateway_invalid_response' });
        expect(await harness(() => { throw new TypeError('fetch failed: unexpected redirect'); }).run()).toEqual({ kind: 'unknown', reason: 'gateway_unavailable' });
    });

    it('times out headers and stalled bodies as unknown, once', async () => {
        const stalled = harness(init => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
        expect(await stalled.run(config(), PROOF, undefined, 20)).toEqual({ kind: 'unknown', reason: 'gateway_timeout' });
        expect(stalled.calls).toHaveLength(1);
        const slowBody = harness(init => new Response(new ReadableStream({
            start(controller) { init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason)); },
        }), { status: 201, headers: { 'content-type': 'application/json' } }));
        expect(await slowBody.run(config(), PROOF, undefined, 20)).toEqual({ kind: 'unknown', reason: 'gateway_timeout' });
        expect(slowBody.calls).toHaveLength(1);
    });

    it('refuses to send with an unreadable or expired proof or an expired service credential', async () => {
        for (const [c, token] of [[config(), 'opaque-token'], [config(), proof(NOW / 1000 - 1)],
            [config({ serviceExpiresAt: new Date(NOW) }), PROOF]] as const) {
            const h = harness(() => json(grantBody()));
            await expect(h.run(c, token)).rejects.toBeInstanceOf(NativeExchangePreconditionError);
            expect(h.calls).toHaveLength(0);
        }
    });

    it('never puts the service credential, the proof or a body in any outcome or log', async () => {
        const logs: unknown[] = [];
        for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...a) => { logs.push(a); });
        const outcomes = [
            await harness(() => json(grantBody({ access_token: PROOF }))).run(),
            await harness(() => json({ error: SERVICE, detail: PROOF }, 401)).run(),
            await harness(() => json({ error: SERVICE }, 503)).run(),
            await harness(() => { throw new Error(`boom ${SERVICE} ${PROOF}`); }).run(),
        ];
        const text = JSON.stringify([outcomes, logs]);
        for (const secret of [SERVICE, PROOF, 'ezs_', 'ezg_']) expect(text).not.toContain(secret);
        expect(logs).toEqual([]);
    });
});
