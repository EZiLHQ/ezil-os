/**
 * Regression test: EVERY port this Worker hands to `exposePort()` —
 * `APP_PREVIEW_PORT` and `CODE_PREVIEW_PORT` — must pass the REAL
 * `@cloudflare/sandbox` SDK's own `validatePort()`, not a hand-copied
 * reimplementation of its reserved-port rules. A hand-copied reimplementation is exactly how the
 * original bug went unnoticed: `APP_PREVIEW_PORT` was `3000`, which
 * `validatePort()` has always rejected (3000 is reserved for the SDK's own
 * sandbox control plane — see `desktop-mode.ts`'s doc comment on
 * `APP_PREVIEW_PORT`), and nothing ever checked the port against the SDK's
 * actual rules until this test.
 *
 * `validatePort` is NOT part of `@cloudflare/sandbox`'s public API — it does
 * not appear in `dist/index.js`'s own `export { ... }` statement, only in an
 * internal, content-hashed chunk (e.g. `dist/sandbox-DKG3H156.js`) that
 * `index.js` imports it from under a minified alias. So this test:
 *
 *   1. Resolves that chunk's filename and the current minified alias
 *      DYNAMICALLY from `index.js`'s own import statement, rather than
 *      hardcoding the content hash — so a routine `@cloudflare/sandbox`
 *      version bump (which changes the hash) fails loudly with a clear
 *      error here instead of silently no-op'ing or bit-rotting.
 *   2. Stubs the workerd-only `cloudflare:workers` virtual module (which
 *      that chunk transitively imports for `RpcTarget`/`DurableObject`/
 *      `WorkerEntrypoint` — types with no meaning outside the Workers
 *      runtime) with inert placeholders via a Bun `plugin()`, purely so the
 *      chunk can load under plain `bun test`. `validatePort` itself is a
 *      pure numeric range/reserved-list check with no dependency on any of
 *      those classes, so the stub never needs to behave like the real thing
 *      — we never instantiate an `RpcTarget`/`DurableObject` here.
 */

import { plugin } from 'bun';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { APP_PREVIEW_PORT, CODE_PREVIEW_PORT, appPortFor, codePortFor, portFor } from './desktop-mode';

plugin({
  name: 'stub-cloudflare-workers-for-validate-port-test',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      exports: {
        RpcTarget: class RpcTarget {},
        DurableObject: class DurableObject {},
        WorkerEntrypoint: class WorkerEntrypoint {},
        env: {},
      },
      loader: 'object',
    }));
  },
});

const sandboxDistDir = fileURLToPath(
  new URL('../node_modules/@cloudflare/sandbox/dist/', import.meta.url),
);
const indexSrc = readFileSync(`${sandboxDistDir}index.js`, 'utf8');

const importLine = indexSrc
  .split('\n')
  .find((line) => /\bas validatePort\b/.test(line) && line.includes(' from '));
if (!importLine) {
  throw new Error(
    "Could not find the `validatePort` import in @cloudflare/sandbox's dist/index.js — " +
      'the SDK must have changed its internal bundling shape; update this test.',
  );
}
const chunkMatch = importLine.match(/ from ["']\.\/([^"']+)["']/);
const aliasMatch = importLine.match(/(\w+) as validatePort\b/);
if (!chunkMatch || !aliasMatch) {
  throw new Error(
    'Could not extract the chunk filename or alias for `validatePort` from the import line: ' +
      importLine,
  );
}
const chunkPath = `${sandboxDistDir}${chunkMatch[1]}`;
const validatePortAlias = aliasMatch[1];

describe('APP_PREVIEW_PORT vs. the real @cloudflare/sandbox SDK', () => {
  it("passes the SDK's own validatePort() (imported live from the SDK, not reimplemented)", async () => {
    const mod = (await import(chunkPath)) as Record<string, unknown>;
    const validatePort = mod[validatePortAlias] as ((port: number) => boolean) | undefined;
    expect(typeof validatePort).toBe('function');

    // The actual regression: APP_PREVIEW_PORT must be accepted.
    expect(validatePort!(APP_PREVIEW_PORT)).toBe(true);

    // Sanity checks against the SDK's real, current reserved-port rules
    // (see `validatePort`'s own doc comment in the SDK source: range
    // 1024-65535, port 3000 reserved for the sandbox control plane) — these
    // pin down that the stub above didn't accidentally neuter the function
    // into a no-op that would make the assertion above meaningless.
    expect(validatePort!(3000)).toBe(false); // reserved control-plane port
    expect(validatePort!(1023)).toBe(false); // below the allowed range
    expect(validatePort!(1024)).toBe(true); // bottom of the allowed range
    expect(validatePort!(65536)).toBe(false); // above the allowed range
  });
});

// The code-server bridge port (`codePortFor`, `preview-bridge.ts`'s
// `parseBridgeHost` target `'code'`) is exposed through the exact same
// `exposePreviewPort()` -> `sandbox.exposePort()` call as the app-preview
// port, so it is subject to the identical SDK rule. It was added without this
// check; that is precisely the shape of the original 3000 bug (a port that
// looks fine, is never validated against the SDK, and fails only at runtime
// inside `ensureDesktop`'s best-effort try/catch — i.e. silently).
describe('CODE_PREVIEW_PORT vs. the real @cloudflare/sandbox SDK', () => {
  it("passes the SDK's own validatePort()", async () => {
    const mod = (await import(chunkPath)) as Record<string, unknown>;
    const validatePort = mod[validatePortAlias] as ((port: number) => boolean) | undefined;
    expect(typeof validatePort).toBe('function');
    expect(validatePort!(CODE_PREVIEW_PORT)).toBe(true);
  });

  it('collides with no other port this Worker exposes or reserves', () => {
    // 3000 = SDK control plane, 8080 = guacamole/Tomcat, 8181 = neko WebRTC,
    // 3002 = the user's own dev server. A collision here is not a test-only
    // concern: two `exposePort()` calls on the same port inside one sandbox
    // fight over the same token registration.
    const reserved = new Set<number>([
      3000,
      portFor('guacamole').port,
      portFor('neko').port,
      APP_PREVIEW_PORT,
    ]);
    expect(reserved.has(CODE_PREVIEW_PORT)).toBe(false);
    expect(CODE_PREVIEW_PORT).toBe(8443);
  });

  it('pairs a distinct token with a distinct port for every neko-mode exposure', () => {
    const exposures = [portFor('neko'), appPortFor('neko'), codePortFor('neko')].filter(
      (e): e is { port: number; token: string } => e !== null,
    );
    expect(new Set(exposures.map((e) => e.port)).size).toBe(exposures.length);
    expect(new Set(exposures.map((e) => e.token)).size).toBe(exposures.length);
    // Hostname-label constraint (see `portFor`'s doc comment): the SDK's
    // `exposePort` rejects anything outside `[a-z0-9_]+`, and a DNS label
    // further forbids `_`.
    for (const { token } of exposures) expect(token).toMatch(/^[a-z0-9]+$/);
  });
});
