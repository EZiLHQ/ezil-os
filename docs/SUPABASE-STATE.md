# Supabase — live state as of 2026-08-19

Written by W11 during the Browser-fix effort, against the **live** system, using the
authenticated Supabase CLI (v2.109.0). Every number below came from a query run this
session; the query is shown next to its result. Nothing here is carried forward from an
earlier document.

> **Headline, and it contradicts two of our own docs.** `app/drizzle/0001_telemetry.sql`
> **has already been applied.** The three telemetry tables exist, they are correctly
> shaped, and they hold **real production error data going back to 2026-08-04**.
> `docs/RUNBOOK.md`'s "🔴 PENDING" section and `docs/telemetry.md:38-42` ("nothing is
> stored") are **STALE**. W11 therefore applied nothing — see §4.

---

## 1. Which project EZiL-OS uses

**`btgqfmnzycdecmeyqubx` — "EZiL App", region `ap-northeast-1`, Postgres 17.6.1.141.**

The org `wmryhsskhwhqnmvmfgnf` has two ACTIVE_HEALTHY projects and neither is named after
this repo, so identity was established by schema, not by name.

### How it was concluded

`app/drizzle/0000_massive_mole_man.sql` creates exactly **one** table — `ezil_computers`.
That table is the discriminator. Both projects were linked in a throwaway workdir (see §7)
and asked the same question:

```sql
select table_schema, table_name from information_schema.tables
where table_name in ('ezil_computers','ezil_error_events',
                     'ezil_error_fingerprints','ezil_error_user_hours')
order by 1,2;
```

| project | ref | result |
|---|---|---|
| `ezil` | `curomaahbwlrddzijatd` (ap-south-1) | **0 rows** |
| `EZiL App` | `btgqfmnzycdecmeyqubx` (ap-northeast-1) | **4 rows** — all four, all in `public` |

Presence alone would be weak evidence, so it was corroborated against the *specific,
unusual* details `0000` documents about itself:

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid='public.ezil_computers'::regclass order by conname;
```
```
ezil_computers_pkey         | PRIMARY KEY (id)
ezil_computers_slot_chk     | CHECK ((slot = ANY (ARRAY[1, 2])))
ezil_computers_user_id_fkey | FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE CASCADE
```

That is an exact match for `0000`, **including** the two things `0000`'s own comments call
out as hand-made and non-default: the constraint is named `..._user_id_fkey` (Postgres's
default) rather than drizzle-kit's `..._users_id_fk`, and it points at `auth.users(id)`
rather than `public.users`. The eight columns match `0000` in order, type, nullability and
default. This is EZiL-OS's database.

The other project (`curomaahbwlrddzijatd`, confusingly the one *named* `ezil`) holds
`agent_*` and `marketing_*` tables — 12 tables, a different application entirely.

### The stale pointer, and the shared database

`/data/openclaw/projects/ezil/supabase/.temp/` points at `btgqfmnzycdecmeyqubx`. That
happens to be the **right** ref, but it belongs to a sibling checkout and is not evidence
about EZiL-OS; the identification above does not rest on it.

This database is genuinely **shared**, which is why "the right schema" had to be
established rather than assumed. It contains 13 schemas —
`ezil_universe`, `ezil_universe_test`, `ezil_works`, `public`, plus the Supabase-managed
ones — and dedicated roles `ezil_universe_app` and `ezil_works_app`. The `public` schema
alone holds **43 tables**, of which EZiL-OS owns exactly **four**: `ezil_computers` and the
three telemetry tables. Tables such as `ezil_desktop_sessions`, `projects`, `canvas`,
`subscriptions` and `razorpay_subscriptions` in the same schema belong to EBuilder, not to
this repo. `ezil_desktop_sessions` in particular has an `hmac_secret` column and was
deliberately not read.

---

## 2. State of `0001_telemetry.sql` — it is applied

### Before (this session, before any write)

All three tables present, populated, and being actively maintained.

```sql
select relname, seq_scan, idx_scan, n_tup_ins, n_tup_del, n_live_tup,
       last_autovacuum, last_analyze
from pg_stat_user_tables where schemaname='public'
  and relname in ('ezil_computers','ezil_error_events',
                  'ezil_error_fingerprints','ezil_error_user_hours');
