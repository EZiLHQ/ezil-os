/**
 * How a desktop CONTROL call (screen read/set, focus, relay refresh) addresses the Worker.
 *
 * An AWS computer's controls are signed v2 with `provider: "aws-ec2"` and the placement's
 * generation and lease epoch, so the Worker can tell the call is AWS even when the tunnel
 * record is absent or fenced, and REFUSE it (`aws_origin_unavailable`) instead of opening,
 * and so waking, a Cloudflare Sandbox of the same name (worker/src/index.ts
 * `awsControlTarget`). Every other computer keeps the exact legacy path: the v1 bearer and
 * the session user's sandbox name, with no database read while placement reads are off.
 */

import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';
import { isPlacementReadEnabled, type Env } from './aws-config';
import { PlacementOwnerError, readPlacement, type PlacementExecutor } from './placement';
import type { WorkerAuth } from './preview-token-v2';
import type { ComputerRef } from './provider';

export interface ControlTarget {
    sandboxName: string;
    auth: WorkerAuth;
}

/**
 * The control target for `computer` (the authenticated session user's). A placement owned by
 * someone else throws `PlacementOwnerError` (callers answer NOT_FOUND); a missing table or an
 * unreadable placement throws too: never Cloudflare by accident.
 */
export async function controlTargetFor(db: PlacementExecutor, computer: ComputerRef, env: Env = process.env): Promise<ControlTarget> {
    const legacy: ControlTarget = { sandboxName: deriveGuacamoleSandboxId(computer.userId, computer.computerId), auth: { kind: 'v1' } };
    if (!isPlacementReadEnabled(env)) return legacy;
    const { record } = await readPlacement(db, computer.computerId);
    if (!record) return legacy;
    // The placement's owner is authoritative for EVERY provider (C-2): ezil_computers is
    // user-writable, so a re-keyed row must not reach a foreign placement's sandbox, Cloudflare
    // or AWS. Same NOT_FOUND as routeComputer.
    if (record.ownerUserId !== computer.userId.toLowerCase()) throw new PlacementOwnerError(record.computerId);
    if (record.provider !== 'aws-ec2') return legacy;
    // Same derivation and claims as the AWS preview (aws-preview.ts) and the tunnel (aws-enroll.ts).
    const sandboxName = deriveGuacamoleSandboxId(record.ownerUserId, record.computerId);
    return {
        sandboxName,
        auth: {
            kind: 'v2',
            claims: {
                sandboxId: sandboxName,
                computerId: record.computerId,
                userId: record.ownerUserId,
                provider: 'aws-ec2',
                store: '',
                generation: record.generation,
                leaseEpoch: record.leaseEpoch,
            },
        },
    };
}
