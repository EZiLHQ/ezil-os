# Telemetry — what EZiL-OS collects, what it does not, and how to turn it off

EZiL-OS is a public, AGPL-licensed project handling real users. This document is the
trust surface for that: an exact account of the crash/error and persistence telemetry
the shell, the Worker, and the container send to EZiL's own servers, written so a
stranger reading the source can verify every claim against the code cited.

Design source of truth: the telemetry design this implementation follows is not
reproduced here in full — read the code it describes instead:
`app/src/server/telemetry/` (schema, fingerprinting, ingest, retention, queries) and
`app/src/server/db/schema/telemetry.ts` (the three Postgres tables). This document is
the plain-language summary of what that code does, kept in sync with it.
Persistence's binding contract is [the persistence signal contract](PERSISTENCE-SIGNAL-CONTRACT.md);
its §§1–2 pin the event vocabulary and the metadata allowed on the wire.

## What is collected

**Structured records of failures and persistence outcomes** — a crash, a boot phase that
failed, an API call that returned an error, a desktop window that failed to open, or the
outcome of restoring, saving or stopping a computer's persistent layers. Ten closed
event classes exist (`boot_phase`, `boot_summary`, `boot_stall`, `crash`, `window_error`,
`api_failure`, `display_failure`, `worker_exception`, `contract_violation`,
`persistence`); nothing outside that list is accepted — `POST /api/shell/telemetry`
validates every event against a strict schema (`app/src/server/telemetry/schema.ts`)
and silently drops anything that doesn't match, rather than storing an unrecognised shape.

`persistence` describes per-computer restore/save/stop outcomes for the workspace and
system layers. Beyond the event's identity, timing and outcome fields, it carries only
reason codes, counts, size buckets, ages since the last OK commits, a trigger and a
`discarded_unsaved` flag (on `persist.stop`). It never carries paths, file or package
names, commands or content; `detail` is never set. That boundary is deliberate: the
signal stays valid once saved layers are end-to-end encrypted. Verify the seven allowed
`attrs` keys in `app/src/server/telemetry/types.ts` against contract §2; unknown keys
are stripped by `app/src/server/telemetry/schema.ts`.

**Persistence also records routine OK outcomes and a 15-minute heartbeat.** Apart from
the boot denominators (`boot_summary` / `boot_phase` OK rows, which already existed),
the other classes remain failure-only. A layer's `(site, code)` change is emitted immediately;
identical repeats are suppressed. `persist.stop` and `persist.open_blocked` are always
emitted. `persist.heartbeat` reports both layers while the computer is running, once
at least 15 minutes have passed since its last persistence event (contract §3).

Each stored row carries, at most:

| Field | What it is |
|---|---|
| `fingerprint` | A SHA-256 hash of the error's *type*, computed server-side from an already-redacted, already-normalised description — never of anything a person typed |
| `user_hash` | A **pseudonym** derived from your account id (`u_xxxxxxxx`, unsalted 32-bit FNV-1a), or the `u_00000000` sentinel for worker/container events without a known computer. It exists so we can count "how many distinct people hit this" without our dashboards, exports or on-call screenshots displaying an account id. It is *not* anonymisation — see the note below, which says exactly what it does and does not protect against |
| `site` / `code` | A hand-written, low-cardinality label for *where* and *what kind* of failure or persistence outcome this was (e.g. `sandbox_start_failed`, or `persist.system.flush` / `too_large`) — never a file path or a URL |
| `detail` | Absent for persistence. For other classes, a short (≤200 char), redacted description. Redacted twice before it is written: once by the sender (`redact`, best-effort) and once again on our server (`sanitizeErrorMessage`, the actual boundary — it, not the sender, produces the value stored) |
| `duration_ms`, `outcome`, `occurred_at` | Timing and pass/fail bookkeeping |
| `computer_id` | The random UUID your own computer row already uses — it identifies no one outside our own database and is already visible to you in the product |
| `attrs` | Extras allowed for that event class. For persistence, only `entries`, `size_bucket`, `system_age_s`, `workspace_age_s`, `consecutive_failures`, `trigger`, `discarded_unsaved` (contract §2) |

