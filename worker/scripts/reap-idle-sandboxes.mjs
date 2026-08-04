#!/usr/bin/env bun
/**
 * Manual/operator safety-net reaper for containers that are `running` far
 * longer than any legitimate session should be — the billing bug this tool
 * exists to contain (see the diagnosis: `guac-cc5e88bdd651455d-1fa4417f4cd847c6`
 * created `2026-08-03T11:35:57Z` was still `running` 26+ hours later, with
 * nobody using it, because the container's own idle timer is defeated by the
 * 10s workspace-flush alarm auto-starting a stopped container).
 *
 * What it does:
 *   1. Lists LIVE instances via `wrangler containers instances <appId> --json`
 *      (read-only; the same command an operator runs by hand).
 *   2. Classifies each `running` instance as an orphan candidate when it has
 *      been running longer than `--max-age-minutes` (default 60 — comfortably
 *      above both the old `SLEEP_AFTER='30m'` and the new `'5m'`, so a
 *      container flagged here has already blown through its own sleep timer
 *      by a wide margin).
 *   3. Can terminate the resulting candidates, but ONLY through the Worker's
 *      EXISTING signed `DELETE /sandbox/:name` path (`handleTerminate` in
 *      `worker/src/index.ts`), which already does a final workspace flush to
 *      R2 and then `sandbox.destroy()` — see that file's doc comment. This
 *      script invents NO new teardown mechanism, and must NEVER shell out to
 *      `wrangler containers delete`, which destroys the entire Worker
 *      application, not one instance.
 *
 * Signing: the DELETE route is HMAC-gated by `authorizeSignedControlRequest`
 * (`worker/src/index.ts`), which accepts the EXACT SAME envelope every other
 * signed control request on this Worker uses (`verifyPreviewToken` /
 * `resolvePreviewSecrets`, `worker/src/hmac.ts`):
 *
 *   token format:  t=<unix_ms>,v1=<hex_hmac_sha256>
 *   signed payload: `${timestamp}.POST./sandbox/preview.`   (fixed string —
 *                    verification does not vary it per route/method; see
 *                    `authorizeSignedControlRequest`'s doc comment)
 *
 * This is NOT a new scheme — it is byte-for-byte the same construction as
 * `app/src/server/lib/cloudflare-guacamole-provider.ts`'s
 * `mintSandboxPreviewToken()` and this repo's own
 * `scripts/twen-live-validate.mjs` / `scripts/run-workspace-isolation-mission.ts`,
 * both of which mint it the same way with `node:crypto`'s `createHmac`
 * (standalone scripts in this repo do not import `src/hmac.ts` directly,
 * since that module is written against Web Crypto for the Workers runtime;
 * `mintControlToken` below is the same node:crypto reimplementation those
 * scripts already use, kept in exact lockstep with the payload/format
 * `hmac.ts`'s `verifyPreviewToken` checks).
 *
 * Guards (see README usage below for flags):
 *   - `--dry-run` is the DEFAULT. Terminating anything requires an explicit
 *     `--confirm`.
 *   - Any `running` instance whose name does not match the sandbox naming
 *     convention (`guac-<userId16>-<scopeId16>`, `deriveSandboxId()` /
 *     `deriveGuacamoleSandboxId()`) is NEVER a reap candidate — reported
 *     separately as refused. This is the same class of incident
 *     `handleTerminate`'s doc comment names live: a DELETE aimed at
 *     `<sandboxId>-nekodesktop` (the preview-hostname label) instead of the
 *     real sandbox id.
 *   - More than `--max-count` (default 25) orphan candidates in one run is a
 *     hard refusal — NOTHING is terminated — unless `--allow-more` is passed.
 *     A safety-net tool that can be tricked into mass-terminating by a bug
 *     upstream of it is worse than no tool.
 *   - The HMAC secret is read from the environment BY NAME
 *     (`CLOUDFLARE_GUACAMOLE_HMAC_SECRET` / `SANDBOX_HMAC_SECRET`) and is
 *     NEVER printed, logged, or included in any report.
 *
 * Usage:
 *   # Dry run (default) — safe to run any time, makes no Worker calls at all.
 *   bun scripts/reap-idle-sandboxes.mjs --app-id <containerAppId>
 *
 *   # Actually terminate the identified orphans.
 *   CLOUDFLARE_GUACAMOLE_WORKER_URL=https://api-desktop.ezil.org \
 *   CLOUDFLARE_GUACAMOLE_HMAC_SECRET=<by-name> \
 *   bun scripts/reap-idle-sandboxes.mjs --app-id <containerAppId> --confirm
 *
 * Flags:
 *   --app-id <id>          Container application id (required; also read from
 *                          SANDBOX_CONTAINER_APP_ID).
 *   --worker-url <url>     Worker base URL (only needed with --confirm; also
 *                          read from CLOUDFLARE_GUACAMOLE_WORKER_URL).
 *   --max-age-minutes <n>  Age threshold for "orphaned". Default 60.
 *   --max-count <n>        Refusal threshold. Default 25.
 *   --allow-more           Override the --max-count refusal.
 *   --confirm              Actually terminate (default is dry-run/report-only).
 *   --json                 Emit the full report as JSON on stdout.
 */