```
```
relname                 | n_tup_ins | n_tup_del | n_live_tup | last_autovacuum
------------------------+-----------+-----------+------------+------------------------------
ezil_computers          |        13 |         2 |          7 | 2026-07-31 18:34:26.842376+00
ezil_error_events       |       199 |       109 |         84 | 2026-08-19 03:44:19.539612+00
ezil_error_fingerprints |       113 |         0 |        113 | 2026-08-15 14:38:33.363107+00
ezil_error_user_hours   |       155 |         0 |        155 | (null)
```

**199 real inserts** into `ezil_error_events`, **109** of them since deleted. That deletion
count is the 14-day retention job (`app/src/server/telemetry/retention.ts`) doing its work:
the oldest surviving raw row is `2026-08-05 09:52:42+00`, and 14 days before the moment of
query (`2026-08-19 07:25:46+00`) is `2026-08-05 07:25`. The autovacuum stamp of
**03:44 this morning** says the cron ran hours ago. The ingest path is not merely wired up —
it is live, writing, and being reaped on schedule.

### Structural verification against the file

```sql
select t.table_name,
  (select count(*) from information_schema.columns c
     where c.table_schema='public' and c.table_name=t.table_name) as cols,
  (select relrowsecurity from pg_class where oid=('public.'||t.table_name)::regclass) as rls,
  (select count(*) from pg_policies p
     where p.schemaname='public' and p.tablename=t.table_name) as policies,
  (select count(*) from pg_indexes i where i.schemaname='public'
     and i.tablename=t.table_name and i.indexname not like '%_pkey') as idx,
  (select count(*) from pg_constraint k
     where k.conrelid=('public.'||t.table_name)::regclass and k.contype='c') as checks,
  (select count(*) from pg_constraint k
     where k.conrelid=('public.'||t.table_name)::regclass and k.contype='f') as fks
from information_schema.tables t
where t.table_schema='public' and t.table_name like 'ezil_error%' order by 1;
```
```
table_name              | cols | rls  | policies | idx | checks | fks
------------------------+------+------+----------+-----+--------+----
ezil_error_events       |   16 | True |        1 |   4 |      3 |   1
ezil_error_fingerprints |   11 | True |        1 |   2 |      0 |   0
ezil_error_user_hours   |    4 | True |        1 |   1 |      0 |   1
```

Totals: **3 tables, RLS enabled on all three, 3 policies, 7 non-PK indexes, 3 CHECK
constraints, 2 foreign keys.** That is, item for item, exactly what `docs/RUNBOOK.md` says
the throwaway Postgres 17.6 container produced. Spot checks confirmed the details rather
than just the counts:

- Policies are all `FOR ALL USING (auth.role() = 'service_role')`, named
  `Service role full access error events` / `... error fingerprints` / `... error user hours` —
  service-role-only, no `authenticated` policy, as designed.
- CHECKs are `fingerprint ~ '^fp_[0-9a-f]{16}$'`, `user_hash ~ '^u_[0-9a-f]{8}$'`, and
  `outcome in ('ok','error','skipped')`.
- FKs are `ezil_error_events.computer_id → ezil_computers(id)` and
  `ezil_error_user_hours.fingerprint → ezil_error_fingerprints(fingerprint)`, both
  `ON UPDATE CASCADE ON DELETE CASCADE`.
- Column lists match `0001` exactly in name and order (16 / 11 / 4).

### When it was applied, and by what route

Best available evidence puts it at or just before **2026-08-04 04:34:32 UTC** — the
`min(first_seen_at)` in `ezil_error_fingerprints`. That is a *lower bound proxy*, not a
creation timestamp; Postgres does not record when a table was created.

It was **not** applied by `drizzle-kit migrate`. The `drizzle.__drizzle_migrations` journal
table now exists live but is **empty (0 rows)** — precisely the fingerprint of the failure
`docs/RUNBOOK.md` describes: `migrate` creates its journal table, then replays
`0000_massive_mole_man.sql`, dies on `relation "ezil_computers" already exists`, and rolls
back the migration while the journal table itself survives. So that RUNBOOK warning is
**still accurate and still current** — `drizzle-kit migrate` remains broken against this
database.

The likely route is `app/scripts/apply-telemetry-migration.mjs` (`npm run db:apply-0001`),
which the RUNBOOK documents as the safe idempotent path, run from a Vercel build where the
real environment exists. **COULD-NOT-DETERMINE:** who ran it, when exactly, and by which of
those routes. Nothing in the database records the applying principal, and the CLI's
management surface exposes no migration-history log for a non-branch project.

---

## 3. Are users hitting errors? — yes, and here is exactly what

The user asked to check the logs to find whether certain users are having trouble. Because
the telemetry tables turned out to be live, this is answerable from real data rather than
from proxies.

**The honest scale first: this product has barely been used, and one person is almost all
of it.**

```sql
select user_hash, count(*) as events, count(*) filter (where outcome='error') as errors,
       min(occurred_at)::date, max(occurred_at)::date