See `app/src/server/db/schema/telemetry.ts` for the literal column
list and `app/src/server/telemetry/types.ts` for the wire contract the shell sends.

> **CORRECTED 2026-08-19 by integration.** This paragraph used to read *"Not
> collected yet at all … nothing is stored. The three tables above do not exist in
> the live database."* **That was false**, and had been for roughly two weeks. It
> was written from the repo rather than from the database, and nobody had looked.

**It is collected, and it is readable.** `app/drizzle/0001_telemetry.sql` was
applied to the live project on or before **2026-08-04**. All three tables exist
with RLS on, 3 policies, 7 indexes, 3 CHECKs and 2 FKs — an exact structural match
for the file. At the **2026-08-19** check, `ezil_error_events` held **84 live rows**
(199 inserts / 109 deletes), and the 14-day retention cron was running.

Three caveats from that dated production check, not a claim about today's drain state:

- 🔴 **Only the shell producer had worked.** All 193 recorded occurrences were
  `source='shell'`. **Zero** rows had arrived with `source='worker'` or
  `source='container'`. Do not read an empty container slice as "nothing failed".
- 🔴 **The R2 spool had never been drained.** `ezil-telemetry-spool` had been
  accumulating worker/container events since 2026-08-03 — 173 objects / 467 kB as
  of 2026-08-19 — and not one had reached Postgres. That was the mechanical reason
  for the point above. See `docs/RUNBOOK.md`, "OPEN OUTAGE".
- 🔴 **`computer_id` was NULL on all 84 rows.** Those rows could not be joined to a
  computer. This snapshot predates the per-computer persistence signal below.

### What `user_hash` is honestly worth

`user_hash` is `u_` + a 32-bit unsalted FNV-1a of your account UUID
(`safeUserHash`, the same function the sandbox Worker has always used for its logs).
Calling it a "one-way hash" would be technically true and practically misleading, so
here is the accurate version:

- **It does what it is for.** Nothing in the telemetry tables, an export, or a shared
  screenshot displays an account id or an email. Two rows from the same person can be
  counted as one person; that is the entire purpose.
- **It is not anonymisation, and we do not claim it is.** The input space is our own
  user list, which we hold. Anyone with both this table and a candidate account id can
  hash that id in microseconds and confirm whether it appears — and we, holding the full
  user list, could re-link the whole table if we chose to. A salt we also store would not
  change that; only not storing a per-user key at all would, and then the one question
  this system exists to answer ("how many *distinct* people hit this bug", as opposed to
  "how many times did it fire") becomes unanswerable. That is the trade being made, and
  it is being made deliberately rather than hidden behind the word "hash".
- **32 bits means collisions.** Past roughly 65,000–77,000 users, two different people
  begin to share a `user_hash` with meaningful probability. The effect is that
  distinct-user counts start to read slightly *low* — the failure direction is
  under-counting, never mixing one person's records into another's identity.
- **It is deliberately unchanged here.** It matches the Worker's existing `safeUserHash`
  precedent exactly, and the two copies are held byte-identical by a test. Widening or
  salting it is a real change with a real migration, not a wording fix, and it is not
  what this document's accuracy depended on.

### `computer_id` and the Worker

The **browser** knows the real computer UUID. **Worker persistence events** also carry
that `ezil_computers.id`: the app hands it down as `projectId` when opening the preview,
and the Worker stores it in Durable Object storage (contract §1). It is never the
sandbox id, `guac-<16 chars of your user id>-<16 chars of your computer id>` — that is a
*truncated copy of your account id*, not an anonymous token.

The drain resolves that computer's owner and stores the owner's pseudonymous
`user_hash`, using the same `safeUserHash`, instead of `u_00000000`. Worker events
without a computer, or with an unknown computer, keep that sentinel and have
`computer_id = NULL`. Non-persistence Worker/container events still leave
`computer_id` NULL and join to a request by `correlation_id`. Verify the attribution
against `app/src/server/telemetry/spool-drain.ts` and contract §4.

