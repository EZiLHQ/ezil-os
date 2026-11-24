import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assignmentMigrationClock } from './assignment-migration-clock';
import type { PlacementExecutor } from './placement';
import { workspaceIdentity } from '@/server/assignment-video/workspace-identity';
import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';

const secret = 'fixture-only-signing-secret-long-enough';
const env = { BILLING_FUNDING_URL: 'https://ai-staging.ezil.work', UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET: secret };
const migration = {
    migration_id: '34292585-ae74-4e0d-a7ab-22e88065e468',
    computer_id: '7534bcb6-4e1a-4b25-8cc1-1071dfbf14d1',
    user_id: '1838bd7d-567a-4def-81a0-ab7f21860428',
    to_size: 'premium',
    paused_at: '2026-11-24T11:00:01.000Z',
    pause_delivered_at: null,
    resumed_at: '2026-11-24T11:05:01.000Z',
    resume_event: 'ready',
};
const endpoint = 'https://universe-staging.ezil.work/internal/assignment-upgrade/event';
const time = Date.parse('2026-11-24T11:06:00.000Z');

function fixture() {
    const execute = vi.fn<PlacementExecutor['execute']>();
    const db = { execute } as unknown as PlacementExecutor;
    const fetcher = vi.fn<typeof fetch>();
    return { execute, db, fetcher, clock: assignmentMigrationClock(db, env, fetcher, () => time)! };
}

describe('the provider migration assignment clock outbox', () => {
    it('delivers the exact workspace-bound signed pause before a verified ready event', async () => {
        const { execute, fetcher, clock } = fixture();
        execute.mockResolvedValueOnce([migration] as never).mockResolvedValue([] as never);
        fetcher.mockImplementation(async () => new Response(null, { status: 204 }));
        await expect(clock.flush(migration.migration_id)).resolves.toBe(true);
        expect(execute).toHaveBeenCalledTimes(3);
        expect(fetcher).toHaveBeenCalledTimes(2);
        const sandbox = deriveGuacamoleSandboxId(migration.user_id, migration.computer_id);
        const binding = workspaceIdentity(migration.user_id, migration.computer_id, sandbox);
        for (const [index, event, occurredAt] of [[0,'paused',migration.paused_at],[1,'ready',migration.resumed_at]] as const) {
            const [target, request] = fetcher.mock.calls[index];
            expect(target).toBe(endpoint);
            expect(request).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
            expect(JSON.parse(String(request?.body))).toEqual({
                workspaceId: binding, operationId: migration.migration_id, event, occurredAt, targetTier: 'premium',
            });
            const headers = new Headers(request?.headers);
            expect(headers.get('X-Ezil-Repo-Open-Timestamp')).toBe(String(time));
            expect(headers.get('X-Ezil-Repo-Open-Signature')).toBe(createHmac('sha256', secret)
                .update(time + '.POST /internal/assignment-upgrade/event.' + request?.body).digest('hex'));
        }
    });

    it('replays a pending pause with the same occurrence and delivers recovery after acknowledgment', async () => {
        const { execute, fetcher, clock } = fixture();
        execute.mockResolvedValueOnce([{ ...migration, resume_event: 'recovered' }] as never);
        fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
        await expect(clock.flush(migration.migration_id)).resolves.toBe(false);
        expect(execute).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledOnce();

        execute.mockResolvedValueOnce([{ ...migration, resume_event: 'recovered' }] as never).mockResolvedValue([] as never);
        fetcher.mockImplementation(async () => new Response(null, { status: 200 }));
        await expect(clock.flush(migration.migration_id)).resolves.toBe(true);
        expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
        expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({ event: 'recovered', occurredAt: migration.resumed_at });
    });

    it('retries only a pending completion after a delivered pause', async () => {
        const { execute, fetcher, clock } = fixture();
        execute.mockResolvedValueOnce([{ ...migration, pause_delivered_at: migration.paused_at }] as never).mockResolvedValue([] as never);
        fetcher.mockImplementation(async () => new Response(null, { status: 200 }));
        await expect(clock.flush(migration.migration_id)).resolves.toBe(true);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ event: 'ready' });
    });

    it('never contacts Universe without a trusted source migration or deployment pairing', async () => {
        const { execute, fetcher, clock, db } = fixture();
        execute.mockResolvedValue([] as never);
        await expect(clock.flush(migration.migration_id)).resolves.toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
        expect(assignmentMigrationClock(db, { ...env, UNIVERSE_PROJECT_REPO_ORIGIN: 'https://evil.example' }, fetcher)).toBeUndefined();
    });
});
