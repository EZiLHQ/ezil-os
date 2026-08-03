# Operating EZiL-OS — the runbook

**Status: deployed and live**, not a pre-launch plan. App at
`https://ezil-os.vercel.app` (Vercel), Worker at `api-desktop.ezil.org`
(Cloudflare), container image **v8**. OBSERVED this session: an
unauthenticated request to the app root gets a real `307 -> /login` from a
live Vercel deployment (`curl -sD- https://ezil-os.vercel.app/`); the Worker
host answers too. A prior session's live, in-browser diagnosis (not
re-verified here, see "Known live issue" below) found a real desktop —
workbench up in ~6s, a real file tree, a working command palette, code-server
serving actual files — with **zero 403/502/1006** on any of the three
WebSockets. This document used to describe a six-item pre-launch checklist
("Wave A/B/C") written when nothing had served a user yet; that plan is
below for history, but treat its language ("nothing deployed") as **stale
relative to the fact of deployment** — this repo's own git history runs many
waves past it (`wave-l` and beyond, at the time of writing).

What this document could NOT verify this session (couldNotVerify, not
"false"): current values of `max_instances`, whether the starter-workspace
template (Wave A2 below) ships in image v8, and whether the specific UX
issue in "Known live issue" has since been fixed. None of those are
re-derivable from source alone — they need a live check against the running
system, which is out of scope for a docs-only pass.

---

## 🔴 PENDING: `app/drizzle/0001_telemetry.sql` has NOT been applied

The telemetry ingest path, the aggregation queries, the hourly retention job and
the `/admin/telemetry` page are all merged and green. **The migration behind them
is deliberately un-applied.** The three tables it creates
(`ezil_error_events`, `ezil_error_fingerprints`, `ezil_error_user_hours`) do not
exist in the live Supabase database, and nothing in this repo will create them —
no code path calls `drizzle-kit push`/`migrate`.

**Why it is safe to ship un-applied.** The ingest route always answers `202` and
does its write in `after()`, after the response is flushed. With no table
present, the insert throws inside that deferred callback, the route has already
returned, and one line goes to the server log. DEMONSTRATED, not asserted —
`app/scripts/telemetry-e2e.ts` step 8 drops the three tables and re-POSTs a real
batch: `202`, no throw, answered in single-digit milliseconds. The desktop, the
shell and every other route are untouched, because nothing reads these tables
except the admin page (which will simply error for the one operator who opens it).

**The command an operator runs to apply it**, against whatever
`SUPABASE_DATABASE_URL` points at, from `app/`:

```
psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0001_telemetry.sql
```

`-v ON_ERROR_STOP=1` matters: the file is a plain script, and without it psql
would keep going past a failed statement and leave a half-built schema.
`drizzle-kit migrate` also works if the journal is in sync; the raw `psql` form is
listed because it is the one that does exactly what the file says and nothing else.

**Verified against a throwaway Supabase Postgres 17.6 container** (same engine
family as production, `auth.uid()`/`auth.role()`/`auth.users` present), applied on
top of `0000`: all three tables created with RLS enabled, three service-role-only
policies, both foreign keys, seven indexes, three CHECK constraints. The real
ingest path then wrote and read back through it end-to-end.

**Reversal**, if it needs to come out. There is no down-migration file; this is it,
and it was executed against the throwaway database as part of the same run:

```
DROP TABLE IF EXISTS "ezil_error_user_hours";
DROP TABLE IF EXISTS "ezil_error_events";
DROP TABLE IF EXISTS "ezil_error_fingerprints";
```

Order matters (both FKs point inward). Confirmed to leave `ezil_computers` and
every other `0000` object untouched. Dropping the tables destroys collected
telemetry and nothing else — no product data lives in them.

⚠️ Applying this is a schema change to a live database holding real users' rows.
It is a human decision, not an automated step, and it is why the file ships
un-applied.

---

## Known live issue: VS Code Workspace Trust eats the first terminal open

Carried forward from a prior session's live diagnosis of code-server in
production (container image v8, confirmed running, not stale):

With a `folder=` parameter on the bridge URL, the workspace opens
**untrusted** (Restricted Mode). The first <kbd>Ctrl+`</kbd> shows an empty
terminal panel behind VS Code's own "Do you trust the authors of the files in
this folder?" modal — a real code-server behaviour, not a bug this repo
introduced. Clicking **Trust Folder & Continue** clears Restricted Mode but
**cancels** the terminal-open action that triggered the prompt; a user has to
press <kbd>Ctrl+`</kbd> a **second** time to actually get a shell. This is a
real, live rough edge as of that diagnosis — not confirmed fixed or
unconfirmed-broken as of this docs pass. The fix, if taken, is almost
certainly either pre-trusting the workspace folder in the code-server launch
config (`--disable-workspace-trust` or an equivalent trust-on-open setting)
so the first `Ctrl+\`` just works, or surfacing the modal itself as an
explicit boot phase so the two-Ctrl+`` interaction reads as intentional
rather than broken.

