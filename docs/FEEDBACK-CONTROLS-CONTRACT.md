# Floating controls + Feedback — pinned contract (v2 feedback extension, 2026-11-08)

The single source of truth for the parallel lanes. The founder authorized the
2026-11-08 feedback report-bundle extension below; unrelated lane contracts remain
unchanged. Historical plan of record:
`/root/.claude/plans/sprightly-bouncing-dusk.md` (founder defaults D1–D11 taken
as recommended).

## 1. Flags (server env → boot payload)

| Env var | Effect |
|---|---|
| `EZIL_OS_FLOATING_CONTROLS=1` | `desktopState.ui.floatingControls = true` — **not read in the round-3 feedback-only port**: the pill lane is not shipped, so `floatingControls` is always `false` |
| `EZIL_OS_FEEDBACK=1` | `desktopState.endpoints.feedback = '/api/shell/feedback'` (absent otherwise); route returns 404 when off |
| `EZIL_OS_FEEDBACK_SCREENSHOTS=1` | `desktopState.ui.feedbackScreenshots = true` (only meaningful with feedback on) |
| `FEEDBACK_PILOT_EMAILS` | comma list; when set, feedback (and screenshots) are on ONLY for these emails |
| `FEEDBACK_ADMIN_EMAILS` | comma list; `/admin/feedback` fail-closed when unset |

`app/src/server/shell/features.ts` → `shellFeaturesFor(email)` is the only reader.
Shell side: features are feature-detected exactly like `endpoints.focus`.

```
desktopState.ui = { floatingControls: boolean, feedbackScreenshots: boolean,
  feedbackEventDiagnostics?: true, feedbackReportBundle?: true, feedbackAppFailures?: true }
desktopState.endpoints.feedback?: '/api/shell/feedback'
```

### App failure context v1

See [FEEDBACK-APP-FAILURES-CONTRACT.md](FEEDBACK-APP-FAILURES-CONTRACT.md) for the
strict `diagnostics.appFailures` records (newest ten), category/code allowlist,
request-id exclusions, and consent rules. `desktopState.ui.feedbackAppFailures`
is `true` only when feedback is enabled; the shell omits these records without
the flag, and the existing `without_event_diagnostics` downgrade strips them.

## 2. Shell module APIs (stubs exist in base; owning lane replaces the body, never the signature)

### `shell/ezil/ui/app-drawer.js` (lane DRAWER)
`attach_app_drawer(el_window, options)` — legacy behaviour byte-for-byte unchanged when
`options.variant !== 'floating'`. Floating variant options:
```
{
  variant: 'floating',
  title: string, icon?: string,
  traffic: {
    on_close: () => void,          // red
    on_minimize: () => void,       // yellow
    on_expand: () => void,         // green (browser full screen toggle)
    expand_supported: boolean,     // false → green not rendered
  },
  overflow: Array<{ id: string, label: string, className?: string, onClick: () => void }>,
  on_feedback?: () => void,        // present → Feedback button rendered at the right end
  flash_on_attach?: boolean,
}
```
Returns the drawer element (`.dashboard-app-drawer.ezil-app-drawer.ezil-floating-drawer`) or
null; the element carries `drawer.ezil_controls = { set_status(text), set_fullscreen(bool),
reveal(), collapse(), focus_grabber(), add_overflow_item(item) }`.
Class hooks kept: red `.dashboard-app-drawer-btn.dashboard-app-drawer-close`, yellow
`.dashboard-app-drawer-btn.dashboard-app-drawer-minimize`, green `.ezil-traffic-expand`,
overflow items get `className` (Settings uses `dashboard-app-drawer-settings`, focus
uses `dashboard-app-drawer-focus-chromium`), feedback `.ezil-drawer-feedback`.
Toolbar: `role="toolbar"`, roving tabindex, ←/→/Home/End, Escape collapses and restores
previous focus; grabber first in Tab order with `aria-expanded`; green has `aria-pressed`;
status region `.ezil-drawer-status[aria-live=polite]`.
Modality: window gets `.ezil-floating-controls`; mode class on the drawer
`.ezil-mode-overlay` (fine pointer, hover, no `(any-pointer: coarse)`, device class not
phone/tablet) or `.ezil-mode-strip` (otherwise). Strip mode keeps main's reserved strip;
overlay mode sets strip height 0 and the collapsed tongue's hit box ≤ visible box + 4px
(no invisible pad). Reveal never changes the stream body size.
CSS lives in `shell/ezil/ui/floating-controls.css` (auto-included by build-shell.sh).

