# Production error analysis — live telemetry, 2026-08-19

Written by P2 against the **live** database, queried between 12:34 and 12:53 UTC on
2026-08-19. **Snapshot at 12:53:28 UTC; the table was still receiving rows when the query
window closed**, so post-deploy counts here are a floor, not a total. Every number below is followed by the SQL that produced it. Nothing is
carried forward unverified from `docs/SUPABASE-STATE.md`; where this document and that
one disagree, the difference is called out and explained.

> ### Read this first — the sample is tiny and skewed
>
> **111 telemetry events. Four distinct `user_hash` values in the entire history of the
> product. One of them (`u_1f6e8a50`) accounts for 90 of the 111 events and 52 of the 63
> errors — and every single one of the ten desktop-launch failures this document analyses.**
> There is no fleet here. Almost every "rate" below is one person's testing across six
> afternoons. A percentage computed on 23 launches by one user is a description of that
> user's afternoon, not a service level. Read every number in this document with that
> sentence attached.

> ### Second thing to read — the deploy landed mid-analysis, and the picture changed
>
> The `main` merge commit `8b5707f` is stamped **2026-08-19 12:27:52 UTC**. Telemetry
> arrived from a **brand-new user** at **12:39:19**, eleven minutes later, and kept
> arriving while this document was being written. So there is a genuine before/after
> boundary and there is post-deploy data on both sides of it. The post-deploy window is
> **19 events over fourteen minutes from one user** — far too small to certify anything, but
> large enough to show three concrete improvements and **one brand-new 100%-failure
> regression that nobody knows about yet**. See §2.2.

---

## 0. Which database, and how I know it is EZiL-OS's

Project **`btgqfmnzycdecmeyqubx` ("EZiL App", ap-northeast-1)**, linked in a throwaway
scratch directory outside the repo. Identity was re-confirmed rather than assumed, because
the database is shared with sibling apps:

```sql
select table_name, ordinal_position, column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name like 'ezil_error%'
order by table_name, ordinal_position;
```

Returns **31 rows** across exactly three tables with the shapes `app/drizzle/0001_telemetry.sql`
declares — `ezil_error_events` 16 columns, `ezil_error_fingerprints` 11, `ezil_error_user_hours` 4,
in the file's own column order. The `site` values in the data are all prefixed `ezil-os:`
and match the constants in `app/src/server/telemetry/types.ts` (e.g. `DESKTOP_SCREEN:
'ezil-os:apps/desktop#screen'` at `types.ts:175`). No sibling app writes to these tables:
every row in all three carries `source='shell'` and an `ezil-os:` site. That is how I know
I am reading EZiL-OS's data and not EBuilder's, EZiL-Universe's or EZiL-Works'.

**Inspection only.** No `db push`, `db pull`, `db diff` or `db reset` was run. Nothing was
written. No token, password or connection string was read, printed or stored.

---

## 1. The real error rate, over time

### 1.1 Events per day, by class and outcome

```sql
select occurred_at::date as d, event_class, outcome, count(*) as n,
       count(distinct user_hash) as users
from public.ezil_error_events group by 1,2,3 order by 1,2,3;
```

| day | event_class | outcome | n | distinct users |
|---|---|---|---|---|
| 2026-08-05 | api_failure | error | 3 | 1 |
| 2026-08-05 | boot_summary | error | 1 | 1 |
| 2026-08-05 | boot_summary | ok | 13 | 2 |
| 2026-08-05 | boot_summary | skipped | 3 | 1 |
| 2026-08-08 | api_failure | error | 7 | 1 |
| 2026-08-08 | boot_summary | error | 5 | 1 |
| 2026-08-08 | boot_summary | ok | 5 | 1 |
| 2026-08-09 | api_failure | error | 13 | 1 |
| 2026-08-09 | boot_summary | error | 5 | 1 |
| 2026-08-09 | boot_summary | ok | 7 | 2 |
| 2026-08-10 | api_failure | error | 8 | 1 |
| 2026-08-10 | boot_summary | error | 4 | 1 |
| 2026-08-10 | boot_summary | ok | 3 | 1 |
| 2026-08-10 | display_failure | error | 1 | 1 |
| 2026-08-15 | boot_summary | ok | 6 | 1 |
| 2026-08-19 (pre-deploy) | boot_summary | error | 2 | 1 |
| 2026-08-19 (pre-deploy) | boot_summary | ok | 3 | 1 |
| 2026-08-19 (pre-deploy) | display_failure | error | 3 | 1 |
| 2026-08-19 (post-deploy) | api_failure | error | 8 | 1 |
| 2026-08-19 (post-deploy) | boot_summary | ok | 7 | 1 |

The raw table holds **14 days**; the retention job (`app/src/server/telemetry/retention.ts`)
has already reaped 2026-08-04. There are **no rows at all** on 08-06, 08-07, 08-11 through
08-14, and 08-16 through 08-18. The product is used in short bursts, not continuously.

### 1.2 Desktop launch success/failure per day

```sql
select occurred_at::date as d, count(*) as launches,
       count(*) filter (where outcome='ok')      as n_ok,
       count(*) filter (where outcome='error')   as n_err,
       count(*) filter (where outcome='skipped') as n_skip,
       round(100.0*count(*) filter (where outcome='error')/count(*),1) as pct_err,
       count(distinct user_hash) as users
from public.ezil_error_events where site='ezil-os:trace#desktop'
  and occurred_at < '2026-08-19 12:27:52+00'   -- pre-deploy corpus only
group by 1 order by 1;
```

**Scoped to the pre-deploy corpus deliberately.** Mixing old-build and new-build launches into
one rate would be wrong; the post-deploy window is reported separately in §2.2.