from ezil_error_events group by 1 order by events desc;
```
```
user_hash  | events | errors | first      | last
-----------+--------+--------+------------+-----------
u_1f6e8a50 |     82 |     47 | 2026-08-05 | 2026-08-15
u_eb38f108 |      1 |      0 | 2026-08-09 | 2026-08-09
u_ce8231b3 |      1 |      0 | 2026-08-05 | 2026-08-05
```

**Three distinct users have ever produced a telemetry event, and one of them accounts for
82 of 84 rows and 100% of the errors.** Every single error fingerprint has
`distinct_users = 1`. So the framing "certain users are having trouble" does not hold up:
there is essentially *one* user's experience in this dataset, and it is very likely the
owner's own testing. (`user_hash` is the designed-safe pseudonym per `docs/telemetry.md`;
no account id or email is stored or shown.)

**With that caveat stated, the failures that user hit are real and directly relevant to the
Browser-fix effort.**

### The dominant failure: the desktop does not come up, and it takes ~32s to say so

All-time via the 90-day rollup (survives the 14-day raw-row retention):

```sql
select f.site, f.code, sum(h.event_count) as events, count(distinct h.user_hash) as users,
       min(h.hour_bucket)::date, max(h.hour_bucket)::date
from ezil_error_user_hours h join ezil_error_fingerprints f using (fingerprint)
where f.site='ezil-os:trace#desktop' group by 1,2 order by 3 desc;
```
```
site                  | code    | events | users | first_day  | last_day
----------------------+---------+--------+-------+------------+-----------
ezil-os:trace#desktop | ok      |     15 |     3 | 2026-08-04 | 2026-08-15
ezil-os:trace#desktop | error   |     10 |     1 | 2026-08-08 | 2026-08-10
ezil-os:trace#desktop | skipped |      1 |     1 | 2026-08-05 | 2026-08-05
```

**10 of 26 desktop launches failed — 38%** — all on 2026-08-08 to 2026-08-10, all one user.
Paired one-for-one with `ezil-os:apps/desktop#mint` / `desktop_unreachable` (10) and
`ezil-os:session#openDesktop` / `auto_retry_desktop_unreachable` (10) — so **the automatic
retry failed too, every time.**

The `attrs.phases` breadcrumb says where the time went:

```
{"phases": "launch_start:0,open_resolved:12,drawer_ready:13,mint_error:32773", "total_ms": 32773}
{"phases": "launch_start:0,open_resolved:57,drawer_ready:58,mint_error:34625", "total_ms": 34625}
{"phases": "launch_start:0,open_resolved:126,drawer_ready:127,mint_error:34163","total_ms": 34164}
```

The shell resolves and draws in **~12–130 ms**, then sits on the mint call for
**32–35 seconds** before it errors. That is a timeout, not a fast rejection. Some failures
were fast (`mint_error:1293`, `mint_error:1531`, `mint_error:2993`) — those look like a
genuine upstream refusal — but the ~32–34 s cluster is a hang.

For contrast, the **successful** desktop boots averaged **27.9 s** and reached **80.2 s**
at worst. A user cannot tell a 28-second success from a 33-second failure while it is
happening; both are just a long blank wait. That is worth knowing for the boot-phase work.

### The `code` app hangs far worse — over three minutes

```
site                | outcome | n  | avg_ms  | max_ms
--------------------+---------+----+---------+--------
ezil-os:trace#code  | ok      | 11 |  18,164 |  39,591
ezil-os:trace#code  | error   |  4 | 186,829 | 188,825
ezil-os:trace#code  | skipped |  2 |  76,917 |  87,248
```

`{"phases": "launch_start:0,open_resolved:55,mint_error:188825"}` — the `code` app's mint
hung for **188 seconds** before failing, with `ezil-os:apps/code#mint` reporting
`code=unknown` (i.e. the failure was not even classified). Three-plus minutes of nothing.

### Everything else, in full

