/**
 * Durable, deduplicated incident alerts for real user failures, independent of feedback submission.
 *
 * Driven by the existing minute billing sweep (`/api/cron/billing-session-sweep`), before any billing dependency,
 * inside its own try: a fault here never touches billing and a billing fault never
 * stops this. The telemetry route is unchanged (still 202, no user impact): this only READS `ezil_error_events`.
 *
 * Per invocation, in one transaction holding an advisory lock (overlapping sweeps skip; provider acceptance followed by rollback can resend):
 *   1. expire stale unsent rows and old accepted ones;
 *   2. scan the last `scanWindowMs` of error events per fingerprint (muted ones excluded, none that already alerted within
 *      `cooldownMs`), judge each with `shouldAlert`, and enqueue at most `queueMax` pending rows;
 *   3. record collection health, and enqueue a `collection_silent` alert when no event has arrived for `silentAfterMs`
 *      (an empty table is not a healthy table);
 *   4. claim ONE due, unmuted row (`FOR UPDATE SKIP LOCKED`) unless the durable budget (`maxPerHour` accepted in the last
 *      hour) is spent, send it, and mark it accepted or back it off. One outbox row per fingerprint per cooldown bucket
 *      (`outbox_key`, unique); latency milestones are never failures.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { IncidentMailer, IncidentNotice } from './incident-alert-mail';
import { WORKER_SENTINEL_USER_HASH, TERMINAL_AI_CODES } from './types';

/** Minimal SQL port, independent of feedback and billing modules. */
export interface IncidentDb {
    transaction<T>(run: (tx: { execute(query: SQL): PromiseLike<unknown> }) => Promise<T>, config: { isolationLevel: 'read committed' }): Promise<T>;
}

const ALERT_LOCK = 0x455a696e;
const MINUTE = 60_000, HOUR = 3_600_000;

/** The explicit policy. Terminal classes are real failures at one user; the rest need several users, and an expected
 * transient (a warming computer) only counts when it persists across `transientMinSpanMs`. */
export const ALERT_POLICY = {
    scanWindowMs: 30 * MINUTE,
    cooldownMs: 6 * HOUR,
    queueMax: 50,
    scanLimit: 20,
    expireMs: 24 * HOUR,
    keepAcceptedMs: 7 * 24 * HOUR,
    silentAfterMs: 6 * HOUR,
    silentCooldownMs: 24 * HOUR,
    terminalClasses: ['crash', 'worker_exception', 'contract_violation'] as readonly string[],
    terminalMinUsers: 1,
    otherMinUsers: 3,
    /** Actionable on their own: a real failure code that one user is enough to act on. */
    singleUserCodes: ['computer_rebase_required', ...TERMINAL_AI_CODES] as readonly string[],
    transientCodes: ['sandbox_starting'] as readonly string[],
    transientMinUsers: 3,
    transientMinSpanMs: 10 * MINUTE,
    maxBackoffMs: 6 * HOUR,
    /** Durable global delivery budget: accepted alerts in the last hour. The queue holds the rest until it expires. */
    maxPerHour: 10,
} as const;

/** Latency milestones (`first_frame_*`, `first_input_*`) are timings, not failures, even when marked `error`. */
export const MILESTONE_SITE = 'ezil-os:apps/desktop#tti';

export interface AlertCandidate { eventClass: string; code: string; distinctUsers: number; events: number; firstAt: Date; lastAt: Date }

/** Pure threshold policy. `distinctUsers` already excludes the worker sentinel. */
export function shouldAlert(c: AlertCandidate): boolean {
    const p = ALERT_POLICY;
    if (p.transientCodes.includes(c.code)) return c.distinctUsers >= p.transientMinUsers && c.lastAt.getTime() - c.firstAt.getTime() >= p.transientMinSpanMs;
    if (p.terminalClasses.includes(c.eventClass) || p.singleUserCodes.includes(c.code)) return c.distinctUsers >= p.terminalMinUsers;
    return c.distinctUsers >= p.otherMinUsers;
}

