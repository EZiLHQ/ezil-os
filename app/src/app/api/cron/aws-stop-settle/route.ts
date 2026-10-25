import { env } from '@/env';
import { defaultAwsCollaborators } from '@/server/api/routers/compute-dispatch';
import { db } from '@/server/db';
import { runAwsStopSettlement } from '@/server/lib/compute/aws-receipts';
import type { PlacementDb } from '@/server/lib/compute/placement';

// Separate from the daily Cloudflare reap; staging invokes this every minute.
export const maxDuration = 45;

export async function GET(req: Request): Promise<Response> {
    if (!env.CRON_SECRET || req.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) {
        return new Response(null, { status: 404 });
    }
    const { executions, tunnels, meter } = defaultAwsCollaborators(process.env);
    return Response.json(await runAwsStopSettlement(process.env, {
        db: db as unknown as PlacementDb, executions, tunnels, meter,
        signal: AbortSignal.timeout(40_000),
    }));
}
