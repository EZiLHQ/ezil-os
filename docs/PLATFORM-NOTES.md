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

## 14. React hydration DELETES DOM that a non-React script created first

Mount a non-React UI (our jQuery shell) into a React document and the ordering is a
race you will eventually lose. If anything mutates a node React rendered — a class on
`<body>`, a child of the mount point — **before** React hydrates, React reports a
mismatch (minified error **#418**) and **regenerates the whole tree from its own copy**,
deleting everything the other script built.

**`suppressHydrationWarning` suppresses the warning, not the regeneration.** And the
wreckage is worse than a repaint: React re-creates `<script src>` tags, and a
re-inserted script **never executes again**, so nothing can re-boot the page. Any
`mounted` latch then keeps it dead. The user gets a permanently blank white page.

It hides on a warm localhost, where React wins every time. Delay **only**
`/_next/static/chunks/**` — what a real network, or a repeat visit with the app's own
assets cached, produces — and it appears: 150ms 3/3 fine, 300ms 1/3 destroyed, 900ms
**4/5 destroyed**, on the production build. `next dev` lost ~75% of loads.

Three rules, in order of how much they buy:
1. **Do not touch React-owned DOM before hydration.** Have the page tell the script
   when it has hydrated (a `useEffect` + an event), and cap the wait so a page whose
   React never loads still works.
2. **`dangerouslySetInnerHTML` is the "not your business" marker.** An element with it
   gets no child fibers, so React neither hydrates nor reconciles its contents. It is
   the only supported way to hand a subtree to a foreign renderer.
3. **Make the mount rebuildable.** Watch for your root leaving the document and build
   it again, bounded. The failure mode must degrade to "boots twice", never "blank
   forever" — a guarantee that survives the next unforeseen mutation.

## 15. The Supabase SSR middleware duplicates an auth round trip you already pay

The stock recipe calls `supabase.auth.getUser()` in middleware. Every protected surface
then calls it again, and middleware **completes before** a Server Component renders, so
the two are strictly serial and never overlap. **MEASURED: `GET /auth/v1/user` is 154ms**
from the app host — ~318ms of duplicate network in the TTFB of every authenticated page.

Middleware performs no authorization here; its only job is refreshing a cookie a Server
Component cannot write. `getSession()` does that job and goes to the network **only when
the token has actually expired**. The warning about `getSession()` on the server is about
*trusting* what it returns — discard it and there is nothing to trust.

Two things this exposes that are easy to miss:
- **The standard matcher covers your static assets.** It excludes `_next/static` and
  image extensions — so `/os/bundle.min.js` and `/os/bundle.min.css` were each paying
  the round trip too.
- **Measure the floor before promising one.** After the fix, `/os` TTFB is 414ms, of
  which 154ms is one auth round trip and 240ms is one computer lookup (a bare
  `select 1` on the same pool is 120ms from this host). A <200ms target is a
  *geography* problem — app and database in one region — not an await-ordering problem.
  This project already issues **ES256** tokens, so `supabase.auth.getClaims()` would
  verify the JWT in-process and remove the remaining 154ms, at the cost of not seeing a
  revocation until the token expires.

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
