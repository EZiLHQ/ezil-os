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

## ✅ APPLIED: `app/drizzle/0001_telemetry.sql` is live, and holds real rows

> **CORRECTED 2026-08-19 by integration.** This section said "🔴 PENDING … the
> three tables do not exist in the live Supabase database". **That was false, and
> had been for roughly two weeks.** It was written from the repo (no code path
> calls `drizzle-kit push`/`migrate`, which is still true) rather than from the
> database. Nobody had looked. `docs/telemetry.md`'s matching "nothing is
> stored" claim was corrected in the same pass. Evidence below is from
> `docs/SUPABASE-STATE.md`, which queried the live project.

**State, measured 2026-08-19 against project `<project-ref>`:**

| Fact | Value |
| --- | --- |
| Migration applied | **Yes**, on or before **2026-08-04** |
| Tables present | `ezil_error_events`, `ezil_error_fingerprints`, `ezil_error_user_hours` |
| Structural match to the file | exact — RLS on, 3 service-role-only policies, 7 indexes, 3 CHECKs, 2 FKs |
| `ezil_error_events` | 199 inserts / 109 deletes / **84 live rows**, autovacuumed the same day |
| Retention cron | running — oldest surviving row is exactly 14 days back |

So **telemetry you add is readable.** The operator command below is retained for
a rebuild or a fresh environment; it is not an outstanding action.

```
psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0001_telemetry.sql
```

`-v ON_ERROR_STOP=1` matters: the file is a plain script, and without it psql
would keep going past a failed statement and leave a half-built schema.

**Reversal**, if it needs to come out — there is no down-migration file, this is
it. ⚠️ It now destroys 84 rows of real collected telemetry:

```
DROP TABLE IF EXISTS "ezil_error_user_hours";
DROP TABLE IF EXISTS "ezil_error_events";
DROP TABLE IF EXISTS "ezil_error_fingerprints";
```

Order matters (both FKs point inward). Leaves `ezil_computers` and every other
`0000` object untouched.

### 🔴 …but only the SHELL producer has ever worked

All 193 recorded occurrences carry `source='shell'`. **Zero** rows have ever
arrived with `source='worker'` or `source='container'`. Before anything is built
on a `container:neko#*` site — `decor_still_present`, `app_exit`, or any other —
treat that producer as **unproven in production**, not merely unused.

Related: **`computer_id` is NULL on all 84 shell rows**, contradicting
`docs/telemetry.md`. Error events cannot currently be joined to a computer.

### 🔴 OPEN OUTAGE: the R2 telemetry spool has never once been drained

> **UPDATED 2026-08-19 — root cause found, fix committed, NOT yet deployed.**
> The cause was not the secret and not the R2 binding. **The cron was never
> invoked.** `app/vercel.json` declared **three** crons and the plan permits
> **two**; Cloudflare's invocation analytics show `sandbox-reap` (`8 4 * * *`)
> hitting the Worker once a day unbroken and `telemetry-maintenance`
> (`17 3 * * *`) demonstrably running — the raw table's retention boundary
> tracks the clock exactly — while `telemetry-drain` (`43 3 * * *`) produced
> **zero hour-03 Worker requests after 2026-08-09**. Every other hop was
> verified working: the container writes the NDJSON, the Worker spools it,
> `POST /telemetry/drain` is deployed and answers correctly (401 unsigned,
> not 404), and the parse chain from real container bytes through the app's
> `parseTelemetryBatch` drops nothing.
>
> **The fix removes the dependency on a third cron rather than rescheduling
> it.** The drain now runs at the tail of `/api/cron/telemetry-maintenance`
> — the cron that is proven to fire — and `vercel.json` is back to two
> entries. The two jobs are isolated: each is awaited in its own `try`, and
> the response reports both, so "the drain is down" can never again look
> like "the cron did nothing". `/api/cron/telemetry-drain` still exists for
> manual runs. See `app/src/server/telemetry/maintenance-handler.ts`.
>
> **What is still unverified (COULD-NOT-DETERMINE):** which plan this Vercel
> project is on, and therefore whether "three crons" is precisely the reason
> the third stopped — the billing API returns nothing at the token scope
> available and the crons endpoint 404s. The inference is from the
> invocation evidence, not from the plan. And nothing here is proven until
> the first post-deploy run: **the check is `select count(*) from
> public.ezil_error_events where source in ('worker','container')` going
> above zero for the first time in the product's history.**