### `shell/ezil/ui/Settings/drawer-action.js` (lane DRAWER)
When the drawer has `.ezil-floating-drawer`, Settings is added via
`drawer.ezil_controls.add_overflow_item({ id:'settings', className:'dashboard-app-drawer-settings', ... })`.

### `shell/ezil/apps/desktop-window.js` (lane WINDOW)
Uses the floating variant iff `desktopState.ui.floatingControls === true` (else unchanged).
green → `document.documentElement.requestFullscreen()` / `document.exitFullscreen()`;
`fullscreenchange` → `set_fullscreen`; then ONE `measure_screen` after resize quiet ≥500 ms.
Red → `shell/ezil/ui/close-confirm.js` `confirm_close({ shared: boolean }) → Promise<'close'|'minimize'|'cancel'>`
(skipped when shared; "Don't ask again" in localStorage key `ezil:close-confirm:skip`, try/catch).
Focus-chromium progress text → `set_status`. On stream frame attach call
`register_capture_target(iframe, origin)` from the bridge; in `on_frame_message` call
`classify_frame_controls_message(ev, { origin, source })` and on `edge_reveal` → `reveal()`,
`controls_hotkey` → `reveal(); focus_grabber()`.

### `shell/ezil/ui/frame-controls-bridge.js` (lane NEKO)
```
classify_frame_controls_message(ev, { origin, source }) → null | { type: 'edge_reveal' | 'controls_hotkey' }
register_capture_target(iframe: HTMLIFrameElement, origin: string) → void
request_frame_capture({ timeoutMs = 4000, signal } = {}) → Promise<Blob | null>
```
Wire (shell→frame): `{ source:'ezil-shell', type:'frame_capture_request', nonce }` sent with
targetOrigin = registered origin. Frame→shell: `{ source:'ezil-mobile', type:'edge_reveal' }`,
`{ source:'ezil-mobile', type:'controls_hotkey' }`, `{ source:'ezil-mobile',
type:'frame_capture_result', nonce, blob: Blob|null }` — the result is posted ONLY to an
allow-listed parent origin, never `'*'`.

### `shell/ezil/ui/feedback/feedback.js` (lane FSHELL)
```
feedback_enabled() → boolean          // endpoints.feedback present
mount_feedback_chip() → void          // the tiny in-app icon (below), idempotent; boot calls it on every mount
resume_feedback_outbox() → void       // §4a resend + `online`/bfcache-restore watch, idempotent; called by mount_feedback_chip
open_feedback_dialog({ source: 'chip'|'pill'|'troubleshoot'|'settings' }) → void
list_my_reports() → Promise<Array<ReportSummary>>
delete_my_report(id) → Promise<boolean>
```
Founder, 2026-10-29: Feedback is not on the home screen; its main entry is Settings →
Feedback (`shell/ezil/ui/Settings/tabs/feedback.js`, shown only when `feedback_enabled()`).
`mount_feedback_chip()` mounts `button.ezil-feedback-chip`, the in-app icon: icon only,
`aria-label` and `title` "Send feedback", shown only while at least one app window is open
(`.window[data-app]` with a non-empty app, not an alert or file dialog, not minimised, not
closing, rendered; full-bleed included) and hidden on the home screen; a MutationObserver
on `<body>` follows windows opening, closing, minimising and restoring. Top-right corner,
level with the 30px window head (whose controls are on the left) or centred in the
full-bleed control strip, right of the centred drawer; never over window controls. The Code
window's full view (app-code lane A2, 2026-10-30; `docs/APP-CODE-FULL-VIEW.md`) uses the same
strip and the same `ezil-fullbleed` class, so the icon takes the same position there with no
Code-specific rule; that window's compact top bar puts the drawer at the left and ends its
minimise / restore / close at least 36px (fine) / 50px (coarse) short of the right edge, so
they never sit under the icon. With `floatingControls` on, the icon is hidden in every
full-bleed window, Code's included. A 16px
glyph on a 20px disc, low emphasis; hit target 24×24 on a fine pointer, 44×44 under
`pointer: coarse`. z-index above every app window (phone/tablet windows are `9999999
!important`), below context menus, the upgrade sheet and the dialog's top layer.
`shell/ezil/ui/feedback/diagnostics.js`: `build_diagnostics() → Diagnostics` (§3 shape only).
Teardown, history navigation and page exit close the form and any nested editor,
cancel pending captures, and discard late results without suppressing shell Back.
Editor Cancel returns to the draft; closing the form preserves its local text draft. Once submission starts,
the button says Close and explains that closing does not cancel the sent request.

