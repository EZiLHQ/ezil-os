import { sendAwsControl, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import { verifyPreviewTokenV2 } from './hmac';

const reply = (ok: boolean, status: number) => Response.json({
  ok, outcome: ok ? 'restart_requested' : 'restart_unavailable',
}, { status, headers: { 'cache-control': 'no-store' } });

/** Called after awsControlTarget. Recheck v2 here: legacy browser/control tokens cannot restart AWS. */
export async function handleAwsRestart(request: Request, target: { record: AwsTunnelRecord; zone: string },
  secrets: string[], fetchFn: FetchLike, nowMs = Date.now()): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.search || url.pathname !== `/sandbox/${target.record.sandboxId}/restart`) return reply(false, 400);
    // Bound even a chunked body before buffering or authenticating it.
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256) { void reader.cancel().catch(() => undefined); return reply(false, 400); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    const auth = await verifyPreviewTokenV2(request.headers.get('x-ezil-auth'), secrets,
      { method: 'POST', path: url.pathname, body: bytes }, nowMs);
    if (!auth.ok) return reply(false, 401);
    const c = auth.claims, r = target.record;
    if (c.provider !== 'aws-ec2' || c.sandboxId !== r.sandboxId || c.computerId !== r.computerId
      || c.generation !== r.generation || c.leaseEpoch !== r.leaseEpoch || !r.originVerified) return reply(false, 409);
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || Object.keys(body).length !== 1 || typeof body.requestId !== 'string'
      || !/^[0-9a-f]{64}$/.test(body.requestId)) return reply(false, 400);
    const response = await sendAwsControl(r, target.zone, 'restart-desktop', fetchFn, Math.floor(nowMs / 1000), undefined, body.requestId);
    const result = await response.json() as { ok?: unknown; state?: unknown } | null;
    return response.ok && result?.ok === true && result.state === 'restart_requested' ? reply(true, 202) : reply(false, 503);
  } catch {
    return reply(false, 503);
  }
}