---

## Telemetry now exists — use it before guessing

As of this pass, `app/src/server/telemetry/` ingests crash/error events from
the shell, and `/admin/telemetry` (gated, see `docs/telemetry.md`) shows the
top fingerprints by distinct users, boot-phase failure rates, and an
hourly error-rate table. Before spending time reproducing a user-reported
bug by hand, check whether its fingerprint is already there — that is
literally what "how many distinct users hit this in the last N hours"
exists to answer. See `docs/telemetry.md` for what is (and is not) recorded.

⚠️ None of it holds any data until `0001_telemetry.sql` is applied — see PENDING above.

---

## Before the next deploy — two prerequisites that are not code

**1. Create the telemetry R2 bucket.** `worker/wrangler.toml` now binds
`TELEMETRY_R2_BUCKET` to `ezil-telemetry-spool`, and the bucket does not exist. A
Worker deploy with an unresolvable R2 binding fails, so this must be run first:

```
cd worker && npx wrangler r2 bucket create ezil-telemetry-spool
```

Deliberately a SEPARATE bucket from `SANDBOX_WORKSPACE_R2_BUCKET`, which is
FUSE-mounted into user containers — sharing it would put the fleet's error log
inside a user's file manager.

Nothing drains this spool yet. The objects are written (`v1/dt=/hh=/…` NDJSON) and
never read; a drainer is unwritten work, and `worker/src/telemetry.ts`'s header
states what it must do.

**2. Nothing else.** The desktop-restart control needs no provisioning: the Worker
route is on by default (`SANDBOX_RESTART` unset = enabled, same convention as
`SANDBOX_FOCUS`), and it reuses the existing HMAC secret. Set `SANDBOX_RESTART=off`
to kill it without a code change.

---

## Desktop restart (Settings → Troubleshoot)

For "the desktop is frozen and there is no way to restart it". The chain is three
independently-deployed links, and each one feature-detects the next:

```
Settings → Troubleshoot  →  POST /api/shell/restart  →  POST /sandbox/:name/restart
   (shell/…/troubleshoot.js)     (app Route Handler)          (Worker + DO)
```

The button is drawn **disabled** unless `desktopState.endpoints.restart` is present in
the boot payload, so a shell newer than its server degrades to an honest "Not available
in this deployment yet" rather than POSTing to a URL it invented. That key
(`SHELL_API_ROUTES.restart`) and the Route Handler must be added and removed together.

What it actually does: SIGTERMs the desktop launcher **inside the already-running
container**, reusing `start-neko.sh`'s own `terminate_stack` trap, then boots the stack
again in place. The container is not recreated; the computer row and the R2 workspace are
untouched. Budget ~45s worst case — up to 20s waiting for the old stack to confirm it is
gone (`RESTART_STOP_DEADLINE_MS`), then the usual ~22s boot. Hence `maxDuration = 300` on
the Route Handler and a 120s client timeout in the provider; a 15s budget copied from
`/focus` would abort restarts that were going to succeed.

Failure outcomes a user can actually see, and what they mean:

| outcome | meaning |
|---|---|
| `stop_timed_out` | The old stack would not die, so **nothing was relaunched** — the Worker refuses to boot a second stack on top of a maybe-alive one. Recreate the computer. |
| `boot_failed` | It stopped, but did not come back. Retry. |
| `unsupported_mode` | Guacamole-mode container: `start-desktop.sh` has no SIGTERM trap to reuse, so restart is refused outright rather than attempted. |
| `restart_in_progress` | A concurrent call; the second is a no-op, not a race. |

Not exercised against a live container by any automated test — the DO's own body does not
run under `bun test`. The decision logic, the route, the auth envelope and the exact URL
are unit-tested on both sides.

---

## Known constraints — design around these, they are not bugs

- **TURN relay is the latency floor.** Cloudflare Containers expose no UDP, so both
  WebRTC peers relay. Not tunable without leaving the platform. The HTTP iframe preview
  is lower-latency than the desktop for anything renderable as a web page.
- **No GPU.** All rendering and encoding is software, competing with the compiler.
- **Containers can vanish without notice.** Persistence must stay eager; the 10s flush is
  the design response.
