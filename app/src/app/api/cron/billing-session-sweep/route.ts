import { env } from '@/env';
import { routeComputer } from '@/server/api/routers/compute-dispatch';
import { getBillingDeps } from '@/server/billing/deps';
import { db } from '@/server/db';
import { newCorrelationId } from '@/server/lib/cloudflare-guacamole-provider';
import { readPlacement, type PlacementExecutor } from '@/server/lib/compute/placement';
import type { ComputerRef } from '@/server/lib/compute/provider';
import { stopComputerForPolicy } from '@/server/lib/compute/stop-policy';
import { handleBillingSessionSweep } from './handler';

export const maxDuration = 300;

async function isStillRunning(computer: ComputerRef): Promise<boolean> {
    try {
        const routed = await routeComputer(db, computer);
        if (routed.kind === 'aws-ec2') {
            const { record } = await readPlacement(db as unknown as PlacementExecutor, computer.computerId);
            return record?.ownerUserId === computer.userId && record.provider === 'aws-ec2'
                && ['RUNNING', 'LEASED', 'STARTING', 'MOUNTING'].includes(record.state);
        }
        const status = await routed.provider.status({ correlationId: newCorrelationId() }, computer);
        return status.ok && status.guacamoleRunning === true;
    } catch {
        return false;
    }
}

export async function GET(req: Request): Promise<Response> {
    if (!env.CRON_SECRET) return new Response(null, { status: 404 });
    if (req.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) return new Response(null, { status: 404 });
    const deps = getBillingDeps();
    const counts = await handleBillingSessionSweep({
        deps, now: deps.now(),
        // There is no session user in a cron: the epoch records the checked owner.
        stop: (computer, reason) => stopComputerForPolicy(db, computer, reason),
        isStillRunning,
    });
    return Response.json(counts);
}