```
site                                  | code                           | outcome |  n | users
--------------------------------------+--------------------------------+---------+----+------
ezil-os:session#openDesktop           | auto_retry_desktop_unreachable | error   | 10 |     1
ezil-os:trace#desktop                 | error                          | error   | 10 |     1
ezil-os:apps/desktop#mint             | desktop_unreachable            | error   | 10 |     1
ezil-os:apps/code#mint                | unknown                        | error   |  7 |     1
ezil-os:trace#code                    | error                          | error   |  4 |     1
ezil-os:apps/desktop#mint             | unknown                        | error   |  3 |     1
ezil-os:trace#code                    | skipped                        | skipped |  2 |     1
ezil-os:trace#preview                 | error                          | error   |  1 |     1
ezil-os:apps/preview#confirmFrame     | frame_not_answering            | error   |  1 |     1
ezil-os:settings/troubleshoot#restart | fetch_failed                   | error   |  1 |     1
ezil-os:trace#desktop                 | skipped                        | skipped |  1 |     1
```

Also present all-time in the rollup: one `crash` at `ezil-os:window#onerror`, one
`unauthorized` at `apps/desktop#mint`, one `frame_not_answering` at `apps/code#confirmFrame`.
`ezil-os:trace#settings` is the one app that never failed — 12 boots, all ok, **avg 15 ms**.

### Two things the data does *not* contain

- **No Worker or container telemetry, ever.** All 113 fingerprints and all 193 recorded
  occurrences are `source = 'shell'`. Zero rows from `worker` or `container`. Either those
  producers have never fired, or their path to ingest does not work. Worth W10 knowing:
  **the browser half of the pipeline is proven in production; the Worker half is not.**
- **`computer_id` is NULL on all 84 rows** (`count(distinct computer_id) = 0`). Consistent
  with `docs/telemetry.md` for Worker/container rows, but these are *shell* rows, which that
  document says do fill it in. Unexplained — see §6.

### Synthetic rows — do not read them as user pain

94 of the 113 fingerprints (95 of 193 occurrences) are from sites matching
`ezil-os:verify/%` — `ezil-os:verify/tv1-load` (`load 13` … `load 36`) and
`ezil-os:verify/tv3`. These are a load/verification harness, all dated 2026-08-04, the day
the migration went in. Excluding them leaves **19 real fingerprints / 98 occurrences**,
which is what §3 reports throughout.

---

## 4. What W11 wrote to the database: nothing

The brief authorised exactly one write — applying `0001_telemetry.sql` — conditional on
first confirming the tables did not exist. **They do exist**, with correct structure and
84/113/155 rows of live data, so the migration was **deliberately not run**.

Re-running it would at best abort on `relation "ezil_error_events" already exists`, and any
attempt to force it past that would destroy real collected telemetry. The correct action on
finding the work already done is to do nothing and say so.

The reversal documented in `docs/RUNBOOK.md` was **not** used and is not needed. Recording
it here only so nobody has to go looking: it is three `DROP TABLE` statements in FK order
(`ezil_error_user_hours`, then `ezil_error_events`, then `ezil_error_fingerprints`).

