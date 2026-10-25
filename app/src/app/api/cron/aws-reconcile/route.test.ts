import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAwsCollaborators } from '@/server/api/routers/compute-dispatch';
import { db } from '@/server/db';
import { createPoolDeps } from '@/server/lib/compute/aws-pool-runtime';
import { runAwsBackgroundReconcile } from '@/server/lib/compute/aws-receipts';
import { GET, maxDuration } from './route';

const mockEnv = vi.hoisted(() => ({ CRON_SECRET: undefined as string | undefined }));
vi.mock('@/env', () => ({ env: mockEnv }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/api/routers/compute-dispatch', () => ({ defaultAwsCollaborators: vi.fn() }));
vi.mock('@/server/lib/compute/aws-pool-runtime', () => ({ createPoolDeps: vi.fn() }));
vi.mock('@/server/lib/compute/aws-receipts', () => ({ runAwsBackgroundReconcile: vi.fn() }));

const request = (authorization?: string) => new Request('https://app.test/api/cron/aws-reconcile', {
    headers: authorization === undefined ? {} : { authorization },
});
const untouched = () => {
    expect(defaultAwsCollaborators).not.toHaveBeenCalled();
    expect(createPoolDeps).not.toHaveBeenCalled();
    expect(runAwsBackgroundReconcile).not.toHaveBeenCalled();
};

beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.CRON_SECRET = 'cron';
    vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', '1');
    vi.mocked(defaultAwsCollaborators).mockReturnValue({});
    vi.mocked(runAwsBackgroundReconcile).mockResolvedValue({ ok: true,
        deleted: { checked: 0, retiresStarted: 0, retired: 0, stuck: 0 }, fleet: { checked: 2, stopsStarted: 1, limitStops: 0 } });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('GET /api/cron/aws-reconcile', () => {
    it.each([undefined, 'Bearer wrong', 'Basic cron', 'bearer cron', 'Bearer', 'Bearer cronx'])('404s a missing or wrong bearer (%s) before any dependency', async auth => {
        const res = await GET(request(auth));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('');
        untouched();
    });

    it.each([undefined, ''])('fails closed when CRON_SECRET is %j, even for "Bearer undefined"/"Bearer "', async secret => {
        mockEnv.CRON_SECRET = secret;
        expect((await GET(request('Bearer undefined'))).status).toBe(404);
        expect((await GET(request('Bearer '))).status).toBe(404);
        untouched();
    });

    it.each([undefined, '0', 'true', 'on'])('kill switch: EZIL_AWS_COMPUTERS_ENABLED=%j skips without building collaborators', async flag => {
        if (flag === undefined) vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', undefined as unknown as string);
        else vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', flag);
        const res = await GET(request('Bearer cron'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, skipped: 'aws_disabled' });
        expect(res.headers.get('cache-control')).toBe('no-store');
        untouched();
    });

    it('runs exactly the existing full reconcile once, with its own bounds and a time budget', async () => {
        const collaborators = { executions: { describe: vi.fn() }, starter: { start: vi.fn() }, tunnels: { createTunnel: vi.fn(), deleteTunnel: vi.fn() },
            describer: { describeForEnrollment: vi.fn() }, meter: { ready: vi.fn(), stopped: vi.fn(), heartbeat: vi.fn() } };
        const pool = { marker: 'pool-deps' };
        vi.mocked(defaultAwsCollaborators).mockReturnValue(collaborators as never);
        vi.mocked(createPoolDeps).mockReturnValue(pool as never);
        const res = await GET(request('Bearer cron'));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toMatchObject({ ok: true, fleet: { checked: 2, stopsStarted: 1 } });
        expect(defaultAwsCollaborators).toHaveBeenCalledExactlyOnceWith(process.env);
        expect(createPoolDeps).toHaveBeenCalledExactlyOnceWith(db, process.env);
        // Two arguments only: no limit override, so the function's own per-pass bounds apply.
        expect(vi.mocked(runAwsBackgroundReconcile).mock.calls).toEqual([[process.env, { db, ...collaborators, pool, signal: expect.any(AbortSignal) }]]);
        const signal = vi.mocked(runAwsBackgroundReconcile).mock.calls[0]![1].signal!;
        expect(signal.aborted).toBe(false);
        // The provider collaborators are handed over, never called by the route itself.
        expect(collaborators.starter.start).not.toHaveBeenCalled();
        expect(collaborators.executions.describe).not.toHaveBeenCalled();
        expect(maxDuration).toBe(50);
    });

    it('propagates a failed pass so the timer client (curl -f) reports it', async () => {
        vi.mocked(runAwsBackgroundReconcile).mockRejectedValue(new Error('db unavailable'));
        await expect(GET(request('Bearer cron'))).rejects.toThrow('db unavailable');
    });
});

describe('staging minute schedule for the full reconcile', () => {
    const root = path.resolve(__dirname, '../../../../../../deploy/aws/os-staging');
    const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

    it('has its own service and minute timer targeting the real route, with the shared cron secret file', () => {
        const timer = read('cron/ezil-os-staging-aws-reconcile.timer');
        expect(timer).toMatch(/^OnCalendar=\*-\*-\* \*:\*:00 UTC$/m);
        expect(timer).toMatch(/^Unit=ezil-os-staging-aws-reconcile.service$/m);
        expect(timer).toMatch(/^AccuracySec=1s$/m);
        const service = read('cron/ezil-os-staging-aws-reconcile.service');
        expect(service).toContain('https://os-staging.ezil.work/api/cron/aws-reconcile');
        expect(service).toContain('Authorization: Bearer ${CRON_SECRET}');
        expect(service).toContain('EnvironmentFile=/etc/ezil-os-staging/cron.env');
        expect(service).toContain('--max-time 50');
        expect(service).toMatch(/^Type=oneshot$/m);
    });

    it('keeps the existing stop-settle minute timer and the daily reap unchanged', () => {
        expect(read('cron/ezil-os-staging-aws-stop-settle.service')).toContain('https://os-staging.ezil.work/api/cron/aws-stop-settle');
        expect(read('cron/ezil-os-staging-aws-stop-settle.timer')).toMatch(/^OnCalendar=\*-\*-\* \*:\*:00 UTC$/m);
        expect(read('cron/ezil-os-staging-sandbox-reap.timer')).toMatch(/^OnCalendar=\*-\*-\* 04:08:00 UTC$/m);
    });

    it('is in the installer archive allowlist and the enabled jobs', () => {
        const installer = read('install-host.sh');
        const allowlist = installer.match(/\(("[a-z-]+"(?:, "[a-z-]+")*)\)\s*\n\s*for kind in/)?.[1]?.split(', ') ?? [];
        expect(allowlist).toContain('"aws-reconcile"');
        expect(allowlist).toContain('"aws-stop-settle"');
        const jobs = installer.match(/^jobs=\(([a-z -]+)\)$/m)?.[1]?.split(' ') ?? [];
        expect(jobs).toContain('aws-reconcile');
        expect(jobs).toContain('aws-stop-settle');
    });
});
