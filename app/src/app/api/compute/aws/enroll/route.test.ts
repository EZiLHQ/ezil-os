/**
 * The enroll route is a thin wrapper: JSON parsing, no-store, and the
 * fail-closed wiring (no EC2 describer yet → 503, nothing consumed).
 */
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
const deferred = vi.hoisted(() => vi.fn());
const prime = vi.hoisted(() => vi.fn());
vi.mock('next/server', async importOriginal => ({ ...await importOriginal<typeof import('next/server')>(), after: deferred }));
vi.mock('@/server/lib/compute/aws-pool-session', () => ({ primePoolRelay: prime }));
vi.mock('@/server/db', () => ({ db: { execute: vi.fn(), transaction: vi.fn() } }));
vi.mock('@/server/lib/compute/aws-enroll', () => ({
    handleAwsEnrollment: (...args: unknown[]) => handle(...args),
    workerTunnelClientFromEnv: () => ({ createTunnel: vi.fn(), deleteTunnel: vi.fn() }),
}));

const { POST } = await import('./route');
const { awsEnrollmentDescriber } = await import('@/server/lib/compute/aws-describer');
const { resetEnrollRefusalLogForTests } = await import('@/server/lib/compute/aws-enroll-log');

const post = (body: string) => POST(new Request('https://app.example.test/api/compute/aws/enroll', { method: 'POST', body, headers: { 'content-type': 'application/json' } }));