Measured 2026-08-19. The R2 bucket `ezil-telemetry-spool` held **173 objects /
467 kB, accumulating since 2026-08-03** — the day it was created — and not one
of those objects has ever reached Postgres. This is the mechanical reason for the
"zero worker/container rows" finding above: **producing and spooling both work;
the drain does not.**

It hid for ~16 days because a broken drain and a quiet day were indistinguishable
in both the result object and the HTTP response — `runTelemetrySpoolDrain` broke
out of its loop identically for "the spool is empty" and "I could not reach the
Worker at all", and both returned `{ pagesDrained: 0 }` with `200 {ok:true}`.

`SpoolDrainResult.drainFailures` (`app/src/server/telemetry/spool-drain.ts`)
separates the two. **A non-zero `drainFailures` is always a fault, never a normal
state.**

**Two things about that first restored run.** It has 173 objects of backlog to
clear, and both bounds that keep it from stalling are load-bearing:

- the page limit (`DRAIN_PAGE_LIMIT = 25`) — without it the Worker's own default
  is 200 sequential `bucket.get()`s inside one request against a 20 s abort, and
  an aborted page never acks, so the backlog stays exactly where it was;
- the wall-clock budget (`DEFAULT_DRAIN_BUDGET_MS = 150 s`) — it stops the drain
  from starting new pages once it has spent its share of the invocation it now
  shares with the retention job. `hitBudget: true` in the response is **not** a
  fault: it means a large backlog is being spread across runs, as designed.

Expect the backlog to clear in one run (173 objects ≈ 7 pages) and the row count
to jump once, then settle.

---

## 📖 The log topology — every stream, where it lands, how long it lives, how to read it

This is the answer to "I want to go back in time and see exactly what the
problem was". There are **five** streams. They have different homes, different
lifetimes and different read commands, and three of them are invisible from the
other two — so the first question in any investigation is *which stream would
have seen it*.

| stream | source of truth | retention | read it with |
| --- | --- | --- | --- |
| Shell/browser telemetry | Postgres `ezil_error_events` (`source='shell'`) | **14 days** raw, **90 days** rolled up | SQL, or `/admin/telemetry` |
| Container + Worker telemetry | R2 `ezil-telemetry-spool` → the same Postgres tables (`source='container'` / `'worker'`) | hours-to-1-day in R2, then **14 days** raw | SQL, same tables — filter `source` |
| Container boot log (`/tmp/neko.log`) | inside the live container only | **dies with the container** | `scripts/pull-neko-log.mjs` |
| CPU saturation samples (`/tmp/neko-cpu-diag.jsonl`) | inside the live container only, and only when opted in | **dies with the container** | `scripts/pull-neko-log.mjs --route cpu-diag` |
| Worker invocation logs | Cloudflare Workers Logs | live tail, plus retained (see below) | `wrangler tail`, or the dashboard's Observability → Logs |

### 1. Shell / browser telemetry — the only stream that has ever worked

The shell (`app/public/os/bundle.min.js`, built from `shell/ezil/telemetry.js`)
POSTs batches to `POST /api/shell/telemetry`, which validates with
`parseTelemetryBatch` (`.strict()` — an event that fails is dropped whole, never
half-written) and writes through the single writer `ingestBatch`.

**Lands in:** `public.ezil_error_events` (raw), `public.ezil_error_fingerprints`
(one row per distinct site+code, all-time counters),
`public.ezil_error_user_hours` (per-user-per-hour rollup).