| day | launches | ok | error | skipped | % error | users |
|---|---|---|---|---|---|---|
| 2026-08-05 | 6 | 5 | 0 | 1 | 0.0 | 2 |
| 2026-08-08 | 3 | 1 | 2 | 0 | 66.7 | 1 |
| 2026-08-09 | 7 | 2 | 5 | 0 | 71.4 | 2 |
| 2026-08-10 | 3 | 0 | 3 | 0 | **100.0** | 1 |
| 2026-08-15 | 2 | 2 | 0 | 0 | 0.0 | 1 |
| 2026-08-19 (pre-deploy) | 2 | 2 | 0 | 0 | 0.0 | 1 |

All-time, from the 90-day rollup that survives raw-row retention:

```sql
select f.code, sum(h.event_count) as events, count(distinct h.user_hash) as users,
       min(h.hour_bucket)::date as first_day, max(h.hour_bucket)::date as last_day
from public.ezil_error_user_hours h join public.ezil_error_fingerprints f using (fingerprint)
where f.site='ezil-os:trace#desktop' group by 1 order by 2 desc;
```

| code | events | users | first | last |
|---|---|---|---|---|
| ok | 24 | **4** | 2026-08-04 | 2026-08-19 |
| error | 10 | **1** | 2026-08-08 | 2026-08-10 |
| skipped | 1 | 1 | 2026-08-05 | 2026-08-05 |

**The headline number has moved, in the right direction, for an uninteresting reason.**
`docs/SUPABASE-STATE.md` reported **10 of 26 = 38%**. It is now **10 of 35 = 28.6%**, and it
fell from 35.7% to 28.6% *during the ten minutes this document was being written*, because
nine successful launches landed after the deploy. **The numerator has not moved since
2026-08-10.** Any figure quoted from this fingerprint is a decaying number whose denominator
grows every time someone opens the app — which is another way of saying it was never a rate. **All ten failures are from one `user_hash`, confined to three days.** The honest
statement is: *one user experienced a run of ten desktop launch failures over 2026-08-08 to
2026-08-10, and nobody — including that user — has reproduced one since.*

### 1.3 Duration of successful vs failed launches — they are indistinguishable

```sql
select outcome, count(*) as n, min(duration_ms) as p_min,
       round(percentile_cont(0.25) within group (order by duration_ms)) as p25,
       round(percentile_cont(0.5)  within group (order by duration_ms)) as median,
       round(avg(duration_ms)) as mean,
       round(percentile_cont(0.75) within group (order by duration_ms)) as p75,
       max(duration_ms) as p_max, round(stddev_samp(duration_ms)) as sd
from public.ezil_error_events where site='ezil-os:trace#desktop'
  and occurred_at < '2026-08-19 12:27:52+00'   -- pre-deploy corpus only
group by 1;
```

| outcome | n | min | p25 | median | mean | p75 | max | sd |
|---|---|---|---|---|---|---|---|---|
| ok | 12 | 4,306 | 22,426 | 25,605 | **29,137** | 34,327 | 80,156 | 19,450 |
| error | 10 | 1,293 | 4,068 | **28,481** | 50,449 | 34,510 | 190,499 | 71,181 |
| skipped | 1 | 70,701 | — | 70,701 | 70,701 | — | 70,701 | — |

The prior document said "27.9s mean success vs 32–35s failure". **The corrected statement is
stronger and worse: the medians are 25.6s (success) and 28.5s (failure). They are not merely
close, they overlap.** Sorting every desktop launch by duration makes it plain:

```sql
select occurred_at, outcome, duration_ms, user_hash, attrs->>'phases' as phases
from public.ezil_error_events where site='ezil-os:trace#desktop' order by duration_ms;
```

In the band **19.6s – 34.8s** there are **8 successes and 4 failures**. Every one of the four
mid-band failures sits inside the success range. A user waiting at 30 seconds has no
information whatsoever about which way it will go.

The failures are not one population. They fall into three clean clusters:

```sql
select case when duration_ms < 10000  then 'A: <10s fast refusal'
            when duration_ms < 60000  then 'B: 24-35s (inside the success range)'
            else 'C: 175-190s hang' end as cluster,
       count(*) as n, min(duration_ms) as min_ms, max(duration_ms) as max_ms,
       string_agg(distinct occurred_at::date::text, ', ') as days
from public.ezil_error_events where site='ezil-os:trace#desktop' and outcome='error'
group by 1 order by 1;
```

| cluster | n | min_ms | max_ms | days |
|---|---|---|---|---|
| A: <10s fast refusal | 4 | 1,293 | 7,292 | 08-09, 08-10 |
| B: 24–35s, inside the success range | 4 | 24,189 | 34,625 | 08-09, 08-10 |
| C: 175–190s hang | 2 | 175,128 | 190,499 | 08-08 |

**This three-way split is the single most useful new finding in §1.** The prior analysis
treated "the 32–34s cluster" as the story. It is only 4 of 10 events, and — as §3 shows —
it is the only cluster with a confirmed production-only cause.

### 1.4 How many real people are behind each number

```sql
select user_hash, count(*) as events, count(*) filter (where outcome='error') as errors,
       min(occurred_at) as first_seen, max(occurred_at) as last_seen,
       count(distinct computer_id) as computers
from public.ezil_error_events group by 1 order by 2 desc;
```

| user_hash | events | errors | first seen | last seen | computers |
|---|---|---|---|---|---|
| `u_1f6e8a50` | 90 | **52** | 2026-08-05 09:52 | 2026-08-19 10:46 | 0 |
| `u_3d037b3c` | 17 | 10 | **2026-08-19 12:39** | 2026-08-19 12:52 | **1** |
| `u_ce8231b3` | 1 | 0 | 2026-08-05 10:04 | 2026-08-05 10:04 | 0 |
| `u_eb38f108` | 1 | 0 | 2026-08-09 05:05 | 2026-08-09 05:05 | 0 |

