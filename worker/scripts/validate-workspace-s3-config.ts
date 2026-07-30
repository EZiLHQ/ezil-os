#!/usr/bin/env bun
/**
 * Redacted local validation harness for the S3-backed sandbox workspace.
 *
 * NOTE: the preferred production mount path is the native R2 binding
 * (`[[r2_buckets]] binding = "SANDBOX_WORKSPACE_R2_BUCKET"` in
 * wrangler.toml, bucket `ezil-sandbox-workspaces`) — a Worker binding, not a
 * `process.env` var, so it is intentionally out of scope for this
 * `process.env`-only presence check. The vars below back the S3-compatible
 * *fallback* path (`resolveWorkspaceMountConfig()`'s `mode: 's3'` branch),
 * used only when no R2 binding is wired (e.g. local Supabase Storage dev).
 *
 * SCOPE (this lane): reports which required runtime variable NAMES are
 * present/absent in the current process env. It never reads, logs, or
 * requires the actual credential-bearing VALUES, and it performs zero
 * network or S3 operations.
 *
 * The full credentialed E2E lane can reuse `REQUIRED_WORKSPACE_S3_VARS`
 * below plus `buildValidationPrefix()` to run the actual mount/seed/
 * read/write/cleanup cycle against a disposable prefix, without duplicating
 * the variable-name list or prefix format.
 *
 * Usage:
 *   bun run infra/cf-guacamole-sandbox/scripts/validate-workspace-s3-config.ts
 *
 * Exit code is always 0 — this is a report, not a pass/fail gate — so it is
 * safe to run in CI or locally without credentials configured.
 */

/**
 * Required runtime variable NAMES for the S3-compatible sandbox workspace
 * bucket mount. Kept in one place (here) so the redacted validator, the
 * future credentialed E2E harness, and documentation can all reference the
 * same source of truth instead of re-deriving it independently.
 *
 * Mirrors `resolveWorkspaceMountConfig()` in
 * `infra/cf-guacamole-sandbox/src/index.ts` — update both together.
 */
export const REQUIRED_WORKSPACE_S3_VARS = [
  'SANDBOX_WORKSPACE_S3_ENDPOINT',
  'SANDBOX_WORKSPACE_S3_BUCKET',
  'SANDBOX_WORKSPACE_S3_ACCESS_KEY_ID',
  'SANDBOX_WORKSPACE_S3_SECRET_ACCESS_KEY',
] as const;

/** Optional runtime variables — absence falls back to documented defaults. */
export const OPTIONAL_WORKSPACE_S3_VARS = [
  'SANDBOX_WORKSPACE_S3_PREFIX',
  'SANDBOX_WORKSPACE_S3_PROVIDER',
  'SANDBOX_WORKSPACE_MOUNT_PATH',
] as const;

export type WorkspaceVarName =
  | (typeof REQUIRED_WORKSPACE_S3_VARS)[number]
  | (typeof OPTIONAL_WORKSPACE_S3_VARS)[number];

export interface WorkspaceVarPresence {
  name: WorkspaceVarName;
  required: boolean;
  present: boolean;
}

/**
 * Disposable validation prefix format for the credentialed E2E lane.
 *
 * Every object the credentialed E2E test writes/reads/deletes MUST live
 * under this prefix so validation runs are trivially identifiable and
 * safely cleaned up without risking real project workspace data.
 *
 * Format: `/__ezil_validation__/<runId>` where `runId` is any
 * caller-supplied unique token (e.g. a timestamp or uuid).
 */
export function buildValidationPrefix(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeRunId) {
    throw new Error('buildValidationPrefix: runId must contain at least one safe character');
  }
  return `/__ezil_validation__/${safeRunId}`;
}

/**
 * Reads `process.env` (by NAME only) and reports present/absent for each
 * required and optional workspace S3 variable. Never returns or logs the
 * variable VALUES.
 */
export function checkWorkspaceEnvPresence(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceVarPresence[] {
  const required = REQUIRED_WORKSPACE_S3_VARS.map((name) => ({
    name,
    required: true as const,
    present: Boolean(env[name]?.trim()),
  }));
  const optional = OPTIONAL_WORKSPACE_S3_VARS.map((name) => ({
    name,
    required: false as const,
    present: Boolean(env[name]?.trim()),
  }));
  return [...required, ...optional];
}

function main(): void {
  const results = checkWorkspaceEnvPresence();
  const allRequiredPresent = results.filter((r) => r.required).every((r) => r.present);

  console.log('── Redacted S3 workspace config validation ──────────────────────');
  console.log('(names only — no credential values are read, logged, or required)\n');

  for (const r of results) {
    const tag = r.required ? 'required' : 'optional';
    const status = r.present ? 'present' : 'absent';
    console.log(`  [${status.padEnd(6)}] (${tag.padEnd(8)}) ${r.name}`);
  }

  console.log('');
  if (allRequiredPresent) {
    console.log(
      'All required variable NAMES are present. This lane does not verify values or\n' +
        'perform any credentialed S3 operation — the credentialed E2E lane can now run\n' +
        `using a disposable prefix, e.g. ${buildValidationPrefix('example-run-id')}.`,
    );
  } else {
    console.log(
      'Not all required variable NAMES are present. Worker will report\n' +
        '`workspace_bucket_not_configured` for `/sandbox/preview` — expected in local\n' +
        'dev without S3 wired up. This is NOT an error in this lane.',
    );
  }

  // Always exit 0: this is a report, not a pass/fail gate.
  process.exit(0);
}

if (import.meta.main) {
  main();
}