**Kept for:** raw events **14 days** (`RETENTION_DAYS_EVENTS`), the hourly rollup
**90 days** (`RETENTION_DAYS_USER_HOURS`), fingerprints indefinitely unless stale
and low-volume. Pruning is the retention half of the `17 3 * * *` cron.
🔴 **The rollup outlives the raw rows on purpose** — after 14 days you can still
answer "how often, how many users, when did it start", but not "what exactly
happened in that one session".

**Read it with** SQL against the project (`<project-ref>`, "EZiL App"):

```sql
-- the last two days, newest first
select occurred_at, source, event_class, site, code, outcome,
       duration_ms, user_hash, computer_id, detail, attrs->>'phases' as phases
from public.ezil_error_events
where occurred_at > now() - interval '2 days'
order by occurred_at desc;
```

or the gated admin page `/admin/telemetry` — which needs an email in
`TELEMETRY_ADMIN_EMAILS`, and that env var is **unset**, so the page is currently
unreachable by everyone. Fail-closed by design; set it if you want the UI.

### 2. Container + Worker telemetry — NDJSON → R2 → Postgres

Three hops, and each one is a place it can stop:

1. **The container writes it.** `emit_telemetry()` in `worker/scripts/start-neko.sh`
   appends one JSON line per boot phase to `/var/log/ezil-telemetry.ndjson`
   — a closed set of phase names, an `ok`/`error`/`skipped` status and an
   integer duration. Never a message, a path or an env value.
2. **The Worker spools it.** After *every* `ensureDesktop` (success and failure
   alike) `drainContainerBootTelemetry` reads a bounded tail of that file, and
   `spoolTelemetry` PUTs it — together with the Worker's own telemetry-worthy
   `LifecycleTimeline` events — as one NDJSON object into the R2 bucket
   `ezil-telemetry-spool`, keyed `v1/dt=YYYY-MM-DD/hh=HH/<correlationId>.ndjson`.
   The PUT is `waitUntil`-ed and never blocks the response.
3. **The cron drains it.** `/api/cron/telemetry-maintenance` (03:17 UTC daily)
   pages the objects out through the Worker's `POST /telemetry/drain`, ingests
   them through the same validator the shell's events go through, and only then
   `POST /telemetry/ack`s (deletes) them. Ingest strictly precedes ack, so the
   drain can duplicate work but cannot lose it.

**Lands in:** the same three Postgres tables, with `source='container'` or
`source='worker'` and `user_hash = 'u_00000000'` — a sentinel, because these
events have no user. 🔴 **Exclude that sentinel from every distinct-user count**,
or one busy container will read as a user.

**Kept for:** hours in R2 (until the next drain), then the same **14 days** as
everything else.

**Read it with** the same SQL, filtered:

```sql
select occurred_at, source, site, code, outcome, duration_ms, correlation_id
from public.ezil_error_events
where source in ('worker','container')
order by occurred_at desc limit 200;
```

`correlation_id` is the join: one browser request, the Worker events it caused
and the container phases underneath it all carry the same value.

To see what is still sitting in R2 undrained (i.e. how deep the backlog is):

```sh
cd worker && npx wrangler r2 bucket info ezil-telemetry-spool
```

That reports the bucket's object count and total size — it is the command that
measured **173 objects / 467 kB** on 2026-08-19. `wrangler` has no
object-listing subcommand, so per-key inspection means the dashboard or the S3
API.

To force a drain between daily runs, without waiting for the cron:

```sh
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  https://ezil-os.vercel.app/api/cron/telemetry-drain | jq
```

A healthy response is `{"ok":true,"result":{... "drainFailures":0 ...}}`.
**`drainFailures > 0` is always a fault**; `hitBudget: true` is not — it means a
backlog is being spread over several runs on purpose.

### 3. The container's own boot log — `/tmp/neko.log`