### `shell/ezil/ui/feedback/capture.js` + `redact-editor.js` (lane FCAPTURE)
```
capture_shell_snapshot({ signal } = {}) → Promise<HTMLCanvasElement | null> // tier A, iframes → grey box
tab_capture_supported() → boolean
capture_tab_frame({ hide, signal } = {}) → Promise<HTMLCanvasElement | null> // tier B; MUST be called synchronously from a click
capture_desktop_frame({ signal } = {}) → Promise<HTMLCanvasElement | null>  // tier C via request_frame_capture
open_redact_editor(canvas, { signal } = {}) → Promise<{ blob: Blob, contentType: string, width: number, height: number } | null>
```
`signal` is an optional AbortSignal. Cancellation resolves null, removes waiting
listeners and stops acquired media tracks. A browser picker cannot be dismissed by
the page; a stream granted after cancellation is stopped immediately. Late decoded
bitmaps are closed and never reopen an editor or attach to another draft.

## 3. Wire format — `app/src/server/feedback/types.ts` is authoritative (zod)
POST `/api/shell/feedback` (JSON; `Content-Type: application/json` required, parameters such as
`charset` allowed — anything else is `415 {error:'unsupported_media_type'}` before the body is read,
so a cross-site simple form cannot post a report on the lax session cookie):
```
{ v: 1, clientRequestId: uuid, category: 'bug'|'idea'|'other', description: string 1..4000,
  computerId?: uuid|null, diagnostics?: Diagnostics|null,
  screenshot?: { contentType: 'image/png'|'image/jpeg'|'image/webp', dataBase64: string } | null }
Diagnostics (strict, every field optional):
{ shellVersion ≤64, appCommit ≤64, browser {family ≤32, major int}, os ≤32,
  deviceClass 'phone'|'tablet'|'desktop', viewport {w,h int, dpr number},
  fullscreen bool, fullbleed bool, computerStatus ≤32, traceId ≤64, phases string[≤24]≤40,
  recentEvents {eventClass ≤40, site ≤80, code ≤80, ageMs?: int, reason?: string≤96, correlationId?: string≤64}[≤50],
  session?: {capturedAt: UTC ISO string, pageAgeMs: int, online: bool, visibility: 'visible'|'hidden',
    network?: {effectiveType?: 'slow-2g'|'2g'|'3g'|'4g', saveData?: bool}},
  tracePhases?: {code: machine string≤40, tMs: int}[≤24], stream {state ≤24, kbps int, rttMs int} }
```
Responses: `201 {id, createdAt, screenshotAccepted}` · idempotent replay `200` same body ·
`400 {error:'invalid_request'}` · `401` · `404` (feature off) · `413` · `415` · `429 {error:'rate_limited'}`.
GET → `200 {reports:[{id, createdAt, category, descriptionPreview ≤140, hasScreenshot, status}]}` (newest first, ≤50).
DELETE `?id=<uuid>` → `204`; `404` if not the caller's.
Limits: canonical metadata without image ≤32 KiB even with screenshot support enabled; body 32 KiB without screenshot support, 2.5 MiB with; decoded image ≤1.5 MiB, ≤4096 px per side,
magic bytes must match contentType; rate 10/h and 30/day per user (DB count); global attachment
budget 500 MB/day and 5 GB total → over budget: report stored, `screenshotAccepted:false`.

## 4. Data (`app/src/server/db/schema/feedback.ts`, SQL in `app/src/server/feedback/migration-sql.ts`)
`ezil_feedback_reports`, `ezil_feedback_attachments`, `ezil_feedback_access_log` — no PKs,
defaults or constraints (production grammar). App-generated UUIDv4 ids. All reads/deletes scoped
by `user_id`. Admin reads write an access-log row first (no content if that write fails).
`ezil_feedback_reports.deploy_sha` is stamped server-side from the image's `EZIL_GIT_SHA` (the
same source as `/api/health`; null when unset or not a hex SHA) — never from the client, so it
is present even when the diagnostics consent is off. Shown on `/admin/feedback`.
Retention (telemetry-maintenance cron): attachments 30 d, reports 180 d, access log 365 d.
The SQL is also committed as `app/drizzle/0011_feedback.sql` (byte-identical to the constants),
registered in `.github/production-migrations.json` as a `snapshot` source for the os-staging
schema tool only (see `docs/feedback-migration.md`); it is refused for `aws-production`.

### 4a. Browser-local state (round 3; `shell/ezil/ui/feedback/feedback.js`)
Two `localStorage` keys per account, keyed by the opaque account id from
`__EZIL_BOOT__.user.id` (never the email), never sent anywhere:
- `ezil:feedback:draft:v1:<accountId>` — `{clientRequestId, category, description}` of the
  unsent form, plus `bug: {activity, steps, expected, actual, reproducibility, impact}`.
  Every structured field survives category changes and closing the dialog; removed when the form is emptied or a send with
  that id is confirmed (200/201). Consent boxes and screenshots are never remembered.
