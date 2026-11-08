# Feedback report bundle — staged handoff, 2026-11-08

Founder-authorized extension of the pinned feedback contract. Base:
`origin/staging/os-union-20261106` at `ffb32293`; implementation branch:
`feat/feedback-report-bundle-20261108`. No migration or new dependency.

## Reporter flow

Settings → Feedback opens the form. Bug reports require a summary, what the user
was doing, reproduction steps, expected result, actual result, reproducibility
(Every time / Sometimes / Once / Not sure) and impact (Blocked / Workaround
available / Minor issue). These become headings in the existing `description`.
The total is at most 4,000 UTF-16 code units, including headings and separators;
over-length submissions are disabled with a visible counter, never truncated.
Ideas and Other keep one description. Changing category preserves the bug fields.
Older free-text bug reports remain valid on the server.

Per-account drafts retain every structured field and the request ID. Neither
consent nor images are remembered in drafts. Submission moves a draft into the
local outbox, together with the exact consented request body. Definitive refusals
restore it; unknown outcomes retry the same ID. Closing a pending send permits a
new independent draft. Storage remains best-effort and the outbox holds ten
reports. User-authored text is subject to the existing server credential redactor.

Settings → Feedback now shows each persisted status and has a Refresh status
button. Troubleshoot retains its existing report deletion flow and legacy list without status;
adding status there requires coordinator ownership of `shell/ezil/ui/Settings/tabs/troubleshoot.js:482`. The admin changes
status; there are no emails, notifications, comments or automatic user messages.

## Optional screenshot

Enable `EZIL_OS_FEEDBACK=1` and `EZIL_OS_FEEDBACK_SCREENSHOTS=1` on the receiving
server, and satisfy `FEEDBACK_PILOT_EMAILS` if configured. New boot payloads expose
the resulting screenshot flag. The form explains when the flag is disabled.
Checkbox consent starts OFF. Capture EZiL OS window uses existing DOM capture and
masks embedded apps/private controls. Tab capture is offered only when supported
and opens the browser's own surface picker; it does not secretly choose a screen.
Desktop capture is offered only for the registered stream bridge. An unsupported
tab API gets explanatory text and the shell capture fallback.

Every capture enters the existing crop/redaction editor before attachment. The
attached preview offers Edit / crop / redact, starting from the already redacted
image, and Remove. Unchecking consent, navigating, closing the dialog or teardown
aborts capture/editor work; late results are discarded and late media grants are
stopped. Browser pickers cannot be programmatically dismissed. No image upload or
clipboard/paste handling was added. PNG/JPEG/WebP, 1.5 MiB decoded bytes, 4096 px
per side, existing image validation and attachment budgets remain in effect.

## Optional diagnostic snapshot

Consent starts OFF. No diagnostic payload is built until the user checks it.
The snapshot is frozen then; editing report text or submitting does not refresh
it. Refresh diagnostic snapshot explicitly replaces it. The preview JSON is the
initial request body, including that exact frozen snapshot.

Allowlisted contents, where available:

- Existing shell version, browser family/major, OS family, device class, viewport,
  full-screen/full-view state and ambient trace identifier (server UUID masking
  of that legacy identifier is unchanged).
- `session`: capture time (UTC ISO string), page age in milliseconds, online flag,
  visible/hidden page state, optional coarse network type (`slow-2g`, `2g`, `3g`,
  `4g`) and data-saver flag. No persistent support identifier is introduced.
- At most 50 newest events from the existing bounded local telemetry mirror:
  machine event class/site/code and nonnegative age relative to capture. Unsafe
  event strings are omitted; detail, outcome and stack/message text are excluded.
- At most 24 phases of the current or latest app-open trace: machine code and
  elapsed milliseconds. A detached read does not finish or mutate the trace.
- At most ten events carry validated failure reasons (96 characters) or
  server request correlations (64 characters). The server excludes correlations
  equal to reporter/computer IDs, sanitizes again and logs only the new report ID
  and validated failure references after commit, following origin/main's work.

This staging base's telemetry mirror does not produce the upstream failure
annotations yet. Their optional schema, validation and consumption are adapted
here, without importing unrelated main changes or changing telemetry producers.
They populate when compatible upstream producers land. Trace phases and event
ages work on this base already. No privileged device logs are available.

No console patching; no cookies, headers, tokens, raw URLs, DOM/form values,
arbitrary state, clipboard, browsing/keyboard/video recording or new background
uploads. Rendered status/stream DOM reads were removed from feedback diagnostics.
The existing independent telemetry upload behavior is unchanged.

The server always records report ID, server creation time and its deployed SHA,
including when diagnostics are OFF. Deep strict schemas reject unknown nested
fields; numeric fields are 0..1,000,000,000; trace code length is 40; session
network values are enums. Existing diagnostic fields retain their pinned limits.
Canonical report metadata without image is capped at 32 KiB even if screenshot
support is enabled. Total screenshot request cap remains 2.5 MiB.

## Compatibility and triage

With feedback enabled, boot advertises `ui.feedbackEventDiagnostics: true` and
`ui.feedbackReportBundle: true`. An absent capability omits the corresponding new
wire fields. During rollback, a 400 on expanded diagnostics retries once with
session, tracePhases, event age/reason/correlation removed. Text, screenshot and
client request ID are unchanged; the local outbox and open preview adopt the
fallback body. Other refusals are not retried by this compatibility path.

`/admin/feedback` still fails closed unless the current authenticated email is
in `FEEDBACK_ADMIN_EMAILS`. Lists/details show persisted status. The status server
action reauthenticates and permits only `new`, `investigating`, `resolved`.
An awaited audit row (`status_new`, `status_investigating`, `status_resolved`)
precedes the parameterized update of exactly the selected report ID. A failed
audit prevents the update. Audit records describe intent, not guaranteed success;
a concurrent delete can leave an attempted-status audit entry. Existing audited
reads and owner-scoped reporter list/delete endpoints are preserved.

## Coordinator handoff

The implementation changes only owned source/docs/artifact paths. Run artifacts
record exact results and limits. Shared Git metadata is read-only in the worker
sandbox: commit creation was attempted and refused at `index.lock`. The worker
must not claim a signed branch commit. Coordinator: stage the manifest's owned
paths explicitly and create DCO-signed commits after review.

`tools/test.sh app` in this base discards supplied test paths. Worker validation
uses an uncommitted scratch copy with paths forwarded and installed tools invoked
directly; no dependencies were installed. Coordinator fix: forward `"$@"` at
`tools/test.sh:380`. Full typecheck currently encounters missing AWS/Vercel modules
in the reused dependency tree; this is not reported as a pass.

The shell build was generated into `work/os`, not the shared shipped bundle.
Coordinator must regenerate and review `app/public/os/` during staging integration
(it is outside this task's owned paths). Browser checks exercise the new bug form
at 1440×900 and 390×844, but this worker's Chromium launch is blocked by sandbox
`Operation not permitted`. Rerun the focused browser runner with the newly built
bundle in a browser-capable environment. Real picker behavior, visual layout,
live database persistence and staged deployment have not been verified here.
No deploy, merge, push, PR publication, live write or peer-lane edit was performed.