Everything human-readable a boot produced: `start-neko.sh`'s own `[ezil-boot]`
lines **plus** the raw stdout+stderr of Xvfb, openbox, `neko serve`, code-server
and Chromium, all redirected into one file.

**Kept for:** as long as the container lives, and **not one second longer**.
There is no copy anywhere else. If a boot failed an hour ago and the container
has since been recycled, this stream is gone — which is exactly why streams 1
and 2 exist. Pull it *while the sandbox is still up*.

**Read it with** (see the next section for the full flag set):

```sh
cd worker
SANDBOX_HMAC_SECRET='<the Worker's HMAC secret>' \
  node scripts/pull-neko-log.mjs guac-<userid16>-<computerid16> --lines 400
```

### 4. CPU saturation samples — `/tmp/neko-cpu-diag.jsonl`

Same shape, same lifetime, same auth as stream 3, but **opt-in**: nothing is
written unless `EZIL_NEKO_CPU_DIAG_ENABLED` is on for that boot. Fixed-shape
JSONL, one sample per interval.

```sh
cd worker
SANDBOX_HMAC_SECRET='<secret>' node scripts/pull-neko-log.mjs <sandbox> --route cpu-diag
```

### 5. Worker invocation logs

Every `console.log`/`console.error` in the Worker, plus the structured
`LifecycleTimeline` JSON lines (`{"ts":…,"correlationId":…,"event":…}`) that are
the *only* record of what the Worker thought was happening — the ~3-minute
upstream hang in `docs/PRODUCTION-ERROR-ANALYSIS.md` §3#6 is invisible in
Postgres precisely because only this stream could have explained it.

**Live tail**, which is the same command it has always been:

```sh
cd worker && npx wrangler tail ezil-os-worker --format pretty
# machine-readable, and grep-able by correlation id or sandbox id:
npx wrangler tail ezil-os-worker --format json | grep '<correlationId>'
```

**Retained**, once `[observability]` with `head_sampling_rate = 1.0` is enabled
in `worker/wrangler.toml` and deployed: invocation logs stop being live-tail-only
and become queryable after the fact in the Cloudflare dashboard under
**Workers & Pages → `ezil-os-worker` → Observability → Logs**, where they can be
filtered by field (`correlationId`, `sandboxId`, `event`, `outcome`) and by time
range. `head_sampling_rate = 1.0` means no sampling: every invocation is kept.

> **COULD-NOT-DETERMINE, two things.** (a) **The retention window.** Cloudflare
> keeps Workers Logs for a few days and the window depends on the account plan;
> the exact number for *this* account was not verified from here. Treat it as
> "days, not weeks", and copy anything you need to keep. (b) **A CLI query
> command.** `wrangler` 4.108 has no subcommand that queries retained logs —
> `wrangler tail` is live-only. The dashboard is the supported reader; there is
> also an account-scoped Workers Observability query API, which was **not**
> exercised from here.

### What none of these streams see

Carried from `docs/PRODUCTION-ERROR-ANALYSIS.md` §4, because it is the part
people forget: a page that never loads emits nothing (the emitter is in the
shell bundle); a session that connects and dies at minute three writes nothing
(the boot trace has already ended, and there is no heartbeat); a user who gave
up and never retried leaves no row at all. **A quiet table is not a healthy
system.**

---

## 🔴 The black desktop — the mechanism, and how to see it

**A black picture means no Chrome window is mapped. There is no other
possibility.** Grep the whole 2,204-line `worker/scripts/start-neko.sh` for
`xsetroot|hsetroot|feh|nitrogen|wallpaper`: there is no root-window painter of
any kind. Xvfb is started bare (`start-neko.sh:970`), openbox paints no desktop,
and code-server is not an X client. Chrome's mapped window is the **only** source
of pixels on `:99`. Remove it and the stream carries the bare X root, which is
solid black.

