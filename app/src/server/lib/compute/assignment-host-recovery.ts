import { sql } from 'drizzle-orm';
import { awsStandaloneGitEnabled } from '@/server/git/staging';
import { isAwsComputersEnabled, type Env } from './aws-config';
import { sharedAwsSdkCollaborators } from './aws-clients';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import { parseRebaseJson } from './aws-rebase-json';
import { rebaseReleaseCandidates } from './aws-rebase-release';
import type { Placement, PlacementExecutor } from './placement';

// The reviewed shared-lower pair. Other releases need their own compatibility evidence.
const LEGACY_AGENT = '9e9e789ceb06344a6ff7982d71ea8bc9209c9050';
const CORRECTED_AGENT = 'd9038defed2f61039ded5b9f9a656c8643c190c9';

/** A notice for the current owner only. It neither grants assignment access nor initiates a lifecycle operation. */
export async function assignmentHostNeedsStop(db: PlacementExecutor, p: Placement, env: Env): Promise<boolean> {
    if (p.provider !== 'aws-ec2' || p.state !== 'RUNNING' || p.region !== 'ap-south-1' || !p.instanceId
        || !p.volumeId || !p.fenceToken || !isAwsComputersEnabled(env) || !awsStandaloneGitEnabled(env)
        || (env.EZIL_AWS_KILL_SWITCH !== undefined && env.EZIL_AWS_KILL_SWITCH !== '0')) return false;
    try {
        const map = parseRebaseJson(env[LIFECYCLE_DEPLOYMENTS_ENV] ?? '{}', 65536) as Record<string, { lowerImageDigest?: string }>;
        const entry = map[p.region];
        const { sources, target } = rebaseReleaseCandidates(entry, entry?.lowerImageDigest ?? null);
        if (target.namespace !== 'prd' || target.region !== p.region || target.agentCommit !== CORRECTED_AGENT || target.recipeVersion !== '1.0.12') return false;
        const legacy = sources.filter(r => r.accountId === target.accountId && r.region === target.region
            && r.namespace === target.namespace && r.lowerImageRef === target.lowerImageRef
            && r.agentCommit === LEGACY_AGENT && r.recipeVersion === '1.0.8');
        if (legacy.length !== 1 || legacy[0]!.amiId === target.amiId) return false;
        const describer = sharedAwsSdkCollaborators(env).describer;
        if (!describer) return false;
        // A slow optional provider observation must not hide the recorded provider or block normal verification.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const host = await Promise.race([
            describer.describeForEnrollment(p.region, p.instanceId),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2500); }),
        ]).finally(() => clearTimeout(timer));
        if (!host || host.state !== 'running' || host.instanceId !== p.instanceId || host.imageId !== legacy[0]!.amiId
            || host.availabilityZoneId !== p.zoneId || host.tags['ezil:stage'] !== 'prd'
            || host.tags['ezil:managed-by'] !== 'app-computer-platform'
            || host.tags['ezil:generation'] !== String(p.generation)) return false;
        const pool = host.tags['ezil:pool-host'] !== undefined;
        if (host.tags[pool ? 'ezil:computer' : 'ezil:computer-id'] !== p.computerId
            || host.tags[pool ? 'ezil:fence' : 'ezil:fence-token'] !== p.fenceToken) return false;
        const disk = host.volumes.filter(v => v.volumeId === p.volumeId);
        if (disk.length !== 1 || disk[0]!.deleteOnTermination !== false) return false;
        // The provider read can race a release. Recheck the same owned session and retained disk in one read.
        const result = await db.execute(sql`/* assignment:running-legacy-host */ SELECT 1 AS matched
            FROM public.ezil_computer_placements
            WHERE computer_id=${p.computerId}::uuid AND owner_user_id=${p.ownerUserId}::uuid
              AND provider='aws-ec2' AND region=${p.region} AND state='RUNNING'
              AND generation=${p.generation} AND lease_epoch=${p.leaseEpoch} AND fence_token=${p.fenceToken}::uuid
              AND instance_id=${p.instanceId} AND volume_id=${p.volumeId} AND lower_image_digest=${target.lowerImageDigest}
              AND lifecycle_job_id IS NULL AND image_upgrade_job_id IS NULL`);
        const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] } | null)?.rows;
        return rows?.length === 1;
    } catch {
        // A missing or ambiguous observation cannot tell somebody to shut down a running session.
        return false;
    }
}
