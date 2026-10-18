/**
 * The enroll route is a thin wrapper: JSON parsing, no-store, and the
 * fail-closed wiring (no EC2 describer yet → 503, nothing consumed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('@/server/db', () => ({ db: { execute: vi.fn(), transaction: vi.fn() } }));
vi.mock('@/server/lib/compute/aws-enroll', () => ({
    handleAwsEnrollment: (...args: unknown[]) => handle(...args),
    workerTunnelClientFromEnv: () => ({ createTunnel: vi.fn(), deleteTunnel: vi.fn() }),
}));

const { POST } = await import('./route');
const { awsEnrollmentDescriber } = await import('@/server/lib/compute/aws-describer');

const post = (body: string) => POST(new Request('https://app.example.test/api/compute/aws/enroll', { method: 'POST', body, headers: { 'content-type': 'application/json' } }));

afterEach(() => handle.mockReset());

describe('POST /api/compute/aws/enroll', () => {
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

    it('the describer exists only with AWS on AND a caller role for every configured region', () => {
        const on = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_REGIONS: 'us-east-1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2' };
        expect(awsEnrollmentDescriber(on)).toBeNull();
        const wired = awsEnrollmentDescriber({ ...on, EZIL_AWS_APP_CALLER_ROLE_ARN_US_EAST_1: 'arn:aws:iam::123456789012:role/ezil/pilot/app-caller' });
        expect(typeof wired?.describeForEnrollment).toBe('function');
    });
});
