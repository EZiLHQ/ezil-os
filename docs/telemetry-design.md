# EZiL-OS fleet crash telemetry — design

Status: DESIGN ONLY. No production code written. Target: three parallel workers
(worker-side, shell-side, app-side) implement against this without talking.

Repo state observed at authoring: `main` @ `a568b5a`, tree clean.
Bindings available to the Worker: Durable Objects + R2 only. Aggregation store:
the existing Supabase Postgres reached through Drizzle at `app/src/server/db/`.
**No new infrastructure is introduced by this design.**

§2's normaliser was validated by a throwaway prototype at authoring time
(7/7 assertions). The behaviour it pinned is now covered by
`app/src/server/telemetry/fingerprint.test.ts`, which is the authority.

---

## 0. Ground truth I measured myself

| Claim in the brief | What I observed | Verdict |
| --- | --- | --- |
| Worker emits structured JSON with `schemaVersion` + hashed `userHash` | `worker/src/observability.ts` — `LOG_SCHEMA_VERSION = 1`, `LogEvent`, `safeUserHash()` (FNV-1a → `u_xxxxxxxx`), `sanitizeErrorMessage()`, `classifyError()`, `LifecycleTimeline` | CONFIRMED |
| "~25 `console.error` across 7 files" | **35 call sites across 11 files** (`grep -c` excluding `shell/src/lib/` vendored jQuery and `node_modules`). 29 of them across 9 files are EZiL-authored under `shell/ezil/`; the other 6 across 2 files are Puter-derived under `shell/src/`. | CORRECTED (undercount) |
| Worker has 25 lifecycle emit sites | `grep -c 'tl\.\(event\|stage\)' worker/src/index.ts` → 25, across 25 distinct `sandbox.*` event names | CONFIRMED |
| Container boot phases already exist | `worker/scripts/start-neko.sh` already emits `[ezil-boot] +<N>ms phase=<name> event=start\|end status=<s> phase_ms=<n> cumulative_ms=<n>`. 11 phase names: `container_start`, `workspace_hydration`, `xvfb`, `openbox`, `devserver_launch`, `codeserver_launch`, `chrome_launch`, `stale_boot_reclaim`, `window_ready_gate`, `neko_serve_bind`, `ready` | CONFIRMED — **do not invent a new phase vocabulary, adopt this one** |
| There is a global crash handler | **There is not.** No `window.onerror`, no `unhandledrejection` listener anywhere in `shell/ezil/` or `app/src/app/os/`. Uncaught shell exceptions are currently invisible. | GAP |
| There is any scheduled-job infrastructure | **None.** No `vercel.json`, no `triggers.crons` in `worker/wrangler.jsonc`. Retention needs one to be added (§7). | GAP |

Two vocabularies already exist and are reused verbatim rather than re-invented:
`GuacamolePreviewErrorCode` (14 members, `app/src/server/lib/cloudflare-guacamole-provider.ts:242`)
and `BOOT_FAILURE_COPY`'s keys (`worker_unreachable`, `sandbox_crashed`,
`desktop_unreachable`, `display_not_streaming`, `timeout`, `unknown`).

---

## 1. Event taxonomy

One row per event. Nine classes, closed set. `source` ∈ `shell | app | worker | container`.

| class | source(s) | when | REQUIRED fields | optional fields |
| --- | --- | --- | --- | --- |
| `boot_phase` | container | one row per **failed** phase, from `start-neko.sh`'s `phase=… event=end status≠ok` | `site`(=phase name), `code`, `outcome`, `duration_ms` | `detail`, `sandbox_id` |
| `boot_summary` | container | exactly one row per container boot, ok or not — the **denominator** for boot-phase failure rates | `site`(=`ready`), `outcome`, `duration_ms`, `attrs.phases[]` | `detail` |
| `boot_stall` | shell | `boot.js` `give_up()` (`shell.stalled` set) | `site`, `code`(=reason), `duration_ms` | `detail` |
| `crash` | shell | NEW global `window.onerror` + `unhandledrejection` (§5.1) | `site`, `code`, `detail` | `attrs.stack_head` |
| `window_error` | shell | an app/window failed to open or a handler threw | `site`, `code` | `detail`, `attrs.app_id` |
| `api_failure` | shell, app | a `/api/shell/*` or Worker call returned `ok:false`/non-2xx/threw | `site`, `code`, `outcome`(=`error`) | `duration_ms`, `attrs.status` |
| `display_failure` | shell | WebRTC/display gate: `confirmFrame` unanswered, nothing watching, `display_not_streaming` | `site`, `code` | `duration_ms`, `attrs.seen` |
| `worker_exception` | worker | any `LifecycleTimeline` event with `outcome:'error'`, plus a top-level `fetch()` catch | `site`(=`event` name), `code`, `outcome` | `duration_ms`, `detail`, `correlation_id` |
| `contract_violation` | shell | an invariant the code already refuses to proceed on — "returned ok with no URL", "UIWindow returned nothing", "no such app", removed-backend stubs | `site`, `code` | `detail` |

### 1.1 Every existing `console.error` site, mapped

These are additions **alongside** the `console.error`, never replacements — the
console line stays for local debugging. 35 sites:

| file (`shell/`) | n | class | `code` |
| --- | --- | --- | --- |
| `ezil/session.js` | 2 | `contract_violation` | `preview_url_missing`, `app_preview_url_missing` |
| `ezil/apps/preview.js` | 4 | `contract_violation` ×1 (`no_computer_in_payload`), `window_error` ×1 (`uiwindow_returned_nothing`), `api_failure` ×1 (`code` = the live `res.errorCode`), `display_failure` ×1 (`frame_not_answering`) |
| `ezil/apps/code.js` | 5 | same four as `preview.js` + `contract_violation` (`code_preview_url_missing`) |
| `ezil/apps/desktop-window.js` | 6 | as `preview.js` + `display_failure` (`no_watcher`) + `window_error` (`drawer_attach_failed`) |
| `ezil/apps/registry.js` | 2 | `contract_violation` (`unknown_app`), `window_error` (`app_open_threw`) |
| `ezil/boot.js` | 3 | `boot_stall` (`code` = `reason`), `window_error` (`mount_failed`) ×2 |
| `ezil/ui/app-drawer.js` | 2 | `contract_violation` (`null_window`), `window_error` (`drawer_handler_threw`) |
| `ezil/ui/Settings/index.js` | 3 | `window_error` (`uiwindow_returned_nothing`, `tab_activate_threw`, `tab_init_threw`) |
| `ezil/ui/Settings/drawer-action.js` | 2 | `window_error` (`collapse_threw`, `settings_handler_threw`) |
| `src/ezil-stubs.js` | 4 | `contract_violation` (`removed_backend`; the stub name goes in `site`, **not** `code`, so all four roll up as one class but stay separable) |
| `src/UI/UIWindow.js` | 2 | `window_error` (`app_launch_failed`), `window_error` (`sidebar_order_save_failed`) |

`worker/src/index.ts`'s 25 `tl.event`/`tl.stage` sites need **no new call sites
at all** — §4.1 changes only the sink.

### 1.2 The wire type (identical on all three sources)