- `ezil:feedback:outbox:v1:<accountId>` — at most 10 `{clientRequestId, body, draft}` entries (draft retains structured text): the
  exact submitted request bodies (including any diagnostics the user consented to) that have
  not been confirmed. Re-sent byte-for-byte, same `clientRequestId` (except the explicit compatibility downgrade below), on the `online` event,
  when the shell mounts (boot → `mount_feedback_chip()` → `resume_feedback_outbox()`, whether
  or not an app window is open) and on a back/forward-cache restore (`pageshow` with
  `persisted`); each entry is sent once even when two flushes overlap. Removed on 200/201;
  dropped on a definitive 4xx (the text then returns to the draft). Storage failures
  (blocked, quota, private mode) only lose the convenience.
- Each POST has a client deadline, `send_deadline_ms(bodyLength)` = 45 s plus the time to
  upload the body at 4 KiB/s (`SEND_DEADLINE`): about 46-53 s for a text report and about
  9.5 min for a maximum screenshot (the client's 1.5 MiB image cap, about 2 MiB of base64).
  The deadline only stops the client giving up early; any server or proxy limit applies on
  its own (not measured here) and comes back as an answer or a network error. A 400 with
  the diagnostics downgrade gives the lean re-send its own deadline, so the worst case is
  twice that. Hitting the deadline aborts the request, including a stalled response body,
  and counts as an unanswered send: the entry stays queued, the form unlocks with "The
  server didn't answer in time… press Send to try again", and Send reuses its
  `clientRequestId`, which the server answers as a replay.
- A flush sends the queued entries smallest first, so text reports never wait behind a
  screenshot. A timed-out entry does not stop the flush; a network failure does, until the
  next trigger above. No timer re-sends on its own, but every trigger re-uploads each
  queued screenshot in full, so a link too slow for one keeps spending that upload.
- After a server error (408 or 5xx) while online, the copy says the report is saved and to
  press Send; a reconnect is promised only after a network failure.

## 5. Never collected
`document.cookie`, any URL / iframe `src`, `__EZIL_BOOT__.user`, `log.js` ring, headers,
clipboard, keystrokes; no continuous recording. Consent checkboxes default OFF; preview shows the
exact JSON that is sent; nothing hits the network before Submit.


## 6. Founder-authorized report bundle and developer loop (2026-11-08)

See [feedback-report-bundle.md](feedback-report-bundle.md) for the exact collection,
flow, capability and handoff contract. Bugs require context, steps, expected and
actual results, reproducibility and impact, formatted with headings in the existing
4,000-character description. Ideas/Other remain one field. No migration.

Diagnostics consent stays OFF until selected. Selection freezes the snapshot;
only the explicit Refresh action replaces it. No DOM text, form values, console
text or privileged device logs are read. The existing local event ring provides
up to 50 event ages; a detached trace read provides up to 24 phases. Numeric fields
are bounded to 0..1,000,000,000. At most ten events keep validated failure references;
reporter/computer IDs cannot be used as correlations. Standard server time, report
ID and deployed version are recorded without optional diagnostic consent.

New boot capability flags are present only when feedback is enabled. Missing
`feedbackEventDiagnostics` omits event reason/correlation; missing
`feedbackReportBundle` omits session, tracePhases and event ages. A rollback 400
retries once without all these expanded fields; report text/image/ID are preserved.
The fallback replaces the queued body and visible preview. No new upload runs in
the background beyond the existing explicitly submitted outbox retry.

Screenshot consent, feature gates, masking, cancellation and image limits remain.
The form explains disabled/unsupported capture; the attached image can be edited
again starting from its redacted pixels. Upload and clipboard are not added.

Admin status changes use the existing status column: new / investigating / resolved.
Every action reauthenticates, checks the fail-closed admin list, validates report ID
and status, awaits a `status_<target>` audit record, then updates only that report.
The audit is intent; it does not assert update success. Admin list/detail and
Settings → Feedback show persisted status, with an explicit reporter refresh.
Existing audit-before-content and owner-scoped reporter reads/deletes remain.


## 2026-11-08 report bundle extension

See [feedback-report-bundle.md](feedback-report-bundle.md) for rich bug fields,
static file imports, paired completed-trace identity, consented session/event
snapshots, audited status changes, non-evicting retry behavior and rollout checks.
The authoritative schema includes session, tracePhases, traceApp and bounded ages.
Validated trace/server request IDs are preserved, excluding reporter/computer IDs;
arbitrary text fields retain credential/UUID masking. Screenshot flags remain gated.