An unknown computer UUID does not cost the rest of a batch: ingest nulls that row's
`computer_id` and still inserts it. On the shell path it also nulls a computer id that
is not owned by the signed-in user, instead of rejecting the batch. UUID syntax is
still validated by the schema. See `app/src/server/telemetry/ingest.ts`,
`app/src/server/telemetry/http-handler.ts` and contract §4.

### What the shell shows

While a computer is open, the shell polls its persistence status no faster than every
60 seconds through `cloudflareGuacamole.persistenceState({ computerId })`, which checks
ownership. When `savingPaused` is true, it shows a one-line notice explaining the
affected layer and reason: for example, "Saving is paused: your home folder is over
the 512 MB limit". The `stale` and `not_restored` notices explain that reopening the
computer restores saving.

Each change of `pausedReason` is reported through authenticated
`POST /api/shell/telemetry` as a `persistence` event with source `shell` and site
`persist.shell_seen`; its code is the reason, or `ok` when cleared. The notice comes
from the status poll; delivery of telemetry is not required to show it. Contract §5
pins the status response and shell behavior; `shell/ezil/telemetry.js` is the sender.

## What is never collected — named so nobody adds it back thinking it was an oversight

- **Your raw account id or email.** Both exist in the browser's own boot payload
  (`window.__EZIL_BOOT__`) and are deliberately never put on the wire. The ingest route's
  schema is `.strict()` — an event carrying an unrecognised field like `userId` is
  rejected outright, not silently accepted (`app/src/server/telemetry/schema.test.ts`
  asserts this directly, not just as a comment's promise).
- **Your IP address.** Not read from the request, not derivable from anything stored.
- **Full stack traces.** At most one stack frame (`functionName@file.js`, no line, no
  column, no path), and only for the `crash` event class.
- **Workspace file names, paths, or contents.** Every absolute path is replaced with the
  literal placeholder `<path>` — so `restart rejected ... at /home/user1/workspace/proj-1`
  is stored as `restart rejected ... at <path>`, keeping the fact that a location was
  involved without keeping the username or the project name. This happens three times
  independently: in the browser before the request is sent
  (`shell/ezil/telemetry.js`'s `redact`), and again on the server in the one function
  that produces the value actually written to the `detail` column
  (`sanitizeErrorMessage`, duplicated byte-identically in
  `app/src/server/telemetry/sanitize.ts` and `worker/src/observability.ts`). POSIX
  paths, `~/`-relative paths, Windows drive paths and paths carried inside a URL are all
  covered.

  **One residual, stated rather than glossed over:** an *unquoted* path whose *last*
  segment contains a space — `/home/user1/workspace/my secret project failed to mount` —
  is redacted only as far as the space, and would be stored as
  `<path> secret project failed to mount`. Nothing can tell where such a path ends;
  swallowing the rest of the sentence would destroy the error message instead. The
  username and every earlier directory are still removed, and a *quoted* path
  (`'/home/user1/workspace/my secret project'`) is removed in full. This case is pinned
  by a test in each of the three redactors so it cannot silently get worse.
- **Full URLs, query strings, or `document.referrer`.** Query strings can carry tokens.
  Replaced with `<url>`, in the same three places and by the same functions as paths
  above — a URL is also a path carrier, so the two are redacted together.
- **Secrets, tokens, cookies, HMAC signatures, TURN/relay credentials.** Redacted twice —
  once by the sender, once again at the server — before storage.
- **Browser/OS fingerprinting signals** (User-Agent, screen size, locale, timezone).
  None of these answer the one question this system exists to answer ("how many people
  hit this specific bug"), so none are collected.
- **A behavioural trail of what you clicked or typed.** Records describe failures or
  the persistence outcomes above — never a breadcrumb history leading up to them.

## How to turn it off

Browser telemetry is **best-effort and silently optional by construction**, not a
setting to find and flip:

- Browser collection requires a signed-in session — there is no anonymous browser path.
- If your browser has JavaScript disabled, or blocks `navigator.sendBeacon`/`fetch`
  requests to this origin (an ad blocker, a strict extension, a corporate proxy), no
  browser telemetry is sent — see the "always 202, nothing to branch on" contract below.
- Blocking requests to `/api/shell/telemetry` at the browser or network level (a
  userscript, an extension rule, a hosts-file entry, a proxy filter) disables browser
  telemetry, including `persist.shell_seen`.
  Because the ingest route never changes what the product does based on whether a batch
  arrived, blocking it has no functional side effect on EZiL-OS itself.

There is no in-product telemetry toggle yet. Collection is limited to crash/error
records and the persistence metadata described above. Blocking browser telemetry does
not disable Worker persistence events in the R2 spool or the app's drain of those
events. The same pseudonym limitations apply to those attributed rows.

## The guarantee: telemetry can never affect what you see

Every telemetry code path is designed so that failure is invisible to the product:

- The ingest route always answers `202 Accepted` with an empty body — whether you are
  signed in, the batch is malformed, the server is overloaded, or Postgres is down. There
  is nothing in the response for a client to read or branch on.
- The actual database write happens **after** that response is already sent (Next.js's
  `after()`), so a slow or unreachable database costs you nothing.
- If the shell's telemetry module throws for any reason, it fails silently and stops
  trying for the rest of that page load — it never surfaces an error of its own.

See `app/src/server/telemetry/http-handler.ts` for the literal code, and its test file for
the both-directions proof (each failure mode is asserted to still return 202 and schedule
no work).

The strongest version of that proof is `app/scripts/telemetry-e2e.ts`, which runs the
whole chain — the shipped browser module, the bytes it actually puts on the wire, the real
route, the real validator, the real writer, a real Postgres, the real aggregation
queries — and then **drops the tables** and re-sends the same batch to confirm the answer
is still an immediate `202` with no throw. It is not part of `vitest run` (it needs a
database); the commands to run it against a throwaway container are in its own header.
It is the only test here that can catch a disagreement between the browser and the server
about what a field means, which is the failure mode this pipeline is most exposed to:
three separate producers, three separate copies of one contract.

## Retention

Raw event rows (`ezil_error_events`) are kept for **14 days**, then deleted — not
archived, not soft-deleted, permanently removed by an hourly maintenance job
(`app/src/server/telemetry/retention.ts`, run from
`GET /api/cron/telemetry-maintenance`). An hourly rollup
(`ezil_error_user_hours` — a count per error-type, per hour, per hashed user, with no
other fields) is kept for 90 days so long-horizon "how many distinct people hit this"
questions can still be answered after the raw rows are gone, without keeping any
per-event detail around longer than two weeks. A small permanent table
(`ezil_error_fingerprints`) records only "this kind of error exists, first/last seen,
how many times total" — no per-event data, and rows unseen for a year with fewer than 10
total occurrences are pruned from even that.

## Who can read it

All three telemetry tables are Postgres Row-Level-Security tables with **no policy at
all for ordinary signed-in users** — only EZiL's own service-role connection can query
them (`app/drizzle/0001_telemetry.sql`). There is no "your own crash reports" view in the
product today. A small internal review page (`/admin/telemetry`) exists for the project
owner, gated by an explicit email allow-list (`app/src/server/telemetry/admin.ts`) that
is unset by default — meaning the page is unreachable by anyone until it is deliberately
configured, never reachable by every signed-in user by default.

## Abuse surface and flood behaviour

`POST /api/shell/telemetry` is reachable by any signed-in session and accepts
client-controlled JSON, so it is treated as hostile input:

- Request bodies are capped at 64 KB, measured by actual bytes read off the request
  stream — never by a trustable `Content-Length` header.
- At most 50 events are accepted per request; more are silently truncated, not rejected.
- Each user is rate-limited to 20 requests/minute per server instance
  (`app/src/server/telemetry/rate-limit.ts` — documented there as best-effort, not a
  distributed limit).
- A global circuit breaker (`app/src/server/telemetry/load-shed.ts`) drops **all** new
  telemetry, from everyone, the moment the underlying table's estimated row count crosses
  2,000,000 — telemetry is designed to fail before the product it is meant to protect
  does.

None of these limits are visible to the caller: every outcome, including being dropped
outright, is the same `202 Accepted`.
