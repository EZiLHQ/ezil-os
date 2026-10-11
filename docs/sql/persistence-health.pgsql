-- Persistence signal contract §1–2. Same query as persistenceHealth().
-- Run: python3 .ci-support/supabase-sql.py query --project <ref> --file docs/sql/persistence-health.pgsql (the helper supplies the read-only transaction).
-- Deliberately .pgsql, not .sql: every *.sql in this repo must be a registered production migration (.github/scripts/production-migrations.mjs).
-- The seven-day window is based on receipt time; ordering uses occurrence time.
-- Both ages are the latest worker event's own attrs at lastWorkerEventAt;
-- missing/-1 is unknown. Daily drain lag never increases ages or flags health.
-- Flag pause codes, system age > 1800 unless the latest worker event is a stop,
-- or the latest shell pause report. Heartbeat time is display-only.
-- Only MD5 prefixes leave SQL.

WITH clock AS (
  SELECT now() AS at
), recent AS (
  SELECT e.computer_id, e.event_id, e.source, e.site, e.code, e.outcome,
         e.attrs, e.occurred_at, e.received_at
  FROM   ezil_error_events e CROSS JOIN clock c
  WHERE  e.event_class = 'persistence'
    AND  e.computer_id IS NOT NULL
    AND  e.received_at >= c.at - interval '7 days'
    AND  e.received_at <= c.at
), latest AS (
  SELECT DISTINCT ON (computer_id) computer_id, site, attrs, occurred_at
  FROM   recent
  WHERE  source = 'worker'
    AND  site <> 'persist.shell_seen'
  ORDER  BY computer_id, occurred_at DESC, received_at DESC, event_id DESC
), shell_events AS (
  SELECT DISTINCT ON (computer_id) computer_id, code
  FROM   recent
  WHERE  source = 'shell' AND site = 'persist.shell_seen'
  ORDER  BY computer_id, occurred_at DESC, received_at DESC, event_id DESC
), restores AS (
  SELECT DISTINCT ON (computer_id) computer_id,
         jsonb_build_object('site', site, 'code', code,
                            'outcome', outcome, 'at', occurred_at) AS restore
  FROM   recent
  WHERE  site IN ('persist.system.restore', 'persist.workspace.restore')
  ORDER  BY computer_id, occurred_at DESC, received_at DESC, event_id DESC
), system_events AS (
  SELECT DISTINCT ON (computer_id) computer_id, code
  FROM   recent
  WHERE  site IN ('persist.system.flush', 'persist.system.restore')
  ORDER  BY computer_id, occurred_at DESC, received_at DESC, event_id DESC
), workspace_events AS (
  SELECT DISTINCT ON (computer_id) computer_id, code
  FROM   recent
  WHERE  site IN ('persist.workspace.flush', 'persist.workspace.restore')
  ORDER  BY computer_id, occurred_at DESC, received_at DESC, event_id DESC
), totals AS (
  SELECT computer_id,
         count(*) FILTER (WHERE site = 'persist.stop'
           AND attrs -> 'discarded_unsaved' = 'true'::jsonb)::int AS discarded,
         max(occurred_at) FILTER (WHERE site = 'persist.heartbeat') AS heartbeat_at,
         max(occurred_at) AS seen_at
  FROM   recent
  GROUP  BY computer_id
), health AS (
  SELECT left(md5(t.computer_id::text), 8) AS "computerShort",
         r.restore AS "lastRestore",
         s.code AS "systemCode", w.code AS "workspaceCode",
         CASE WHEN jsonb_typeof(l.attrs -> 'system_age_s') = 'number'
              THEN nullif((l.attrs ->> 'system_age_s')::double precision, -1)
         END AS "systemOkAgeS",
         CASE WHEN jsonb_typeof(l.attrs -> 'workspace_age_s') = 'number'
              THEN nullif((l.attrs ->> 'workspace_age_s')::double precision, -1)
         END AS "workspaceOkAgeS",
         t.discarded AS "discardedUnsaved",
         t.heartbeat_at AS "lastHeartbeatAt", t.seen_at AS "lastSeenAt",
         l.occurred_at AS "lastWorkerEventAt",
         l.site AS "lastWorkerEventSite", sh.code AS "shellCode"
  FROM   totals t
  LEFT   JOIN latest l USING (computer_id)
  LEFT   JOIN shell_events sh USING (computer_id)
  LEFT   JOIN restores r USING (computer_id)
  LEFT   JOIN system_events s USING (computer_id)
  LEFT   JOIN workspace_events w USING (computer_id)
)
SELECT h."computerShort", h."lastRestore", h."systemCode", h."workspaceCode",
       h."systemOkAgeS", h."workspaceOkAgeS", h."discardedUnsaved",
       h."lastHeartbeatAt", h."lastSeenAt", h."lastWorkerEventAt",
       coalesce("systemCode" IN ('too_large', 'stale', 'not_restored'), false)
       OR coalesce("workspaceCode" IN ('too_large', 'stale', 'not_restored'), false)
       OR coalesce("lastWorkerEventSite" <> 'persist.stop' AND "systemOkAgeS" > 1800, false)
       OR coalesce("shellCode" IN ('too_large', 'stale', 'not_restored'), false) AS flagged
FROM   health h
ORDER  BY flagged DESC, "lastSeenAt" DESC, "computerShort";
