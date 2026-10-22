import { createHash } from 'node:crypto';
import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';
import { isAwsComputersEnabled, type Env } from './aws-config';
import { readPlacement, type PlacementExecutor } from './placement';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import type { ComputerRef, RestartResult } from './provider';

const unavailable = (): RestartResult => ({ ok: false, outcome: 'restart_unavailable', error: 'restart_unavailable' });
const RESTART_READY_TIMEOUT_MS = 180_000; // Below the shell's 215s and route's 300s budgets.
const RESTART_POLL_MS = 2_000;

/**
 * Restart only the live desktop unit, then wait for its new runtime.
 * The Worker 202 acknowledges the host's queue, NOT completion (worker/src/aws-restart.ts).
 * GET relay-refresh reads Neko's process identity without minting/renewing a relay or preview.
 * start-neko.sh gates Neko startup on code-server's listening port, so a NEW identity also
 * proves the old editor is gone and the replacement passed its startup gate. Placement's
 * RUNNING/generation/leaseEpoch describe the host and do not change on a desktop restart.
 */
export async function requestAwsRestart(db: PlacementExecutor, computer: ComputerRef, requestId: string, env: Env): Promise<RestartResult> {
    const startedAt = Date.now();
    const progress: { phase: 'preflight' | 'a' | 'b' | 'c_or_d' } = { phase: 'preflight' };
    let phaseStartedAt = startedAt, status = 0, polls = 0, unreadable = 0;
    let readCode = 'not_read';
    const log = (code: string) => console.info(`[aws-restart] phase=${progress.phase} code=${code} status=${status} elapsed_ms=${Date.now() - startedAt} phase_ms=${Date.now() - phaseStartedAt} polls=${polls} unreadable=${unreadable}`);
    const fail = (code: string): RestartResult => { log(code); return unavailable(); };
    const enter = (next: typeof progress.phase) => { progress.phase = next; phaseStartedAt = Date.now(); status = 0; };
    log('started');
    if (!isAwsComputersEnabled(env) || (env.EZIL_AWS_KILL_SWITCH !== undefined && env.EZIL_AWS_KILL_SWITCH !== '0')) return fail('disabled');
    const secret = env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    const workerUrl = env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.trim();
    if (!secret || !workerUrl || !requestId) return fail('config_invalid');
    try {
        const { record: p } = await readPlacement(db, computer.computerId);
        if (!p || p.provider !== 'aws-ec2' || p.ownerUserId !== computer.userId.toLowerCase()
            || p.state !== 'RUNNING' || p.generation < 1 || p.leaseEpoch < 1) return fail('placement_unavailable');
        const sandboxId = deriveGuacamoleSandboxId(p.ownerUserId, p.computerId);
        const endpoint = new URL(`${workerUrl.replace(/\/$/, '')}/sandbox/${sandboxId}/restart`);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return fail('endpoint_invalid');
        const deadline = Date.now() + RESTART_READY_TIMEOUT_MS;
        const request = async (url: URL, method: 'GET' | 'POST', body = '') => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('restart_deadline');
            status = 0;
            readCode = 'transport_failed';
            const token = mintPreviewTokenV2(secret, {
                ts: Date.now(), sandboxId, computerId: p.computerId, userId: p.ownerUserId,
                provider: 'aws-ec2', store: '', generation: p.generation, leaseEpoch: p.leaseEpoch,
            }, { method, path: url.pathname, body });
            const response = await fetch(url.toString(), {
                method, ...(body ? { body } : {}), redirect: 'error', cache: 'no-store',
                signal: AbortSignal.timeout(Math.min(15_000, remaining)),
                headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: token },
            });
            status = response.status;
            readCode = 'response_invalid';
            const data = await response.json() as { ok?: unknown; outcome?: unknown; runtimeId?: unknown } | null;
            return { response, data };
        };
        const relayEndpoint = new URL(endpoint.toString().replace(/\/restart$/, '/relay-refresh'));
        const readRuntime = async (): Promise<string | null> => {
            try {
                const { response, data } = await request(relayEndpoint, 'GET');
                const valid = response.ok && data?.ok === true && typeof data.runtimeId === 'string'
                    && /^[a-f0-9]{32}$/.test(data.runtimeId);
                readCode = valid ? 'runtime_ready' : response.ok ? 'runtime_invalid' : 'http_error';
                return valid ? data!.runtimeId as string : null;
            } catch { return null; } // A restart's transient transport failure is not a new runtime.
        };
        enter('a');
        const previousRuntime = await readRuntime();
        // Without a baseline, a healthy reply could still belong to the OLD desktop.
        // Refuse before dispatch rather than claim an unobserved restart completed.
        if (!previousRuntime) return fail(`baseline_${readCode}`);
        log('baseline_ready');
        enter('b');

        // Stable across transport retries, including a freshly minted v2 token. Dispatch ONCE.
        const body = JSON.stringify({ requestId: createHash('sha256').update(requestId).digest('hex') });
        const { response, data } = await request(endpoint, 'POST', body);
        if (response.status !== 202 || data?.ok !== true || data.outcome !== 'restart_requested') return fail('dispatch_rejected');
        log('dispatch_queued');
        enter('c_or_d');

        while (Date.now() < deadline) {
            polls++;
            const runtime = await readRuntime();
            if (!runtime) unreadable++;
            if (Date.now() < deadline && runtime && runtime !== previousRuntime) {
                log('runtime_changed');
                return { ok: true, outcome: 'restart_requested' };
            }
            const remaining = deadline - Date.now();
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(RESTART_POLL_MS, remaining)));
        }
        // The queue ACK cannot prove a unit ran. Neither an unchanged identity nor
        // an unreadable one distinguishes a failed restart (c) from identity loss (d).
        return fail(readCode === 'runtime_ready' ? 'runtime_unchanged' : `runtime_unreadable_${readCode}`);
    } catch {
        return fail(progress.phase === 'b' ? `dispatch_${readCode}` : 'preflight_failed');
    }
}
