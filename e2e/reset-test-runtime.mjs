/**
 * After a staging deploy, Cloudflare keeps a live Durable Object on its old code
 * and resets it later ("Durable Object reset because its code was updated"). On
 * staging that reset landed inside timed acceptance: a desktop open failed with
 * 500 and the cold first paint missed its budget. The prepare step therefore
 * resets the stopped test computer's object onto the deployed code, then waits
 * until a fresh instance answers with the desktop still stopped, before any
 * acceptance timing starts. The Worker route is staging-scoped to the one
 * acceptance computer and HMAC-authenticated (`/sandbox/:name/acceptance-reset`).
 */
import { createHmac } from 'node:crypto';

const CODE = /^[a-z_0-9]{1,40}$/;
export class ResetError extends Error {
  constructor(code) { super(code); this.code = CODE.test(code) ? code : 'reset_failed'; }
}

export async function resetTestRuntime({ worker, sandbox, secret, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  settleMs = 1500, intervalMs = 2000, deadlineMs = 60000 }) {
  const base = new URL(worker);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash) throw new ResetError('worker_url_invalid');
  if (!/^guac-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/.test(sandbox ?? '')) throw new ResetError('sandbox_invalid');
  if (!secret) throw new ResetError('secret_missing');
  const timestamp = now();
  const signature = createHmac('sha256', secret).update(`${timestamp}.POST./sandbox/preview.`).digest('hex');
  const reset = await fetchImpl(`${base.origin}/sandbox/${encodeURIComponent(sandbox)}/acceptance-reset`, {
    method: 'POST', headers: { authorization: `Bearer t=${timestamp},v1=${signature}` },
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  const answer = await reset.json().catch(() => null);
  if (reset.status !== 200 || answer?.ok !== true) {
    throw new ResetError(typeof answer?.error === 'string' ? answer.error : `reset_http_${reset.status}`);
  }
  // The object is discarded just after it replied; let that happen first.
  await sleep(settleMs);
  const deadline = now() + deadlineMs;
  let healthy = 0;
  while (now() < deadline) {
    // Non-waking: answers from a fresh instance and never starts a container.
    const status = await fetchImpl(`${base.origin}/sandbox/${encodeURIComponent(sandbox)}/status`, {
      signal: AbortSignal.timeout(15000), redirect: 'error',
    }).catch(() => null);
    const body = status ? await status.json().catch(() => null) : null;
    if (status?.status === 200 && body?.ok === true) {
      if (body.desktopRunning !== false) throw new ResetError('desktop_running_after_reset');
      if (++healthy >= 2) return { healthy };
    } else healthy = 0;
    await sleep(intervalMs);
  }
  throw new ResetError('reset_status_timeout');
}
