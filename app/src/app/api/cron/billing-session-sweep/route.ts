import { env } from '@/env';
import { routeComputer } from '@/server/api/routers/compute-dispatch';
import { getBillingDeps } from '@/server/billing/deps';
import { runningAwsComputersAfterEpochs } from '@/server/billing/store';
import { db } from '@/server/db';
import { newCorrelationId } from '@/server/lib/cloudflare-guacamole-provider';
import { isPlacementReadEnabled } from '@/server/lib/compute/aws-config';
import { readLastUsageStop, readPlacement, type PlacementExecutor } from '@/server/lib/compute/placement';
import type { ComputerRef } from '@/server/lib/compute/provider';
import { advanceReverseMoves } from '@/server/lib/compute/provider-reverse-runtime';
import { stopComputerForPolicy } from '@/server/lib/compute/stop-policy';
import { handleBillingSessionSweep, reverseMoveInFlightFor, RUNNING_GRACE_MS } from './handler';

export const maxDuration = 300;

/**
 * The retry's running check. An AWS host counts only RUNNING since before `RUNNING_GRACE_MS` (round 6 CR-4):
 * LEASED/STARTING/MOUNTING after a policy close is a re-open booting, and a RUNNING row written just now may be one
 * whose epoch is being opened; neither is the closed session, so neither takes a stop under its reason. Nor does a
 * host that stopped after the close (its usage row closed since, `readLastUsageStop`; a lease renewal never moves
 * that): what runs now is a later open (a held one is the held bound's).
 */
function isStillRunningAt(now: Date) {
    return async (computer: ComputerRef, closedAt: Date): Promise<boolean> => {
        try {
            const routed = await routeComputer(db, computer);
            if (routed.kind === 'aws-ec2') {
                const placements = db as unknown as PlacementExecutor;
                const { record } = await readPlacement(placements, computer.computerId);
                if (record?.ownerUserId !== computer.userId || record.provider !== 'aws-ec2' || record.state !== 'RUNNING'
                    || now.getTime() - record.updatedAt.getTime() < RUNNING_GRACE_MS) return false;
                const stopped = await readLastUsageStop(placements, computer.computerId, computer.userId);
                return stopped === null || stopped.getTime() < closedAt.getTime();
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
    let deps: ReturnType<typeof getBillingDeps>, now: Date;
    try {
        deps = getBillingDeps();
        now = deps.now();
    } catch (error) {
        // Phase B (§5.4, r7 fixer): the reverse pass is the only driver of a move's deadlines, so a billing fault before the
        // handler still runs it (it never throws); the sweep then fails as before.
        await advanceReverseMoves(Date.now());
        throw error;
    }
    const counts = await handleBillingSessionSweep({
        deps, now,
        // There is no session user in a cron: the epoch records the checked owner.
        stop: (computer, reason) => stopComputerForPolicy(db, computer, reason),
        isStillRunning: isStillRunningAt(now),
        awsStopProof,
        // The held bound reads placements (C-2, through placement.ts): only where placement reads are on, as sandbox-reap.
        ...(isPlacementReadEnabled(process.env)
            ? { runningAwsPlacements: (after: string | null, limit: number) => runningAwsComputersAfterEpochs(db, after, limit),
                reverseMoveInFlight: reverseMoveInFlightFor(db as unknown as PlacementExecutor) }
            : {}),
    });
    return Response.json(counts);
}
