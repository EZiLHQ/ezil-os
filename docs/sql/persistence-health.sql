-- Persistence signal contract §1–2. Same query as persistenceHealth().
-- Run: python3 .ci-support/supabase-sql.py query --project <ref> --file docs/sql/persistence-health.sql (the helper supplies the read-only transaction).
-- The seven-day window is based on receipt time; ordering, activity, and
-- elapsed ages use occurrence time so delayed delivery cannot refresh them.
-- Both ages use the latest worker event with an age attr; missing/-1 is unknown.
-- Staleness uses the latest persistence event; a latest persist.stop is exempt.
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
  SELECT DISTINCT ON (computer_id) computer_id, attrs, occurred_at
  FROM   recent
  WHERE  source = 'worker'
    AND  site <> 'persist.shell_seen'
    AND  (attrs ? 'system_age_s' OR attrs ? 'workspace_age_s')
  ORDER  BY computer_id, occurred_at DESC, received_at DESC, event_id DESC
), latest_events AS (
  SELECT DISTINCT ON (computer_id) computer_id, site
  FROM   recent
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
                   + extract(epoch FROM (c.at - l.occurred_at))::double precision
         END AS "systemOkAgeS",
         CASE WHEN jsonb_typeof(l.attrs -> 'workspace_age_s') = 'number'
              THEN nullif((l.attrs ->> 'workspace_age_s')::double precision, -1)
                   + extract(epoch FROM (c.at - l.occurred_at))::double precision
         END AS "workspaceOkAgeS",
         t.discarded AS "discardedUnsaved",
         t.heartbeat_at AS "lastHeartbeatAt", t.seen_at AS "lastSeenAt",
         e.site AS "lastEventSite"
  FROM   totals t
  JOIN   latest_events e USING (computer_id)
  LEFT   JOIN latest l USING (computer_id)
  LEFT   JOIN restores r USING (computer_id)
  LEFT   JOIN system_events s USING (computer_id)
  LEFT   JOIN workspace_events w USING (computer_id)
  CROSS  JOIN clock c
)
SELECT h."computerShort", h."lastRestore", h."systemCode", h."workspaceCode",
       h."systemOkAgeS", h."workspaceOkAgeS", h."discardedUnsaved",
       h."lastHeartbeatAt", h."lastSeenAt",
       coalesce("systemCode" IN ('too_large', 'stale', 'not_restored'), false)
       OR coalesce("workspaceCode" IN ('too_large', 'stale', 'not_restored'), false)
       OR coalesce("lastSeenAt" >= c.at - interval '30 minutes'
                   AND "systemOkAgeS" > 1800, false)
       OR coalesce("lastSeenAt" < c.at - interval '30 minutes'
                   AND "lastEventSite" <> 'persist.stop'
                   AND "lastSeenAt" >= c.at - interval '2 hours', false) AS flagged
FROM   health h CROSS JOIN clock c
ORDER  BY flagged DESC, "lastSeenAt" DESC, "computerShort";