`u_3d037b3c` is **new since the deploy** and is the fourth user ever. `ezil_computers` grew
from 7 rows / 4 users to **8 rows / 5 users** at 12:38:13 today — that user created a
computer and immediately used it.

Per-fingerprint user counts, all-time, excluding the `ezil-os:verify/%` synthetic harness:

```sql
select f.site, f.code, f.total_count, count(distinct h.user_hash) as distinct_users
from public.ezil_error_fingerprints f join public.ezil_error_user_hours h using (fingerprint)
where f.site not like 'ezil-os:verify/%' group by 1,2,3 order by 3 desc;
```

**Every single error fingerprint has `distinct_users` of 1 or 2. Not one failure mode has
ever been seen by three people.** Specifically:

| fingerprint | occurrences | distinct users |
|---|---|---|
| `apps/desktop#mint` / `desktop_unreachable` | 10 | **1** |
| `session#openDesktop` / `auto_retry_desktop_unreachable` | 10 | **1** |
| `trace#desktop` / `error` | 10 | **1** |
| `apps/code#mint` / `unknown` | 7 | **1** |
| `trace#code` / `error` | 6 | **1** |
| `apps/code#confirmFrame` / `frame_not_answering` | 4 | 2 |
| `apps/desktop#screen` / `screen_upstream` | **8 (all today, all post-deploy)** | **1** |

The `desktop_unreachable` fingerprint — the one that generated the 38% headline — has been
seen by exactly one person, ever.

---

## 2. What has arrived since the deploy

### 2.1 `source='worker'` / `source='container'` — **No. Still zero. The R2 drain outage is unchanged.**

```sql
select 'events' as tbl, count(*) as n from public.ezil_error_events
  where source in ('worker','container')
union all select 'fingerprints', count(*) from public.ezil_error_fingerprints
  where source in ('worker','container')
union all select 'events_any_source_not_shell', count(*) from public.ezil_error_events
  where source <> 'shell'
union all select 'fp_any_source_not_shell', count(*) from public.ezil_error_fingerprints
  where source <> 'shell';
```

| | count |
|---|---|
| events with source in (worker, container) | **0** |
| fingerprints with source in (worker, container) | **0** |
| events with any source ≠ shell | **0** |
| fingerprints with any source ≠ shell | **0** |

Re-checked at 12:53:28 UTC, twenty-six minutes after the deploy and after 19 fresh events
had landed: **`count(*) filter (where source <> 'shell') = 0` out of 111 events.** `SOURCES`
in `app/src/server/telemetry/types.ts:32` has always accepted `'worker'` and `'container'`;
nothing has ever used them.

The producer side is wired end to end
and is working: the container appends NDJSON to `/var/log/ezil-telemetry.ndjson`
(`worker/src/index.ts:889-893`), the Worker drains it into R2 via `spoolTelemetry`
(`worker/src/index.ts:120-127`, binding `TELEMETRY_R2_BUCKET` at `worker/wrangler.toml:73-76`),
and `POST /telemetry/drain` + `/telemetry/ack` exist (`worker/src/telemetry.ts:318-333`) with a
Vercel cron registered at `app/vercel.json` (`43 3 * * *`). What has never worked is the last
hop into Postgres. `docs/telemetry.md:51-57` records the spool at **173 objects / 467 kB
accumulated since 2026-08-03**, none of it drained; `docs/RUNBOOK.md:79-97` carries it as an
**OPEN OUTAGE** and is explicit that root cause is *not* established (candidates: an
unset/wrong drain secret, an unconfigured R2 binding, or the scheduled trigger never firing).

Today's `d00c684` ("send an explicit drain page limit") **does not fix this.** It hardens the
first recovery run — `drainPage` was sending no `limit`, so `clampDrainLimit(undefined)` fell
back to 200 sequential awaited `bucket.get()` calls inside one request against a 20s abort,
which would have aborted, never acked, and left the backlog untouched. That is a real fix to a
real second-order bug, and it changes nothing about why the drain has not run in sixteen days.

I could not verify the R2 object count directly — R2 is not visible from the Supabase
management API. The 173/467 kB figure is quoted from `docs/telemetry.md` and inherits that
document's freshness, not mine.

### 2.2 🔴 What *did* arrive — three improvements and one brand-new 100%-failure regression

```sql
select occurred_at, site, code, outcome, duration_ms, user_hash,
       (computer_id is not null) as has_cid, attrs->>'phases' as phases
from public.ezil_error_events
where occurred_at >= '2026-08-19 12:27:52+00' order by occurred_at;
```

19 rows by 12:53:28 UTC and still arriving, all from one user (`u_3d037b3c`, new),
starting 12:39:19. The first 15 in full — the pattern does not change after them:

| time | site | code | outcome | ms | phases |
|---|---|---|---|---|---|
| 12:39:19 | `apps/desktop#screen` | **screen_upstream** | error | — | — |
| 12:40:05 | `apps/desktop#screen` | **screen_upstream** | error | — | — |
| 12:40:11 | `trace#desktop` | ok | ok | 8,251 | `mint_ok:1397,confirm_ok:6386,display_live` |
| 12:40:26 | `apps/desktop#screen` | **screen_upstream** | error | — | — |
| 12:40:32 | `trace#desktop` | ok | ok | 7,432 | `mint_ok:1401,confirm_ok:6627,display_unverified` |
| 12:40:47 | `apps/desktop#screen` | **screen_upstream** | error | — | — |
| 12:40:54 | `trace#desktop` | ok | ok | 8,876 | `mint_ok:1863,confirm_ok:5443,display_live` |
| 12:41:10 | `apps/desktop#screen` | **screen_upstream** | error | — | — |
| 12:41:16 | `trace#desktop` | ok | ok | 8,264 | `mint_ok:1461,confirm_ok:6290,display_live` |
| 12:45:28 | `apps/desktop#screen` | **screen_upstream** | error | — | — |
| 12:45:53 | `trace#desktop` | ok | ok | **27,916** | `mint_ok:21308,confirm_ok:26118,display_live` |
| 12:47:13 | `apps/desktop#screen` | **screen_upstream** | error | — | — |
| 12:47:21 | `trace#desktop` | ok | ok | 9,778 | `mint_ok:2545,confirm_ok:7361,display_live` |
| 12:48:50 | `apps/desktop#screen` | **screen_upstream** | error | — | — |
| 12:49:11 | `trace#desktop` | ok | ok | **25,003** | `mint_ok:18413,confirm_ok:23274,display_live` |

