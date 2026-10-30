import { env } from '@/env';
import { routeComputer } from '@/server/api/routers/compute-dispatch';
import { getBillingDeps } from '@/server/billing/deps';
import { runningAwsComputersAfterEpochs } from '@/server/billing/store';
import { db } from '@/server/db';
import { newCorrelationId } from '@/server/lib/cloudflare-guacamole-provider';
import { readPlacement, type PlacementExecutor } from '@/server/lib/compute/placement';
import type { ComputerRef } from '@/server/lib/compute/provider';
import { stopComputerForPolicy } from '@/server/lib/compute/stop-policy';
import { handleBillingSessionSweep, HELD_LOOKBACK_MS, RUNNING_GRACE_MS } from './handler';

export const maxDuration = 300;

/**
 * The retry's running check. An AWS host counts only RUNNING since before `RUNNING_GRACE_MS` (round 6 CR-4):
 * LEASED/STARTING/MOUNTING after a policy close is a re-open booting, and a RUNNING row written just now may be one
 * whose epoch is being opened; neither is the closed session, so neither takes a stop under its reason.
 */
function isStillRunningAt(now: Date) {
    return async (computer: ComputerRef): Promise<boolean> => {
        try {
            const routed = await routeComputer(db, computer);
            if (routed.kind === 'aws-ec2') {
                const { record } = await readPlacement(db as unknown as PlacementExecutor, computer.computerId);
                return record?.ownerUserId === computer.userId && record.provider === 'aws-ec2' && record.state === 'RUNNING'
                    && now.getTime() - record.updatedAt.getTime() >= RUNNING_GRACE_MS;
            }
            const status = await routed.provider.status({ correlationId: newCorrelationId() }, computer);
            return status.ok && status.guacamoleRunning === true;
        } catch {
            return false;
        }
    };
}

/**
 * Placement proof for stale AWS epochs (round 3, D9). Unlike `isStillRunning`
 * this THROWS on any read error and never answers `running: false` for an
 * unproven placement, so the sweep closes metered time only on evidence.
 * `stoppedAt` stays null: the handler then closes at the epoch's last heartbeat.
 */
async function awsStopProof(computer: ComputerRef): Promise<{ running: boolean; stoppedAt: Date | null }> {
    const routed = await routeComputer(db, computer);
    if (routed.kind !== 'aws-ec2') return { running: true, stoppedAt: null };
    const { record } = await readPlacement(db as unknown as PlacementExecutor, computer.computerId);
    if (!record || record.ownerUserId !== computer.userId || record.provider !== 'aws-ec2') throw new Error('placement_unproven');
    return { running: ['RUNNING', 'LEASED', 'STARTING', 'MOUNTING'].includes(record.state), stoppedAt: null };
}

export async function GET(req: Request): Promise<Response> {
    if (!env.CRON_SECRET) return new Response(null, { status: 404 });
    if (req.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) return new Response(null, { status: 404 });
    const deps = getBillingDeps();
    const now = deps.now();
    const counts = await handleBillingSessionSweep({
        deps, now,
        // There is no session user in a cron: the epoch records the checked owner.
        stop: (computer, reason) => stopComputerForPolicy(db, computer, reason),
        isStillRunning: isStillRunningAt(now),
        awsStopProof,
        runningAwsPlacements: limit => runningAwsComputersAfterEpochs(db, new Date(now.getTime() - HELD_LOOKBACK_MS), limit),
    });
    return Response.json(counts);
}
