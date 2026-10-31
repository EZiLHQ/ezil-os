/**
 * The workspace's key prefix: the Cloudflare open's derivation (`ensureWorkspaceMount`
 * and `/sandbox/preview`, index.ts) as functions, for the reverse import (AWS →
 * Cloudflare, docs/compute/REVERSE-MOVE-CONTRACT.md §4.1, "P").
 *
 * 🔴 The import writes the head the NEXT Cloudflare open of the computer reads.
 * If the two derivations ever drift, the import commits a head nothing hydrates
 * and the open seeds an empty workspace over the user's files.
 * `workspace-prefix.test.ts` drives the real `/sandbox/preview` route and fails on
 * any drift. index.ts keeps its expressions inline for now: `index.test.ts` pins
 * their source text (`config.prefix ?? …`, `|| 'main'`).
 */
import { realR2KeyPrefix } from './workspace-seed';

/** The app's Cloudflare open sends no branch; the Worker defaults it (index.ts `workspaceBranch`). */
export const DEFAULT_WORKSPACE_BRANCH = 'main';

/**
 * `SANDBOX_WORKSPACE_S3_PREFIX`, read exactly as the mount config reads it: trimmed, and
 * present whenever the variable is (an empty value is still an override, never the default).
 * It is deployment-wide, the same for every computer.
 */
export function workspacePrefixOverride(env: { SANDBOX_WORKSPACE_S3_PREFIX?: string }): string | undefined {
  return env.SANDBOX_WORKSPACE_S3_PREFIX?.trim();
}

/**
 * The prefix the open hands `hydrateWorkspace`, with the leading slash `mountBucket()` requires:
 * the deployment-wide override when present (`??`, not `||`: kept byte for byte), else
 * `/<projectId>/branches/<branch>`. The real key prefix is `realR2KeyPrefix` of it.
 */
export function workspaceMountPrefix(override: string | undefined, scope: { projectId: string; branch: string }): string {
  return override ?? `/${scope.projectId}/branches/${scope.branch}`;
}

/**
 * P: the real key prefix the next Cloudflare open of `computerId` hydrates when no override is
 * set. The app opens a computer with `projectId` = its id (`cloudflare.ts`) and no branch.
 * An import under an override would write a deployment-wide head, so it is refused instead.
 */
export function importWorkspacePrefix(computerId: string): string {
  return realR2KeyPrefix(workspaceMountPrefix(undefined, { projectId: computerId, branch: DEFAULT_WORKSPACE_BRANCH }));
}
