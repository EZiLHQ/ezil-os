// Twen live validation harness (throwaway mission-secret signed).
// Proves: Twen mutation visible + persists (same SHA on re-sync) under identity
// A, and is ABSENT under identity B (isolation). No raw content is read.
import { createHmac } from 'node:crypto';

const SECRET = process.env.TWEN_MISSION_SECRET;
const BASE = process.env.TWEN_WORKER_URL || 'https://api.ezil.org';
if (!SECRET) { console.error('missing TWEN_MISSION_SECRET'); process.exit(2); }

function mint() {
  const ts = Date.now().toString();
  const sig = createHmac('sha256', SECRET).update(`${ts}.POST./sandbox/preview.`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

async function twen(name, op, operationId, label) {
  const t0 = Date.now();
  // Cold-boot of a brand-new sandbox container (neko/vscode/guacamole image) +
  // R2 FUSE mount can take a couple of minutes on first contact; retry on the
  // client-side timeout before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}/sandbox/${encodeURIComponent(name)}/twen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: mint(), op, operationId }),
        signal: AbortSignal.timeout(240_000),
      });
      const body = await res.json();
      console.error(`[step ${label}] ${op} ${name} → ${res.status} (${Date.now() - t0}ms, attempt ${attempt})`);
      return { status: res.status, body };
    } catch (err) {
      console.error(`[step ${label}] attempt ${attempt} error: ${err?.name || err} (${Date.now() - t0}ms)`);
      if (attempt >= 3) throw err;
    }
  }
}

const A = 'guac-twenval-alpha';
const B = 'guac-twenval-beta';
const OP = 'twenlive1';

const out = {};
// 1) Auth negative: unsigned request must be rejected.
{
  const res = await fetch(`${BASE}/sandbox/${A}/twen`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'sync', operationId: OP }),
  });
  out.unsigned = { status: res.status, body: await res.json() };
}
// 2) Invalid operationId (traversal) must be rejected 400.
out.traversal = await twen(A, 'sync', '../escape', 'traversal');
// 3) Identity A: sync (create-or-update the fixed status artifact).
out.a_sync1 = await twen(A, 'sync', OP, 'a_sync1');
// 4) Identity A: re-sync — deterministic content ⇒ identical SHA (persistence/idempotency).
out.a_sync2 = await twen(A, 'sync', OP, 'a_sync2');
// 5) Identity A: read-only status.
out.a_status = await twen(A, 'status', OP, 'a_status');
// 6) Identity B: read-only status — artifact must be ABSENT (isolation).
out.b_status = await twen(B, 'status', OP, 'b_status');

console.log(JSON.stringify(out, null, 2));

// Assertions
const errs = [];
if (out.unsigned.status !== 401) errs.push('unsigned not rejected');
if (out.traversal.status !== 400) errs.push('traversal not rejected 400');
if (!(out.a_sync1.body.ok && out.a_sync1.body.wrote && out.a_sync1.body.exists && out.a_sync1.body.matches)) errs.push('A sync1 failed');
if (!(out.a_sync2.body.ok && out.a_sync2.body.matches)) errs.push('A sync2 failed');
if (out.a_sync1.body.sha256 !== out.a_sync2.body.sha256) errs.push('SHA not stable across re-sync');
if (!(out.a_status.body.ok && out.a_status.body.exists && out.a_status.body.sha256 === out.a_sync1.body.sha256)) errs.push('A status mismatch');
if (!(out.b_status.body.ok && out.b_status.body.exists === false)) errs.push('B isolation FAILED (artifact leaked)');
// No raw content leak
const dump = JSON.stringify(out);
if (/"content"|origin=twen[^"]*ezil-workspace/.test(dump)) errs.push('possible content leak');

if (errs.length) { console.error('FAIL:', errs.join('; ')); process.exit(1); }
console.error('PASS: twen mutation visible+persists under A, isolated from B, auth+validation enforced');