import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── Sandbox naming convention ────────────────────────────────────────────────

/**
 * Shape `deriveSandboxId()` (`worker/src/index.ts`) / `deriveGuacamoleSandboxId()`
 * (`app/src/server/lib/cloudflare-guacamole-provider.ts`) always produce:
 * `guac-<userId, alnum, 1-16 chars>-<scopeId, alnum, 1-16 chars>`.
 *
 * Deliberately anchored (`^...$`) so a legacy/incident-shaped name with an
 * extra trailing label — e.g. `guac-<id>-<id>-nekodesktop`, the exact
 * preview-hostname mixup `handleTerminate`'s doc comment documents as a real,
 * previously-live incident — does NOT match and is refused rather than
 * silently accepted as "close enough".
 */
export const SANDBOX_NAME_RE = /^guac-[a-zA-Z0-9]{1,16}-[a-zA-Z0-9]{1,16}$/;

export function isValidSandboxName(name) {
  return typeof name === 'string' && SANDBOX_NAME_RE.test(name);
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_AGE_MINUTES = 60;
export const DEFAULT_MAX_REAP_COUNT = 25;
export const DEFAULT_PER_PAGE = 1000;

// ── HMAC signing (same envelope as every other signed control request) ──────

/**
 * Mint the shared control-request token. Byte-for-byte the same construction
 * as `mintSandboxPreviewToken()` / `scripts/twen-live-validate.mjs` — see the
 * module doc comment above for why this is a deliberate reimplementation
 * rather than an import.
 */
export function mintControlToken(secret, now = Date.now()) {
  const timestamp = String(now);
  const payload = `${timestamp}.POST./sandbox/preview.`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

// ── Parsing `wrangler containers instances --json` output ───────────────────

/**
 * `wrangler`'s `--json` output is not guaranteed to be the ONLY thing on
 * stdout — an "update available" notice has been observed printed ahead of
 * the JSON array on stdout (not stderr) by the pinned wrangler version this
 * repo uses. Try parsing the whole (trimmed) output first — the clean case,
 * and the one that correctly rejects a well-formed non-array JSON value
 * rather than mis-locating a `[` inside it. Only on failure fall back to
 * locating the first `[` and parsing from there, so a cosmetic CLI notice
 * ahead of the real payload never turns into a hard parse failure.
 */
export function parseInstancesOutput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf('[');
    if (start === -1) {
      throw new Error(`wrangler_json_parse_failed: no JSON array found in output: ${raw.slice(0, 200)}`);
    }
    try {
      parsed = JSON.parse(raw.slice(start));
    } catch (err) {
      throw new Error(`wrangler_json_parse_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error('wrangler_json_parse_failed: expected a JSON array');
  }
  return parsed;
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * One instance's reap classification. `reason` is always set, so a report
 * never has to infer WHY something was or was not flagged.
 *
 *   'not_running'                — instance state isn't `running`; never billed.
 *   'invalid_name_refused'       — running, but the name fails the naming-
 *                                  convention guard. NEVER a reap candidate,
 *                                  regardless of age or --confirm.
 *   'unparseable_created_timestamp' — running, valid name, but `created`
 *                                  could not be parsed as a date. Refused
 *                                  rather than guessed.
 *   'running_within_age_budget'  — running, valid name, but younger than the
 *                                  age threshold. Not (yet) an orphan.
 *   'running_past_age_budget'    — the actual orphan candidate.
 */
export function classifyInstances(instances, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMinutes = opts.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES;
  const maxAgeMs = maxAgeMinutes * 60_000;

  return instances.map((inst) => {
    const name = inst?.name;
    const state = inst?.state;
    const createdAt = inst?.created ?? null;
    const running = state === 'running';
    const validName = isValidSandboxName(name);
    const createdMs = createdAt ? Date.parse(createdAt) : NaN;
    const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : null;

    let reason;
    let orphaned = false;
    if (!running) {
      reason = 'not_running';
    } else if (!validName) {
      reason = 'invalid_name_refused';
    } else if (ageMs === null) {
      reason = 'unparseable_created_timestamp';
    } else if (ageMs < maxAgeMs) {
      reason = 'running_within_age_budget';
    } else {
      orphaned = true;
      reason = 'running_past_age_budget';
    }

    return {
      name,
      state,
      createdAt,
      ageMinutes: ageMs === null ? null : Math.round(ageMs / 60_000),
      validName,
      orphaned,
      reason,
    };
  });
}

// ── Reap planning (the max-count refusal guard) ──────────────────────────────

/**
 * Turn a classified list into a plan. When the number of orphan candidates
 * exceeds `maxCount` and `allowMore` is not set, the WHOLE run is refused —
 * `ok: false`, `candidates: []` — rather than silently truncating to the
 * first N. Truncating would let a bug upstream of this tool (e.g. a clock
 * error, or the age threshold set too low) mass-terminate an arbitrary subset
 * with no operator signal; a hard refusal forces a human to look.
 */
export function planReap(classified, opts = {}) {
  const maxCount = opts.maxCount ?? DEFAULT_MAX_REAP_COUNT;
  const allowMore = opts.allowMore ?? false;
  const candidates = classified.filter((c) => c.orphaned);
  const refused = classified.filter((c) => c.reason === 'invalid_name_refused');

  if (!allowMore && candidates.length > maxCount) {
    return {
      ok: false,
      error: `too_many_candidates: ${candidates.length} orphan candidates exceeds --max-count ${maxCount} (pass --allow-more to override)`,
      candidates: [],
      refused,
      totalOrphans: candidates.length,
    };
  }

  return { ok: true, candidates, refused, totalOrphans: candidates.length };
}

// ── Execution (the dry-run-by-default guard) ─────────────────────────────────

/**
 * Apply a plan's candidates. When `dryRun` is true (the default everywhere
 * this is called from `main()`), `terminate` is NEVER invoked — this is the
 * single choke point the dry-run guard depends on.
 */
export async function executeReap(candidates, opts) {
  const { dryRun, terminate } = opts;
  const results = [];
  for (const candidate of candidates) {
    if (dryRun) {
      results.push({ name: candidate.name, action: 'would_terminate', executed: false });
      continue;
    }
    const outcome = await terminate(candidate.name);
    results.push({ name: candidate.name, action: 'terminated', executed: true, outcome });
  }
  return results;
}

// ── Worker call (real teardown — the EXISTING signed DELETE path only) ──────

/**
 * Terminate one sandbox through the Worker's `DELETE /sandbox/:name`. Never
 * throws — a transport failure or a non-2xx response comes back as
 * `{ ok: false, ... }`, mirroring
 * `cloudflare-guacamole-provider.ts`'s `requestGuacamoleSandboxTerminate`
 * (whose contract this deliberately matches byte-for-byte, since it is the
 * same route signed the same way).
 */
export async function terminateSandbox({ workerUrl, secret, name, timeoutMs = 10_000 }) {
  const token = mintControlToken(secret);
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => '');
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Non-JSON body (edge error page) — fall through with empty data.
    }
    if (!res.ok) {
      return {
        ok: false,
        terminated: false,
        outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
        error: typeof data.error === 'string' ? data.error : `worker_http_${res.status}`,
      };
    }
    return {
      ok: data.ok === true,
      terminated: data.terminated === true,
      outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
      error: typeof data.error === 'string' ? data.error : undefined,
    };
  } catch (err) {
    return { ok: false, terminated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Listing (read-only `wrangler containers instances --json`) ──────────────

/**
 * List LIVE instances for a container application via the read-only
 * `wrangler containers instances <appId> --json` command — the exact command
 * an operator runs by hand. Never mutates anything.
 */
export function listInstancesViaWrangler({ appId, cwd, perPage = DEFAULT_PER_PAGE }) {
  const result = spawnSync('bunx', ['wrangler', 'containers', 'instances', appId, '--json', '--per-page', String(perPage)], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`wrangler_spawn_failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`wrangler_exit_${result.status}: ${(result.stderr || '').slice(0, 500)}`);
  }
  const instances = parseInstancesOutput(result.stdout ?? '');
  if (instances.length === perPage) {
    // Cannot tell whether this is the true total or a truncated page — the
    // CLI exposes no next-page cursor. Surface it as a warning field instead
    // of silently under-reporting.
    instances.__possiblyTruncated = true;
  }
  return instances;
}

// ── CLI argument parsing ──────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    dryRun: true,
    appId: undefined,
    workerUrl: undefined,
    maxAgeMinutes: DEFAULT_MAX_AGE_MINUTES,
    maxCount: DEFAULT_MAX_REAP_COUNT,
    allowMore: false,
    json: false,
    only: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--confirm':
        args.dryRun = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--allow-more':
        args.allowMore = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--app-id':
        args.appId = argv[++i];
        break;
      case '--worker-url':
        args.workerUrl = argv[++i];
        break;
      case '--only':
        args.only = argv[++i];
        break;
      case '--max-age-minutes': {
        const v = Number(argv[++i]);
        if (Number.isFinite(v) && v >= 0) args.maxAgeMinutes = v;
        break;
      }
      case '--max-count': {
        const v = Number(argv[++i]);
        if (Number.isFinite(v) && v >= 0) args.maxCount = v;
        break;
      }
      default:
        break;
    }
  }
  return args;
}

