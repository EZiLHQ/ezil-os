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

## 16. `guacamoleRunning: true` and an HTTP 500 preview host are not a contradiction

Observed live 2026-07-31: the Worker's `/sandbox/:id/status` reported
`guacamoleRunning: true` while every request to the preview host returned
**HTTP 500 `Proxy routing error`**. Both are correct. They describe different
things, and nothing in the stack made that obvious.

`describeDesktopStatus` derives `guacamoleRunning` from
`sandbox.getExposedPorts()`, which reads **Durable Object storage plus
`ctx.container.running`** and never issues a request through the edge. A port
registered in DO storage whose *edge route* is broken therefore reports healthy
indefinitely. **The container-side signal structurally cannot see a routing
failure.**

The 500 itself is not Cloudflare's. It is `@cloudflare/sandbox`'s own catch-all
in `proxyToSandbox` (`dist/index.js`):

```js
} catch (error) {
  createProxyLogger(request).error("Proxy routing error", ...);
  return new Response("Proxy routing error", { status: 500 });
}
```

Two consequences worth knowing before you spend an hour on it:
- **The body carries no diagnostic information by construction.** Every failure
  inside `sandbox.fetch(previewRequest)` — the DO fetch, not the container —
  collapses to the same nine bytes. The real error goes only to the logger, so
  per §11 it exists **only in `wrangler tail`**, and only while you are
  attached.
- **The status line is the only thing you can read from outside**, which is
  exactly what the frame-honesty check keys on: `probeDesktopFrame` treats
  `status >= 400` as not-alive rather than trying to interpret a body that was
  designed not to say anything.

Product consequence, and the reason this note exists: **an iframe cannot see it
either.** `load` fires for that 500 page exactly as it does for a working
desktop, and cross-origin script can read neither the status code nor the
document. So the browser has no honest signal about its own frame at all —
only the server does, by fetching the origin itself. Anything that claims
"ready", "Live", or hides a boot panel must be gated on that server-side
observation. See `probeDesktopFrame` / `confirmFrame` and
`computeBootUiState`'s `success` branch.

## 17. A `<script src>` inserted by an App Router soft navigation never executes — including a server action's `redirect()`

Observed live 2026-07-31, production build, real Chromium, real Supabase login:
`/login?returnUrl=%2Fos` after a fresh sign-in landed on `/os` with `bundleFetched: 0`,
`window.ezil` and `window.__EZIL_BOOT__` both `undefined`, no taskbar, no visible text —
30 seconds after landing, permanently. Only a manual reload recovered it. Independently
reproduced from `router.push('/os')`, i.e. from what any future `<Link href="/os">`
would do, and confirmed absent on a real document load (24/24 clean in the same session).

**What happens.** The HTML living standard only auto-executes a `<script>` element that
is *parser-inserted* — created by the browser's own HTML parser as it reads the
document — or one explicitly created and `appendChild`'d by other script in a way that
sets its execution flag. A `<script>` a React tree renders during a client-side
transition is neither: React diffs the new tree against the old one and mutates the DOM
to match, which inserts the node as an ordinary element, not as a parser-driven or
`document.write`-style insertion. The element sits in the DOM, `src` set, and the browser
never fetches or runs it. This is `PLATFORM-NOTES.md §14`'s hydration hazard's mirror
image: §14 is React deleting a foreign script during its OWN document's hydration; this
is a *future* navigation inserting a script that was never going to run in the first
place, on a page that has nothing to do with hydration at all.

**Why a server action's `redirect()` counts.** `redirect()` called from inside a
`'use server'` action is not an HTTP redirect the browser follows. The action's response
carries the destination back over the existing fetch, and the Next.js App Router
performs the navigation *client-side* — the same code path as clicking a `<Link>`. A
route that looks like a plain server-rendered page and simply calls `redirect()` on
success is, from the browser's perspective, indistinguishable from a soft nav. Nothing
in the action's own code signals this; it has to be known about the framework, not read
off the page.

**What to do instead.** Any destination that is not a React route — a separate
JS application's host document, delivered as `<script src>` tags, is the case here —
must be reached by an actual document load:
- A **route handler**'s `NextResponse.redirect(...)` is a real HTTP 3xx the browser
  follows itself (`GET` handlers, not server actions — see `/auth/callback`).
- A server action can return the destination as a **value** instead of redirecting to
  it, and let the client perform `window.location.assign(...)` — a real navigation, not
  `router.push`, which reproduces the exact defect.
- Either way, treat "an authenticated destination is a document load" as the rule, not
  "routes that need one are a list" — a list goes stale the moment a new non-React
  surface is added and nobody remembers to check it against the list.
- Add an arrival-side check regardless: something that notices a page with no boot
  payload and a navigation-timing entry pointing at a *different* URL than the one it's
  on now, and reloads once (bounded, `sessionStorage`-gated so a storage failure can't
  turn it into a loop) rather than sitting there silently. Belt and braces: the senders
  can all be right and a future contributor still adds a `<Link>` to the surface.

## 18. Turbopack fatals on a `node_modules` symlink that escapes the project root

§2 says `node_modules` must never live on R2-backed storage, so `start-neko.sh` symlinks
it out to local ephemeral disk. Next 16's **default** dev bundler then refuses to start:

```
Error [TurbopackInternalError]: Symlink [project]/node_modules is invalid,
it points out of the filesystem root
```

Deterministic, not a race. The fix is `turbopack: { root: '/' }` in `next.config.js` —
`root` is a real, schema-validated option (`next/dist/server/config-schema.js`,
`zTurbopackConfig.root`), and `/` is the only value that works here because the workspace
mount and the local-state directory share no ancestor but the filesystem root.

**Two traps around this:**

- **A partial fix is worse than none.** The launcher also ran `rm -rf node_modules` before
  installing. `rm -rf` on a *symlink* only unlinks it, so the split was destroyed on every
  cold boot and `bun install` quietly materialised a real tree on the R2-backed root —
  the §2 pathology, reintroduced automatically. Repairing only that, and leaving Turbopack
  unconfigured, upgrades an intermittent failure into a **fatal on every boot**. Clear the
  symlink's *target* in place instead; never unlink the symlink.
- **A clobbered split becomes durable.** Once a real `node_modules` directory exists at the
  workspace root, the boot script's own idempotent symlink setup `rm -rf`s it on the next
  restart — so a broken install persists to R2 instead of self-healing.

Second Turbopack landmine in this repo (see §12). Both were invisible until the real thing
ran: the symptom here was an HTTP 500 `Cannot find module 'react/jsx-runtime'` plus ~20
`_next/static` 404s, which reads like a missing dependency and is actually a bundler
refusing to cross a symlink.

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
