/**
 * END-TO-END TELEMETRY PROOF — the only test in this repo that touches a real
 * Postgres, and the only one that can catch the class of bug it was written
 * for. NOT part of `vitest run`: it needs a database, so it is a hand-run
 * gate for anyone changing the telemetry write path or the migration.
 *
 * HOW TO RUN (throwaway database only — see the guard below):
 *
 *   docker run -d --rm --name ezil-tel-pg -e POSTGRES_PASSWORD=throwaway \
 *     -e POSTGRES_DB=ezil_e2e -p 55433:5432 \
 *     public.ecr.aws/supabase/postgres:17.6.1.140
 *   # the image starts as supabase_admin; give `postgres` the public schema:
 *   docker exec ezil-tel-pg psql -U supabase_admin -d ezil_e2e \
 *     -c 'grant all on schema public to postgres'
 *   PGPASSWORD=throwaway psql -h 127.0.0.1 -p 55433 -U postgres -d ezil_e2e \
 *     -v ON_ERROR_STOP=1 -f drizzle/0000_massive_mole_man.sql
 *   PGPASSWORD=throwaway psql -h 127.0.0.1 -p 55433 -U postgres -d ezil_e2e \
 *     -v ON_ERROR_STOP=1 -f drizzle/0001_telemetry.sql
 *   TELEMETRY_E2E_DATABASE_URL=postgres://postgres:throwaway@127.0.0.1:55433/ezil_e2e \
 *     bun run scripts/telemetry-e2e.ts
 *   docker rm -f ezil-tel-pg
 *
 * The script DROPS the three telemetry tables at the end (that is step 8, the
 * reversibility + no-table-present proof), so the database it runs against is
 * single-use by construction.
 *
 * The chain it exercises:
 *
 *   REAL shell/ezil/telemetry.js  (the shipped browser module, imported as-is)
 *     -> the JSON body it would actually POST
 *       -> REAL handleTelemetryPost (the shipped route core)
 *         -> REAL parseTelemetryBatch (zod .strict())
 *           -> REAL ingestBatch (the single writer)
 *             -> REAL Postgres (Supabase postgres:17.6, throwaway container,
 *                0000 + 0001 applied there and ONLY there)
 *               -> REAL Q1..Q4 aggregation queries
 *
 * Nothing is re-implemented. If the shell and the app disagree on a single
 * field name, type or bound, the row never lands and this script says so.
 *
 * 🔴 Reads TELEMETRY_E2E_DATABASE_URL. Never `@/server/db`, never
 * SUPABASE_DATABASE_URL — it must be impossible for this to touch production.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '@/server/db/schema';
import { handleTelemetryPost } from '@/server/telemetry/http-handler';
import { safeUserHash } from '@/server/telemetry/sanitize';
import { fingerprint } from '@/server/telemetry/fingerprint';
import {
    distinctUsersForFingerprint,
    fingerprintLeaderboard,
    errorRateOverTime,
    spikeDetection,
    bootPhaseFailureRanking,
} from '@/server/telemetry/queries';
import { resetLoadShedCacheForTests } from '@/server/telemetry/load-shed';

const URL_ = process.env.TELEMETRY_E2E_DATABASE_URL;
if (!URL_) throw new Error('TELEMETRY_E2E_DATABASE_URL is required — refusing to guess a database.');
if (/supabase\.co|pooler\.supabase/i.test(URL_)) {
    throw new Error('Refusing to run against what looks like a hosted Supabase URL.');
}

const results: Array<[boolean, string, string?]> = [];
const ok = (cond: boolean, name: string, extra?: string) => results.push([!!cond, name, extra]);

// ── 1. Stand up the browser globals the shipped shell module needs ──────────
// Exactly the shape `telemetry.js`'s `bootPayload()` reads. No jsdom: the
// module is deliberately a leaf with no DOM dependency beyond addEventListener.
let sentBody: string | null = null;
const listeners: Record<string, Array<(e: unknown) => void>> = {};

(globalThis as Record<string, unknown>).window = {
    __EZIL_BOOT__: {
        user: { id: '11111111-1111-4111-8111-111111111111' },
        desktopState: { endpoints: { telemetry: '/api/shell/telemetry' } },
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
        (listeners[type] ??= []).push(fn);
    },
};
(globalThis as Record<string, unknown>).document = {
    visibilityState: 'visible',
    addEventListener: (type: string, fn: (e: unknown) => void) => {
        (listeners[type] ??= []).push(fn);
    },
};
// No sendBeacon -> the module falls through to its `fetch` transport, which is
// what we intercept. (Both transports send the identical body.)
(globalThis as Record<string, unknown>).navigator = {};
(globalThis as Record<string, unknown>).fetch = (_url: string, init: { body: string }) => {
    sentBody = init.body;
    return Promise.resolve({ ok: true });
};

// ── 2. Import the SHIPPED shell module and produce events through it ────────
// The SHIPPED shell module, by relative path out of `app/` into `shell/` —
// there is no package boundary between them, and importing a copy would defeat
// the entire point of this file.
// No cast: `telemetry.js`'s JSDoc gives TypeScript a real signature here, so
// this import is itself a contract check between the two trees.
const telemetry = (await import('../../shell/ezil/telemetry.js')).default;

const COMPUTER_ID = '22222222-2222-4222-8222-222222222222';

// One of each interesting class, produced the way the real call sites do.
telemetry.capture({
    eventClass: 'api_failure',
    site: 'ezil-os:settings/troubleshoot#restart',
    code: 'stop_timed_out',
    detail: 'restart rejected for https://api-desktop.ezil.org/sandbox/guac-abc/restart',
    computerId: COMPUTER_ID,
    attrs: { status: 500, retryable: false },
});
// 🔴 THE PATH LEAK, verbatim. Before the path rules landed in `redact()` /
// `sanitizeErrorMessage()`, THIS string was measured at the far end of this
// exact chain and `ezil_error_events.detail` held it with the username and
// the project name intact:
//
//   restart rejected for <url> after 20001ms for u_b6b2f6a3 at
//   /home/user1/workspace/proj-1 (cid_abc1, computer <uuid>, port :8444)
//
// `docs/telemetry.md` promises, under "What is never collected", that
// workspace paths never reach storage. Step 4b below reads the stored row
// back out of Postgres and proves it.
const PATH_LEAK_DETAIL =
    'restart rejected for https://api-desktop.ezil.org/sandbox/guac-abc/restart after 20001ms ' +
    'for u_b6b2f6a3 at /home/user1/workspace/proj-1 ' +
    '(cid_abc1, computer 33333333-3333-4333-8333-333333333333, port :8444)';
telemetry.capture({
    eventClass: 'api_failure',
    site: 'ezil-os:settings/troubleshoot#restart',
    code: 'restart_rejected',
    detail: PATH_LEAK_DETAIL,
    computerId: COMPUTER_ID,
    attrs: { status: 409, retryable: true },
});
telemetry.capture({
    eventClass: 'crash',
    site: 'ezil-os:window#onerror',
    code: 'TypeError',
    detail: "Cannot read properties of undefined (reading 'foo')",
    attrs: { stack_head: 'openWindow@UIWindow.js' },
});
telemetry.capture({
    eventClass: 'boot_summary',
    site: 'ezil-os:boot#summary',
    code: 'ready',
    outcome: 'ok',
    durationMs: 21_400,
    attrs: { phases: 9, total_ms: 21_400 },
});

// Force the flush the same way a real `pagehide` does.
for (const fn of listeners.pagehide ?? []) fn({});

ok(sentBody !== null, 'the shell module actually put a body on the wire');
const wire = JSON.parse(sentBody ?? '{}') as { schemaVersion: number; events: Record<string, unknown>[] };
ok(wire.events?.length === 4, 'all four captured events reached the wire', `got ${wire.events?.length}`);

// Privacy assertions on the ACTUAL bytes the shell sends.
ok(!/11111111-1111-4111-8111-111111111111/.test(sentBody ?? ''), '🔴 the raw user id is NOT on the wire');
ok(!/userId|email|cookie|authorization/i.test(sentBody ?? ''), '🔴 no identity/credential key on the wire');
ok(
    !/api-desktop\.ezil\.org/.test(sentBody ?? ''),
    '🔴 the URL in the detail string was redacted before the wire',
);
ok(
    !/\/home\/|user1|proj-1/.test(sentBody ?? ''),
    '🔴 the absolute workspace path was redacted before the wire (client, first line of defence)',
);

// ── 3. Feed those exact bytes to the SHIPPED route core ─────────────────────
const client = postgres(URL_, { max: 4, prepare: false });
const db = drizzle(client, { schema });
resetLoadShedCacheForTests();

const USER_ID = '11111111-1111-4111-8111-111111111111';
const userHash = safeUserHash(USER_ID);
ok(/^u_[0-9a-f]{8}$/.test(userHash), 'server-derived userHash matches the Worker precedent shape', userHash);

// The computer row the FK needs. Created here, in the throwaway DB only.
await client`insert into auth.users (id, instance_id, aud, role, email)
             values (${USER_ID}::uuid, '00000000-0000-0000-0000-000000000000'::uuid,
                     'authenticated', 'authenticated', 'e2e@example.invalid')
             on conflict do nothing`;
await client`insert into ezil_computers (id, user_id, name, slot)
             values (${COMPUTER_ID}::uuid, ${USER_ID}::uuid, 'e2e', 1)
             on conflict do nothing`;

let scheduled: Array<() => void | Promise<void>> = [];
const post = (body: string, user: { id: string } | null = { id: USER_ID }) =>
    handleTelemetryPost(new Request('https://ezil-os.vercel.app/api/shell/telemetry', { method: 'POST', body }), {
        getContext: async () => ({ user, db }),
        schedule: (w) => { scheduled.push(w); },
    });

const res1 = await post(sentBody ?? '');
ok(res1.status === 202, 'ingest answers 202', String(res1.status));
for (const w of scheduled) await w();
scheduled = [];

// ── 4. It landed ────────────────────────────────────────────────────────────
const rows = await client`select event_class, source, site, code, outcome, detail, duration_ms,
                                 computer_id, attrs, user_hash, fingerprint
                          from ezil_error_events order by event_class, code`;
ok(rows.length === 4, '🔴 FOUR ROWS LANDED IN POSTGRES', `got ${rows.length}`);
ok(rows.every((r) => r.user_hash === userHash), 'every row carries the server-derived user_hash');
ok(rows.every((r) => r.source === 'shell'), 'source survived as shell');
const apiRow = rows.find((r) => r.code === 'stop_timed_out');
ok(apiRow?.site === 'ezil-os:settings/troubleshoot#restart', 'site survived field-for-field', String(apiRow?.site));
ok(apiRow?.code === 'stop_timed_out', 'code survived field-for-field', String(apiRow?.code));
ok(apiRow?.computer_id === COMPUTER_ID, 'computerId survived as a real FK-checked uuid');
ok(
    JSON.stringify(apiRow?.attrs) === JSON.stringify({ status: 500, retryable: false }),
    'per-class attrs allow-list kept status+retryable',
    JSON.stringify(apiRow?.attrs),
);
const crashRow = rows.find((r) => r.event_class === 'crash');
ok(
    JSON.stringify(crashRow?.attrs) === JSON.stringify({ stack_head: 'openWindow@UIWindow.js' }),
    'crash kept only stack_head',
    JSON.stringify(crashRow?.attrs),
);
const bootRow = rows.find((r) => r.event_class === 'boot_summary');
ok(bootRow?.outcome === 'ok' && bootRow?.duration_ms === 21400, 'boot_summary kept outcome + durationMs');
ok(rows.every((r) => /^fp_[0-9a-f]{16}$/.test(String(r.fingerprint))), 'every fingerprint satisfies the CHECK');
ok(
    apiRow?.fingerprint ===
        fingerprint({
            eventClass: 'api_failure',
            source: 'shell',
            site: 'ezil-os:settings/troubleshoot#restart',
            code: 'stop_timed_out',
            detail: String(apiRow?.detail ?? ''),
        }),
    'the stored fingerprint is reproducible from the stored fields',
);
ok(
    !String(apiRow?.detail ?? '').includes('api-desktop'),
    '🔴 no URL survived into the stored detail',
    String(apiRow?.detail),
);

// ── 4b. 🔴 THE PATH LEAK, read back out of Postgres ─────────────────────────
// This is the assertion the whole change exists for. `detail` is the column
// that was holding `/home/user1/workspace/proj-1`; `normalized_detail` (the
// fingerprint's input) always looked clean, which is exactly why the leak
// survived review. Both are checked, and so is the other direction: the row
// has to remain diagnostically useful, or the redactor traded one bug for
// another.
const leakRow = rows.find((r) => r.code === 'restart_rejected');
const storedDetail = String(leakRow?.detail ?? '');
const [{ normalized_detail: storedNormalized }] =
    await client`select normalized_detail from ezil_error_fingerprints where fingerprint = ${String(leakRow?.fingerprint)}`;
ok(leakRow !== undefined, '🔴 the path-bearing event landed as its own row');
for (const forbidden of ['/home', 'user1', 'proj-1', 'workspace/']) {
    ok(!storedDetail.includes(forbidden), `🔴 STORED detail contains no "${forbidden}"`, storedDetail);
    ok(!String(storedNormalized).includes(forbidden), `stored normalized_detail contains no "${forbidden}"`);
}
ok(
    !/(?:^|[\s'"(=])~?\/[\w.@%+~-]/.test(storedDetail),
    '🔴 STORED detail contains no absolute path of ANY shape',
    storedDetail,
);
ok(storedDetail.includes('<path>'), 'the location was replaced with <path>, not deleted', storedDetail);
ok(
    storedDetail.includes('port :8444') &&
        storedDetail.includes('20001ms') &&
        storedDetail.includes('cid_abc1') &&
        storedDetail.includes('restart rejected'),
    '🔴 and the row is still ACTIONABLE: port, duration and correlation id all survived',
    storedDetail,
);
ok(
    storedDetail ===
        'restart rejected for <url> after 20001ms for u_b6b2f6a3 at <path> ' +
            '(cid_abc1, computer <uuid>, port :8444)',
    '🔴 the stored detail is exactly the redacted form, character for character',
    storedDetail,
);

const fps = await client`select fingerprint, total_count from ezil_error_fingerprints`;
ok(fps.length === 4, 'four dimension rows upserted', `got ${fps.length}`);
ok(fps.every((f) => Number(f.total_count) === 1), 'total_count rolled up to 1 each');
const hours = await client`select fingerprint, user_hash, event_count from ezil_error_user_hours`;
ok(hours.length === 4, 'four user-hour rollup rows', `got ${hours.length}`);

// ── 5. Idempotency — the same batch again must not double-count ─────────────
await post(sentBody ?? '');
for (const w of scheduled) await w();
scheduled = [];
const [{ n: eventCount }] = await client`select count(*)::int as n from ezil_error_events`;
ok(eventCount === 4, '🔴 a re-sent batch is a no-op (eventId is the idempotency key)', `n=${eventCount}`);
const fps2 = await client`select total_count from ezil_error_fingerprints`;
ok(fps2.every((f) => Number(f.total_count) === 1), '🔴 total_count did NOT double on the replay');
const hours2 = await client`select event_count from ezil_error_user_hours`;
ok(hours2.every((h) => Number(h.event_count) === 1), '🔴 rollup event_count did NOT double on the replay');

// ── 6. The aggregation queries read it back ─────────────────────────────────
const fpApi = String(apiRow?.fingerprint);
const q1 = await distinctUsersForFingerprint(db, fpApi, 24);
ok(q1.distinctUsers === 1 && q1.events === 1, 'Q1 distinct-users returns the row', JSON.stringify(q1));
const q2 = await fingerprintLeaderboard(db, { windowHours: 24, limit: 10 });
// THREE, not four: the leaderboard filters `e.outcome = 'error'` on purpose, and
// the boot_summary event is outcome 'ok' — it is the DENOMINATOR, not an error.
ok(q2.length === 3, 'Q2 leaderboard returns the three error fingerprints, excluding the ok boot_summary', `len=${q2.length}`);
ok(
    q2.some((r) => r.fingerprint === fpApi && Number(r.distinctUsers) === 1),
    'Q2 counts distinct users, not rows',
);
const q3 = await errorRateOverTime(db, { hours: 24 });
ok(q3.length >= 1 && q3.some((b) => Number(b.errors) > 0), 'Q3 error-rate-over-time has a non-empty bucket');
const q4 = await spikeDetection(db);
ok(Array.isArray(q4), 'Q4 spike detection runs against real SQL');
const q5 = await bootPhaseFailureRanking(db, 24);
ok(Array.isArray(q5), 'boot-phase failure ranking runs against real SQL');

// ── 6b. 🔴 THE HEADLINE FEATURE, re-proved after the redaction change ───────
// Two DIFFERENT people hitting the SAME bug in their OWN workspaces must fold
// into ONE fingerprint with `distinctUsers = 2`. That is the single question
// this whole system exists to answer, and it is exactly the property a
// redaction change can silently destroy: if the per-user path survived into
// the fingerprint's input, each user would get their own fingerprint and
// every count would read 1.
//
// This is now a STRONGER property than before the path rules landed. It used
// to hold only because `normalizeDetail`'s N9 erased the paths on the way to
// the hash while `detail` kept them; now the two users' STORED details are
// identical too, so the fold is visible in the raw rows and not just in the
// hash.
const USER_ID_2 = '44444444-4444-4444-8444-444444444444';
const userHash2 = safeUserHash(USER_ID_2);
ok(userHash2 !== userHash, 'the two users hash to different correlation keys', `${userHash} vs ${userHash2}`);

// Same eventClass/site/code, different workspace path — i.e. the same bug,
// two people. Produced through the SHIPPED shell module, like everything else.
// Different depths and different names on purpose: the fold must survive the
// paths being structurally unalike, not just differing in one segment.
for (const path_ of ['/home/alice/workspace/blog-rewrite/src/index.ts', '/home/bob/workspace/shop-2/app/page.tsx']) {
    telemetry.capture({
        eventClass: 'window_error',
        site: 'ezil-os:apps/code#open',
        code: 'open_failed',
        detail: `could not open editor at ${path_} after 1200ms`,
        attrs: { app_id: 'code' },
    });
}
for (const fn of listeners.pagehide ?? []) fn({});
const shared = JSON.parse(sentBody ?? '{}') as { schemaVersion: number; events: Record<string, unknown>[] };
ok(shared.events?.length === 2, 'both same-bug events reached the wire', `got ${shared.events?.length}`);
ok(
    !/alice|bob|blog-rewrite|shop-2/.test(sentBody ?? ''),
    '🔴 neither user\'s workspace path is on the wire',
);

// One event per user, through the real route core, as two separate sessions.
for (const [i, uid] of [USER_ID, USER_ID_2].entries()) {
    await post(JSON.stringify({ schemaVersion: shared.schemaVersion, events: [shared.events[i]] }), { id: uid });
    for (const w of scheduled) await w();
    scheduled = [];
}

const sharedRows = await client`select user_hash, fingerprint, detail
                                from ezil_error_events where code = 'open_failed' order by user_hash`;
ok(sharedRows.length === 2, 'both rows landed', `got ${sharedRows.length}`);
ok(
    new Set(sharedRows.map((r) => String(r.user_hash))).size === 2,
    'the two rows carry two different user_hashes',
    sharedRows.map((r) => String(r.user_hash)).join(','),
);
const sharedFps = new Set(sharedRows.map((r) => String(r.fingerprint)));
ok(
    sharedFps.size === 1,
    '🔴 TWO USERS, ONE FINGERPRINT — the per-user path did not fragment it',
    [...sharedFps].join(','),
);
ok(
    new Set(sharedRows.map((r) => String(r.detail))).size === 1,
    'and their STORED details are now identical too, not just their hashes',
    sharedRows.map((r) => String(r.detail)).join(' | '),
);
ok(
    sharedRows.every((r) => !/alice|bob|blog-rewrite|shop-2|\/home/.test(String(r.detail))),
    '🔴 neither stored detail names a user or a project',
    String(sharedRows[0]?.detail),
);
const fpShared = [...sharedFps][0]!;
const q1b = await distinctUsersForFingerprint(db, fpShared, 24);
ok(
    q1b.distinctUsers === 2 && q1b.events === 2,
    '🔴 Q1 REPORTS distinctUsers = 2 FOR THAT ONE FINGERPRINT',
    `${fpShared} -> ${JSON.stringify(q1b)}`,
);
const [{ n: sharedHourRows }] =
    await client`select count(*)::int as n from ezil_error_user_hours where fingerprint = ${fpShared}`;
ok(sharedHourRows === 2, 'the user-hour rollup also has one row per user for that fingerprint', `n=${sharedHourRows}`);

// ── 7. Hostile input still 202s and writes nothing extra ────────────────────
// Re-read rather than reusing step 5's `eventCount`: step 6b legitimately
// added two more rows, and a stale baseline here would make this assertion
// pass for the wrong reason.
const [{ n: before }] = await client`select count(*)::int as n from ezil_error_events`;
for (const bad of [
    'not json at all',
    JSON.stringify({ schemaVersion: 1, events: [{ eventId: 'nope', schemaVersion: 1 }] }),
    // The leak attempt the .strict() guard exists for.
    JSON.stringify({
        schemaVersion: 1,
        events: [{ ...wire.events[0], eventId: '33333333-3333-4333-8333-333333333333', userId: USER_ID }],
    }),
]) {
    const r = await post(bad);
    ok(r.status === 202, `hostile body -> 202 (${bad.slice(0, 24)}…)`, String(r.status));
    for (const w of scheduled) await w();
    scheduled = [];
}
const [{ n: after }] = await client`select count(*)::int as n from ezil_error_events`;
ok(after === before, '🔴 hostile bodies wrote nothing, including the userId smuggling attempt', `n=${after}`);

// Unauthenticated -> 202, nothing scheduled, nothing written.
const rAnon = await post(sentBody ?? '', null);
ok(rAnon.status === 202 && scheduled.length === 0, '🔴 unauthenticated -> 202 and NOTHING scheduled');

// ── 8. Reversibility + the un-applied-migration safety contract ─────────────
// Drop the three tables (the exact DOWN below) and prove the OS-facing
// contract still holds: 202, no throw, nothing to see.
await client.unsafe(`
    DROP TABLE IF EXISTS "ezil_error_user_hours";
    DROP TABLE IF EXISTS "ezil_error_events";
    DROP TABLE IF EXISTS "ezil_error_fingerprints";
`);
const [{ n: leftovers }] =
    await client`select count(*)::int as n from pg_tables where schemaname='public' and tablename like 'ezil_error%'`;
ok(leftovers === 0, 'DOWN removes all three tables', `n=${leftovers}`);
const [{ n: computersLeft }] =
    await client`select count(*)::int as n from pg_tables where schemaname='public' and tablename='ezil_computers'`;
ok(computersLeft === 1, '🔴 DOWN leaves ezil_computers (and every 0000 object) untouched');

resetLoadShedCacheForTests();
let threw = false;
let statusNoTable = 0;
const t0 = Date.now();
try {
    const r = await post(sentBody ?? '');
    statusNoTable = r.status;
    for (const w of scheduled) await w();
    scheduled = [];
} catch {
    threw = true;
}
const elapsed = Date.now() - t0;
ok(!threw, '🔴 WITH NO TABLE PRESENT, ingest does not throw');
ok(statusNoTable === 202, '🔴 WITH NO TABLE PRESENT, ingest still answers 202', String(statusNoTable));
ok(elapsed < 5_000, 'and it answered promptly, not after a hang', `${elapsed}ms`);

await client.end({ timeout: 5 });

// ── report ──────────────────────────────────────────────────────────────────
let failed = 0;
for (const [pass, name, extra] of results) {
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
