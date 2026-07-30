/**
 * VENDORED COPY of the Worker-relevant slice of
 * `packages/constants/src/preview-timeouts.ts` (the canonical
 * `@ezil/constants` source of truth for the client/Worker cold-start
 * timeout ordering contract — see that file's module doc for the full
 * rationale).
 *
 * Why vendored instead of imported by relative path (as this file used to
 * be, `../../../packages/constants/src/preview-timeouts`): `infra/cf-guacamole-sandbox`
 * is a standalone Cloudflare Worker package with its own `package.json`/
 * lockfile that is deliberately NOT a member of the root Bun workspace (see
 * the canonical file's doc comment for why turning it into one is a much
 * larger change than this warrants). `wrangler deploy` bundles this Worker
 * with esbuild from an ISOLATED copy of just this directory in some
 * deployment paths (e.g. a build step that copies `infra/cf-guacamole-sandbox`
 * out of the monorepo before running `wrangler deploy`) — in that context
 * `../../../packages/constants/...` resolves to nothing and the build fails
 * with `Could not resolve "../../../packages/constants/src/preview-timeouts"`.
 * A same-directory vendored copy has no such path dependency.
 *
 * This trades the elegance of a single import for an explicit duplication —
 * `preview-timeouts.test.ts`'s drift guard is what keeps that duplication
 * honest: it asserts this value equals the canonical one whenever
 * `packages/constants` is reachable in the current checkout (i.e. always in
 * CI / normal development, never in an isolated deploy-only checkout, where
 * the guard harmlessly skips instead of failing the build it's protecting).
 */

/**
 * Max time (ms) the Worker (`infra/cf-guacamole-sandbox/src/index.ts`) waits
 * for the SELECTED desktop service to bind + serve, covering the slowest
 * (Neko) cold-start path end to end.
 *
 * MUST match `packages/constants/src/preview-timeouts.ts`'s
 * `WORKER_DESKTOP_READY_TIMEOUT_MS` — see this file's module doc.
 */
export const WORKER_DESKTOP_READY_TIMEOUT_MS = 180_000;