// ── Reporting ─────────────────────────────────────────────────────────────────

export function formatReport(classified, plan, opts) {
  const lines = [];
  const running = classified.filter((c) => c.state === 'running');
  lines.push(`Total instances: ${classified.length}`);
  lines.push(`Running: ${running.length}`);
  lines.push(`Orphan candidates (running > ${opts.maxAgeMinutes}m): ${plan.totalOrphans ?? 0}`);
  if (plan.refused && plan.refused.length > 0) {
    lines.push(`Refused (running, invalid name — NEVER acted on): ${plan.refused.length}`);
    for (const r of plan.refused) lines.push(`  - ${r.name} (created ${r.createdAt})`);
  }
  if (!plan.ok) {
    lines.push(`REFUSED: ${plan.error}`);
    return lines.join('\n');
  }
  for (const c of plan.candidates) {
    lines.push(`  ORPHAN: ${c.name}  running ${c.ageMinutes}m  created ${c.createdAt}  (${opts.dryRun ? 'would reap — dry run' : 'REAPING'})`);
  }
  if (plan.candidates.length === 0) {
    lines.push('  (none)');
  }
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appId = args.appId ?? process.env.SANDBOX_CONTAINER_APP_ID;
  if (!appId) {
    console.error('missing --app-id (or SANDBOX_CONTAINER_APP_ID)');
    process.exitCode = 2;
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const workerCwd = path.resolve(scriptDir, '..');

  let instances;
  try {
    instances = listInstancesViaWrangler({ appId, cwd: workerCwd });
  } catch (err) {
    console.error(`failed to list instances: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const filtered = args.only ? instances.filter((i) => i.name === args.only) : instances;
  const classified = classifyInstances(filtered, { maxAgeMinutes: args.maxAgeMinutes });
  const plan = planReap(classified, { maxCount: args.maxCount, allowMore: args.allowMore });

  if (args.json) {
    console.log(JSON.stringify({ dryRun: args.dryRun, classified, plan }, null, 2));
  } else {
    console.log(formatReport(classified, plan, { maxAgeMinutes: args.maxAgeMinutes, dryRun: args.dryRun }));
  }

  if (!plan.ok) {
    // Hard refusal (too many candidates without --allow-more). Nothing was
    // touched. Non-zero exit so a scripted caller notices.
    process.exitCode = 3;
    return;
  }

  if (plan.candidates.length === 0) {
    return; // Nothing to do, dry-run or not.
  }

  if (args.dryRun) {
    console.log('\nDRY RUN — no instance was touched. Re-run with --confirm to terminate the above.');
    return;
  }

  // --confirm path: real teardown through the existing signed DELETE route.
  const workerUrl = args.workerUrl ?? process.env.CLOUDFLARE_GUACAMOLE_WORKER_URL;
  const secret =
    process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET ?? process.env.SANDBOX_HMAC_SECRET ?? '';
  if (!workerUrl) {
    console.error('missing --worker-url (or CLOUDFLARE_GUACAMOLE_WORKER_URL) — required for --confirm');
    process.exitCode = 2;
    return;
  }
  if (!secret) {
    console.error('missing CLOUDFLARE_GUACAMOLE_HMAC_SECRET / SANDBOX_HMAC_SECRET — required for --confirm');
    process.exitCode = 2;
    return;
  }

  const results = await executeReap(plan.candidates, {
    dryRun: false,
    terminate: (name) => terminateSandbox({ workerUrl, secret, name }),
  });

  let failures = 0;
  for (const r of results) {
    const ok = r.outcome?.ok === true;
    if (!ok) failures++;
    console.log(`${ok ? 'OK' : 'FAILED'}: ${r.name} -> ${JSON.stringify(r.outcome)}`);
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