**Reproduced locally, 2026-08-19.** `ezil-integrated:local`, plain boot, healthy:
`shot.jpg` reads `mean 34.664 / max 255 / nonzeroFrac 1.0000` (three consecutive
boots, identical to the digit). `pkill -9` the Chrome that owns
`--user-data-dir=/tmp/chromium-app-data` and the *same* endpoint one second later
reads **`mean 0.000 / max 0 / nonzeroFrac 0.0000`** — the exact production
signature — while `phase=ready event=end status=ok` still stands in `/tmp/neko.log`
and `GET /api/room/screen` still answers `1920x1080@60`.

### Why nothing catches it

| check | what it actually proves |
| --- | --- |
| window-ready gate | `wmctrl -x -l` prints **some** line whose class field matches `chrome` (`start-neko.sh:1899-1908`). Not the pid, not the boot generation, not map state, **not one pixel**. |
| code-server leg | a bare TCP *connect* to `127.0.0.1:8443` (`wait_tcp`, 559-569). Any listener passes. |
| `/tmp/neko-app-health.json` | measured stale: it read `{"chromium":{"state":"running","pid":210,"restarts":0}}` while pid 210 had been dead for a minute and the screen was black. |
| `?confirm=frame` / `?confirm=display` | the iframe answered, and neko thinks somebody is watching. Both are true of a black stream. |

### The unbounded gap W4 opened

`_app_exit_is_clean` (`start-neko.sh:1150-1161`) exempts `rc == 0 && uptime >= 5s`
from the restart budget. `attempt` is incremented **only** on the crash branch
(1245), and the fatal sentinel — the only thing that makes the desktop fail
closed — is reachable **only** from that branch (1253). So an app that exits 0
after ≥5s restarts **forever** and can never fail the desktop closed. The only
floor is the linear backoff, `2s * clean_streak` capped at 30s (1230-1235).

Driven live in a container:

```
app=chromium exited rc=0 after 50051ms — CLEAN exit: restarting in 2s,  NOT charged (still 1/5 used, clean_streak=1)
app=chromium exited rc=0 after  5051ms — CLEAN exit: restarting in 4s,  NOT charged (still 1/5 used, clean_streak=2)
app=chromium exited rc=0 after  5047ms — CLEAN exit: restarting in 6s,  NOT charged (still 2/5 used, clean_streak=3)
app=chromium exited rc=0 after  5060ms — CLEAN exit: restarting in 8s,  NOT charged (still 3/5 used, clean_streak=4)
app=chromium exited rc=0 after 19348ms — CLEAN exit: restarting in 10s, NOT charged (still 3/5 used, clean_streak=5)
```

and the framebuffer during that 10 s window, sampled every 2 s:

```
t+02s mean=0.000 max=0 nonzero=0.0000
t+04s mean=0.000 max=0 nonzero=0.0000
t+06s mean=0.000 max=0 nonzero=0.0000
t+08s mean=0.000 max=0 nonzero=0.0000
t+10s mean=42.952 max=255 nonzero=1.0000   <- Chrome remapped
```

At the 30 s cap that is a **30-second black desktop, on repeat, forever**, under
`ready ok`, with `restarts: 0` in the health file. W4's own commit message claims
"the budget is unchanged and is not infinite"; that is true of the *crash* budget
only. The in-file comment at 1136-1145 is the honest one.

### Reading the picture yourself, server-side

`GET /api/room/screen/shot.jpg` renders the X framebuffer and **bypasses the
encoder entirely**, so it settles "is X black, or is only the capture black?" in
one request. `/shot` alone 404s; it needs a neko **admin** bearer:

```sh
ADMIN=$(docker exec <container> printenv NEKO_PASSWORD_ADMIN)
TOK=$(curl -s -X POST http://127.0.0.1:<port>/api/login \
        -H 'content-type: application/json' \
        -d "{\"username\":\"probe\",\"password\":\"$ADMIN\"}" | jq -r .token)
curl -s -o shot.jpg http://127.0.0.1:<port>/api/room/screen/shot.jpg -H "Authorization: Bearer $TOK"
```