**Three things got better:**

1. **8 of 8 desktop launches succeeded** (7 shown above, one more by 12:52). No `desktop_unreachable`, no `mint_error`, no
   `auto_retry_*`. And this is no longer only warm boots — **two of the seven were cold**
   (`mint_ok:21308` and `mint_ok:18413`, totals 27.9 s and 25.0 s), landing squarely in the
   15–37 s cold-boot band where 4 of 10 pre-deploy launches used to fail. The fix has now
   been exercised against the condition it was written for, and passed twice. Two is still
   two.
2. **`computer_id` is populated for the first time ever.** All post-deploy rows carry
   `3d348cd2-057b-4bae-a342-1761812000e5`. The historical NULL is fixed and confirmed live.
3. **The `code` app's `frame_not_answering` failures stopped.** The three that fired at
   10:45–10:46 (pre-deploy, `mint_ok:994` then `confirm_error:2716`) have not recurred.

**And one thing got worse — a regression introduced by this deploy:**

```sql
select fingerprint, source, event_class, site, code, first_seen_at, last_seen_at, total_count
from public.ezil_error_fingerprints where site like '%screen%';
```

| fingerprint | site | code | first_seen_at | total_count |
|---|---|---|---|---|
| `fp_32a00d3037af7e6a` | `ezil-os:apps/desktop#screen` | `screen_upstream` | **2026-08-19 12:39:32** | 11 |

**`ezil-os:apps/desktop#screen` / `screen_upstream` is a brand-new fingerprint whose first
occurrence is 100 seconds after the deploy, and it is the *only* error produced since. Eleven
calls, eleven failures — a 100% failure rate, with no successful `apps/desktop#screen` event
ever recorded.** (There are more screen calls than launches because the resize also fires on
window-resize, not only at launch.)

