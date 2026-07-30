#!/usr/bin/env bun
/**
 * Workspace R2 persistence + A/B/C isolation mission runner.
 *
 * Drives the HMAC-gated `POST /sandbox/:name/workspace-diag` endpoint to prove,
 * against the LIVE Cloudflare-native runtime (where the R2 FUSE mount actually
 * works), two independent properties:
 *
 *   1. Deterministic R2 persistence — writing a marker slot under identity A,
 *      then re-reading it AFTER an explicit terminate + recreate of A, returns
 *      the IDENTICAL SHA-256. (A same-slot digest is a pure function of the slot
 *      name, so an equal hash can only mean the bytes actually persisted in R2
 *      and were remounted — not that a fresh identical file was written, because
 *      we assert `exists:true` on a read-only `stat` BEFORE any rewrite.)
 *
 *   2. A/B/C isolation — a slot written under A is provably ABSENT
 *      (`exists:false`) under identities B and C, and each of B/C's own slots is
 *      absent from A. No cross-over between per-identity R2 prefixes.
 *
 * Secrets: the HMAC secret is read from the process environment BY NAME
 * (SANDBOX_HMAC_SECRET / CLOUDFLARE_GUACAMOLE_HMAC_SECRET). Its value is never
 * printed, logged, or embedded in output. If no secret is available the runner
 * still executes but reports `runtime integration blocked` rather than
 * fabricating a pass.
 *
 * Usage:
 *   API_BASE=https://<worker-host> \
 *   SANDBOX_HMAC_SECRET=<by-name> \
 *   bun scripts/run-workspace-isolation-mission.ts \
 *     [--a guac-a] [--b guac-b] [--c guac-c] [--slot mission] [--json]
 *
 * Exit code 0 == mission PASS; non-zero == FAIL/BLOCKED.
 */

import { createHmac } from 'node:crypto';

type DiagResponse = {
  ok: boolean;
  op?: string;
  slot?: string;
  exists?: boolean;
  bytes?: number | null;
  sha256?: string | null;
  expectedSha256?: string;
  matches?: boolean;
  wrote?: boolean;
  error?: string;
  workspace?: unknown;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HAS_JSON = process.argv.includes('--json');

const API_BASE = (process.env.API_BASE ?? '').replace(/\/$/, '');
const HMAC_SECRET =
  process.env.SANDBOX_HMAC_SECRET ?? process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET ?? '';

const A = arg('a', 'guac-mission-a');
const B = arg('b', 'guac-mission-b');
const C = arg('c', 'guac-mission-c');
const SLOT = arg('slot', 'mission');

/** Mint the same HMAC envelope the Worker's `verifyPreviewToken` accepts. */
function mintToken(): string {
  if (!HMAC_SECRET) return 'local-dev';
  const ts = Date.now().toString();
  const sig = createHmac('sha256', HMAC_SECRET).update(`${ts}.POST./sandbox/preview.`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

async function diag(name: string, op: string, slot: string): Promise<DiagResponse> {
  const res = await fetch(`${API_BASE}/sandbox/${encodeURIComponent(name)}/workspace-diag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: mintToken(), op, slot }),
  });
  const text = await res.text();
  let parsed: DiagResponse;
  try {
    parsed = JSON.parse(text) as DiagResponse;
  } catch {
    parsed = { ok: false, error: `non_json_${res.status}: ${text.slice(0, 200)}` };
  }
  return parsed;
}

async function terminate(name: string): Promise<void> {
  await fetch(`${API_BASE}/sandbox/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
}

const steps: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string) {
  steps.push({ name, pass, detail });
  if (!HAS_JSON) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function main() {
  if (!API_BASE) {
    console.error('BLOCKED: API_BASE is required (live worker host).');
    process.exit(3);
  }
  if (!HMAC_SECRET) {
    console.error(
      'BLOCKED: no HMAC secret in env (SANDBOX_HMAC_SECRET / CLOUDFLARE_GUACAMOLE_HMAC_SECRET). ' +
        'Runtime integration cannot be authenticated — reporting blocked, not pass.',
    );
    process.exit(4);
  }

  // ── 1) A: write marker, capture baseline digest ────────────────────────────
  const aWrite = await diag(A, 'ensure', SLOT);
  record(
    'A.write',
    Boolean(aWrite.ok && aWrite.exists && aWrite.matches),
    aWrite.ok
      ? `exists=${aWrite.exists} sha=${aWrite.sha256?.slice(0, 12)} matches=${aWrite.matches}`
      : `error=${aWrite.error}`,
  );
  const baselineSha = aWrite.sha256;

  // ── 2) A: explicit terminate + recreate, then read-only stat ───────────────
  await terminate(A);
  const aStat = await diag(A, 'stat', SLOT);
  record(
    'A.persist.after.recreate',
    Boolean(aStat.ok && aStat.exists && aStat.sha256 === baselineSha && aStat.matches),
    aStat.ok
      ? `exists=${aStat.exists} sha=${aStat.sha256?.slice(0, 12)} == baseline=${baselineSha?.slice(0, 12)}`
      : `error=${aStat.error}`,
  );

  // ── 3) Isolation: A's slot must be ABSENT under B and C ────────────────────
  for (const [label, id] of [['B', B], ['C', C]] as const) {
    const s = await diag(id, 'stat', SLOT);
    record(
      `${label}.absent.of.A.slot`,
      Boolean(s.ok && s.exists === false),
      s.ok ? `exists=${s.exists}` : `error=${s.error}`,
    );
  }

  // ── 4) Cross-over: B/C write their OWN slot, A must NOT gain it ─────────────
  const bcSlot = `${SLOT}-bc`;
  for (const [label, id] of [['B', B], ['C', C]] as const) {
    const w = await diag(id, 'ensure', bcSlot);
    record(`${label}.write.own`, Boolean(w.ok && w.exists), w.ok ? `exists=${w.exists}` : `error=${w.error}`);
  }
  const aCross = await diag(A, 'stat', bcSlot);
  record(
    'A.absent.of.BC.slot',
    Boolean(aCross.ok && aCross.exists === false),
    aCross.ok ? `exists=${aCross.exists}` : `error=${aCross.error}`,
  );

  const passed = steps.every((s) => s.pass);
  if (HAS_JSON) {
    console.log(JSON.stringify({ pass: passed, steps }, null, 2));
  } else {
    console.log(`\nMISSION ${passed ? 'PASS' : 'FAIL'} (${steps.filter((s) => s.pass).length}/${steps.length})`);
  }
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`BLOCKED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(5);
});
