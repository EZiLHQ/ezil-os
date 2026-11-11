/** Narrow standalone Git transport: no generic exec or Cloudflare fallback. */
import { awsOriginHostname, decodeControlKey, isComputerId, signGatewayHeader, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import type { PreviewTokenV2Claims } from './hmac';
import { parseRepoOpenRequest } from './repo-open';
const json = (error: string, status = 502) => Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
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
}
export async function openAwsStandaloneRepo(request: Request, claims: PreviewTokenV2Claims, sandbox: string,
  raw: unknown, deps: AwsRepoOpenDeps): Promise<Response> {
  if (!deps.enabled || !deps.zone) return json('repo_open_unsupported_provider', 409);
  const derived = `guac-${claims.userId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}-${claims.computerId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`;
  if (claims.provider !== 'aws-ec2' || claims.store !== '' || !isComputerId(claims.userId) || !isComputerId(claims.computerId)
    || claims.sandboxId !== sandbox || derived !== sandbox || !Number.isSafeInteger(claims.generation) || claims.generation < 1
    || !Number.isSafeInteger(claims.leaseEpoch) || claims.leaseEpoch < 1) return json('repo_open_invalid_request', 401);
  const now = deps.now ?? Date.now;
  const parsed = parseRepoOpenRequest(raw, now());
  if (!parsed.ok) return json(parsed.error, 400);
  const op = parsed.request;
  if (!op.privatePacket || !/^https:\/\/github\.ezil\.work\/default\//.test(op.canonicalURL)
    || /[^A-Za-z0-9._~+/=?-]/.test(op.token)) return json('repo_open_unsupported_provider', 409);
  const started = now();
  const expiry = Date.parse(op.expiresAt);
  const deadline = Math.min(started + op.timeoutMs, expiry - 5000);
  if (expiry > started + 300_000 || deadline < started + 20_000) return json('repo_open_token_expired', 409);
  const jobId = (deps.jobId ?? (() => hex(crypto.getRandomValues(new Uint8Array(32)))))();
  if (!/^[0-9a-f]{64}$/.test(jobId)) return json('repo_open_failed');
  const body = JSON.stringify({ v: 1, jobId, repositoryId: op.repositoryId, privatePacket: op.privatePacket, timeoutMs: op.timeoutMs });
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
    if (admission.status !== 202) return json('repo_open_failed');
    const admitted = await readAnswer(admission);
    if (!exact(admitted, ['ok', 'state']) || admitted.ok !== true || !['running', 'done'].includes(admitted.state as string))
      return json('repo_open_failed');
    for (;;) {
      const response = await call('GET', `/__ezil/control/standalone-repo-open-status/${jobId}`);
      if (response.status !== 200) return json('repo_open_failed');
      const status = await readAnswer(response);
      if (exact(status, ['ok', 'state']) && status.ok === true && status.state === 'running') {
        await (deps.sleep ?? pause)(Math.min(500, Math.max(1, deadline - now())), signal);
        continue;
      }
      if (!exact(status, ['ok', 'state', 'result']) || status.ok !== true || status.state !== 'done') return json('repo_open_failed');
      await current(); // Old placements cannot become Code URLs.
      const result = status.result;
      if (exact(result, ['ok', 'folder', 'status']) && result.ok === true
        && result.folder === `/workspace/projects/${op.repositoryId}` && (result.status === 'cloned' || result.status === 'fetched'))
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      if (exact(result, ['ok', 'error']) && result.ok === false && failures.has(result.error as string))
        return json(result.error as string, result.error === 'runtime_not_running' ? 409 : 502);
      return json('repo_open_failed');
    }
  } catch { return json(signal.aborted || now() >= deadline ? 'repo_open_timeout' : 'repo_open_failed'); }
}

