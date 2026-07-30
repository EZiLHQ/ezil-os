# Platform notes — verified findings

Everything here was established empirically against live infrastructure, not inferred
from documentation. Each item cost real debugging time. Read this before assuming any
part of the Cloudflare Containers / Workers / Neko stack behaves the way its docs imply.

---

## 1. R2 mounted via s3fs silently drops every second write

**Do not use `sandbox.mountBucket()` as a working filesystem.**

Writes alternate: 1st succeeds, 2nd fails with **0 bytes written**, 3rd succeeds, 4th
fails. Positional, not name-dependent. Reproduced 5× live with 8-second gaps to rule out
timing.

**Root cause** — the 403 is emitted by Cloudflare's own S3 emulator running *inside the
Durable Object* (`r2EgressHandler` in `@cloudflare/sandbox`). s3fs talks to
`http://r2.internal`; on even writes it takes a copy-based metadata-update path carrying
`x-amz-copy-source`, which the emulator rejects. The copy branch also does
`customMetadata: sourceObject.customMetadata`, discarding the request's `x-amz-meta-*` —
which is why failing writes show `mode=0` with missing `atime`/`gid`/`uid`.

**Present in the latest SDK. Upgrading does not fix it.**

**The failure is invisible.** The 403 surfaces only from FUSE `flush`/`release` — i.e.
`close(2)` — which shell redirection never checks. `s3fs -o retries=N` retries 5xx and
curl errors only; a 403 is fatal `EACCES`. **There is no retry wrapper you can put around
VS Code, git, or npm.**

**What to do instead:** local disk is the filesystem; R2 is the durable store, written
only through the Worker's **R2 binding**. Hydrate on boot, flush on a short interval.

Cloudflare's own docs agree, for a different reason: *"operations on mounted buckets are
slower due to network latency… copy frequently accessed files locally."*

## 2. R2 is also pathological for small files

Independently of the loss bug. s3fs fetches metadata one object at a time with no batch
listing. Community evidence on comparable trees: `ls -R` >10 min cold, a 14,499-object
clone ~30 min, an incremental build that **exceeded 5 hours and failed**.

`node_modules` is tens of thousands of small files. **Never let it touch an object store.**
Keep it on local ephemeral disk and regenerate it — `bun install` is deterministic and
faster than syncing.

## 3. `wrangler deploy --dry-run` does not prove deployability

It bundles. **It never boots workerd.** A Worker that cannot start will dry-run clean.

Corollary: **workerd validates every top-level export of the entrypoint module** and
requires each to be a function / class / `ExportedHandler`. A plain `const` re-export
aborts the entire runtime:

```
Uncaught TypeError: Incorrect type for map entry 'X':
the provided value is not of type 'function or ExportedHandler'
```

Rejection is value-type-specific — RegExps and arrays survive; a plain number does not.
Re-export functions only.

## 4. `unstable_dev()` hangs instead of failing on a broken entrypoint

It **resolves successfully** even when workerd failed to start. The failure surfaces
asynchronously on stderr and is never thrown; the subsequent `worker.fetch()` then hangs
forever.

So the obvious boot test *hangs* rather than fails — worse than no test, because a hang
reads as slow CI and earns a longer timeout instead of an investigation. Watch stderr for
the failure signature and race it against the fetch.

Also: `unstable_dev()` hangs indefinitely under **Bun** with no error, and works under
**Node**. Run it as a Node child process.

## 5. Port 3000 is reserved

`validatePort(3000) === false`. `@cloudflare/sandbox` reserves it for the sandbox control
plane, and the base image's entrypoint binds it inside the container. `exposePort(3000)`
throws `SandboxSecurityError` before any network call.

Two failure modes stack: the SDK refuses to expose it, *and* a dev server on 3000 would
hit `EADDRINUSE`.

## 6. There is no UDP path to a container

Cloudflare Containers expose HTTP/WS only. **Direct WebRTC P2P is architecturally
impossible** — both peers must relay through TURN. That is the latency floor and it is
not tunable without leaving the platform.

Consequence for a streamed desktop: the iframe-over-reverse-proxy path (plain HTTP) is
lower latency than the WebRTC desktop for anything that can be rendered as a web page.
Make the desktop the fallback, not the default.

## 7. No GPU, no hardware encode

Everything is software-rendered and software-encoded. On a small instance, a desktop
streamer competes with the compiler for the same cores.

Tuning that matters for a *coding* desktop: lower the framerate (static text, not motion
video), hold the bitrate (sharper text for free), and set encoder `threads=1` on a
fractional-vCPU instance — multiple encoder threads on half a core is pure contention.

## 8. Containers have no guaranteed lifetime

Host restarts happen "on an irregular cadence" with no notice, *even while active*. All
local disk is ephemeral; there is no volume primitive and disk snapshots are announced
but unshipped.

So persistence must be **continuous and eager**. Flushing on idle/sleep is not enough.

## 9. Prefix derivation is a data-leak surface

Any workspace prefix derived from a non-globally-unique value collapses users onto a
shared prefix. Two real instances found:
- a `?? 'default'` fallback meaning any caller omitting an id mounted a globally shared
  workspace;
- an empty-string prefix reducing `bucket.list({prefix:''})` to **the whole bucket**.

**Rule: prefixes are UUIDs, required — never defaulted, never widened, never derived from
an ordinal.** Add explicit empty-prefix refusal guards.

## 10. Sync loops must never delete

A flush that treats *absent locally* as *delete remotely* destroys a workspace the first
time it runs against a partially-hydrated one.

Enforce it in the type system, not by convention: give the flush path a bucket interface
declaring **only `put()`**. It then cannot delete, because it has no method to.
Gate flush on verified-complete hydration.

## 11. Observability is `wrangler tail` and nothing else

There is no exec route into a production container. Emit timestamped, phase-tagged logs
with elapsed ms through the whole boot — a single `tail` should show where time goes and
where a boot died.

Measured reference: full container boot **21.9s** (`desktop_ready_wait` ~15.3s dominant,
`workspace_mount` ~5.9s, `container_start` ~0.3s). If a timeout budget is many times
this, it is probably absorbing something that is no longer there.

## 12. Next.js 16 + Turbopack breaks Vercel packaging

`next build` succeeds completely, then Vercel's packager fails:
```
ENOENT: .next/server/middleware.js.nft.json
```
The rename `proxy.js.nft.json → middleware.js.nft.json` is gated on
`bundler !== Turbopack`, and Next 16 defaults to Turbopack. Build with `--webpack` until
upstream fixes it.

## 13. Vercel-specific gotchas for this shape of app

- **`maxDuration` is not inherited.** A route with a long budget (a container cold start)
  must declare it explicitly or the platform default kills it in 10-15s.
- **Middleware may activate for the first time** on Vercel if a previous host stripped it
  at build. Check that server-to-server callbacks are exempt, or they get 302'd to login.
- **Serverless multiplies DB pools.** Each warm instance *and each route bundle* carries
  its own. Cap the pool, set a non-zero `idle_timeout`, and prefer a transaction pooler.

---

## Method notes

Two habits found more bugs than any amount of code reading:

1. **Run it for real.** Every significant finding here came from `wrangler dev`, `docker
   run` against the built image, `psql` against the live DB, or `curl` against production
   — never from a passing test suite. Several of these bugs coexisted with a fully green
   suite.
2. **Verify the claim, not the code.** Comments and docs in a mature codebase are often
   wrong — a "known unsupported" primitive turned out to work, a "never runs" migration
   had run, a documented reference implementation was a dead prototype. Check the artifact
   that actually executes.
