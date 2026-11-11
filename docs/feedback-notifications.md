# Feedback email notifications

Newly accepted feedback atomically enqueues server-only metadata with its report.
The app tries delivery after the successful response. The existing authenticated
minute billing sweep retries one due notification independently of billing setup.
SMTP2GO sends from the existing verified `invites@projects.ezil.work` domain to
`contact@ezil.work`. Mail contains category, report ID, submission time and an
authenticated admin link. Descriptions, diagnostics, user identifiers, screenshots
and provider credentials never enter email. The recipient needs the existing
feedback admin allowlist to open the link.

Retries have exponential backoff capped at six hours and no attempt-count drop.
Concurrent drains serialize with a transaction-scoped advisory lock. Acceptance
and provider message ID are stored durably. Provider acceptance does not prove
mailbox arrival. A process death after provider acceptance and before DB commit
can cause a duplicate on retry; SMTP2GO has no proven idempotency contract here.
A stable Message-ID identifies duplicates. User/admin deletion removes queued
metadata; the drain also removes orphan rows after retention.

## Rollout

Apply `0022_feedback_notifications.sql` before app code. It is additive, RLS on,
client roles revoked, and never baselined on production. The existing pinned
AWS production schema tool records its digest. No historical rows are enqueued.
For this incident, Root pinned notification coverage at `2026-11-11T18:36:00Z`.
This excludes the earlier 17:46 report and all historical feedback. Read only report
IDs, categories and creation times before capture; abort if more than 20 eligible
reports are found so the unexpected volume can be reviewed.
After app cutover, recover only the migration-to-app window with a guarded
transaction that locks reports in SHARE mode and notifications in SHARE ROW
EXCLUSIVE mode, then inserts metadata for reports at or after that pinned start
whose report IDs are absent from the queue. Those locks serialize with app inserts
and drains. Preserve the same timestamp on a retry. Do not backfill older reports.

Supply the existing approved SMTP2GO credential as server-only
`FEEDBACK_SMTP2GO_API_KEY` through the normal production secret CAS and env
renderer. The optional key must not be configured on staging or tests that should
not send real mail. Preserve all existing production secret fields. Missing key
leaves queued notifications intact. Removing it stops delivery without deleting
reports. Rollback to older app code keeps the additive queue inert; never drop
queued reports as an application rollback.

Verify with synthetic feedback through the normal authenticated endpoint and
inspect its durable queue acceptance and provider message ID. No real email is
sent by unit or PostgreSQL tests. Monitor `[feedback] notification sweep` retry
counts and fixed `notification delivery deferred`/`notification sweep unavailable`
logs; error details are deliberately not logged.