- **`/os`'s first paint has a ~400-650ms floor, not the <200ms this project informally
  aimed at.** A protected page has to know the visitor really is who their cookie claims
  before it can decide to render anything (redirecting to `/login` otherwise), and that
  decision has to be made before the first byte goes out — there is no way to paint first
  and redirect later without either trusting an unverified session or moving the
  auth-vs-redirect decision to the client. So one Supabase Auth round trip
  (`supabase.auth.getUser()`, 150-300ms depending on host/network, up to ~700ms observed
  on a loaded shared dev host) plus one database lookup for the user's computer
  (~120-240ms) are both on the critical path before anything paints. MEASURED,
  production build, localhost, zero client network latency, median of 8 warm loads:
  **TTFB 410ms, taskbar on screen 618ms** (see `docs/PLATFORM-NOTES.md` §15 and §17).
  Streaming the wallpaper ahead of that lookup was considered and rejected: `/os` is not
  a React page, it is two `<script src>` tags that must run deterministically, and
  resolving them behind a React Suspense boundary reintroduces the exact hazard §14
  documents — content a streaming response inserts after the initial parse is not
  guaranteed to execute the same way a parser-inserted `<script>` does. Getting under
  200ms for real needs one of: local JWT verification (`supabase.auth.getClaims()` —
  this project already issues ES256 tokens, so this is possible; the cost is not seeing a
  revocation until the token expires) or deploying the app in the database's region.
  Neither is a change made here. Until one of those lands, **the honest target for `/os`
  is 400-650ms, not <200ms** — treat a number in that range as success, not as a miss.
- **`max_instances`** was committed at 20 against an owner answer of 3 at the time this
  line was last written; **not re-checked this session** — confirm the live value before
  relying on either number.

## Open, owner-side

🔴 Key rotation — `<path-redacted>/KEY-ROTATION-REQUIRED.md`, end of day.
`CLOUDFLARE_GUACAMOLE_HMAC_SECRET` and the Worker's `SANDBOX_HMAC_SECRET` rotate
**together**; Worker secrets are versioned, so a rollback silently reverts a rotated one.
**Not re-verified this session — confirm this file's status before assuming it is stale.**

---

## History: the pre-launch plan ("Wave A/B/C")

Kept for context — this is what the team wrote before the first deploy, when
none of the six requirements below were met. Several have since been proven
live (see the top of this document); none of the specific line items below
were individually re-verified this session, so their per-item status marks
are historical, not re-measured.

### What "native-feeling" actually requires

Six things, in the order a user meets them, **as assessed when this section
was written** (superseded by the live status at the top of this file):

| # | Requirement | Status (historical) |
|---|---|---|
| 1 | It exists — deployed, reachable | now **true** — see the top of this file |
| 2 | Boot is legible, not a blank spinner for ~22s | phases logged; whether they were surfaced to users by the time of deploy is not re-verified here |
| 3 | It opens to a **populated** workspace | not re-verified this session |
| 4 | Keyboard/mouse actually reach apps | ✅ proven by XTEST injection |
| 5 | It feels responsive | ⚠️ encoder tuned; TURN relay is a hard floor |
| 6 | Work survives closing the tab | ✅ hydrate + 10s flush, put-only |

### Wave A — make it exist

**A1. Database + environment.** Apply `app/drizzle/0000_*.sql` to Supabase (long since
done — see `0001_telemetry.sql` below, which is **not** applied). Write `.env.local` for
`app/`. The one constraint that breaks everything silently:
`CLOUDFLARE_GUACAMOLE_HMAC_SECRET` must **byte-match** the Worker's
`SANDBOX_HMAC_SECRET`.

**A2. Put the template in the image.** `/opt/ezil-sandbox-template` — whether this ships
in image v8 was not re-verified this session.

**A3. Deploy.** Done — see the top of this file.

### Wave B — make it feel native

**B1. Boot phase checklist.** The Worker/container emit named boot phases with elapsed
ms (`start-neko.sh`). Surfacing them to the user: *Waking machine → Mounting your files →
Starting desktop → Connecting display*. Research finding behind this: past ~5 seconds a
bare spinner reads as frozen; the boot budget is ~22s and there is data to spend it
honestly.

**B2. Desktop chrome.** A thin strip **outside** the stream — back to computers, name,
status, fullscreen. Everything else is desktop. The reference is Codespaces: minimal
chrome, the real tool owns the viewport.

### Wave C — prove it

Live end-to-end, in this order, each gating the next (historical checklist; not
re-run this session):
1. Sign in → `/computers` → create → boots
2. **Type in VS Code. Click in Chrome.** Input is the difference between a computer and a video.
3. Write a file → close tab → reopen → **file is there**
4. Second computer is isolated from the first
5. Third create is refused
6. Measure real click-to-paint against the ≤80ms p50 budget
