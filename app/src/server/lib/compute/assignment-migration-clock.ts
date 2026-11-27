import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { assignmentAuthority, assignmentSigningSecret } from '@/server/assignment-video/authority';
import { workspaceIdentity } from '@/server/assignment-video/workspace-identity';
import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';
import type { PlacementExecutor } from './placement';

const path = '/internal/assignment-upgrade/event';
type ClockEvent = 'paused' | 'ready' | 'recovered';
type MigrationClock = {
    migration_id: string;
    computer_id: string;
    user_id: string;
    to_size: 'standard' | 'premium';
    paused_at: string | Date;
    pause_delivered_at: string | Date | null;
    resumed_at: string | Date | null;
    resume_event: 'ready' | 'recovered' | null;
};

function rows<T>(result: unknown): T[] {
    return (Array.isArray(result) ? result : (result as { rows?: T[] } | null)?.rows) as T[] ?? [];
}

export function assignmentMigrationClock(
    db: PlacementExecutor,
    env: Record<string, string | undefined> = process.env,
    fetcher: typeof fetch = fetch,
    now = Date.now,
) {
    const authority = assignmentAuthority(env);
    const secret = assignmentSigningSecret(env);
    if (!authority || !secret) return undefined;
    const endpoint = authority.universe + path;
    const signingSecret: string = secret;

    async function send(clock: MigrationClock, event: ClockEvent, occurredAt: string | Date): Promise<boolean> {
        const sandbox = deriveGuacamoleSandboxId(clock.user_id, clock.computer_id);
        const body = JSON.stringify({
            workspaceId: workspaceIdentity(clock.user_id, clock.computer_id, sandbox),
            operationId: clock.migration_id,
            event,
            occurredAt: new Date(occurredAt).toISOString(),
            targetTier: clock.to_size,
        });
        const time = String(now());
        const signature = createHmac('sha256', signingSecret)
            .update(time + '.POST ' + path + '.' + body).digest('hex');
        try {
            const response = await fetcher(endpoint, {
                method: 'POST', redirect: 'error', cache: 'no-store', body,
                headers: {
                    'content-type': 'application/json',
                    'X-Ezil-Repo-Open-Timestamp': time,
                    'X-Ezil-Repo-Open-Signature': signature,
                },
                signal: AbortSignal.timeout(2_000),
            });
            void response.body?.cancel().catch(() => {});
            return response.ok;
        } catch { return false; }
    }

    async function flush(migrationId: string): Promise<boolean> {
        const [clock] = rows<MigrationClock>(await db.execute(sql`
            SELECT c.*, m.computer_id::text, m.user_id::text, m.to_size
            FROM public.ezil_assignment_migration_clock c
            JOIN public.ezil_compute_migrations m ON m.id = c.migration_id
            WHERE c.migration_id = ${migrationId}::uuid AND c.resume_delivered_at IS NULL
        `));
        if (!clock) return true;
        if (!clock.pause_delivered_at) {
            if (!await send(clock, 'paused', clock.paused_at)) return false;
            await db.execute(sql`
                UPDATE public.ezil_assignment_migration_clock SET pause_delivered_at = clock_timestamp()
                WHERE migration_id = ${migrationId}::uuid AND pause_delivered_at IS NULL
            `);
        }
        if (clock.resume_event && clock.resumed_at) {
            if (!await send(clock, clock.resume_event, clock.resumed_at)) return false;
            await db.execute(sql`
                UPDATE public.ezil_assignment_migration_clock SET resume_delivered_at = clock_timestamp()
                WHERE migration_id = ${migrationId}::uuid AND resume_delivered_at IS NULL
            `);
        }
        return true;
    }

    async function pendingCompletions(limit: number): Promise<string[]> {
        return rows<{ migration_id: string }>(await db.execute(sql`
            SELECT migration_id::text FROM public.ezil_assignment_migration_clock
            WHERE resumed_at IS NOT NULL AND resume_delivered_at IS NULL
            ORDER BY resumed_at, migration_id LIMIT ${limit}
        `)).map(row => row.migration_id);
    }

    return { flush, pendingCompletions };
}