It comes from the live-resize feature shipped in this deploy (`c569e58` "size the streamed
desktop to the window it is shown in" and `bc81833` "split the X framebuffer from the initial
screen size"). The chain: the shell calls the screen-set endpoint; `worker/src/index.ts:4869`
answers HTTP **502** with `error: screen_upstream_<status>` when neko returns a status that is
neither 2xx nor the 400/422 "unsupported" pair; the shell's `onFailure` handler maps that to
`code: screen_upstream` and captures an `api_failure`.

The good news is that it is **non-fatal by design** — the desktop still launches and still
reaches `display_live`, so users are not blocked. The bad news is that a headline feature of
this deploy has never once succeeded in production, and without this telemetry row nobody
would know, because it does not surface as a failed launch. `duration_ms` and `detail` are
NULL on all eight rows, so the HTTP status neko actually returned is **not recorded** — see
COULD-NOT-DETERMINE #10.

---

## 3. 🔴 Why production and not local

This section is built from the telemetry and the code, and each hypothesis gets a verdict:
**BITING** (the data shows it), **STRUCTURAL** (real and confirmed in code, but no telemetry
row proves it caused a failure), or **REFUTED** (checked and it is not happening here).

### Ranked by how much of the observed failure they actually explain

---

### #1 — The public edge answers fast and wrong during a boot transition — **BITING**

**This is the only hypothesis with a direct evidential chain from the data to a failure.**

The mechanism, as the code itself states at
`app/src/server/lib/cloudflare-guacamole-provider.ts:1608-1615`:

> "The mechanism is that the edge answers FAST and WRONG during a normal boot transition.
> `proxyToSandbox` returns `404 INVALID_TOKEN`, `410 STALE_PREVIEW_URL` and `500 Container
> suddenly disconnected` in well under a second while a container is still settling. All are
> `>= 400`, so the probe reports `alive:false` immediately — a 27.9s success and a 33s failure
> are the same boot, and the probe merely missed at the finish line."

**One correction to the brief's framing.** Those two error codes are *not* emitted by
`worker/src/preview-bridge.ts`. That file (all 1414 lines) emits only 503/401/302/502/200/101.
`INVALID_TOKEN` and `STALE_PREVIEW_URL` come from the vendored `@cloudflare/sandbox` SDK's
`proxyToSandbox` (`worker/node_modules/@cloudflare/sandbox/dist/sandbox-DKG3H156.js:7469` and
`:7478`). The repo only names them in comments and tests. The claim about *what happens* is
right; the claim about *where the code lives* was not.

**A second correction, and it matters for anyone trying to reproduce this locally.** A local
run does **not** probe `127.0.0.1:8181`. `127.0.0.1:8181` is the in-container address. A local
probe hits `http://8181-guac-a-b-nekodesktop.localhost:8787/` — the local Worker — which still
goes through `proxyToSandbox` (`cloudflare-guacamole-provider.test.ts:991, 1025`). The
load-bearing local/prod difference is not the address. It is that a local run frequently has
**no real container at all**: `cloudflare-guacamole-provider.ts:205-206` defines
`mode?: 'local-dev-stub' | 'production'`, and `cloudflare-guacamole.ts:283` short-circuits
`enableImplicitHosting` to `'manual'` on the stub. **A stub has no container to be mid-boot, so
there is no transition window for the edge to answer wrongly inside. The failure mode is not
merely rarer locally — for a stub run it does not exist.**

**The telemetry proof.** The desktop app runs a frame probe; the code app does not. If the
probe is the discriminator, then a desktop launch should be able to fail *at the same moment,
on the same sandbox*, that a code launch succeeds. Pairing each failed desktop launch with the
nearest code launch within 120 seconds:

```sql
with d as (select occurred_at, duration_ms from public.ezil_error_events
             where site='ezil-os:trace#desktop' and outcome='error'),
     c as (select occurred_at, outcome, duration_ms from public.ezil_error_events
             where site='ezil-os:trace#code')
select d.occurred_at as desktop_at, d.duration_ms as desktop_ms,
       c.occurred_at as code_at, c.outcome as code_outcome, c.duration_ms as code_ms,
       round(extract(epoch from c.occurred_at - d.occurred_at))::int as gap_s
from d left join lateral (
  select * from c where abs(extract(epoch from c.occurred_at - d.occurred_at)) < 120
  order by abs(extract(epoch from c.occurred_at - d.occurred_at)) limit 1) c on true
order by d.occurred_at;
```

| desktop_at | desktop_ms | code_at | code outcome | code_ms | gap |
|---|---|---|---|---|---|
| 08-08 07:14:05 | 175,128 | 08-08 07:14:05 | **error** | 187,536 | 0s |
| 08-08 12:34:55 | 190,499 | 08-08 12:34:56 | **error** | 188,306 | 0s |
| 08-09 03:32:12 | 24,189 | 08-09 03:32:15 | **ok** | 21,896 | +3s |
| 08-09 05:04:11 | 34,164 | 08-09 05:04:17 | **ok** | 37,358 | +6s |
| 08-10 10:54:49 | 34,625 | 08-10 10:54:44 | **ok** | 21,081 | −5s |
| **08-10 12:30:46** | **32,773** | **08-10 12:30:51** | **ok** | **39,591** (`mint_ok:32786`) | **+5s** |

The last row is the cleanest single piece of evidence in this dataset. **The desktop app's
mint failed at 32,773 ms. Five seconds later the code app's mint on the same sandbox
succeeded at 32,786 ms — thirteen milliseconds apart.** Same user, same sandbox, same
seconds, same duration, opposite verdicts. The only difference between those two code paths
is that the desktop path ran a 6-second frame probe against the public edge and the code
path did not.

**Explains: all 4 of the B-cluster failures (24–35s), and by extension the 10 paired
`desktop_unreachable` / `auto_retry_desktop_unreachable` rows that hang off them.** It does
**not** explain cluster C (both apps failed together at ~180s) and does not explain cluster A.

**What today's fix does.** `d39b73d` (08:26 UTC today) replaced the single
`probeDesktopFrame(...)` call with `confirmDesktopFrame(...)`
(`cloudflare-guacamole.ts:245`), which loops the same 6s probe inside a
`DESKTOP_FRAME_CONFIRM_BUDGET_MS = 20_000` budget with a
`DESKTOP_FRAME_CONFIRM_GAP_MS = 1_500` gap, breaking early only on the deterministic
`bad_url` (`provider.ts:1635-1682`). Post-deploy, **8 of 8 desktop launches succeeded, two of
them cold** (`mint_ok:21308` and `mint_ok:18413` — 27.9 s and 25.0 s total, inside the exact
band where 4 of 10 pre-deploy launches failed). That is the first direct evidence the fix
works against the condition it was written for. It is also eight launches by one user in
fourteen minutes: an absence of counter-examples, not a proof.

---

### #2 — Cold containers: production boots a real container, local reuses a warm one — **BITING, as the enabling condition**

`docs/PLATFORM-NOTES.md:138-140` (a sub-point of §11, which is titled "Observability is
`wrangler tail` and nothing else", not "cold containers"):

> "Measured reference: full container boot **21.9s** (`desktop_ready_wait` ~15.3s dominant,
> `workspace_mount` ~5.9s, `container_start` ~0.3s)."

The telemetry corroborates that number precisely. Extracting the `mint_*` marker from the
phases breadcrumb:

```sql
with p as (select site,
  (regexp_match(attrs->>'phases','mint_(ok|error):([0-9]+)'))[1] as mint_res,
  ((regexp_match(attrs->>'phases','mint_(ok|error):([0-9]+)'))[2])::int as mint_ms
  from public.ezil_error_events where site like 'ezil-os:trace#%' and attrs ? 'phases')
select site, mint_res, count(*) as n, min(mint_ms), round(avg(mint_ms)), max(mint_ms)
from p where mint_res is not null group by 1,2 order by 1,2;
```

| site | result | n | min | avg | max |
|---|---|---|---|---|---|
| `trace#desktop` | ok | 12 | 27 | 19,374 | 36,617 |
| `trace#desktop` | error | 10 | 1,293 | 50,449 | 190,498 |
| `trace#code` | ok | 13 | 994 | 11,172 | 33,075 |
| `trace#code` | error | 4 | 182,649 | 186,829 | 188,825 |

The **bimodality is the point**. Successful desktop mints are either ~15–37s (cold: a real
container start, matching the 21.9s reference) or **27 ms to 1.9 s** (warm: the sandbox is
already up). `worker/src/index.ts:940-941` and `:961-962` make the warm path explicit — if the
port is already exposed, `ensureDesktop` logs `status:'skipped', detail:'already_exposed'` and
returns without starting anything.

**Why this is #2 rather than a cause in its own right:** cold boot does not *fail*. It
produces a 15–37 second window in which the container is settling, and that window is exactly
the window in which #1's edge-answers-wrongly race is live. A warm local test collapses that
window to milliseconds, so the race has nowhere to happen. **Cold boot is the enabling
condition for #1, not an independent failure mode.** Note that this is a warm-*sandbox* fast
path, not a local-vs-prod switch: production hits it too on every call after the first —
which is why the post-deploy launches at 12:40 show `mint_ok:1397`, `mint_ok:1401`,
`mint_ok:1863`, `mint_ok:1461`.

---

### #3 — No UDP in Cloudflare Containers, so every production session is TURN-relayed — **STRUCTURAL; a consistent but not conclusive signature in the data**

`docs/PLATFORM-NOTES.md:85-93` (§6):

> "Cloudflare Containers expose HTTP/WS only. **Direct WebRTC P2P is architecturally
> impossible** — both peers must relay through TURN. That is the latency floor and it is not
> tunable without leaving the platform."

`docs/PLATFORM-NOTES.md:353-360` (§16c) confirms the retransmit ladder and the deadline
verbatim: "DTLS's own retransmit ladder is 1+2+4+8+16s for a single lost flight… Now **45s**,
one full ladder."

**One correction to the brief.** That 45s lives at `shell/ezil/apps/desktop-window.js:213`
(`DISPLAY_BLANK_DEADLINE_MS = 45_000`), alongside `DISPLAY_UNVERIFIED_DEADLINE_MS = 6_000` at
line 212. There is a *second, different* 45s — `FRAME_CONFIRM_DEADLINE_MS` at
`app/src/components/desktop/boot-phases.ts:154` — which is a different clock justified on
different grounds, and `cloudflare-guacamole-canvas.tsx:339` says explicitly that the two must
not be conflated.

**And a correction that weakens the local/prod framing.** `worker/wrangler.toml:88-89` sets
`SANDBOX_NEKO_ICE_POLICY = "relay"` in a single `[vars]` block; there are **no `[env.*]`
blocks in that file at all**. The same relay policy applies to `wrangler dev` and production.
What differs is that the TURN credentials are secrets absent locally, and
`worker/src/desktop-mode.ts:77-87` **fails closed** (`turn_required`) rather than falling back
to STUN. So the accurate statement is not "local is STUN, production is TURN" — it is "a local
run with a real container would refuse to start, and a local run without one (`local-dev-stub`)
has no WebRTC at all". Either way the relayed path is never exercised locally.

**Is it biting?** The signature §16c predicts is a boot that reveals the desktop without ever
proving pixels arrived. That marker exists and it fires:

```sql
select case when attrs->>'phases' like '%display_live%' then 'display_live'
            when attrs->>'phases' like '%display_unverified%' then 'display_unverified'
            else 'no_display_marker' end as verdict, count(*) as n
from public.ezil_error_events where site='ezil-os:trace#desktop' and outcome='ok' group by 1;
```

| verdict | n (pre-deploy) |
|---|---|
| `display_live` | 8 |
| `display_unverified` | **4** |

**4 of 12 successful pre-deploy desktop boots (33%) were revealed to the user without the
display gate ever observing the stream** — and it has happened once more since the deploy
(12:40:32), so 5 of 20 overall.
`shell/ezil/apps/desktop-window.js:1493` sets the marker: `display_live` means the gate
observed streaming; `display_unverified` means it was revealed anyway with a warning strip
(`:1477-1480`). Both end the trace `ok`.

That 33% is *consistent with* a relayed connection that took longer than the 6s unverified
deadline but came up inside the 45s blank deadline. **It is not proof.** No telemetry row
records the ICE candidate type, the connection state, or how long DTLS took. A slow container,
a slow browser and a slow relay all produce the identical marker. Ranked #3 because it is
architecturally certain and consistently visible, but the causal link to any *failure* is
inferred, not measured.

---

### #4 — Vercel function timeouts — **REFUTED as an explanation for the observed failures**

`docs/PLATFORM-NOTES.md:153-155` (§13) is correct as a hazard: "`maxDuration` is not
inherited. A route with a long budget (a container cold start) must declare it explicitly or
the platform default kills it in 10-15s."

**But the codebase has already mitigated it**, and the data shows no timeout at any Vercel
boundary. There is no `functions` block in `app/vercel.json` (crons only) and no root
`vercel.json`; every long path declares its own budget as a route segment config:

| maxDuration | route |
|---|---|
| 300 | `app/src/app/api/shell/desktop/route.ts:63` |
| 300 | `app/src/app/api/shell/preview-url/route.ts:42` |
| 300 | `app/src/app/api/shell/code-preview-url/route.ts:38` |
| 300 | `app/src/app/api/shell/restart/route.ts:34` |
| 300 | `app/src/app/api/trpc/[trpc]/route.ts:15` |
| 90 | the three cron routes |
| 10 | `app/src/app/api/shell/telemetry/route.ts:35` (deliberately short) |

The longest failure ever recorded is **190,499 ms**, well inside 300 s. The cluster-C
failures at 175–190 s are nowhere near a 10 s, 15 s, 60 s or 300 s boundary, and they are far
too tightly grouped (182.6, 187.5, 188.3, 188.8, and 175.1, 190.5) to be anything but a
*different* fixed ~3-minute timeout somewhere upstream. **Refuted here; it remains a real
hazard for any new route that forgets to declare a budget.**

---

### #5 — Shared / pooled Postgres and connection limits — **REFUTED; no sign of it in the data**

```sql
select (select setting::int from pg_settings where name='max_connections') as max_conn,
       (select count(*) from pg_stat_activity) as current_conn,
       (select count(*) from pg_stat_activity where state='active') as active,
       (select count(*) from pg_stat_activity where state='idle in transaction') as idle_in_txn,
       (select count(*) from pg_stat_activity where wait_event_type='Lock') as waiting_on_lock;
```

| max_connections | current | active | idle in txn | waiting on lock |
|---|---|---|---|---|
| 60 | 27 | 1 | **0** | **0** |

Connections are fronted by Supavisor (9 as `postgres`, 3 as `pgbouncer` auth_query, 1 as
`ezil_universe_app`), plus PostgREST ×2 and the usual Supabase daemons. Whole-instance health:

```sql
select datname, xact_commit, xact_rollback, deadlocks, conflicts, blks_hit, blks_read,
       temp_files, stats_reset from pg_stat_database where datname='postgres';
```

2,855,486 commits / 1,729 rollbacks (**0.06%**), **0 deadlocks**, **0 conflicts**, 58.2 M
buffer hits against 2,398 reads since 2026-06-30.

The application's pool config is uniform across environments — `app/src/server/db/index.ts:27-31`
sets `max: 10, idle_timeout: 20, prepare: false` with **no environment branch at all**. The
only env-dependent thing is the URL. **Nothing in the data resembles connection pressure, lock
contention or pooler exhaustion.** One caveat: `temp_files = 35,352` / 83 GB of temp bytes
since 2026-06-30 is a lot of spill, but this is a *shared* instance and EZiL-OS owns 4 of 43
public tables holding ~110 live rows between them. That spill is not ours.

---

### #6 — The one the brief did not list: a ~3-minute upstream hang that hits both apps at once

Cluster C (2 desktop failures) and all 4 `trace#code` failures form a single population:
**175,128 / 190,499 / 182,649 / 187,536 / 188,306 / 188,825 ms**, all on 2026-08-05 and
2026-08-08, all one user. On 08-08 at 07:14:05 and again at 12:34:55, **the desktop and the
code app failed within one second of each other, both at ~180 s.** That is not the frame
probe — the code app has no frame probe. It is a shared upstream (the Worker, the container,
or the sandbox SDK) hanging for about three minutes and then giving up.

**This is the largest single block of failure time in the dataset — roughly 18 minutes of a
user staring at nothing — and there is no telemetry that says why**, because the only
component that could say is the Worker, and the Worker half has never produced a row (§2).
The paired `apps/code#mint` rows carry `code='unknown'` — the failure was not even classified.

---

## 4. What is still invisible — failures that produce no telemetry row at all

Do not read a quiet table as a healthy system. The following would leave no trace:

1. **Everything the Worker or the container sees.** Zero rows, ever (§2). Container boot
   failures, Xvfb/openbox crashes, neko refusing a session, sandbox start failures, TURN
   credential errors — all of it is spooled to R2 and none of it has ever reached Postgres.
   **The ~3-minute hang in §3#6 is invisible for exactly this reason.**
2. **Anything that happens after the boot trace ends.** `trace#desktop` ends at
   `display_live` / `display_unverified`. A session that connects and then dies at minute
   three writes nothing. There is no heartbeat, no session-end event, no disconnect event.
3. **Anything on a page that never loads.** The telemetry emitter is in the shell bundle
   (`app/public/os/bundle.min.js`). A failed page load, a bad deploy, a CDN 5xx, an auth
   redirect loop — none of them get far enough to emit.
4. **Every user who gave up and did not retry.** The dataset contains only sessions that
   reached the shell. `ezil_computers` has **8 rows, 5 users, and only 3 ever opened** —
   five computers were created and never used. Not one of those five non-uses produced a
   telemetry row.
5. **`computer_id` — historically NULL, now fixed, but only forward.** 92 of 101 rows have
   `computer_id IS NULL`. The 9 rows that carry one are **all post-deploy**, all from
   `u_3d037b3c`, all pointing at `3d348cd2-057b-4bae-a342-1761812000e5`. So the fix works and
   is confirmed in production — **and every historical row is permanently unjoinable to a
   machine.** No amount of new instrumentation retro-fills that.
6. **Sign-in and auth failures.** `auth.audit_log_entries` is empty (Supabase prunes it on
   managed projects). Auth-side trouble is observable only in the GoTrue log, which needs the
   dashboard's Logs Explorer or the bare access token — see §6.
7. **Whether a "success" was actually usable.** 5 of 16 successful boots were
   `display_unverified` — revealed to the user without proof that pixels arrived. If those
   users saw a black rectangle, the telemetry says `ok`.
8. **`docs/RUNBOOK.md` is stale in both directions.** Its "🔴 PENDING: `0001_telemetry.sql`
   has NOT been applied" section is false (it was applied on or before 2026-08-04), while its
   `drizzle-kit migrate` warning and its telemetry-drain OPEN OUTAGE section are both still
   accurate. A reader who trusts one part and distrusts the other will be wrong either way.
   `docs/telemetry.md:38-42` has since been corrected in-place; the RUNBOOK has not.

---

## 5. Advisors — re-run 2026-08-19

```
supabase db advisors --linked --type security    --level info
supabase db advisors --linked --type performance --level info
```

### Security — 85 findings, **zero touching an EZiL-OS table**

| level | finding | count |
|---|---|---|
| ERROR | `policy_exists_rls_disabled` | 1 |
| ERROR | `rls_disabled_in_public` | 1 |
| WARN | `function_search_path_mutable` | 43 |
| WARN | `anon_security_definer_function_executable` | 10 |
| WARN | `authenticated_security_definer_function_executable` | 10 |
| WARN | `auth_leaked_password_protection` | 1 |
| INFO | `rls_enabled_no_policy` | 19 |

Filtering every finding's JSON for `ezil_computers` or `ezil_error` returns **0 matches**.

**Both ERROR findings are the same sibling-app table and are unchanged since the prior
analysis.** `public.message_topups` has three RLS policies
(`message_topups_insert_policy`, `_select_policy`, `_update_policy`) but **RLS is not enabled**,
so the policies are inert and the table is readable through PostgREST. That table belongs to
EBuilder, not EZiL-OS, but it is a live hole in a database this project shares and the owning
team still has not been told — this is the second consecutive analysis to report it.

### Performance — 377 findings, 36 touching EZiL-OS tables, all cosmetic or minor

| level | finding | total | of which EZiL-OS |
|---|---|---|---|
| INFO | `unused_index` | 298 | 4 |
| INFO | `unindexed_foreign_keys` | 27 | **1** |
| WARN | `multiple_permissive_policies` | 26 | 24 |
| WARN | `auth_rls_initplan` | 25 | 7 |
| INFO | `no_primary_key` | 1 | 0 |

- **`unindexed_foreign_keys` on `ezil_error_events_computer_id_fkey`** — the only arguable gap
  in `0001`. Now slightly more interesting than it was: `computer_id` has just started being
  populated, so this index will start mattering the moment anyone queries by computer. At 101
  rows it still costs nothing.
- **`auth_rls_initplan` ×7** — `auth.role()` / `auth.uid()` re-evaluated per row instead of
  wrapped in `(select …)`. Standard Supabase advice; irrelevant at this volume.
- **`multiple_permissive_policies` ×24** — `ezil_computers` carries both a service-role policy
  and per-user policies. That is the intended defence-in-depth from `0000`'s own comments. The
  count of 24 is one finding × 8 database roles × 3 actions.
- **`unused_index` ×4** — `idx_ezil_error_events_fp_time_user`, `_class_time`, `_user_time`,
  `idx_ezil_error_fingerprints_class`. Expected: the only reader is `/admin/telemetry`, gated
  behind an unset email allow-list.

Total moved 374 → 377 between the prior analysis and this one; the EZiL-OS-touching count is
unchanged at 36.

---

## 6. COULD-NOT-DETERMINE

1. **Whether the eight post-deploy successes mean anything.** Eight launches by one user over
   fourteen minutes is not a sample, and one user cannot reproduce a failure that only one
   *other* user ever saw. Two of the eight were genuine cold boots in the failing band, which
   is the strongest signal available — and two is still two. The `desktop_unreachable`
   fingerprint was silent for five days (08-10 → 08-15) before this deploy too.
2. **Root cause of the ~3-minute hang (§3#6).** Six failures, ~18 minutes of user-facing dead
   time, and no evidence beyond "mint did not answer". Resolving it requires the Worker-side
   telemetry that has never produced a row. This is the largest unexplained thing in the data.
3. **Root cause of cluster A** — the four sub-10-second `mint_error`s (1.3 s, 1.5 s, 3.0 s,
   7.3 s). Fast enough to be a genuine upstream refusal rather than a timeout, but the code
   is `desktop_unreachable` for all of them, which does not distinguish "the Worker said no"
   from "the probe said no". `detail` is NULL on every row.
4. **Whether the TURN/relay path ever actually caused a failure.** The `display_unverified`
   rate (31%) is consistent with it and nothing more. Nothing in the schema records ICE
   candidate type, connection state, or DTLS timing. To settle it, the shell would have to
   emit `RTCPeerConnection.getStats()` candidate-pair type on the display gate's verdict.
5. **The current R2 spool depth.** R2 is not reachable from the Supabase management API. The
   173 objects / 467 kB figure is quoted from `docs/telemetry.md` and may be stale.
6. **Why the drain has never run.** `docs/RUNBOOK.md:79-97` lists three candidates (drain
   secret, R2 binding, cron trigger) and explicitly says to diagnose rather than assume. I did
   not diagnose it — it is a Worker/Vercel question, not a database one — and today's
   `d00c684` addresses a different bug.
7. **Postgres/PostgREST/GoTrue server logs.** The CLI at 2.109.0 has no `logs` subcommand and
   the Management API's `analytics/endpoints/logs.*` route needs the bare personal access
   token, which the rules forbid extracting. Sign-in failures in particular are unobservable
   from SQL (`auth.audit_log_entries` is empty).
8. **Whether `u_3d037b3c` is a real new user or another test identity.** `user_hash` is
   designed to make this unanswerable from telemetry alone, and correctly so.
9. **What HTTP status neko actually returned to the eleven failed `screen_upstream` calls.**
   The shell's `onFailure` handler captures only `code`; `detail` and `duration_ms` are NULL on
   every row. `worker/src/index.ts:4869` builds `screen_upstream_<status>` with the real status
   embedded, but the shell collapses it to the bare `screen_upstream` before emitting. Whoever
   fixes this regression will need `wrangler tail`, not the telemetry table — which is itself
   an instance of §4's point.
10. **Whether the prod/local gap explains anything for a second user.** Every single failure
   fingerprint in this dataset has one or two distinct users. **There is no observation in this
   database of two independent people hitting the same failure.** Everything in §3 is an
   explanation of one person's experience, generalised on the strength of the code, not the data.

---

## 7. Method

- `supabase db query --linked` and `supabase db advisors --linked` via the Management API,
  from a throwaway scratch link outside the repo. No `psql`, no database password.
- **Never run:** `db push`, `db pull`, `db diff`, `db reset` — none are schema-scoped and
  `reset` issues `DROP SCHEMA … CASCADE` against a database shared with three other apps.
- **Nothing was written to the database.** No token, password or connection string was read,
  printed, logged or stored.
- One gotcha for whoever queries next: the Management API's SQL endpoint rejects `day` as a
  bare column alias (`syntax error at or near "day"`). Use `as d` or quote it.
- Query window 12:34–12:44 UTC on 2026-08-19. Events were still arriving during it — the
  totals moved from 92 to 101 mid-analysis. Anything in this document is a snapshot at
  **12:53:28 UTC**, and the table was still receiving rows at that moment.