In production the admin password is HMAC-derived (`deriveNekoAdminValue`) and only
the app server holds the secret — the password in the desktop URL is the **user**
role and gets `403 session is not admin`.

### The detector that now exists

`worker/assets/neko-branding/www/ezil-mobile.js` (image tag **`brand3`** and up)
samples the decoded `<video>` from inside the stream's own origin — the only
place in the product that can — and posts a verdict to the shell, which turns it
into a real telemetry row:

| field | value |
| --- | --- |
| `eventClass` | `display_failure` |
| `site` | `ezil-os:apps/desktop#picture` |
| `code` | `picture_black` (pixels read, and they were black) or `picture_starved` (pixels unreadable; normalised bitrate below 0.072 kbps/kpx) |
| `outcome` | `error` |

It is **one-shot and anchored at the start of the stream**: 3 grace ticks, then 8
consecutive black samples, then it reports once and stops. The first non-black
sample disarms it permanently, so a healthy desktop pays for exactly one 64x36
canvas readback and a legitimately dark screen later in the session is never
judged. The cost of that choice: a desktop that goes black **mid-session** is not
caught here — it is caught on the next open.

---

## `POST /sandbox/:name/logs` — the container boot-log tail

Added 2026-08-19. Returns a bounded tail of the container's own `/tmp/neko.log`
so "more logs" in Settings → Troubleshoot means something.

| Property | Value |
| --- | --- |
| Route | `POST /sandbox/:name/logs` |
| Auth | the same HMAC envelope as `POST /sandbox/:name/focus` |
| Path read | hardcoded `/tmp/neko.log` — **never caller-supplied** |
| Bounds | byte cap, line cap, per-line cap |
| Redaction | every returned line runs through `sanitizeErrorMessage` |
| Kill switch | `EZIL_NEKO_LOGS` — `on` (default) \| `off`; `off` answers `404 {ok:false,error:"neko_logs_disabled"}` |

Modelled line-for-line on the existing `handleCpuDiag`, and it follows the same
`SANDBOX_CPU_DIAG` / `SANDBOX_WORKSPACE_DIAG` operator-switch pattern.