beforeEach(() => resetEnrollRefusalLogForTests());
afterEach(() => { handle.mockReset(); deferred.mockReset(); prime.mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('POST /api/compute/aws/enroll', () => {
    const enrollment = { computerId: 'computer', ownerUserId: 'owner', generation: 4, leaseEpoch: 9,
        instanceId: 'instance', fenceToken: 'fence' };
    it('defers relay preparation until after the credential response and never returns the server-only binding', async () => {
        handle.mockResolvedValue({ status: 200, body: { tunnelToken: 'test-token' }, poolRelay: enrollment });
        const r = await post('{}');
        expect(await r.json()).toEqual({ tunnelToken: 'test-token' });
        expect(deferred).toHaveBeenCalledTimes(1);
        expect(prime).not.toHaveBeenCalled();
        await deferred.mock.calls[0]![0]();
        expect(prime).toHaveBeenCalledWith(expect.objectContaining({ env: process.env }), enrollment);
    });

    it.each([200, 403, 503])('does not prepare without an authenticated successful pool binding (%i)', async status => {
        handle.mockResolvedValue({ status, body: {}, ...(status !== 200 ? { poolRelay: enrollment } : {}) });
        await post('{}'); expect(deferred).not.toHaveBeenCalled(); expect(prime).not.toHaveBeenCalled();
    });

    it('preserves a successful enrollment if background scheduling fails', async () => {
        handle.mockResolvedValue({ status: 200, body: { tunnelToken: 'test-token' }, poolRelay: enrollment });
        deferred.mockImplementation(() => { throw new Error('no after context'); });
        const r = await post('{}'); expect(r.status).toBe(200); expect(await r.json()).toEqual({ tunnelToken: 'test-token' });
    });

    it('invalid JSON → 400 enroll_request_invalid, no-store, handler not called', async () => {
        const r = await post('{');
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'enroll_request_invalid' });
        expect(r.headers.get('cache-control')).toBe('no-store');
        expect(handle).not.toHaveBeenCalled();
    });

    it('passes the parsed body and answers with the handler status and body, no-store', async () => {
        handle.mockResolvedValue({ status: 403, body: { error: 'enroll_state' } });
        const r = await post(JSON.stringify({ computerId: 'x' }));
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'enroll_state' });
        expect(r.headers.get('cache-control')).toBe('no-store');
        expect(handle.mock.calls[0]![1]).toEqual({ computerId: 'x' });
    });

    it('Codex PR #200: an unexpected throw is a STRUCTURED retryable 503, never an unstructured 500', async () => {
        handle.mockRejectedValue(new Error('connection terminated unexpectedly'));
        const r = await post('{}');
        expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ error: 'enroll_unavailable', retryable: true });
        expect(r.headers.get('cache-control')).toBe('no-store');
    });

    it('AWS off (this test environment): the handler receives no describer, so it answers 503 and consumes nothing', async () => {
        handle.mockResolvedValue({ status: 503, body: { error: 'enroll_unavailable' } });
        await post('{}');
        expect(awsEnrollmentDescriber({})).toBeNull();
        expect(handle.mock.calls[0]![0]).toMatchObject({ describer: null });
    });

    describe('[aws-enroll] refused log', () => {
        const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
        const NONCE = Buffer.alloc(32, 5).toString('base64url');
        const SIGNATURE = 'MIAGCSqGSIb3DQEHAqCAMIACAQExCzAJBgUrDgMCGgUAMIAGCSqGSIb3DQEHAaCAJIAEggHa';
        const hostBody = (computerId: string) => JSON.stringify({
            computerId, generation: 2, leaseEpoch: 3, nonce: NONCE, signature: SIGNATURE,
            identityDocument: JSON.stringify({ accountId: '123456789012', instanceId: 'i-0123456789abcdef0', privateIp: '10.0.0.12' }),
        });
        const host = hostBody(C1.toUpperCase());
        // What the handler attaches to a refusal once the request presented the epoch's nonce (aws-enroll.ts).
        const subject = { computerId: C1, generation: 2, leaseEpoch: 3 };
        const anonymous = { computerId: null, generation: null, leaseEpoch: null };
        const consoleOutput = () => (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

        it('a Worker tunnel failure: one bounded line with its detail; the host body carries none of it', async () => {
            const spies = consoleOutput();
            handle.mockResolvedValue({ status: 503, body: { error: 'tunnel_unavailable', retryable: true }, subject,
                tunnel: { code: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403' } });
            const r = await post(host);
            expect(r.status).toBe(503);
            expect(await r.json()).toEqual({ error: 'tunnel_unavailable', retryable: true });
            expect(console.warn).toHaveBeenCalledExactlyOnceWith('[aws-enroll] refused', {
                status: 503, error: 'tunnel_unavailable', retryable: true, ...subject,
                tunnel: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403',
            });
            const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
            for (const secret of [NONCE, SIGNATURE, '123456789012', 'i-0123456789abcdef0', '10.0.0.12']) expect(logged).not.toContain(secret);
        });

        it('a host retrying every few seconds logs once per distinct refusal per minute', async () => {
            consoleOutput();
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-31T00:00:00Z'));
            handle.mockResolvedValue({ status: 403, body: { error: 'enroll_instance_not_running', retryable: true }, subject });
            for (let i = 0; i < 10; i++) { await post(host); vi.setSystemTime(Date.now() + 5_000); }
            expect(console.warn).toHaveBeenCalledTimes(1);
            handle.mockResolvedValue({ status: 503, body: { error: 'enroll_describe_unavailable', retryable: true }, subject });
            await post(host);
            expect(console.warn).toHaveBeenCalledTimes(2);
            handle.mockResolvedValue({ status: 403, body: { error: 'enroll_instance_not_running', retryable: true }, subject });
            vi.setSystemTime(new Date('2026-10-31T00:01:00Z'));
            await post(host);
            expect(console.warn).toHaveBeenCalledTimes(3);
            expect(vi.mocked(console.warn).mock.calls[2]).toEqual(['[aws-enroll] refused', expect.objectContaining({ error: 'enroll_instance_not_running', suppressed: 9 })]);
        });

        it('invalid JSON and an unexpected throw are logged too, anonymously; a 200 never is', async () => {
            consoleOutput();
            await post('{');
            handle.mockRejectedValue(new Error(`connection terminated ${NONCE}`));
            await post(host);
            handle.mockResolvedValue({ status: 200, body: { tunnelToken: 'test-token' } });
            await post(host);
            expect(vi.mocked(console.warn).mock.calls).toEqual([
                ['[aws-enroll] refused', { status: 400, error: 'enroll_request_invalid', retryable: false, ...anonymous }],
                ['[aws-enroll] refused', { status: 503, error: 'enroll_unavailable', retryable: true, ...anonymous }],
            ]);
        });

        it('the body never names a line or its key: callers rotating computer ids before any nonce check get one line per error', async () => {
            consoleOutput();
            handle.mockResolvedValue({ status: 400, body: { error: 'enroll_request_invalid' } });
            for (let i = 0; i < 500; i++) await post(JSON.stringify({ computerId: randomUUID() }));
            handle.mockResolvedValue({ status: 404, body: { error: 'not_found', retryable: true } });
            for (let i = 0; i < 500; i++) await post(hostBody(randomUUID()));
            handle.mockResolvedValue({ status: 403, body: { error: 'enroll_nonce_invalid' } });
            for (let i = 0; i < 500; i++) await post(hostBody(randomUUID()));
            expect(vi.mocked(console.warn).mock.calls).toEqual([
                ['[aws-enroll] refused', { status: 400, error: 'enroll_request_invalid', retryable: false, ...anonymous }],
                ['[aws-enroll] refused', { status: 404, error: 'not_found', retryable: true, ...anonymous }],
                ['[aws-enroll] refused', { status: 403, error: 'enroll_nonce_invalid', retryable: false, ...anonymous }],
            ]);
            // A proven host interleaved with that flood is still logged under its own computer, once.
            handle.mockResolvedValue({ status: 503, body: { error: 'tunnel_unavailable', retryable: true }, subject, tunnel: { code: 'tunnel_http_502', detail: 'cf_api_403' } });
            for (let i = 0; i < 3; i++) await post(host);
            expect(vi.mocked(console.warn).mock.calls.slice(3)).toEqual([
                ['[aws-enroll] refused', { status: 503, error: 'tunnel_unavailable', retryable: true, ...subject, tunnel: 'tunnel_http_502', detail: 'cf_api_403' }],
            ]);
        });
    });

    it('the describer exists only with AWS on AND a caller role for every configured region', () => {
        const on = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_REGIONS: 'us-east-1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2' };
        expect(awsEnrollmentDescriber(on)).toBeNull();
        const wired = awsEnrollmentDescriber({ ...on, EZIL_AWS_APP_CALLER_ROLE_ARN_US_EAST_1: 'arn:aws:iam::123456789012:role/ezil/pilot/app-caller' });
        expect(typeof wired?.describeForEnrollment).toBe('function');
    });
});
