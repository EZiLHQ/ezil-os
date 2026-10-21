import { createHash } from 'node:crypto';
import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';
import { isAwsComputersEnabled, type Env } from './aws-config';
import { readPlacement, type PlacementExecutor } from './placement';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import type { ComputerRef, RestartResult } from './provider';

const unavailable = (): RestartResult => ({ ok: false, outcome: 'restart_unavailable', error: 'restart_unavailable' });

/** Restart only the live desktop unit. No admission, lease renewal or instance lifecycle work. */
export async function requestAwsRestart(db: PlacementExecutor, computer: ComputerRef, requestId: string, env: Env): Promise<RestartResult> {
    if (!isAwsComputersEnabled(env) || (env.EZIL_AWS_KILL_SWITCH !== undefined && env.EZIL_AWS_KILL_SWITCH !== '0')) return unavailable();
    const secret = env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    const workerUrl = env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.trim();
    if (!secret || !workerUrl || !requestId) return unavailable();
    try {
        const { record: p } = await readPlacement(db, computer.computerId);
        if (!p || p.provider !== 'aws-ec2' || p.ownerUserId !== computer.userId.toLowerCase()
            || p.state !== 'RUNNING' || p.generation < 1 || p.leaseEpoch < 1) return unavailable();
        const sandboxId = deriveGuacamoleSandboxId(p.ownerUserId, p.computerId);
        const endpoint = new URL(`${workerUrl.replace(/\/$/, '')}/sandbox/${sandboxId}/restart`);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return unavailable();
        // Stable across transport retries, including a freshly minted v2 token.
        const body = JSON.stringify({ requestId: createHash('sha256').update(requestId).digest('hex') });
        const token = mintPreviewTokenV2(secret, {
            ts: Date.now(), sandboxId, computerId: p.computerId, userId: p.ownerUserId,
            provider: 'aws-ec2', store: '', generation: p.generation, leaseEpoch: p.leaseEpoch,
        }, { method: 'POST', path: endpoint.pathname, body });
        const response = await fetch(endpoint.toString(), {
            method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(15_000),
            headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: token },
        });
        const data = await response.json() as { ok?: unknown; outcome?: unknown } | null;
        return response.status === 202 && data?.ok === true && data.outcome === 'restart_requested'
            ? { ok: true, outcome: 'restart_requested' } : unavailable();
    } catch {
        return unavailable();
    }
}