⚠️ **`/tmp/neko.log` is a shared sink, not a curated stream.** `start-neko.sh`'s
own `log()` / `phase_*` emit only phase names, outcomes and integers — but six
other producers redirect raw stdout+stderr into the same file (Xvfb, openbox,
both supervised apps, `neko serve`, and the workspace bootstrap's stderr). Chrome
prints URLs it navigates to; neko prints session and room state. The redaction
and the caps on this route are what the guarantee rests on, not the script's
editorial discipline. That header comment used to over-promise and was corrected
in the same pass.

### How to actually pull one — `worker/scripts/pull-neko-log.mjs`

🔴 **This route was deployed on 2026-08-19 and then called by nothing for the
rest of the day**, because a caller needs an HMAC token and there was no way to
mint one outside the app's own server code. There is now:

```sh
cd worker
SANDBOX_HMAC_SECRET='<the Worker's CLOUDFLARE_GUACAMOLE_HMAC_SECRET>' \
  node scripts/pull-neko-log.mjs guac-<userid16>-<computerid16> --lines 400
```

- **The sandbox name** is `guac-<first 16 alphanumerics of the user's id>-<first
  16 of the computer's id>` (`deriveGuacamoleSandboxId`,
  `app/src/server/lib/cloudflare-guacamole-provider.ts`). It is also the
  `sandboxId` field in every Worker log line for that computer, so the easiest
  way to get one is to copy it out of `wrangler tail`.
- **The secret** goes in the environment, never in a flag — a flag lands in
  shell history and in `ps`. `CLOUDFLARE_GUACAMOLE_HMAC_SECRET` is accepted as
  an alias, since that is what the same value is called on the Vercel side.
- **`EZIL_WORKER_URL`** defaults to `https://api-desktop.ezil.org`; set it to
  `http://localhost:8787` to run against `wrangler dev`.
- **Flags:** `--lines N` (default 400, ceiling 2000), `--route cpu-diag` to pull
  `/tmp/neko-cpu-diag.jsonl` through the twin route instead, `--json` for the
  whole response envelope rather than just the text.
- **Output split:** the log text goes to **stdout** (so `| grep`, `| less` and
  `> file` all work) and the one-line summary to **stderr**.
- **Exit codes:** `0` got a log · `1` the route said no, or this container has
  never written one · `2` bad usage or no secret configured.

The token is a 5-minute HMAC over the same canonical payload every other signed
Worker route uses. `scripts/pull-neko-log.test.ts` verifies the script's tokens
with the **Worker's own** `verifyPreviewToken`, so the two copies of that string
cannot drift into a 401 unnoticed.

**Typical answers and what they mean:**

| what you see | meaning |
| --- | --- |
| `… absent — neko_log_absent: …` (exit 1) | that sandbox has never run `start-neko.sh` — a fresh container, or a guacamole-mode one |
| `404 neko_logs_disabled` (exit 1) | the `EZIL_NEKO_LOGS` kill switch is off |
| `401 hmac_signature_mismatch` (exit 1) | wrong secret |
| `401 hmac_token_expired` (exit 1) | the machine's clock is more than 5 minutes out |
| `(TRUNCATED)` in the summary | the file is bigger than the caps; raise `--lines`, but 256 KiB is the hard byte ceiling |

---

## 🔴 Known limitation: a Troubleshoot restart drops the desktop back to 1920x1080

`EzilSandboxDO.restartDesktopStack` rebuilds its boot env (`iceEnv`) from
`this.env` + `sandboxId` alone and sets **no `NEKO_SCREEN`**, so the relaunched
container falls back to `start-neko.sh:138`'s `${NEKO_SCREEN:-1920x1080x24}`. A
portrait desktop comes back landscape after a restart.

**The shell does not silently repair it** — checked, not assumed.
`desktop-window.js`'s `screen_ctl.request()` fires only from the ResizeObserver
settle path, and a restart does not change the browser window's size, so no tick
occurs; even if one did, the controller's `settled()` dedupe still holds the
pre-restart `last_applied`/`last_sent` and would drop it as already-answered.

**Workaround for a user:** close and reopen the desktop window. That re-runs the
Tier-1 boot-time ask (`POST /api/shell/desktop` with `screen`), which does set
`NEKO_SCREEN`.

**Why it is written down rather than fixed.** The restart is initiated inside the
DO with no caller-supplied body, so the requested size could only come from DO
storage. That means `handlePreview` (Worker-side, outside the DO) gains an RPC
that writes it, and `handleScreen` updates it on every live resize or the restart
restores a stale shape. That is a new persisted field on the sandbox lifecycle
and it is not exercisable outside a real deployed Worker.

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

⚠️ It holds **84 live rows**, all `source='shell'` — see "APPLIED" above. No
worker- or container-sourced row has ever landed, because the R2 spool drain has
never run; see "OPEN OUTAGE" above before reading an empty container slice as
"nothing failed". The cause is now known (the drain's cron was never invoked) and
the fix is committed but **not deployed** — so until the first post-deploy
03:17 UTC run, an empty `source in ('worker','container')` slice still means
"nothing has ever arrived", not "nothing failed". "📖 The log topology" above
lists all five streams and which one would have seen what you are looking for.

---

## Before the next deploy — two prerequisites that are not code

**1. ~~Create the telemetry R2 bucket.~~ DONE — and now the problem is the other
end.** `worker/wrangler.toml` binds `TELEMETRY_R2_BUCKET` to
`ezil-telemetry-spool`. The bucket **exists and has existed since 2026-08-03**:

```
cd worker && npx wrangler r2 bucket create ezil-telemetry-spool   # already run
```

Deliberately a SEPARATE bucket from `SANDBOX_WORKSPACE_R2_BUCKET`, which is
FUSE-mounted into user containers — sharing it would put the fleet's error log
inside a user's file manager.

A drainer **has since been written** (`app/src/server/telemetry/spool-drain.ts`)
and it has **never yet run in production**: 173 objects / 467 kB have accumulated
and none has ever been ingested. Root cause is the cron, not the drainer — see
"OPEN OUTAGE" above, where the fix (fold the drain into the one cron that is
proven to fire) and the single query that confirms it are written out. Writing
the spool is proven; reading it is proven everywhere except against production.

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

### Database migrations — read this before running `drizzle-kit migrate`

🔴 **`drizzle-kit migrate` does not work against this database, and failing to
know that wastes a deploy.** There is no `drizzle.__drizzle_migrations` journal:
the original schema was created by some route other than `migrate` (`db:push`,
or by hand). So `migrate` believes nothing has been applied, replays
`0000_massive_mole_man.sql` from the top, and dies on:

```
PostgresError: relation "ezil_computers" already exists
```

That failure is **safe** — it happens inside a transaction and rolls back
without touching anything — but it blocks every later migration behind it.

Until someone baselines that journal, apply migrations individually. The
telemetry migration ships with a script that does it safely:

```
cd app && npm run db:apply-0001     # needs SUPABASE_DATABASE_URL
```

It is idempotent (exits 0 if `ezil_error_events` already exists), refuses to run
on a file containing `DROP`/`TRUNCATE`/`DELETE` or an `ALTER` of a table it did
not itself create, applies everything in one transaction, and verifies the table
count moved by **exactly** three with RLS on and policies present before
committing. `public` already holds ~40 tables from an older project sharing this
database — which is why "additive only" is checked rather than assumed.

**No database credentials are needed locally to run it.** `vercel env pull`
returns 11-character placeholders for this project's encrypted variables, so the
practical route is to run the script inside a Vercel build, where the real
environment exists, by temporarily prefixing the `build` script with it. Revert
that prefix afterwards: a build step that mutates the schema on every deploy is
a different policy decision, and not one to make by accident.

### Secret rotation

The deployment holds exactly these secrets. Anything not listed here is public by design.

| Secret | Where | Notes |
|---|---|---|
| `CLOUDFLARE_GUACAMOLE_HMAC_SECRET` | app env | must **byte-match** the Worker's `SANDBOX_HMAC_SECRET` |
| `SANDBOX_HMAC_SECRET` | Worker | the other half of the same pair |
| `SUPABASE_DATABASE_URL` | app env | carries the database password |
| `SANDBOX_NEKO_TURN_API_TOKEN` / `SANDBOX_NEKO_TURN_KEY_ID` | Worker | Cloudflare Realtime TURN |

🔴 **The HMAC pair rotates together or not at all.** They are compared byte-for-byte;
changing one alone makes every signed control-plane call fail with `hmac_required` /
`hmac_invalid`, and the symptom — a desktop that will not start — does not name the cause.

Because a Worker secret takes effect immediately while an app env var only takes effect on
the next deploy, there is an unavoidable window between the two where the halves disagree.
Keep it short and expect it:

1. set the new value on the app side and start a deploy;
2. the moment that deploy is live, `wrangler secret put SANDBOX_HMAC_SECRET`;
3. verify with a real signed request, not just a health check — `/health` is unauthenticated
   and answers 200 with a broken secret.

⚠️ **Worker secrets are versioned.** A `wrangler rollback` silently restores the *previous*
secret value along with the previous code, which un-rotates the Worker half and re-opens the
window above. After any rollback, re-check the pair.

**Never commit rotation state, key inventories, or operator paths to this repository.** An
earlier revision of this file pointed at a local key-inventory file by absolute path; that
line has been removed. Track rotation wherever you track other operational secrets.

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
