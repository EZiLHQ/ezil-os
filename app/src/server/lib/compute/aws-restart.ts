import { createHash } from 'node:crypto';
import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';
import { isAwsComputersEnabled, type Env } from './aws-config';
import { readPlacement, type PlacementExecutor, type PlacementState } from './placement';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import type { ComputerRef, RestartResult } from './provider';

/**
 * Round 3: distinct desktop-restart outcomes (`outcome`/`error` = `restart_<code>`), never one
 * collapsed `restart_unavailable`:
 * - `not_running`: no RUNNING AWS computer to restart; `busy`: it is opening, stopping or its
 *   lease moved (Worker 409), or the host reports a restart already running;
 * - `budget_exhausted`: the host's restart budget is spent (only when the Worker says so);
 * - `host_unreachable`: the Worker or the host did not answer the dispatch (transport, 502-504);
 * - `timeout`: dispatched, but no new desktop was observed inside the budget;
 * - `unavailable`: disabled, misconfigured, or any other refusal.
 */
export const AWS_RESTART_CODES = ['not_running', 'busy', 'budget_exhausted', 'host_unreachable', 'timeout', 'unavailable'] as const;
export type AwsRestartCode = typeof AWS_RESTART_CODES[number];
const refused = (code: AwsRestartCode): RestartResult => ({ ok: false, outcome: `restart_${code}`, error: `restart_${code}` });
const RESTART_READY_TIMEOUT_MS = 180_000; // Below the shell's 215s and route's 300s budgets.
const RESTART_POLL_MS = 2_000;
const BUSY_STATES: readonly PlacementState[] = ['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RECOVERING', 'RETIRING'];

/**
 * Restart only the live desktop unit, then wait for its new runtime.
 * The Worker 202 acknowledges the host's queue, NOT completion (worker/src/aws-restart.ts).
 * GET relay-refresh reads Neko's process identity without minting/renewing a relay or preview.
 * start-neko.sh gates Neko startup on code-server's listening port, so a NEW identity also
 * proves the old editor is gone and the replacement passed its startup gate. Placement's
 * RUNNING/generation/leaseEpoch describe the host and do not change on a desktop restart.
 *
 * Round 3: a frozen desktop cannot answer the pre-read, and that is exactly when a restart is
 * needed, so the pre-read is a baseline only. Completion is a runtime id different from the
 * baseline; without a baseline it is a desktop that answers after being seen down (the failed
 * pre-read or a later failed read), or a second identity different from the first one seen.
 */
export async function requestAwsRestart(db: PlacementExecutor, computer: ComputerRef, requestId: string, env: Env): Promise<RestartResult> {
    const startedAt = Date.now();
    const progress: { phase: 'preflight' | 'a' | 'b' | 'c_or_d' } = { phase: 'preflight' };
    let phaseStartedAt = startedAt, status = 0, polls = 0, unreadable = 0;
    let readCode = 'not_read';
    const log = (code: string) => console.info(`[aws-restart] phase=${progress.phase} code=${code} status=${status} elapsed_ms=${Date.now() - startedAt} phase_ms=${Date.now() - phaseStartedAt} polls=${polls} unreadable=${unreadable}`);
    const fail = (code: string, outcome: AwsRestartCode = 'unavailable'): RestartResult => { log(code); return refused(outcome); };
    const enter = (next: typeof progress.phase) => { progress.phase = next; phaseStartedAt = Date.now(); status = 0; };
    log('started');
    if (!isAwsComputersEnabled(env) || (env.EZIL_AWS_KILL_SWITCH !== undefined && env.EZIL_AWS_KILL_SWITCH !== '0')) return fail('disabled');
    const secret = env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    const workerUrl = env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.trim();
    if (!secret || !workerUrl || !requestId) return fail('config_invalid');
    try {
        const { record: p } = await readPlacement(db, computer.computerId);
        if (!p || p.provider !== 'aws-ec2' || p.ownerUserId !== computer.userId.toLowerCase()) return fail('placement_unavailable', 'not_running');
        if (BUSY_STATES.includes(p.state)) return fail('placement_busy', 'busy');
        if (p.state !== 'RUNNING') return fail('placement_unavailable', 'not_running');
        if (p.generation < 1 || p.leaseEpoch < 1) return fail('placement_unavailable');
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
        // The desktop answered, but not with a usable identity: it is down (frozen or crashed).
        let seenDown = !previousRuntime && readCode !== 'transport_failed';
        log(previousRuntime ? 'baseline_ready' : `baseline_missing_${readCode}`);
        enter('b');

        // Stable across transport retries, including a freshly minted v2 token. Dispatch ONCE.
        const body = JSON.stringify({ requestId: createHash('sha256').update(requestId).digest('hex') });
        let dispatched;
        try { dispatched = await request(endpoint, 'POST', body); }
        catch { return fail(`dispatch_${readCode}`, readCode === 'transport_failed' ? 'host_unreachable' : 'unavailable'); }
        const { response, data } = dispatched;
        if (response.status !== 202 || data?.ok !== true || data.outcome !== 'restart_requested') {
            const outcome = typeof data?.outcome === 'string' ? data.outcome : '';
            // Forward-compatible Worker reasons (crossLane: worker/src/aws-restart.ts) take precedence over the status.
            const code: AwsRestartCode = outcome === 'restart_budget_exhausted' || response.status === 429 ? 'budget_exhausted'
                : outcome === 'restart_busy' || response.status === 409 ? 'busy'
                : [502, 503, 504].includes(response.status) ? 'host_unreachable' : 'unavailable';
            return fail('dispatch_rejected', code);
        }
        log('dispatch_queued');
        enter('c_or_d');

        let firstSeen: string | null = null;
        while (Date.now() < deadline) {
            polls++;
            const runtime = await readRuntime();
            // Without a baseline, an answered-but-unusable read after dispatch is the old desktop going down.
            if (!runtime) { unreadable++; if (readCode !== 'transport_failed') seenDown = true; }
            const changed = runtime !== null && (previousRuntime !== null ? runtime !== previousRuntime
                : seenDown || (firstSeen !== null && runtime !== firstSeen));
            if (Date.now() < deadline && changed) {
                log(previousRuntime ? 'runtime_changed' : 'runtime_healthy_after_restart');
                return { ok: true, outcome: 'restart_requested' };
            }
            if (runtime && previousRuntime === null) firstSeen ??= runtime;
            const remaining = deadline - Date.now();
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(RESTART_POLL_MS, remaining)));
        }
        // The queue ACK cannot prove a unit ran. Neither an unchanged identity nor
        // an unreadable one distinguishes a failed restart (c) from identity loss (d).
        return fail(readCode === 'runtime_ready' ? 'runtime_unchanged' : `runtime_unreadable_${readCode}`, 'timeout');
    } catch {
        return fail(progress.phase === 'b' ? `dispatch_${readCode}` : 'preflight_failed');
    }
}