```ts
/** app/src/server/telemetry/types.ts — the single shared contract. */
export const TELEMETRY_SCHEMA_VERSION = 1; // mirrors LOG_SCHEMA_VERSION's discipline

export const EVENT_CLASSES = [
  'boot_phase', 'boot_summary', 'boot_stall', 'crash', 'window_error',
  'api_failure', 'display_failure', 'worker_exception', 'contract_violation',
] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export const SOURCES = ['shell', 'app', 'worker', 'container'] as const;
export type Source = (typeof SOURCES)[number];

export type Outcome = 'ok' | 'error' | 'skipped'; // reuse worker/src/observability.ts

/** What a client PUTS ON THE WIRE. Note what is absent: no userId, no
 *  fingerprint, no URL, no email, no stack beyond `attrs.stack_head`. */
export interface TelemetryEventInput {
  /** Client-generated UUIDv4. The idempotency key — a re-sent batch is a no-op. */
  eventId: string;
  schemaVersion: number;
  eventClass: EventClass;
  source: Source;
  /** Client's clock, ISO-8601. Advisory only; the server also stamps its own. */
  occurredAt: string;
  /** LOGICAL origin, never a file:line. `ezil-os:apps/preview#mint`,
   *  `sandbox.preview.desktop_ready`, `workspace_hydration`. Closed-ish set,
   *  low cardinality by construction. Max 96 chars. */
  site: string;
  /** Typed low-cardinality code. Produced by `classifyError()` on the worker
   *  side and by a literal at every shell site. Max 64 chars, `[a-z0-9_]+`. */
  code: string;
  outcome: Outcome;
  /** Already run through `sanitizeErrorMessage()` BY THE PRODUCER. Max 200. */
  detail?: string;
  durationMs?: number;
  /** Groups every event of one page-load / one Worker request. */
  correlationId?: string;
  /** Non-sensitive opaque id. Safe: it is a random id, joins to nothing outside
   *  our own DB, and the row is already scoped to its owner. */
  computerId?: string;
  /** Bounded allow-listed extras. Schema per class, §8. NEVER free-form. */
  attrs?: Record<string, string | number | boolean>;
}

