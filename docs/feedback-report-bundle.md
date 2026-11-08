# Feedback report bundle

Settings → Feedback now requires bug summary, activity, reproduction steps, expected
and actual results, reproducibility and impact. Ideas/Other remain a single description.
Sections become readable headings in the existing description column (4,000 combined
UTF-16 code units, including headings). The form never truncates sections. Existing
free-text API clients remain valid. No migration or new dependency is required.

## Screenshots

Consent starts OFF. Attach a static PNG/JPEG/WebP from any supported device, including
phones, or use the existing capture options. Imported files remain local: MIME/magic,
8 MiB source size and 4096px side bounds are checked before decoding, then checked again.
Animated WebP is refused. The canvas is scaled to a 1920px long edge.

Every import/capture enters the crop/redaction editor. Fresh flattened WebP/JPEG output
bakes the crop and black boxes into pixels; original filenames/metadata are not sent.
Users can preview, re-edit or remove it. Cancellation discards late decodes, releases
object URLs/bitmaps and stops media tracks. Shell capture masks private fields and
embedded frames. Tab capture requires browser support and its picker. The staging
source does not wire the optional remote-frame capture bridge; file import supplies
the phone fallback.

Enable EZIL_OS_FEEDBACK=1 and EZIL_OS_FEEDBACK_SCREENSHOTS=1 on the receiving server,
plus any FEEDBACK_PILOT_EMAILS eligibility, after verifying the existing feedback tables.
The boot payload controls availability. The older migration guide deliberately leaves
screenshots off; that is not proof of live flags.

Final images retain the 1.5 MiB/4096px API bounds and attachment budgets. Metadata is
capped at 32 KiB, full JSON at 2.5 MiB. Caddy permits 3 MB only for /api/shell/feedback
so valid base64 envelopes fit; other routes keep 2 MB.

## Diagnostics and compatibility

Consent starts OFF. Checking it freezes the snapshot; Refresh diagnostic snapshot
explicitly replaces it. The preview is the initial request body. Contents are bounded:
browser/OS/version/device/viewport/fullscreen, capture time/page age, online/visibility,
coarse network/data-saver state, at most 50 recent machine-coded events with ages,
and at most 24 current/latest app-open phases. Trace ID, built-in app identity and
phases come from the same detached snapshot, including completed app opens.
Validated request trace IDs are preserved; reporter/computer IDs are excluded.

Optional failure reason/server correlation annotations are limited to ten events.
Their validation/consumption is adapted from main; this staging base still lacks
upstream annotation producers, so those fields can be absent. No privileged device
or full computer logs are claimed.

No console interception, cookies/headers/tokens, raw URLs, DOM/form contents, clipboard,
arbitrary state dumps, keystrokes, browsing replay or video recording is added.
Independent existing telemetry is unchanged. The server sanitizes again and always
stamps report ID, server creation time and deployed SHA, including without consent.

feedbackReportBundle/feedbackEventDiagnostics boot capabilities gate expanded fields.
A rollback 400 retries once after removing only expanded diagnostic fields; text,
image and request ID remain. The open preview and outbox adopt the downgraded body.

## Delivery and triage

Account-scoped drafts retain all bug fields, never screenshot/consent. Submitted bodies
enter a ten-report retry outbox with stable IDs. New reports never evict pending ones.
Queue/quota failure retains text and truthfully explains automatic retry was not saved.
Editing an unconfirmed report forks its ID before a delayed prior receipt can hide edits.

The /admin/feedback action reauthenticates the allowlisted administrator, validates
new/investigating/resolved, awaits its audit row, then updates only the selected report
with bound SQL. Audit failure prevents change; audit records describe intent.
Settings → Feedback shows persisted status with Refresh status, using a list distinct
from Troubleshoot so the existing owner-scoped deletion flow remains usable.
Retention stays 30 days/images, 180/reports and 365/audit. No notification or automatic
code-fix dispatch is introduced.

## Verification and release

This isolated branch targets staging/os-union-20261106; active watcher/other lanes are
untouched. Rebuilt app/public/os bundles are committed because staging serves them.
Checks cover app typecheck/lint, server tests, disposable PostgreSQL persistence,
feedback/capture/import/trace regressions and real Chromium at 1440×900 and 390×844,
including actual cropped/redacted pixels and outgoing request bytes.

The EZiL Database MCP production copy (2026-11-08T02:15:02Z) does not expose OS feedback
tables and cannot establish live counts/persistence. No application DB was changed.
Deployment and screenshot flag enablement remain with the existing release owner,
as a separate reviewed candidate after the release currently in flight.

Signed-in staging acceptance: submit a non-sensitive image with diagnostics, verify
screenshotAccepted and authorized readback, update status and refresh the reporter,
then delete and check attachment removal. Verify consent-off and non-admin refusal
on that deployed build. Local checks do not establish deployed behavior.
