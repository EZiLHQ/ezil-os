import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAwsCollaborators } from '@/server/api/routers/compute-dispatch';
import { db } from '@/server/db';
import { runAwsStopSettlement } from '@/server/lib/compute/aws-receipts';
import { GET, maxDuration } from './route';

const mockEnv = vi.hoisted(() => ({ CRON_SECRET: undefined as string | undefined }));
vi.mock('@/env', () => ({ env: mockEnv }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/api/routers/compute-dispatch', () => ({ defaultAwsCollaborators: vi.fn() }));
vi.mock('@/server/lib/compute/aws-receipts', () => ({ runAwsStopSettlement: vi.fn() }));

const request = (authorization?: string) => new Request('https://app.test/api/cron/aws-stop-settle', {
    headers: authorization === undefined ? {} : { authorization },
});

beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.CRON_SECRET = 'cron';
    vi.mocked(defaultAwsCollaborators).mockReturnValue({});
    vi.mocked(runAwsStopSettlement).mockResolvedValue({ ok: true, checked: 3, settled: 3 });
});

describe('GET /api/cron/aws-stop-settle', () => {
    it.each([undefined, 'Bearer wrong', 'Basic cron', 'bearer cron'])('rejects a missing or wrong bearer (%s)', async auth => {
        expect((await GET(request(auth))).status).toBe(404);
        expect(defaultAwsCollaborators).not.toHaveBeenCalled();
        expect(runAwsStopSettlement).not.toHaveBeenCalled();
    });

    it('fails closed when the cron secret is unset', async () => {
        mockEnv.CRON_SECRET = undefined;
        expect((await GET(request('Bearer undefined'))).status).toBe(404);
        expect(defaultAwsCollaborators).not.toHaveBeenCalled();
        expect(runAwsStopSettlement).not.toHaveBeenCalled();
    });

    it('wires only settlement collaborators with a time budget and returns counts', async () => {
        const executions = { describe: vi.fn() };
        const tunnels = { createTunnel: vi.fn(), deleteTunnel: vi.fn() };
        const meter = { ready: vi.fn(), stopped: vi.fn(), heartbeat: vi.fn() };
        vi.mocked(defaultAwsCollaborators).mockReturnValue({ executions, tunnels, meter, starter: { start: vi.fn() },
            describer: { describeForEnrollment: vi.fn() } });
        const response = await GET(request('Bearer cron'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, checked: 3, settled: 3 });
        expect(defaultAwsCollaborators).toHaveBeenCalledExactlyOnceWith(process.env);
        expect(runAwsStopSettlement).toHaveBeenCalledExactlyOnceWith(process.env, {
            db, executions, tunnels, meter, signal: expect.any(AbortSignal),
        });
        expect(maxDuration).toBe(45);
    });

    it('propagates pass failures so the timer client detects them', async () => {
        vi.mocked(runAwsStopSettlement).mockRejectedValue(new Error('db unavailable'));
        await expect(GET(request('Bearer cron'))).rejects.toThrow('db unavailable');
    });
});

describe('staging stop settlement schedule', () => {
    const root = path.resolve(__dirname, '../../../../../../deploy/aws/os-staging');
    const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

    it('runs settlement every minute in its own service while Cloudflare reap remains daily', () => {
        const timer = read('cron/ezil-os-staging-aws-stop-settle.timer');
        expect(timer).toMatch(/^OnCalendar=\*-\*-\* \*:\*:00 UTC$/m);
        expect(timer).toMatch(/^Unit=ezil-os-staging-aws-stop-settle.service$/m);
        expect(timer).toMatch(/^AccuracySec=1s$/m);
        const service = read('cron/ezil-os-staging-aws-stop-settle.service');
        expect(service).toContain('https://os-staging.ezil.work/api/cron/aws-stop-settle');
        expect(service).toContain('Authorization: Bearer ${CRON_SECRET}');
        expect(service).toContain('--max-time 50');
        expect(read('cron/ezil-os-staging-sandbox-reap.timer')).toMatch(/^OnCalendar=\*-\*-\* 04:08:00 UTC$/m);
    });

    it('includes both units in the installer archive allowlist and enabled jobs', () => {
        const installer = read('install-host.sh');
        const allowlist = installer.match(/\(("[a-z-]+"(?:, "[a-z-]+")*)\)\s*\n\s*for kind in/)?.[1] ?? '';
        expect(allowlist.split(', ')).toContain('"aws-stop-settle"');
        const jobs = installer.match(/^jobs=\(([a-z -]+)\)$/m)?.[1]?.split(' ') ?? [];
        expect(jobs).toContain('aws-stop-settle');
    });
});