export interface TelemetryBatch {
  schemaVersion: number;
  /** Max 50. Longer batches are truncated server-side, not rejected. */
  events: TelemetryEventInput[];
}
```

**Required-vs-optional is enforced in exactly one place**: the zod schema in
`app/src/server/telemetry/schema.ts`, used by the HTTP route AND by the R2
drainer. A field failing validation drops **that event**, never the batch.

---

## 2. The fingerprint

> Two users hitting the same bug must produce the same fingerprint despite
> different sandbox ids, URLs, timestamps and stack line numbers.

### 2.1 Where it is computed

**Server-side only, at ingest, in `app/src/server/telemetry/fingerprint.ts`.**
Clients never send a fingerprint and are never trusted with one. This is the
single most important structural decision here: shell events, Worker events
spooled through R2, and app-server events all pass through the same function,
so a shell `sandbox_start_failed` and a Worker `sandbox_start_failed` at the
same `site` are guaranteed byte-identical fingerprints. A client-computed
fingerprint would drift across the three codebases within a release.

### 2.2 The rule

```
fingerprint = 'fp_' + sha256(
    eventClass + '\x1f' + source + '\x1f' + site + '\x1f' + code + '\x1f' +
    normalizeDetail(detail)
).hex.slice(0, 16)
```

`normalizeDetail` is `sanitizeErrorMessage()` (the Worker's existing redactor,
lifted to a shared module) followed by 13 ordered rewrites. **Order is
load-bearing** — URLs must be eaten before ports, durations before bare
integers. Verbatim from the validated prototype:

```ts
export function normalizeDetail(input: unknown): string {
  let s = sanitizeErrorMessage(input);          // worker/src/observability.ts
  if (!s) return '';
  s = s
    .replace(/\b(?:data|blob):[^\s'"]+/gi, '<uri>')                                   // N1
    .replace(/\bhttps?:\/\/[^\s'"<>)\]]+/gi, '<url>')                                 // N2
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>') // N3
    .replace(/\bu_[0-9a-f]{8}\b/g, '<uhash>')                                         // N4
    .replace(/\bcid_[0-9a-z]+\b/gi, '<cid>')
    .replace(/([\w.\-]+\.(?:js|mjs|ts|tsx|sh)):\d+(?::\d+)?/gi, '$1:<pos>')            // N5
    .replace(/\b\d+(?:\.\d+)?\s?(ms|s|m|h)\b/gi, '<dur>')                              // N6
    .replace(/\b\d+(?:\.\d+)?\s?(b|kb|mb|gb|kib|mib|gib)\b/gi, '<size>')               // N7
    .replace(/(^|[\s\]([{=,>a-z])(:\d{2,5})\b/gi, '$1:<port>')                          // N8
    .replace(/(?:^|(?<=[\s'"(=]))\/(?:[\w.@+-]+\/)*[\w.@+-]*/g, '<path>')               // N9
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')                                            // N10
    .replace(/\b[A-Za-z0-9_-]{22,}\b/g, '<opaque>')
    .replace(/"[^"]{0,120}"/g, '<str>').replace(/'[^']{0,120}'/g, '<str>')             // N11
    .replace(/\b\d{4,}\b/g, '<n>')                                                     // N12
    .replace(/\s+/g, ' ').trim().toLowerCase();                                        // N13
  return s.slice(0, 120);
}
```

**N12 is deliberately 4+ digits.** 1–3 digit integers are KEPT: exit code `137`
(OOM) vs `1`, HTTP `500` vs `412`, signal numbers — those *are* the diagnosis
and collapsing them would merge distinct bugs. Everything that varies per-user
with ≤3 digits has already been consumed by N5–N9.

`site` and `code` carry the identity; `detail` only refines it. That is why
`site` must never contain a file:line — the taxonomy in §1.1 assigns each call
site a hand-written stable `site` string.

### 2.3 Worked examples (measured, not asserted)

**Example A — two users, different sandbox ids, ports and exit-code context.**
Real shape from `worker/src/index.ts`'s `sandbox.preview.desktop_ready`:

```
user u_f5537974: "sandbox_start_failed: container 550e8400-e29b-41d4-a716-446655440000
                  exited with code 137 while binding http://ezil-a1b2c3d4e5f6.api-desktop.ezil.org:8080"
user u_0c41ba9e: "sandbox_start_failed: container 7c9e6679-7425-40de-944b-e07fc1f90ae7
                  exited with code 137 while binding http://ezil-99887766aabb.api-desktop.ezil.org:9223"

both normalise to: "sandbox_start_failed: container <uuid> exited with code 137 while binding <url>"
both fingerprint to: fp_404f6d7caa22afc2                                    ← ONE fingerprint
```

**Example B — two users, same shell bug, different durations and stack columns.**
Real string from `shell/ezil/apps/preview.js:265`:

```
user u_f5537974: "preview mint failed after 21437ms: sandbox_start_failed"
user u_0c41ba9e: "preview mint failed after 18902ms: sandbox_start_failed"

both normalise to: "preview mint failed after <dur>: sandbox_start_failed"
both fingerprint to: fp_af5334bac72abfa5                                    ← ONE fingerprint
```

**Negative controls (must NOT collide), also measured:**

```
timeout vs sandbox_start_failed at the same site →  fp_1d345f8cde3e8e9f ≠ fp_af5334bac72abfa5
"exited with code 137"  vs  "exited with code 1"  →  fp_fa8b15ab481d21b6 ≠ fp_d6a1dddf7f35ff59
```

**Privacy control**, also measured — an HMAC envelope, a bearer token and an
ICE-candidate IP in the same string:

```
in:  "unauthorized: bad sig t=1754006400123,v1=9f8e7d6c5b4a39281706 for
      authorization: Bearer eyJhbGciOi.J9.abc from 203.0.113.42"
out: "unauthorized: bad sig [redacted-token] for authorization=[redacted]"
```

The IP, the signature and the token never reach the hash input, so they cannot
be recovered from a stored fingerprint even by brute force.

### 2.4 Required tests for the implementer

`app/src/server/telemetry/fingerprint.test.ts` must pin, at minimum: the 4
positive pairs, the 2 negative controls and the leak scan above (regexes
`/v1=[0-9a-f]{8,}/`, `/bearer\s+ey/i`, IPv4, `/@[\w.]+\.[a-z]{2,}/`) run over
every normalised string in the corpus. Plus: `normalizeDetail('')` → `''`,
and stability — the two example fingerprints are asserted as **literals**, so a
regex edit that silently re-buckets the whole fleet fails CI.

---

## 3. The Postgres schema

Three tables. Conventions carried from `ezil_computers`: `ezil_` prefix, RLS
enabled, foreign keys named explicitly (`..._fkey`, Supabase's own default), all
timestamps `timestamptz`.

**One convention is deliberately INVERTED and this is the reason.**
`ezil_computers` is soft-delete-only because its `id` *is* an R2 prefix root.
`ezil_error_events` is **hard-delete-only**: a soft-deleted telemetry row keeps
both its bytes and its index entries, which is strictly worse than no row and
defeats the entire purpose of retention (§7). There is therefore no `deleted_at`
column, and `DELETE` is the one command the retention job is *supposed* to run.

**There is no `user_id` column and no FK to `auth.users`.** Only `user_hash`.
Consequences, stated openly:
- Account deletion does not cascade through `auth.users`. It is handled by
  (a) the `computer_id` FK below, which *does* cascade
  (`auth.users` → `ezil_computers` → here), and (b) an explicit
  `delete from ezil_error_events where user_hash = $1` in the account-deletion
  path, and (c) the 90-day ceiling as a backstop. The implementer MUST wire (b).
- `user_hash` is FNV-1a/32-bit — it is a **correlation key, not a security
  primitive**. It has ~4.3e9 outputs over a small user population, so it is
  reversible by anyone holding the user-id list. It is not stored to protect
  against someone who already has our database; it is stored so that every
  query, dashboard, CSV export and screenshot downstream of this table touches
  no identity at all. That is the actual threat being managed. Do not upgrade it
  to a keyed hash without also changing `worker/src/observability.ts`, or the
  Worker and the app will stop agreeing on who is who.

### 3.1 `app/src/server/db/schema/telemetry.ts`

```ts
import { relations, sql } from 'drizzle-orm';
import {
    bigint, char, check, foreignKey, index, integer, jsonb, pgTable,
    primaryKey, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';

import { computers } from './computers';

/**
 * Raw crash/error telemetry. APPEND-ONLY, HARD-DELETE-ONLY, SHORT-LIVED.
 *
 * Never contains: secrets, tokens, HMAC values, cookies, file contents,
 * absolute user paths, email addresses, raw user ids, IP addresses, or full
 * URLs. Producers run `sanitizeErrorMessage()` before the wire; the ingest
 * route runs it again (defence in depth) before the insert. See §8.
 *
 * `fingerprint` is computed SERVER-SIDE ONLY (`server/telemetry/fingerprint.ts`)
 * so all four sources bucket identically. Clients never supply it.
 */
export const errorEvents = pgTable(
    'ezil_error_events',
    {
        // Client-generated UUIDv4, used as the PK so a re-sent beacon is an
        // idempotent no-op via ON CONFLICT DO NOTHING rather than a duplicate.
        eventId: uuid('event_id').primaryKey(),
        schemaVersion: integer('schema_version').notNull().default(1),
        eventClass: varchar('event_class', { length: 32 }).notNull(),
        source: varchar('source', { length: 16 }).notNull(),
        /** `fp_` + 16 hex chars = 19. */
        fingerprint: char('fingerprint', { length: 19 }).notNull(),
        /** `u_` + 8 hex chars = 10. NEVER a raw user id. */
        userHash: char('user_hash', { length: 10 }).notNull(),
        site: varchar('site', { length: 96 }).notNull(),
        code: varchar('code', { length: 64 }).notNull(),
        outcome: varchar('outcome', { length: 16 }).notNull(),
        detail: varchar('detail', { length: 200 }),
        durationMs: integer('duration_ms'),
        correlationId: varchar('correlation_id', { length: 64 }),
        computerId: uuid('computer_id'),
        /** Allow-listed scalars only (§8.2). Never free-form. */
        attrs: jsonb('attrs'),
        /** Producer's clock. Advisory — clocks lie. */
        occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
        /** OUR clock, at ingest. Every time-window query uses THIS one. */
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
        // Q1 "distinct users on this fingerprint in the last hour" — the whole
        // point of the table. Column order matters: equality key first, range
        // key second, payload third so it is an INDEX-ONLY scan.
        index('idx_ezil_error_events_fp_time_user').on(t.fingerprint, t.receivedAt, t.userHash),
        // Q2 error rate over time + Q3 spike detection, sliced by class.
        index('idx_ezil_error_events_class_time').on(t.eventClass, t.receivedAt),
        // Q4 boot-phase ranking, and the retention sweep's driving scan.
        index('idx_ezil_error_events_time').on(t.receivedAt),
        // Per-user drill-down ("show me everything this one reporter hit").
        index('idx_ezil_error_events_user_time').on(t.userHash, t.receivedAt),
        // Cascade path for account deletion. Nullable: a crash can happen
        // before any computer exists, and that crash is exactly the one we
        // most need to see.
        foreignKey({
            name: 'ezil_error_events_computer_id_fkey',
            columns: [t.computerId],
            foreignColumns: [computers.id],
        }).onDelete('cascade').onUpdate('cascade'),
        check('ezil_error_events_fingerprint_chk', sql`${t.fingerprint} ~ '^fp_[0-9a-f]{16}$'`),
        check('ezil_error_events_user_hash_chk', sql`${t.userHash} ~ '^u_[0-9a-f]{8}$'`),
        check('ezil_error_events_outcome_chk', sql`${t.outcome} in ('ok','error','skipped')`),
    ],
).enableRLS();

/**
 * One row per distinct error class, ever. Tiny (hundreds of rows), permanent,
 * and the join target for every dashboard. Upserted on the ingest path.
 * Outlives the raw events it summarises, so "when did we first see this?"
 * survives retention.
 */
export const errorFingerprints = pgTable(
    'ezil_error_fingerprints',
    {
        fingerprint: char('fingerprint', { length: 19 }).primaryKey(),
        eventClass: varchar('event_class', { length: 32 }).notNull(),
        source: varchar('source', { length: 16 }).notNull(),
        site: varchar('site', { length: 96 }).notNull(),
        code: varchar('code', { length: 64 }).notNull(),
        /** The normalised (not raw) detail — already id-stripped, so safe. */
        normalizedDetail: varchar('normalized_detail', { length: 120 }),
        firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
        /** Lifetime counter. Survives retention; never reset. */
        totalCount: bigint('total_count', { mode: 'number' }).notNull().default(0),
        /** Set by a human to stop a known-benign class paging anyone. */
        mutedAt: timestamp('muted_at', { withTimezone: true }),
        notes: text('notes'),
    },
    (t) => [
        index('idx_ezil_error_fingerprints_last_seen').on(t.lastSeenAt),
        index('idx_ezil_error_fingerprints_class').on(t.eventClass, t.lastSeenAt),
    ],
).enableRLS();

/**
 * The long-horizon rollup: (fingerprint, hour, user) -> count.
 *
 * This shape — one row per user per hour rather than a pre-summed count — is
 * the ONLY one that keeps DISTINCT-USER counts exact over arbitrary windows
 * after the raw events are pruned. `count(*)` grouped by hour gives distinct
 * users; `sum(event_count)` gives event volume. A pre-summed `user_count`
 * column cannot be re-aggregated across hours without over-counting, and HLL
 * would mean a new extension. This costs ~4 rows/user/day (§7).
 */
export const errorUserHours = pgTable(
    'ezil_error_user_hours',
    {
        fingerprint: char('fingerprint', { length: 19 }).notNull(),
        /** `date_trunc('hour', received_at)`. */
        hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
        userHash: char('user_hash', { length: 10 }).notNull(),
        eventCount: integer('event_count').notNull().default(0),
    },
    (t) => [
        primaryKey({ name: 'ezil_error_user_hours_pkey', columns: [t.fingerprint, t.hourBucket, t.userHash] }),
        index('idx_ezil_error_user_hours_hour').on(t.hourBucket),
        foreignKey({
            name: 'ezil_error_user_hours_fingerprint_fkey',
            columns: [t.fingerprint],
            foreignColumns: [errorFingerprints.fingerprint],
        }).onDelete('cascade').onUpdate('cascade'),
    ],
).enableRLS();

export const errorEventsRelations = relations(errorEvents, ({ one }) => ({
    fingerprintRow: one(errorFingerprints, {
        fields: [errorEvents.fingerprint],
        references: [errorFingerprints.fingerprint],
    }),
    computer: one(computers, { fields: [errorEvents.computerId], references: [computers.id] }),
}));

export const errorEventInsertSchema = createInsertSchema(errorEvents);
export type ErrorEvent = typeof errorEvents.$inferSelect;
export type NewErrorEvent = typeof errorEvents.$inferInsert;
export type ErrorFingerprint = typeof errorFingerprints.$inferSelect;
```

Then add `export * from './telemetry';` to `app/src/server/db/schema/index.ts`.
Note there is **no FK from `errorEvents.fingerprint` to `errorFingerprints`** —
ingest inserts events and upserts fingerprints in the same transaction, and a
hard FK there would turn a fingerprint-upsert hiccup into a dropped event. The
rollup table does carry the FK, because it is written by a job that can retry.

### 3.2 Migration `app/drizzle/0001_telemetry.sql`

Generated with `bunx drizzle-kit generate`, then the policies appended by hand
(drizzle-kit does not emit RLS policies — the same hand-edit `0000` already
carries). Full expected content:

```sql
CREATE TABLE "ezil_error_fingerprints" (
	"fingerprint" char(19) PRIMARY KEY NOT NULL,
	"event_class" varchar(32) NOT NULL,
	"source" varchar(16) NOT NULL,
	"site" varchar(96) NOT NULL,
	"code" varchar(64) NOT NULL,
	"normalized_detail" varchar(120),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_count" bigint DEFAULT 0 NOT NULL,
	"muted_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "ezil_error_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"event_class" varchar(32) NOT NULL,
	"source" varchar(16) NOT NULL,
	"fingerprint" char(19) NOT NULL,
	"user_hash" char(10) NOT NULL,
	"site" varchar(96) NOT NULL,
	"code" varchar(64) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"detail" varchar(200),
	"duration_ms" integer,
	"correlation_id" varchar(64),
	"computer_id" uuid,
	"attrs" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ezil_error_events_fingerprint_chk" CHECK ("ezil_error_events"."fingerprint" ~ '^fp_[0-9a-f]{16}$'),
	CONSTRAINT "ezil_error_events_user_hash_chk" CHECK ("ezil_error_events"."user_hash" ~ '^u_[0-9a-f]{8}$'),
	CONSTRAINT "ezil_error_events_outcome_chk" CHECK ("ezil_error_events"."outcome" in ('ok','error','skipped'))
);
--> statement-breakpoint
CREATE TABLE "ezil_error_user_hours" (
	"fingerprint" char(19) NOT NULL,
	"hour_bucket" timestamp with time zone NOT NULL,
	"user_hash" char(10) NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ezil_error_user_hours_pkey" PRIMARY KEY("fingerprint","hour_bucket","user_hash")
);
--> statement-breakpoint
ALTER TABLE "ezil_error_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_error_fingerprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_error_user_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ezil_error_events" ADD CONSTRAINT "ezil_error_events_computer_id_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ezil_error_user_hours" ADD CONSTRAINT "ezil_error_user_hours_fingerprint_fkey" FOREIGN KEY ("fingerprint") REFERENCES "public"."ezil_error_fingerprints"("fingerprint") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_ezil_error_events_fp_time_user" ON "ezil_error_events" USING btree ("fingerprint","received_at","user_hash");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_events_class_time" ON "ezil_error_events" USING btree ("event_class","received_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_events_time" ON "ezil_error_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_events_user_time" ON "ezil_error_events" USING btree ("user_hash","received_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_fingerprints_last_seen" ON "ezil_error_fingerprints" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_fingerprints_class" ON "ezil_error_fingerprints" USING btree ("event_class","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_ezil_error_user_hours_hour" ON "ezil_error_user_hours" USING btree ("hour_bucket");--> statement-breakpoint

-- ── RLS (hand-written; drizzle-kit does not emit policies) ──────────────────
-- These three tables are SERVICE-ROLE ONLY. There is deliberately no policy
-- for `authenticated`: a user must not read other users' error rows, and has
-- no product reason to read their own. With RLS enabled and no matching
-- policy, every non-service-role SELECT/INSERT/UPDATE/DELETE returns nothing
-- or is rejected — the safe default, chosen on purpose rather than by
-- omission. If a "your crash reports" UI is ever built, it needs a new,
-- explicitly reviewed SELECT policy keyed on user_hash.
CREATE POLICY "Service role full access error events"
    ON "ezil_error_events" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access error fingerprints"
    ON "ezil_error_fingerprints" FOR ALL USING (auth.role() = 'service_role');
--> statement-breakpoint
CREATE POLICY "Service role full access error user hours"
    ON "ezil_error_user_hours" FOR ALL USING (auth.role() = 'service_role');
```

Remember to add the `0001` entry to `app/drizzle/meta/_journal.json` if
hand-editing rather than regenerating.

---

## 4. Ingest path

Three producers, **one validator, one fingerprinter, one writer**
(`app/src/server/telemetry/ingest.ts`). Everything converges there.

```
shell (browser) ──sendBeacon──> POST /api/shell/telemetry ─┐
app server (route handlers) ───── direct call ─────────────┼─> ingestBatch() ─> Postgres
worker ─> R2 spool ─> GET /api/cron/telemetry-maintenance ─┘
container ─> /var/log/ezil-telemetry.ndjson ─> worker drains it into the same spool
```

### 4.1 Worker → R2 spool (worker-side implementer)

`worker/src/observability.ts` already builds and sanitises every event. The
only change is the **sink**: add a `CollectingSink` that appends built
`LogEvent`s to an in-request array while still `console.log`-ing them (so
`wrangler tail` keeps working unchanged). No new `tl.event` call sites.

At the end of a preview/diag request, in `ctx.waitUntil()` — never on the
response path:

```ts
// Only requests that produced at least one error event, PLUS one
// boot_summary per preview attempt (the denominator — see §6 Q4).
const lines = events
  .filter((e) => e.outcome === 'error' || e.event === 'sandbox.preview.desktop_ready')
  .map((e) => JSON.stringify(toTelemetryEventInput(e)))
  .join('\n');
if (lines) {
  ctx.waitUntil(
    env.TELEMETRY_R2_BUCKET
      .put(`v1/dt=${yyyy}-${mm}-${dd}/hh=${hh}/${correlationId}.ndjson`, lines, {
        httpMetadata: { contentType: 'application/x-ndjson' },
      })
      .catch(() => {}),   // a failed telemetry PUT is a no-op, never a 500
  );
}
```

🔴 **Use a SEPARATE R2 bucket binding**, e.g.
`binding = "TELEMETRY_R2_BUCKET"`, `bucket_name = "ezil-telemetry-spool"`, in
`worker/wrangler.toml`. Do **not** reuse `SANDBOX_WORKSPACE_R2_BUCKET`: that
bucket is FUSE-mounted into user containers, and a mount that ever resolves
without a per-computer prefix would put the whole fleet's error log inside a
user's file manager. A second bucket is within the allowed binding set
(DO + R2) and costs nothing; the risk of sharing is not worth the tidiness.

Direct `fetch()` from Worker to the app was considered and rejected: it couples
Worker health to Vercel availability, and it needs a reverse-direction HMAC
trust relationship that does not exist today. R2 is durable, is already a
binding, and a 15-minute drain latency is well inside the "last hour" question.

### 4.2 Container → Worker (worker-side implementer)

`worker/scripts/start-neko.sh` already emits everything needed. Add one function
next to the existing `phase_end`, writing one JSON line per phase to a fixed
path. It must pass `bash -n` (`worker/src/shell-scripts-parse.test.ts`).

```bash
# 🔴 No apostrophes anywhere inside this block, comments included.
TELEMETRY_NDJSON="/var/log/ezil-telemetry.ndjson"
emit_telemetry() {
  # $1=class $2=site(phase) $3=code $4=outcome $5=duration_ms
  printf '{"eventClass":"%s","source":"container","site":"%s","code":"%s","outcome":"%s","durationMs":%s}\n' \
    "$1" "$2" "$3" "$4" "${5:-0}" >> "$TELEMETRY_NDJSON" 2>/dev/null || true
}
```

Called from `phase_end` only: `status=ok` on the `ready` phase emits
`boot_summary`; any `status` other than `ok` emits `boot_phase`. `|| true` on
every line — a full disk must not fail a boot.

**Never interpolate a raw message into that `printf`.** Only the phase name
(closed set of 11) and a status token. Nothing from a user's workspace can
reach the string. The Worker drains it with the `sandbox.readFile()` call it
already uses elsewhere (`worker/src/index.ts:1208`), caps the read at 64 KB,
parses line-by-line discarding any line that is not valid JSON, and appends the
survivors to the same R2 object as §4.1.

### 4.3 Shell → app (shell-side implementer)

New module `shell/ezil/telemetry.js`. `POST /api/shell/telemetry`, added to
`SHELL_API_ROUTES` in `app/src/server/shell/boot-payload.ts` and
**feature-detected** by the shell exactly the way the app switcher already
detects `endpoints.focus` — an older cached bundle against a newer server, or
vice versa, then does nothing rather than POSTing to a URL it invented.

```js
const MAX_BUFFER   = 50;   // events held in memory
const MAX_BATCH    = 50;   // events per request
const MAX_FLUSHES  = 10;   // per page life
const MAX_PER_FP   = 3;    // per fingerprint-ish key per page life
const FLUSH_MS     = 10_000;
```

Transport, in order of preference:
1. `navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }))`.
   Same-origin, so the Supabase auth cookie rides along and the server can
   derive identity itself. sendBeacon is fire-and-forget by construction: it
   returns a boolean, exposes no response, cannot reject, and the browser owns
   delivery across page unload.
2. If `sendBeacon` is missing or returns `false` (queue full / payload > 64 KB):
   `fetch(url, { method:'POST', keepalive:true, body:json, signal:
   AbortSignal.timeout(3000) }).catch(() => {})`. **Never awaited by any caller.**

Flush triggers: the 10 s timer, `visibilitychange → hidden`, and `pagehide`.
Not `beforeunload` (unreliable, and it can block the unload).

### 4.4 The route: `app/src/app/api/shell/telemetry/route.ts`

```ts
export const maxDuration = 10;   // deliberately short — see the focus route's rationale

export async function POST(req: Request) {
  try {
    const { ctx } = await shellCaller(req);
    // 🔴 ALWAYS 202. Never 401, never 400, never 500. The client has nothing to
    // branch on, so no telemetry response can ever change product behaviour.
    if (!ctx.user) return ACCEPTED;
    if (shedLoad()) return ACCEPTED;                       // §7.3 kill switch
    const parsed = telemetryBatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return ACCEPTED;

    const userHash = safeUserHash(ctx.user.id);            // SERVER-side. The
    // client never sends an id and is never trusted with a hash.
    after(() => ingestBatch(parsed.data.events.slice(0, 50), userHash, 'shell')
      .catch((e) => console.error('[telemetry] ingest failed', { m: String(e?.message ?? e) })));
    return ACCEPTED;
  } catch {
    return ACCEPTED;
  }
}
const ACCEPTED = new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
```

`after()` (Next 16, `next/server`) runs the Postgres write **after the response
is flushed**, so the beacon's round trip never waits on the database. A slow or
dead Postgres costs the user nothing.

### 4.5 `ingestBatch` — the single writer

Per batch, one transaction, three statements:

```sql
-- 1. fingerprints dimension (upsert)
insert into ezil_error_fingerprints
  (fingerprint, event_class, source, site, code, normalized_detail, total_count)
values ($1,$2,$3,$4,$5,$6,$7)
on conflict (fingerprint) do update
  set last_seen_at = now(),
      total_count  = ezil_error_fingerprints.total_count + excluded.total_count;

-- 2. the events (multi-row VALUES; idempotent)
insert into ezil_error_events (...) values (...), (...), (...)
on conflict (event_id) do nothing;

-- 3. keep the rollup live for the current hour (so Q1/Q3 work even if the
--    cron is late). Cheap: at most one row per (fp, hour, user) per batch.
insert into ezil_error_user_hours (fingerprint, hour_bucket, user_hash, event_count)
values ($1, date_trunc('hour', now()), $2, $3)
on conflict (fingerprint, hour_bucket, user_hash) do update
  set event_count = ezil_error_user_hours.event_count + excluded.event_count;
```

Statement 1 must run before 2 is irrelevant (no FK between them) but before 3 is
**required** (FK). Order: 1, 2, 3.

### 4.6 Failure behaviour, end to end

| failure | what the user sees | why |
| --- | --- | --- |
| `capture()` itself throws | nothing | the whole body is inside `try {} catch {}`, and a re-entrancy flag stops a telemetry bug recursing through the global `onerror` handler it installed |
| buffer overflows | nothing | oldest events dropped at 50; counters in `attrs.dropped` on the next event so we know it happened |
| beacon rejected by the browser | nothing | falls through to `keepalive` fetch, itself `.catch(() => {})` |
| ingest returns 429/503/anything | nothing | the client never reads the response |
| ingest times out | nothing | `AbortSignal.timeout(3000)`, and nothing awaits the promise |
| two consecutive transport failures | telemetry stops for the page | session kill switch; product unaffected |
| Postgres is down | nothing | the write is inside `after()`, past the flushed response, and is caught |
| the whole `/api/shell/telemetry` route 404s (old server, new bundle) | nothing | feature-detected via `endpoints.telemetry`; absent ⇒ the module never arms |
| R2 spool PUT fails | nothing | `.catch(() => {})` inside `waitUntil`; those events are simply lost |
| container log file unwritable | nothing | `|| true` on every append |

**The guarantee, stated once:** no telemetry code path is ever `await`ed by a
code path that produces user-visible output, and no telemetry response body or
status is ever read. Those two invariants are what make failure invisible;
everything above is an application of them. A reviewer should be able to check
them by grepping for `await` next to the telemetry module and finding none.

---

## 5. Shell-side specifics

### 5.1 The crash handler that does not exist yet

Installed once, first thing in `shell/ezil/boot.js`, before anything else can
throw:

```js
window.addEventListener('error', (ev) => capture({
  eventClass: 'crash', site: siteFor(ev.filename), code: codeFor(ev.error),
  detail: sanitize(ev.message),
  attrs: { stack_head: firstFrame(ev.error) },          // ONE frame, function
}));                                                    // name + file only
window.addEventListener('unhandledrejection', (ev) => capture({
  eventClass: 'crash', site: 'unhandled_rejection', code: codeFor(ev.reason),
  detail: sanitize(ev.reason),
}));
```

`attrs.stack_head` is **one frame**, and only `functionName@file.js` — no
column, no full stack, no `file://` or absolute path. Full stacks routinely
contain query strings, tokens in URLs and inlined data URIs; one frame is
enough to locate the bug and is the most that can be made safe cheaply.

### 5.2 The one thing the shell must not do

It must not send `payload().user.id` or `payload().user.email`. Both are
present in `window.__EZIL_BOOT__` (`ShellBootUser` carries `id` and `email`) and
both are forbidden on the wire. The shell sends **no identity at all**; the
server derives `user_hash` from the session cookie. An implementer who "helpfully"
adds `userId` to the payload has broken the privacy contract, so
`app/src/server/telemetry/schema.test.ts` must assert the zod schema **rejects
unknown keys** (`.strict()`), making that mistake a test failure rather than a leak.

---

## 6. The aggregation queries

All four live in `app/src/server/telemetry/queries.ts` as parameterised
Drizzle `sql` templates. Written here in plain SQL so they can be pasted
straight into the Supabase SQL editor during an incident.

⚠️ Not executed against a live Postgres while authoring (no server binaries in
this environment — `psql` client only, no `initdb`). Hand-checked against the
schema in §3; the implementer must run each one and `EXPLAIN` it before
merging. See `couldNotVerify`.

### Q1 — distinct users per fingerprint per window (**the owner's actual question**)

One query, one index, no join:

```sql
-- "How many distinct users hit THIS error in the last hour?"
SELECT count(DISTINCT user_hash) AS distinct_users,
       count(*)                  AS events,
       min(received_at)          AS first_in_window,
       max(received_at)          AS last_in_window
FROM   ezil_error_events
WHERE  fingerprint = $1
  AND  received_at >= now() - interval '1 hour';
-- index-only on idx_ezil_error_events_fp_time_user (fingerprint, received_at, user_hash)
```

The fleet-wide leaderboard version, which is what a human actually opens:

```sql
-- "What is hurting the most people right now?"
SELECT e.fingerprint,
       f.event_class, f.source, f.site, f.code, f.normalized_detail,
       count(DISTINCT e.user_hash) AS distinct_users,
       count(*)                    AS events,
       max(e.received_at)          AS last_seen,
       f.first_seen_at
FROM   ezil_error_events e
JOIN   ezil_error_fingerprints f USING (fingerprint)
WHERE  e.received_at >= now() - interval '1 hour'
  AND  e.outcome = 'error'
  AND  f.muted_at IS NULL
GROUP  BY e.fingerprint, f.event_class, f.source, f.site, f.code,
          f.normalized_detail, f.first_seen_at
ORDER  BY distinct_users DESC, events DESC
LIMIT  50;
```

Beyond the raw-retention horizon, the same answer from the rollup — exact, not
estimated, because the rollup stores one row per user per hour:

```sql
SELECT fingerprint,
       count(DISTINCT user_hash) AS distinct_users,   -- exact across any window
       sum(event_count)          AS events
FROM   ezil_error_user_hours
WHERE  hour_bucket >= now() - interval '90 days'
GROUP  BY fingerprint
ORDER  BY distinct_users DESC
LIMIT  50;
```

### Q2 — error rate over time

The denominator is `users_reporting`: every user whose client sent *anything*
in that hour, including the always-emitted `boot_summary` with
`outcome = 'ok'`. That is precisely why `boot_summary` is sent on success —
without it there is no denominator and "error rate" degenerates into "error
count", which rises with signups and tells you nothing.

```sql
WITH buckets AS (
  SELECT generate_series(date_trunc('hour', now()) - interval '47 hours',
                         date_trunc('hour', now()),
                         interval '1 hour') AS h
)
SELECT b.h AS hour,
       count(*) FILTER (WHERE e.outcome = 'error')                    AS errors,
       count(DISTINCT e.user_hash) FILTER (WHERE e.outcome = 'error') AS users_with_errors,
       count(DISTINCT e.user_hash)                                    AS users_reporting,
       round(100.0 * count(DISTINCT e.user_hash) FILTER (WHERE e.outcome = 'error')
             / nullif(count(DISTINCT e.user_hash), 0), 1)             AS pct_users_affected
FROM   buckets b
LEFT   JOIN ezil_error_events e
       ON e.received_at >= b.h AND e.received_at < b.h + interval '1 hour'
GROUP  BY b.h
ORDER  BY b.h;
```

Add `AND e.event_class = $1` to the join condition (not the WHERE clause — a
WHERE predicate on the outer side turns the LEFT JOIN back into an inner one
and silently drops the zero-error hours, which are the ones that prove the fix
worked) to slice by class.

### Q3 — is this error spiking?

Compares the last hour against **the same hour-of-day over the previous 7
days**, so a nightly batch job or a European-morning traffic peak does not read
as a regression.

```sql
WITH recent AS (
  SELECT fingerprint, count(DISTINCT user_hash)::numeric AS users
  FROM   ezil_error_events
  WHERE  received_at >= now() - interval '1 hour' AND outcome = 'error'
  GROUP  BY fingerprint
),
baseline AS (
  SELECT fingerprint,
         avg(users)                        AS mean_users,
         coalesce(stddev_samp(users), 0)   AS sd_users,
         count(*)                          AS sample_hours
  FROM (
    SELECT fingerprint, hour_bucket, count(*)::numeric AS users
    FROM   ezil_error_user_hours
    WHERE  hour_bucket >= now() - interval '7 days'
      AND  hour_bucket <  date_trunc('hour', now())
      AND  extract(hour FROM hour_bucket AT TIME ZONE 'UTC')
           = extract(hour FROM now()     AT TIME ZONE 'UTC')
    GROUP  BY fingerprint, hour_bucket
  ) h
  GROUP BY fingerprint
)
SELECT r.fingerprint, f.site, f.code, f.normalized_detail,
       r.users                             AS users_now,
       round(coalesce(b.mean_users, 0), 2) AS baseline_mean,
       round(coalesce(b.sd_users, 0), 2)   AS baseline_sd,
       b.sample_hours,
       round((r.users - coalesce(b.mean_users, 0))
             / greatest(coalesce(b.sd_users, 0), 1), 2) AS z,
       (b.fingerprint IS NULL)             AS is_new
FROM   recent r
JOIN   ezil_error_fingerprints f ON f.fingerprint = r.fingerprint
LEFT   JOIN baseline b ON b.fingerprint = r.fingerprint
WHERE  f.muted_at IS NULL
  AND  ( (b.fingerprint IS NULL AND r.users >= 3)            -- never seen before
      OR (r.users - coalesce(b.mean_users, 0))
         / greatest(coalesce(b.sd_users, 0), 1) >= 3.0 )     -- 3 sigma
ORDER  BY is_new DESC, z DESC;
```

`greatest(sd, 1)` is the important detail: it prevents division by zero **and**
stops a fingerprint that was perfectly flat at 0 from scoring infinite sigma
the first time one user hits it. A brand-new fingerprint needs 3 distinct users
before it is called a spike — one user with a broken extension is not an outage.

### Q4 — which boot phase fails most

```sql
WITH attempts AS (
  SELECT count(*)::numeric AS n
  FROM   ezil_error_events
  WHERE  event_class = 'boot_summary'
    AND  received_at >= now() - interval '24 hours'
)
SELECT p.site                              AS phase,
       count(*)                            AS failures,
       count(DISTINCT p.user_hash)         AS users_affected,
       (SELECT n FROM attempts)            AS boot_attempts,
       round(100.0 * count(*) / nullif((SELECT n FROM attempts), 0), 2) AS pct_of_boots,
       round(avg(p.duration_ms))           AS avg_ms_before_failure,
       mode() WITHIN GROUP (ORDER BY p.code) AS most_common_code
FROM   ezil_error_events p
WHERE  p.event_class = 'boot_phase'
  AND  p.outcome = 'error'
  AND  p.received_at >= now() - interval '24 hours'
GROUP  BY p.site
ORDER  BY failures DESC;
```

`site` here is one of the 11 phase names already emitted by `start-neko.sh`, so
this query answers "where does boot die" in the container's own vocabulary and
needs no translation table.

---

## 7. Volume, cost and retention

### 7.1 Rows per user per day

ASSUMPTIONS — stated so they can be corrected once real numbers exist, not
presented as measurements. Per active user per day: 3 desktop boots, ~5 app
opens, ~20 API calls.

| class | rows/user/day | reasoning |
| --- | --- | --- |
| `boot_summary` | 3.0 | one per boot, always (the denominator) |
| `boot_phase` | 0.4 | ~8% of boots fail, ~1.5 phases each |
| `worker_exception` | 0.4 | ~5% of ~8 sandbox ops |
| `api_failure` | 0.5 | |
| `window_error` | 0.3 | |
| `crash` | 0.2 | most sessions are crash-free |
| `display_failure` | 0.15 | |
| `boot_stall` + `contract_violation` | 0.1 | |
| **total** | **≈ 5** | design budget **8**, hard client cap **25/session** |

Row cost measured against §3's column widths: ~330 B heap + ~250 B across four
indexes ≈ **600 B all-in per event**.

| DAU | events/day | raw rows @14d | raw size | rollup rows @90d | rollup size | **total** |
| --- | --- | --- | --- | --- | --- | --- |
| 200 | 1.6 k | 22 k | 13 MB | 72 k | 9 MB | **~22 MB** |
| 1,000 | 8 k | 112 k | 67 MB | 360 k | 43 MB | **~110 MB** |
| 5,000 | 40 k | 560 k | 336 MB | 1.8 M | 216 MB | **~550 MB** ⚠️ |
| 10,000 | 80 k | 1.12 M | 672 MB | 3.6 M | 432 MB | **~1.1 GB** 🔴 |

Write rate at 1,000 DAU is ~0.1 inserts/s average, batched 10–50 per request.
Postgres will not notice. **Size is the risk, not throughput.**

### 7.2 Retention policy

| table | retention | why |
| --- | --- | --- |
| `ezil_error_events` | **14 days** (→ **7 days** above 5,000 DAU) | long enough to debug a report that arrives on Monday about Friday; the rollup covers everything longer |
| `ezil_error_user_hours` | **90 days** | quarter-over-quarter trend, exact distinct users, ~120 B/row |
| `ezil_error_fingerprints` | **forever**, except rows with `last_seen_at < now() - 1 year AND total_count < 10` | hundreds of rows; `first_seen_at` answers "did we ship this?" long after the events are gone |

Enforced hourly by `GET /api/cron/telemetry-maintenance`, which does, in order:
roll up any hour not yet rolled up, then prune. Add to `app/vercel.json`
(the file does not exist yet):

```json
{ "crons": [{ "path": "/api/cron/telemetry-maintenance", "schedule": "17 * * * *" }] }
```

Guard it with `CRON_SECRET` — add `CRON_SECRET: z.string().min(32).optional()`
to `serverSchema` in `app/src/env.ts`; **if it is unset the route 404s** (fail
closed, so a misconfigured deploy cannot expose a delete endpoint). Vercel sends
`Authorization: Bearer $CRON_SECRET` automatically.

Vercel's Hobby plan only permits daily crons. If this project is on Hobby, the
fallback is a Worker cron — `[triggers] crons = ["17 * * * *"]` in
`worker/wrangler.toml` plus a `scheduled()` handler that `fetch`es the same
route with the same bearer. The Worker has no `scheduled()` handler today, so
this is genuinely new code either way; the Vercel path is one JSON file less.

The prune must be **chunked**, never a single unbounded `DELETE`:

```sql
DELETE FROM ezil_error_events
WHERE event_id IN (
  SELECT event_id FROM ezil_error_events
  WHERE received_at < now() - interval '14 days'
  ORDER BY received_at
  LIMIT 5000
);
```

Loop until it returns 0 rows or a 20-second wall-clock budget is spent; the
next hourly run continues. A single `DELETE` of a million rows on a shared
transaction-pooler connection is exactly the outage this section exists to
prevent. Follow the loop with `ANALYZE ezil_error_events;` — the `reltuples`
estimate in §7.3 depends on it being fresh.

### 7.3 The load-shed kill switch

Retention is a *lagging* control; it runs hourly. The leading control lives on
the ingest path:

```ts
// Refreshed at most every 5 minutes, module-scoped. Free: reads the planner's
// own estimate, never scans the table.
//   SELECT reltuples::bigint FROM pg_class WHERE relname = 'ezil_error_events';
const SHED_ABOVE_ROWS = 2_000_000;
function shedLoad(): boolean { return cachedRowEstimate > SHED_ABOVE_ROWS; }
```

Above the ceiling the route still returns 202 and simply **drops the batch**.
Telemetry sheds itself before it sheds the product. The same check emits one
`console.error` per 5-minute window so the shed is itself visible.

Two further bounds, both cheap: a per-request cap of 50 events, and a
per-user-per-hour cap enforced by the natural key of
`ezil_error_user_hours` — a single user in a crash loop can add at most
`MAX_PER_FP` events per fingerprint per page life and exactly one rollup row
per hour, so one pathological client cannot dominate a distinct-user count.

---

## 8. Privacy

Public AGPL repo, real users. Every field, and why it is safe.

### 8.1 Field-by-field

| field | safe because |
| --- | --- |
| `event_id` | client-generated random UUIDv4; carries no information |
| `schema_version` | integer constant |
| `event_class`, `source`, `outcome` | closed enums, 9 / 4 / 3 members |
| `fingerprint` | SHA-256 of already-redacted, already-normalised text. Every id, path, URL, token and IP was replaced by a placeholder *before* hashing (§2.3's privacy control), so there is no preimage to recover |
| `user_hash` | `safeUserHash()`, the existing FNV-1a construction — **explicitly a correlation key, not a security primitive** (§3). It keeps identity out of every dashboard and export. It does **not** protect against an attacker holding both the DB and the user list; nothing in a first-party analytics store does |
| `site` | hand-written literal from a closed set. Never a URL, never a file path, never a file:line |
| `code` | `[a-z0-9_]{1,64}` from `classifyError()` or a literal. `classifyError` derives it from an error's *prefix token* only, so it cannot smuggle a message |
| `detail` | `sanitizeErrorMessage()` at the producer AND again at ingest. Redacts HMAC envelopes, bearer/authorization/cookie headers, `key=`/`secret=`/`token=`/`password=` assignments, AWS/R2 key ids, IPv4 and IPv6. Hard-capped at 200 chars |
| `duration_ms` | integer |
| `correlation_id` | random UUID per request/page-load, already emitted in Worker logs today |
| `computer_id` | an opaque random UUID that is already in the client's own boot payload and joins to nothing outside our DB; the row is already scoped to its owner |
| `occurred_at` / `received_at` | timestamps |
| `attrs` | allow-listed scalars only, §8.2 |
| `normalized_detail` (fingerprints) | the post-normalisation string — id-free by construction, which is the whole point of storing that one and not the raw |

### 8.2 `attrs` allow-list — closed, per class

Anything not on this list is **stripped by the zod schema**, not rejected:

`crash` → `stack_head` (one frame, `functionName@file.js`, no line/col, no path)
`window_error` → `app_id` (member of the app registry's own id enum)
`api_failure` → `status` (HTTP integer), `retryable` (boolean)
`display_failure` → `seen` (short enum from `confirmFrame`)
`boot_summary` → `phases` (array of `{name, ms, status}`, names from the closed
set of 11), `total_ms`
`boot_phase`, `boot_stall`, `worker_exception`, `contract_violation` → none.

### 8.3 Not collected, deliberately

Named so nobody adds them later thinking they were an oversight:

- **Raw user id, email, display name.** Present in `window.__EZIL_BOOT__`
  (`ShellBootUser` has both `id` and `email`) and deliberately never sent.
- **IP address.** Not stored, and not derivable — the ingest route must **not**
  read `x-forwarded-for`. `sanitizeErrorMessage` already strips IPs from
  `detail` because ICE candidates leak them.
- **User-Agent, screen size, locale, timezone.** All are fingerprinting surface
  and none of them answer the owner's question. If a browser-specific bug ever
  needs them, add a coarse `attrs.ua_family` (a 6-member enum), never the
  raw string.
- **Full URLs and `document.referrer`.** Query strings carry tokens.
- **Full stack traces.** One frame only (§5.1).
- **Workspace file names, paths or contents.** `<path>` normalisation exists
  precisely so a filename cannot ride in on an error message.
- **HMAC values, cookies, TURN/relay credentials.** Redacted twice.
- **Breadcrumbs / user action trails.** Highest-value debugging feature here,
  and deliberately out of scope: a breadcrumb trail is a behavioural record of
  a named person and is not worth its privacy cost on a public-repo product.

### 8.4 Uncertain — left out, flagged for the owner

Per the brief's "if unsure, leave it out and say so":

- **`sandbox_id`.** Derived from `computer_id`, so it adds nothing that
  `computer_id` does not, and it appears in URLs. Left out of the schema
  entirely; the taxonomy table lists it as optional but the columns do not
  include it. If a Worker-side debugging need appears, put it in `detail`
  where the sanitiser can see it, not in a column.
- **`project_id`.** The Worker's `LogEvent` carries it. Unclear whether project
  ids are user-chosen strings (a user-chosen id can contain anything, including
  a name or an email). **Left out until someone confirms they are generated,
  not typed.**
- **Container `exit_code` / `signal` as a first-class column.** Genuinely useful
  for boot debugging, but it belongs in `code` (`sandbox_exit_137`) rather than
  a column, keeping the closed-set discipline. Noted, not adopted.

---

## 9. Work split for three parallel implementers

The seam is deliberate: **nobody but the app-side worker writes the
fingerprinter, the zod schema or the DB writer.** The other two produce events
and hand them over.

**app-side** (owns `app/`) — the critical path, land this first:
`src/server/telemetry/{types,schema,fingerprint,ingest,queries}.ts` +
`fingerprint.test.ts` (§2.4) + `schema.test.ts` (`.strict()`, §5.2) ·
`src/server/db/schema/telemetry.ts` + `export *` from `schema/index.ts` ·
`drizzle/0001_telemetry.sql` + `meta/_journal.json` ·
`src/app/api/shell/telemetry/route.ts` · `src/app/api/cron/telemetry-maintenance/route.ts` ·
`CRON_SECRET` in `src/env.ts` · `vercel.json` · add `telemetry` to
`SHELL_API_ROUTES` in `src/server/shell/boot-payload.ts`.
Lift `sanitizeErrorMessage` into a module both app and worker import, or
duplicate it with a test asserting the two are byte-identical — do not let them
drift, because the fingerprint depends on both producing the same string.

**shell-side** (owns `shell/`) — `shell/ezil/telemetry.js` (buffer, caps,
beacon, kill switch, feature detection) · the global handlers in `boot.js`
(§5.1) · a `capture()` call **beside** each of the 35 `console.error` sites per
§1.1, none replaced. 🔴 Never commit `app/public/os/bundle.min.js`; the
integrator rebuilds it once.

**worker-side** (owns `worker/`) — `CollectingSink` in `src/observability.ts`
(additive; the 25 call sites do not change) · `toTelemetryEventInput()` mapper ·
the `waitUntil` R2 spool (§4.1) · `TELEMETRY_R2_BUCKET` in `wrangler.toml` ·
`emit_telemetry()` in `scripts/start-neko.sh` (§4.2) · the `readFile` drain.
🔴 `bash -n` must pass (`src/shell-scripts-parse.test.ts`) and there must be no
apostrophes inside single-quoted `bash -c` blocks, comments included.

Contract between them: §1.2's `TelemetryEventInput`. The app-side worker should
land `types.ts` first and the other two should import from it (worker via a
relative path or a copied type with a parity test — the worker has no path into
`app/`).

Suggested landing order: app-side schema + migration + route → worker-side →
shell-side. Each is independently mergeable; the shell simply feature-detects
nothing and stays dark until the route exists.

---

## 10. What this design CANNOT capture (blind spots)

Stated plainly, because a telemetry design that oversells its coverage is worse
than none.

1. **Anything that stops the page from running JavaScript.** A bundle parse
   error, a CSP violation that blocks the bundle, a failed CDN fetch, a browser
   OOM-kill, or a crash before `boot.js`'s first line installs the handlers.
   These are precisely the worst failures, and they are invisible here. The
   only cover is the server-side `boot_summary` denominator: users who
   requested `/os` but never sent a single event are a *derivable* signal, and
   computing it requires a page-view counter this design does not include.
2. **Anything lost with the tab.** Events buffered but not yet flushed die if
   the browser is force-quit, the OS kills the tab, or the device sleeps.
   `sendBeacon` on `pagehide` covers the common cases; a hard kill loses up to
   10 seconds of events. Under-counting is therefore systematic and biased
   *toward* the most severe crashes.
3. **The distinct-user count is a distinct-*session-identity* count.** One user
   on a laptop and a phone is one `user_hash`; a signed-out visitor is
   `u_anon`, and every signed-out visitor collapses into that single bucket.
   Any "N users affected" figure for an error that happens before sign-in is
   meaningless.
4. **Correctness bugs that do not throw.** A desktop that boots to a black
   screen, a file saved to the wrong place, a window rendered off-screen —
   nothing errors, so nothing is captured. This design measures *failures*, not
   *badness*.
5. **Cross-source causality.** A shell `api_failure` and the Worker
   `worker_exception` that caused it get different fingerprints by design and
   are joinable only if the `correlationId` happens to be shared — which it is
   for the preview path (the Worker returns it) and is **not** for anything
   else. Whole-request stitching across shell → app → worker → container is not
   solved here.
6. **Rate, when the population changes.** Q2's denominator is "users who sent
   telemetry", which excludes users whose client never armed (blind spot 1) and
   users on a stale cached bundle. A rate improvement can be a real fix or a
   drop in reporting clients; the two look identical.
7. **Sampling bias, once shedding starts.** Above 2M rows the kill switch drops
   whole batches at whichever instances are hot, which is *not* a uniform
   random sample. Any figure computed during a shed window is a lower bound
   only, and nothing in the schema records that a shed was in progress —
   the implementer should add a `shed` marker row per window so a reader can
   tell. (Recommended, not designed here.)
8. **Fingerprint drift across releases.** A code change that alters an error
   message's wording produces a new fingerprint, and "this bug is fixed" and
   "this bug was reworded" are indistinguishable in the data. The literal
   fingerprint assertions in §2.4 make the *normaliser* stable; nothing can
   make the *messages* stable.
9. **The 15-minute R2 drain latency** means Worker and container events are not
   in Q1's answer for up to 15 minutes. Shell events are near-real-time. A
   query run mid-incident therefore under-reports the server side specifically.
10. **The volume table in §7.1 is assumptions, not measurements.** No production
    error-rate data exists yet. Every size figure downstream inherits that.
    Re-derive after one week of real ingest before trusting the 5,000-DAU row.