**Two documents need correcting** (W11 does not own either file, so this is a request, per
the contract's §9):

- `docs/RUNBOOK.md:27-78` — the "🔴 PENDING: `0001_telemetry.sql` has NOT been applied"
  section is false as of 2026-08-19. Its `drizzle-kit migrate` warning further down is
  still true and should stay.
- `docs/telemetry.md:38-42` — "**Not collected yet at all** … nothing is stored" is false.
  Data has been collected since 2026-08-04.
- `docs/BROWSER-FIX-CONTRACT.md` §8's sentence "Everything above is written to a table that
  does not exist yet … W11 applies it" is also false, but that file is PINNED and read-only;
  flagging only.

---

## 5. Advisors

Run with `supabase db advisors --linked --type security|performance --level info`.

**Security: 85 findings, and not one of them touches an EZiL-OS table.**

| level | finding | count |
|---|---|---|
| ERROR | `policy_exists_rls_disabled` | 1 |
| ERROR | `rls_disabled_in_public` | 1 |
| WARN | `function_search_path_mutable` | 43 |
| WARN | `anon_security_definer_function_executable` | 10 |
| WARN | `authenticated_security_definer_function_executable` | 10 |
| WARN | `auth_leaked_password_protection` | 1 |
| INFO | `rls_enabled_no_policy` | 19 |

Both ERROR-level findings are the same table, `public.message_topups` — RLS policies exist
on it but RLS is **not enabled**, so the policies do nothing and the table is readable
through PostgREST. That is an **EBuilder** table, not EZiL-OS's, but it is a live hole in a
database this project shares and the owning team should be told. The 19
`rls_enabled_no_policy` INFO findings are likewise all EBuilder tables (`branches`,
`conversations`, `deployments`, `payments`, `subscriptions`, …).

Filtering the findings for `ezil_computers` or `ezil_error_*` returns **0 rows**. EZiL-OS's
own four tables are clean.

**Performance: 374 findings, 36 of which touch EZiL-OS tables — all cosmetic or minor.**

| level | finding | count |
|---|---|---|
| INFO | `unused_index` | 296 |
| INFO | `unindexed_foreign_keys` | 26 |
| WARN | `multiple_permissive_policies` | 26 |
| WARN | `auth_rls_initplan` | 25 |
| INFO | `no_primary_key` | 1 |

The EZiL-OS ones, worth exactly the weight given here:

- **`unindexed_foreign_keys` on `ezil_error_events_computer_id_fkey`** — the only finding
  that is arguably a real gap in `0001`. The migration creates seven indexes and none
  covers `computer_id` alone, so a cascading delete of an `ezil_computers` row has to seq-scan
  the events table. At 84 rows this costs nothing; it is noted, not recommended as urgent.
- **`auth_rls_initplan` ×8** — the `auth.role()` / `auth.uid()` calls in our policies are
  re-evaluated per row rather than wrapped in `(select …)`. Standard Supabase advice, real
  at scale, irrelevant at 7 and 84 rows.
- **`multiple_permissive_policies` ×24** — `ezil_computers` has both a service-role policy
  and per-user policies for the same action. This is the intended defence-in-depth design
  that `0000`'s own comments describe, not a defect. The 24 count is just one finding
  multiplied across 8 database roles × 3 actions.
- **`unused_index` ×4** — four of the telemetry indexes have never been scanned. Expected:
  the only reader is `/admin/telemetry`, which is gated behind an unset email allow-list and
  so has effectively never been opened.

---

## 6. Real usage — how much has this actually been used

```sql
select count(*) total, count(*) filter (where deleted_at is null) live,
       count(distinct user_id) users, count(*) filter (where last_opened_at is not null) ever_opened,
       min(created_at)::date, max(created_at)::date, max(last_opened_at)
from ezil_computers;
```
```
total | live | soft_deleted | distinct_users | ever_opened | first_created | last_created | most_recent_open
------+------+--------------+----------------+-------------+---------------+--------------+------------------------------
    7 |    6 |            1 |              4 |           3 | 2026-07-31    | 2026-08-09   | 2026-08-02 13:23:57.043+00
```

**Seven computer rows, four distinct users, three ever opened.** Four of the seven have
`last_opened_at = NULL` — created and never used.

`auth.users` holds **85** accounts (82 with a sign-in, newest signup and most recent
sign-in both today, 2026-08-19) — but that is the **shared** auth pool for EBuilder,
EZiL-Universe and EZiL-Works. Only **4 of those 85** have ever created an EZiL-OS computer.
Do not read 85 as an EZiL-OS user count.

**On the two "last used" dates, which disagree and both are right.** `max(last_opened_at)`
is 2026-08-02, but telemetry shows successful app boots through 2026-08-15.
`lastOpenedAt` is stamped only by `app/src/app/computer/[id]/page.tsx:44` — the
`/computer/<id>` route. The later activity is `/os` shell sessions, which do not pass
through that route. So: **the last time anyone opened a computer via `/computer/<id>` was
2026-08-02; the last time anyone used the shell was 2026-08-15 14:45 UTC.** Four days of
silence since.

This also means `sandbox-reap`'s staleness query, which keys on `last_opened_at IS NOT NULL`,
sees only three of the seven computers at all — noted in passing, not investigated.

Database health, whole instance (shared, so not attributable to EZiL-OS):

```
datname  | xact_commit | xact_rollback | deadlocks | conflicts | blks_hit | blks_read | stats_reset
---------+-------------+---------------+-----------+-----------+----------+-----------+------------------------------
postgres |   2,842,511 |         1,723 |         0 |         0 | 57.7 M   |     2,398 | 2026-06-30 00:57:20.337617+00
```

Rollback rate **0.06%**, zero deadlocks, zero conflicts, ~100% buffer cache hit rate since
2026-06-30. Nothing here suggests users are hitting database-level trouble.

---

## 7. Method, and what it cost

- The CLI was already authenticated. The personal access token was **never** read, printed,
  copied, or passed on a command line; no attempt was made to extract it from the CLI's
  credential store, and one attempt to inspect the CLI binary was blocked by policy and not
  worked around.
- No `psql`, no `SUPABASE_DATABASE_URL`, no database password — none were available and
  none were needed.
- Both projects were linked in **throwaway workdirs under the session scratchpad**, not in
  this repo, so no Supabase state was written into `EZiL-OS/`.
- **Never run** in line with the standing rule: `supabase db push`, `db pull`, `db diff`,
  `db reset`. None are schema-scoped and `db reset` issues `DROP SCHEMA … CASCADE`.

**What worked:**

| path | verdict |
|---|---|
| `supabase projects list` | works |
| `supabase link --project-ref <ref> --yes` | works, no DB password needed |
| `supabase db query --linked "<sql>"` | **works** — arbitrary read SQL via the Management API. The workhorse for everything above. |
| `supabase db advisors --linked --type security\|performance` | works |
| `supabase inspect db table-stats --linked` | works (and is how the shared-database picture was first seen) |

**What did not:**

| path | verdict |
|---|---|
| direct `psql` | no credential, not attempted |
| `supabase logs` / `functions logs` | **no such command in CLI 2.109.0** |
| raw Management API via `curl` | would need the bare token; deliberately not attempted |

---

## 8. COULD-NOT-DETERMINE — with reasons

1. **The Logflare-backed logs: Postgres server log, PostgREST/API log, GoTrue auth log.**
   The CLI at 2.109.0 exposes no `logs` subcommand, and the Management API's
   `/analytics/endpoints/logs.*` route needs the bare personal access token, which lives in
   the CLI's private credential store and which the rules forbid extracting. **This is the
   one item the user explicitly asked for that was not delivered.** To get it, either run
   in the Supabase dashboard (Logs Explorer), or run locally with the token in the
   environment:
   `curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" 'https://api.supabase.com/v1/projects/btgqfmnzycdecmeyqubx/analytics/endpoints/logs.all?sql=<urlencoded>'`
   The in-database substitutes used instead (§2, §6) do cover error/rollback/deadlock rates
   and table-level activity, and they show nothing alarming.
2. **`auth.audit_log_entries` is empty — 0 rows, no min/max.** Supabase prunes it on
   managed projects. So sign-in failures and auth-side user trouble are **not** observable
   from SQL here; that evidence only exists in the GoTrue log covered by item 1.
3. **Who applied `0001`, exactly when, and by which route.** Nothing records the applying
   principal; `drizzle.__drizzle_migrations` is empty. Best proxy is
   `min(first_seen_at) = 2026-08-04 04:34:32 UTC`.
4. **Why `computer_id` is NULL on all 84 shell-sourced rows** when `docs/telemetry.md` says
   the browser fills it in. Establishing this needs a read of the shell's telemetry emit
   path, which is W10's file and outside W11's remit. Consequence, and it matters: **error
   events cannot currently be joined to a specific computer**, so "which machine was this"
   is unanswerable from the data as stored.
5. **Whether the ~32–34 s `desktop_unreachable` timeouts were the container failing to boot,
   the Worker refusing, or the TURN/WebRTC path failing.** The shell only records that mint
   did not answer. Resolving it needs the Worker-side telemetry that has never produced a
   row (§3), or the container log route W10 is adding.
6. **Whether the 2026-08-08→10 desktop failures are still reproducible.** The last
   telemetry of any kind is 2026-08-15 14:45 UTC — nothing has exercised the system in four
   days, so the current state is untested, not proven good.
7. **`max_instances`**, still carried as unverified from `docs/RUNBOOK.md`. Not a database
   value; not checkable from here.

---

## 9. What this means for the Browser-fix effort

- **The premise of §8 of the contract is out of date in the team's favour.** Telemetry is
  not write-only. The new `site` values W1–W10 are adding will land in a real table and be
  readable the moment they deploy. "I added telemetry" now can mean "we can see it" — for
  shell-sourced events.
- **But only for shell-sourced events.** Zero Worker or container rows have ever arrived.
  Before anyone relies on `container:neko#decor` or `container:neko#xserver`, that producer
  needs proving end-to-end — it has never once worked in production.
- **`/admin/telemetry` will work now**, and its email allow-list is unset, so it is
  currently unreachable by anyone. Setting it is a one-variable change that turns 84 rows of
  real data into something the owner can look at.
- **There is a real, recorded, 38%-failure desktop boot path** with a ~32 s timeout
  signature, plus a `code`-app mint that hung for 188 s. That is the closest thing to a
  reproduction the team has, and it predates all twelve agents' changes.
