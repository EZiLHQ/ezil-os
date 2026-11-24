/** Narrow standalone Git transport: no generic exec or Cloudflare fallback. */
import { awsOriginHostname, decodeControlKey, isComputerId, signGatewayHeader, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import type { PreviewTokenV2Claims } from './hmac';
import { ASSIGNMENT_PRELOAD_PORT, splitAssignmentPreload, type AssignmentPreloadWitness } from './assignment-preload';
import { parseRepoOpenRequest, type RepoOpenRequest } from './repo-open';
/** Only these fixed reasons may cross the host/Worker boundary; never provider text or CLI stderr. */
export const REPO_OPEN_DIAGNOSTIC_REASONS = [
  'bootstrap_unavailable', 'workspace_unavailable', 'workspace_not_ready', 'folder_conflict',
  'checkout_busy', 'invalid_request', 'repository_not_authorized', 'ref_mismatch', 'clone_failed',
  'cleanup_unconfirmed', 'supervisor_unavailable', 'token_expired', 'runtime_not_running', 'invalid_result',
  'admission_rejected', 'admission_invalid', 'admission_stopping', 'status_unavailable',
  'status_invalid', 'transport_unavailable', 'budget_exhausted',
] as const;
type DiagnosticReason = typeof REPO_OPEN_DIAGNOSTIC_REASONS[number];
const diagnosticReasons = new Set<string>(REPO_OPEN_DIAGNOSTIC_REASONS);
const json = (error: string, status = 502, diagnosticReason?: DiagnosticReason) => Response.json(
  { ok: false, error, ...(diagnosticReason ? { diagnosticReason } : {}) },
  { status, headers: { 'cache-control': 'no-store' } });
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const failures = new Set(['repo_open_failed', 'repo_open_timeout', 'repo_open_git_missing', 'repo_open_token_expired', 'runtime_not_running']);
const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, '0')).join('');
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const aborted = () => { clearTimeout(timer); reject(new Error('aborted')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
  if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
});
async function readAnswer(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 4096) throw new Error('large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export interface AwsRepoOpenDeps {
  enabled: boolean;
  zone: string | null;
  lookup: (sandbox: string) => Promise<AwsTunnelRecord | null>;
  fetch: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jobId?: () => string;
  authorizeAssignment?: (input: unknown, request: RepoOpenRequest) => Promise<{ witness: AssignmentPreloadWitness; nonce: string } | null>;
}
export async function openAwsStandaloneRepo(request: Request, claims: PreviewTokenV2Claims, sandbox: string,
  raw: unknown, deps: AwsRepoOpenDeps): Promise<Response> {
  if (!deps.enabled || !deps.zone) return json('repo_open_unsupported_provider', 409);
  const derived = `guac-${claims.userId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}-${claims.computerId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`;
  if (claims.provider !== 'aws-ec2' || claims.store !== '' || !isComputerId(claims.userId) || !isComputerId(claims.computerId)
    || claims.sandboxId !== sandbox || derived !== sandbox || !Number.isSafeInteger(claims.generation) || claims.generation < 1
    || !Number.isSafeInteger(claims.leaseEpoch) || claims.leaseEpoch < 1) return json('repo_open_invalid_request', 401);
  const now = deps.now ?? Date.now;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return json('repo_open_invalid_request', 400);
  const bodyWithAssignment = raw as Record<string, unknown>;
  const { repoBody, preload } = splitAssignmentPreload(bodyWithAssignment);
  const parsed = parseRepoOpenRequest(repoBody, now());
  if (!parsed.ok) return json(parsed.error, 400);
  const op = parsed.request;
  const assignment = Object.hasOwn(bodyWithAssignment, 'assignmentPreload')
    ? await deps.authorizeAssignment?.(preload, op) : undefined;
  if (Object.hasOwn(bodyWithAssignment, 'assignmentPreload') && !assignment) return json('repo_open_invalid_request', 400);
  if (!op.privatePacket || !/^https:\/\/github\.ezil\.work\/default\//.test(op.canonicalURL)
    || /[^A-Za-z0-9._~+/=?-]/.test(op.token)) return json('repo_open_unsupported_provider', 409);
  const started = now();
  const expiry = Date.parse(op.expiresAt);
  const deadline = Math.min(started + op.timeoutMs, expiry - 5000);
  if (expiry > started + 300_000 || deadline < started + 20_000) return json('repo_open_token_expired', 409);
  const jobId = (deps.jobId ?? (() => hex(crypto.getRandomValues(new Uint8Array(32)))))();
  if (!/^[0-9a-f]{64}$/.test(jobId)) return json('repo_open_failed');
  const body = JSON.stringify({ v: 1, jobId, repositoryId: op.repositoryId, privatePacket: op.privatePacket, timeoutMs: op.timeoutMs,
    ...(op.gitAuthor ? { gitAuthor: op.gitAuthor } : {}), ...(op.refreshOnly ? { refreshOnly: true } : {}),
    ...(assignment ? { assignmentPreload: { ...assignment.witness, nonce: assignment.nonce } } : {}) });
  const encoded = new TextEncoder().encode(body);
  if (encoded.byteLength > 20_480) return json('repo_open_invalid_request', 400);
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)));
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, Math.floor(deadline - now())))]);
  const current = async () => {
    if (signal.aborted || now() >= deadline) throw new Error('deadline');
    const rec = await deps.lookup(sandbox);
    if (signal.aborted || now() >= deadline) throw new Error('deadline');
    if (!rec || !rec.originVerified || rec.computerId !== claims.computerId || rec.sandboxId !== sandbox
      || rec.generation !== claims.generation || rec.leaseEpoch !== claims.leaseEpoch) throw new Error('placement');
    return rec;
  };
  const call = async (method: 'POST' | 'GET', path: string, payload?: string) => {
    const rec = await current();
    const key = decodeControlKey(rec.controlKey);
    if (!key) throw new Error('key');
    const host = awsOriginHostname(sandbox, rec.generation, rec.leaseEpoch, deps.zone!);
    const signed = await signGatewayHeader(key, rec, method, path, now() / 1000);
    if (signal.aborted || now() >= deadline) throw new Error('deadline');
    return deps.fetch(`https://${host}${path}`, {
      method, redirect: 'manual', signal,
      headers: { 'x-ezil-gw': signed, ...(payload === undefined ? {} : {
        'content-type': 'application/json', 'content-length': String(encoded.byteLength),
      }) }, ...(payload === undefined ? {} : { body: payload }),
    });
  };
  try {
    const admission = await call('POST', `/__ezil/control/standalone-repo-open/${digest}`, body);
    if (admission.status === 404) return json('repo_open_unsupported_provider', 409);
    if (admission.status !== 202) {
      let reason: DiagnosticReason = 'admission_rejected';
      try {
        const refused = await readAnswer(admission);
        if (exact(refused, ['ok', 'error']) && refused.ok === false) {
          if (refused.error === 'workspace_busy') reason = 'checkout_busy';
          else if (refused.error === 'stopping') reason = 'admission_stopping';
          else if (refused.error === 'runtime_not_running') reason = 'runtime_not_running';
          else if (refused.error === 'standalone_repo_invalid') reason = 'admission_invalid';
        }
      } catch { /* Untrusted or unavailable refusal bodies never become diagnostics. */ }
      return json('repo_open_failed', 502, reason);
    }
    const admitted = await readAnswer(admission);
    if (!exact(admitted, ['ok', 'state']) || admitted.ok !== true || !['running', 'done'].includes(admitted.state as string))
      return json('repo_open_failed', 502, 'admission_invalid');
    for (;;) {
      const response = await call('GET', `/__ezil/control/standalone-repo-open-status/${jobId}`);
      if (response.status !== 200) return json('repo_open_failed', 502, 'status_unavailable');
      const status = await readAnswer(response);
      if (exact(status, ['ok', 'state']) && status.ok === true && status.state === 'running') {
        await (deps.sleep ?? pause)(Math.min(500, Math.max(1, deadline - now())), signal);
        continue;
      }
      if (!exact(status, ['ok', 'state', 'result']) || status.ok !== true || status.state !== 'done')
        return json('repo_open_failed', 502, 'status_invalid');
      await current(); // Old placements cannot become Code URLs.
      const result = status.result;
      const fields = assignment ? ['ok', 'folder', 'status', 'checkoutFolder', 'assignmentPreload'] : ['ok', 'folder', 'status'];
      const folder = `/workspace/projects/${op.repositoryId}`;
      if (exact(result, fields) && result.ok === true && result.folder === folder
        && (result.status === 'cloned' || result.status === 'fetched')) {
        if (assignment) {
          const expectedCheckout = folder + '/' + op.canonicalURL.split('/').at(-1)!.slice(0, -4);
          const ack = result.assignmentPreload;
          if (result.checkoutFolder !== expectedCheckout || !exact(ack, ['eventId', 'nonce', 'port', 'status'])
            || ack.eventId !== assignment.witness.eventId || ack.nonce !== assignment.nonce
            || ack.port !== ASSIGNMENT_PRELOAD_PORT || ack.status !== 'acknowledged')
            return json('repo_open_failed', 502, 'invalid_result');
        }
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      }
      if ((exact(result, ['ok', 'error']) || (exact(result, ['ok', 'error', 'diagnosticReason'])
        && typeof result.diagnosticReason === 'string' && diagnosticReasons.has(result.diagnosticReason)))
        && result.ok === false && failures.has(result.error as string))
        return json(result.error as string, result.error === 'runtime_not_running' ? 409 : 502,
          result.diagnosticReason as DiagnosticReason | undefined);
      return json('repo_open_failed', 502, 'invalid_result');
    }
  } catch {
    const expired = signal.aborted || now() >= deadline;
    return json(expired ? 'repo_open_timeout' : 'repo_open_failed', 502,
      expired ? 'budget_exhausted' : 'transport_unavailable');
  }
}