export interface IncidentAlertCounts { enqueued: number; accepted: number; retry: number; dropped: number; skipped: boolean; silent: boolean; budget: boolean }
const list = (values: readonly string[]) => sql.join(values.map(v => sql`${v}`), sql`, `);
/** One outbox row per fingerprint per cooldown bucket, whoever races to insert it. */
const outboxKey = (fingerprint: string, now: Date, ms: number) => `${fingerprint}:${Math.floor(now.getTime() / ms)}`;
function rows<T>(result: unknown): T[] {
    return (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[];
}
const iso = (d: Date) => d.toISOString();

export async function drainIncidentAlerts(db: IncidentDb, mailer: IncidentMailer | null, now = new Date()): Promise<IncidentAlertCounts> {
    const p = ALERT_POLICY;
    return db.transaction(async tx => {
        const none: IncidentAlertCounts = { enqueued: 0, accepted: 0, retry: 0, dropped: 0, skipped: true, silent: false, budget: false };
        const lock = rows<{ locked: boolean }>(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${ALERT_LOCK}::int4, 0::int4) AS locked`))[0];
        if (!lock?.locked) return none;
        const expired = rows<{ n: number }>(await tx.execute(sql`WITH gone AS (
            DELETE FROM ezil_telemetry_alerts WHERE (accepted_at IS NULL AND created_at < ${iso(new Date(now.getTime() - p.expireMs))}::timestamptz)
                OR (accepted_at IS NOT NULL AND accepted_at < ${iso(new Date(now.getTime() - p.keepAcceptedMs))}::timestamptz)
            RETURNING accepted_at) SELECT count(*) FILTER (WHERE accepted_at IS NULL)::int AS n FROM gone`))[0]?.n ?? 0;
        const muted = rows<{ n: number }>(await tx.execute(sql`WITH gone AS (
            DELETE FROM ezil_telemetry_alerts a WHERE a.accepted_at IS NULL AND EXISTS (
                SELECT 1 FROM ezil_error_fingerprints f WHERE f.fingerprint = a.fingerprint AND f.muted_at IS NOT NULL)
            RETURNING 1) SELECT count(*)::int AS n FROM gone`))[0]?.n ?? 0;
        let dropped = expired + muted;
        // Detection reads telemetry even with sending off, so the queue and health stay truthful.
        const found = rows<{ fingerprint: string; eventClass: string; site: string; code: string; distinctUsers: number; events: number; firstAt: Date | string; lastAt: Date | string }>(await tx.execute(sql`
            SELECT e.fingerprint, min(e.event_class) AS "eventClass", min(e.site) AS site, min(e.code) AS code,
                count(DISTINCT e.user_hash) FILTER (WHERE e.user_hash <> ${WORKER_SENTINEL_USER_HASH})::int AS "distinctUsers",
                count(*)::int AS events, min(e.received_at) AS "firstAt", max(e.received_at) AS "lastAt"
            FROM ezil_error_events e
            LEFT JOIN ezil_error_fingerprints f ON f.fingerprint = e.fingerprint
            WHERE e.outcome = 'error' AND e.received_at >= ${iso(new Date(now.getTime() - p.scanWindowMs))}::timestamptz
                AND f.muted_at IS NULL
                AND NOT (e.site = ${MILESTONE_SITE} OR e.code ~ '^(first_frame|first_input)_')
                AND NOT EXISTS (SELECT 1 FROM ezil_telemetry_alerts a WHERE a.fingerprint = e.fingerprint
                    AND a.created_at > ${iso(new Date(now.getTime() - p.cooldownMs))}::timestamptz)
            GROUP BY e.fingerprint
            -- Thresholds apply here, before LIMIT, so ineligible fingerprints can never starve a critical one.
            HAVING CASE
                WHEN min(e.code) IN (${list(p.transientCodes)}) THEN
                    count(DISTINCT e.user_hash) FILTER (WHERE e.user_hash <> ${WORKER_SENTINEL_USER_HASH}) >= ${p.transientMinUsers}
                    AND max(e.received_at) - min(e.received_at) >= ${p.transientMinSpanMs} * interval '1 millisecond'
                WHEN min(e.event_class) IN (${list(p.terminalClasses)}) OR min(e.code) IN (${list(p.singleUserCodes)}) THEN
                    count(DISTINCT e.user_hash) FILTER (WHERE e.user_hash <> ${WORKER_SENTINEL_USER_HASH}) >= ${p.terminalMinUsers}
                ELSE count(DISTINCT e.user_hash) FILTER (WHERE e.user_hash <> ${WORKER_SENTINEL_USER_HASH}) >= ${p.otherMinUsers}
            END
            ORDER BY max(e.received_at) DESC LIMIT ${p.scanLimit}`));
        const due = found.map(r => ({ ...r, firstAt: new Date(r.firstAt), lastAt: new Date(r.lastAt) })).filter(shouldAlert);
        const pending = rows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM ezil_telemetry_alerts WHERE accepted_at IS NULL`))[0]?.n ?? 0;
        const room = Math.max(0, p.queueMax - pending);
        const enqueue = due.slice(0, room);
        dropped += due.length - enqueue.length;
        for (const r of enqueue) {
            await tx.execute(sql`INSERT INTO ezil_telemetry_alerts (outbox_key, fingerprint, event_class, site, code, distinct_users, event_count, window_start, window_end, created_at, attempts, next_attempt_at)
                VALUES (${outboxKey(r.fingerprint, now, p.cooldownMs)}, ${r.fingerprint}, ${r.eventClass}, ${r.site}, ${r.code}, ${r.distinctUsers}, ${r.events}, ${iso(r.firstAt)}::timestamptz, ${iso(r.lastAt)}::timestamptz, ${iso(now)}::timestamptz, 0, ${iso(now)}::timestamptz)
                ON CONFLICT (outbox_key) DO NOTHING`);
        }
        // Collection health: the newest event ever received. Silence past the threshold is itself an incident.
        const latest = rows<{ at: Date | string | null }>(await tx.execute(sql`SELECT max(received_at) AS at FROM ezil_error_events`))[0]?.at ?? null;
        const latestAt = latest ? new Date(latest) : null;
        await tx.execute(sql`INSERT INTO ezil_telemetry_alert_health (id, first_observed_at, last_scan_at, last_event_at, consecutive_failures, dropped_total)
            VALUES (1, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz, ${latestAt ? iso(latestAt) : null}::timestamptz, 0, ${dropped})
            ON CONFLICT (id) DO UPDATE SET last_scan_at = EXCLUDED.last_scan_at, last_event_at = EXCLUDED.last_event_at,
                dropped_total = ezil_telemetry_alert_health.dropped_total + EXCLUDED.dropped_total`);
        const health = rows<{ firstObservedAt: Date | string; silentAlertedAt: Date | string | null }>(await tx.execute(sql`SELECT first_observed_at AS "firstObservedAt", silent_alerted_at AS "silentAlertedAt" FROM ezil_telemetry_alert_health WHERE id = 1`))[0];
        const baseline = latestAt ?? new Date(health?.firstObservedAt ?? now);
        const silentFor = now.getTime() - baseline.getTime();
        const lastSilent = health?.silentAlertedAt ? new Date(health.silentAlertedAt).getTime() : 0;
        let silent = false;
        if (silentFor >= p.silentAfterMs && now.getTime() - lastSilent >= p.silentCooldownMs && room - enqueue.length > 0) {
            silent = true;
            await tx.execute(sql`INSERT INTO ezil_telemetry_alerts (outbox_key, fingerprint, event_class, site, code, distinct_users, event_count, window_start, window_end, created_at, attempts, next_attempt_at)
                VALUES (${outboxKey('collection_silent', now, p.silentCooldownMs)}, 'collection_silent', 'collection', 'telemetry_ingest', 'no_events', 0, 0, ${iso(baseline)}::timestamptz, ${iso(baseline)}::timestamptz, ${iso(now)}::timestamptz, 0, ${iso(now)}::timestamptz)
                ON CONFLICT (outbox_key) DO NOTHING`);
            await tx.execute(sql`UPDATE ezil_telemetry_alert_health SET silent_alerted_at = ${iso(now)}::timestamptz WHERE id = 1`);
        }
        const enqueued = enqueue.length + (silent ? 1 : 0);
        if (!mailer) return { enqueued, accepted: 0, retry: 0, dropped, skipped: true, silent, budget: false };
        const sent = rows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM ezil_telemetry_alerts WHERE accepted_at > ${iso(new Date(now.getTime() - HOUR))}::timestamptz`))[0]?.n ?? 0;
        if (sent >= p.maxPerHour) return { enqueued, accepted: 0, retry: 0, dropped, skipped: false, silent, budget: true };
        const notice = rows<IncidentNotice & { attempts: number }>(await tx.execute(sql`
            SELECT n.fingerprint, n.event_class AS "eventClass", n.site, n.code, n.distinct_users AS "distinctUsers", n.event_count AS events,
                n.window_start AS "windowStart", n.window_end AS "windowEnd", n.created_at AS "createdAt", n.attempts
            FROM ezil_telemetry_alerts n
            WHERE n.accepted_at IS NULL AND n.next_attempt_at <= ${iso(now)}::timestamptz
                AND NOT EXISTS (SELECT 1 FROM ezil_error_fingerprints f WHERE f.fingerprint = n.fingerprint AND f.muted_at IS NOT NULL)
            ORDER BY n.next_attempt_at, n.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`))[0];
        if (!notice) return { enqueued, accepted: 0, retry: 0, dropped, skipped: false, silent, budget: false };
        const normalized: IncidentNotice = { fingerprint: notice.fingerprint, eventClass: notice.eventClass, site: notice.site, code: notice.code,
            distinctUsers: notice.distinctUsers, events: notice.events, windowStart: new Date(notice.windowStart).toISOString(),
            windowEnd: new Date(notice.windowEnd).toISOString(), createdAt: new Date(notice.createdAt).toISOString() };
        let outcome;
        try { outcome = await mailer(normalized); } catch { outcome = { accepted: false as const }; }
        const key = sql`fingerprint = ${notice.fingerprint} AND created_at = ${normalized.createdAt}::timestamptz`;
        if (outcome.accepted) {
            await tx.execute(sql`UPDATE ezil_telemetry_alerts SET accepted_at = ${iso(now)}::timestamptz, provider_message_id = ${outcome.messageId}, attempts = attempts + 1 WHERE ${key}`);
            await tx.execute(sql`UPDATE ezil_telemetry_alert_health SET last_accepted_at = ${iso(now)}::timestamptz, consecutive_failures = 0 WHERE id = 1`);
            return { enqueued, accepted: 1, retry: 0, dropped, skipped: false, silent, budget: false };
        }
        const delayMs = Math.min(p.maxBackoffMs, MINUTE * 2 ** Math.min(9, notice.attempts));
        await tx.execute(sql`UPDATE ezil_telemetry_alerts SET attempts = attempts + 1, next_attempt_at = ${iso(new Date(now.getTime() + delayMs))}::timestamptz WHERE ${key}`);
        await tx.execute(sql`UPDATE ezil_telemetry_alert_health SET last_failure_at = ${iso(now)}::timestamptz, consecutive_failures = consecutive_failures + 1 WHERE id = 1`);
        return { enqueued, accepted: 0, retry: 1, dropped, skipped: false, silent, budget: false };
    }, { isolationLevel: 'read committed' });
}
