# Floating controls + Feedback — pinned contract (feedback amendment, 2026-11-11)

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
  feedbackEventDiagnostics?: true, feedbackReportBundle?: true, feedbackAppFailures?: true,
  feedbackScreenshotsMax?: 5, feedbackStagedUploads?: true }
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
capture_shell_snapshot({ signal, info } = {}) → Promise<HTMLCanvasElement | null> // tier A, iframes → grey box at their own layer; info.frameCoverage 0..1
tab_capture_supported() → boolean
capture_tab_frame({ hide, signal } = {}) → Promise<HTMLCanvasElement | null> // tier B; MUST be called synchronously from a click
capture_desktop_frame({ signal } = {}) → Promise<HTMLCanvasElement | null>  // tier C via request_frame_capture
open_redact_editor(canvas, { signal } = {}) → Promise<{ blob: Blob, contentType: string, width: number, height: number } | null>
```
Tier A masks (grey + "Desktop stream not captured" for frames, black for private fields) are painted
inside snapdom's clone, in each filtered node's placeholder at its own position and z-index, never over
the finished image: shell overlays stacked above an embedded app (needs_operator, progress, errors)
stay visible (2026-11-11; real-browser pixel test `capture-browser-test.mjs`). Frame documents, URLs and
field values are never read. A private field whose placeholder cannot be found is still covered on the image.
`open_redact_editor` also takes `limit` (bytes, ≤ 1.5 MiB): what the report's image total leaves.
`signal` is an optional AbortSignal. Cancellation resolves null, removes waiting
listeners and stops acquired media tracks. A browser picker cannot be dismissed by
the page; a stream granted after cancellation is stopped immediately. Late decoded
bitmaps are closed and never reopen an editor or attach to another draft.

## 3. Wire format — `app/src/server/feedback/types.ts` is authoritative (zod)
POST `/api/shell/feedback` (JSON; `Content-Type: application/json` required, parameters such as
`charset` allowed — anything else is `415 {error:'unsupported_media_type'}` before the body is read,
so a cross-site simple form cannot post a report on the lax session cookie):
```
{ v: 1, clientRequestId: uuid, category: 'bug'|'idea'|'other', description: string 0..4000 (trimmed; blank is valid, 2026-11-10),
  computerId?: uuid|null, diagnostics?: Diagnostics|null,
  screenshot?: Image | null,          // exactly one image (the original key; older servers and queued bodies)
  screenshots?: Image[1..5] }         // two or more, in order (2026-11-11); never together with a non-null screenshot
Image = { contentType: 'image/png'|'image/jpeg'|'image/webp', dataBase64: string }
Diagnostics (strict, every field optional):
{ shellVersion ≤64, appCommit ≤64, browser {family ≤32, major int}, os ≤32,
  deviceClass 'phone'|'tablet'|'desktop', viewport {w,h int, dpr number},
  fullscreen bool, fullbleed bool, computerStatus ≤32, traceId ≤64, phases string[≤24]≤40,
  recentEvents {eventClass ≤40, site ≤80, code ≤80, ageMs?: int, reason?: string≤96, correlationId?: string≤64}[≤50],
  session?: {capturedAt: UTC ISO string, pageAgeMs: int, online: bool, visibility: 'visible'|'hidden',
    network?: {effectiveType?: 'slow-2g'|'2g'|'3g'|'4g', saveData?: bool}},
  tracePhases?: {code: machine string≤40, tMs: int}[≤24], stream {state ≤24, kbps int, rttMs int} }
```
Responses: `201 {id, createdAt, screenshotAccepted, screenshotCount}` · idempotent replay `200` same body (count read from the stored rows) ·
`400 {error:'invalid_request'}` · `401` · `404` (feature off) · `413` · `415` · `429 {error:'rate_limited'}`.
GET → `200 {reports:[{id, createdAt, category, descriptionPreview ≤140, hasScreenshot, screenshotCount, status}]}` (newest first, ≤50).
DELETE `?id=<uuid>` → `204`; `404` if not the caller's.
Limits: canonical metadata without image ≤32 KiB even with screenshot support enabled; body 32 KiB without screenshot support, 2.5 MiB with; decoded image ≤1.5 MiB, ≤4096 px per side,
magic bytes must match contentType; rate 10/h and 30/day per user (DB count); global attachment
budget 500 MB/day and 5 GB total → over budget: report stored, `screenshotAccepted:false`.
Several images: at most 5, decoded total ≤1.75 MiB (inside the unchanged 2.5 MiB body and the 3 MB proxy
limit; the client encodes each image against what the total leaves), the same image twice is a 400, more
than 5 a 400, a larger total a 413. The budget is checked against their sum, all or none: the report is
stored either with every previewed image or with none (`screenshotCount: 0`). Each image is one
`ezil_feedback_attachments` row of the report (no schema change); its `created_at` is the report time plus
its position in ms, and the admin viewer reads image n with `/api/admin/feedback/screenshot?id=…&n=0..4`
(`ORDER BY created_at, sha256`; no `n` = the first). Owner delete, admin delete and retention remove every row.
The boot payload advertises `desktopState.ui.feedbackScreenshotsMax` (5) with screenshots on; without it the
shell offers one image.

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
  unsent form. Drafts saved before 2026-11-10 may also carry `bug: {activity, steps, expected, actual,
  reproducibility, impact}`; it is folded whole into the one description when read and never written again.
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
- Listing and deleting the reporter's own reports (`list_my_reports`, `delete_my_report`)
  have a 20 s deadline (`REPORTS_DEADLINE_MS`) that also covers reading the response: a
  stalled list fails with "Could not load your reports" and a stalled delete settles as not
  deleted, so Settings shows its retry copy instead of loading forever. Only the newest load writes
  its list: an older load failing at its deadline never replaces a list a later one rendered.
  A failed delete keeps one message per row and does not claim the report still exists (a
  timed-out delete may have committed; loading the list again shows which).

## 5. Never collected
`document.cookie`, any URL / iframe `src`, user emails or names, `log.js` ring,
request headers, keystrokes or continuous recordings. Only the validated opaque
`__EZIL_BOOT__.user.id` UUID is read for account-local storage and the staged
expected-account comparison header described in §7. The clipboard is never read
programmatically: an image paste the person makes into the open dialog reads its
image files; text pastes retain their normal behavior. Both attachment checkboxes
default on, can be switched off, and nothing uploads before explicit Send.


## 6. Founder-authorized report bundle and developer loop (2026-11-08)

See [feedback-report-bundle.md](feedback-report-bundle.md) for the exact collection,
flow, capability and handoff contract. Amended 2026-11-10 (founder): the form is one
optional description (category fixed to `bug`, no required question, blank is valid).
No migration.

Diagnostics are selected by default and can be switched off. The snapshot is taken
when the form opens and frozen; switching diagnostics off and back on takes a new snapshot. No DOM text, form values, console
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

Screenshot consent, feature gates, cancellation and image limits remain. The current
explicit paste/drop/file flow in §7 replaces the earlier automatic capture UI.
Edit starts from the attached preview pixels, including any prior redactions.

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


## 2026-11-11 upload-first screenshots

With `ui.feedbackStagedUploads: true` (present only while screenshots are on), Send uploads each image first, then
posts the report. Nothing is uploaded before Send. The storage is the existing private `ezil_feedback_attachments`
table: no DDL, no bucket, no URL, no image GET.

- **Ticket.** The report id is derived from the signed-in user and `clientRequestId` (UUIDv8 layout, sha256 of a fixed
  label, the user id and the request id): `ingest.ts` `stagingTicket`. Every read and write also filters `user_id`, so
  the ticket is never a credential.
- **`PUT /api/shell/feedback?crid=<uuid>`**, body is the raw image, `Content-Type` is `image/png|jpeg|webp` (never a
  simple form type).
  - Rejected before the DB:
    - 404 while screenshots are off
    - 400 for a bad `crid`, an empty body, or a header that does not match the declared type
    - 415 for any other type
    - 413 over 1.5 MiB (byte-counted read)
    - 400 above 4096 px a side
  - In one READ COMMITTED transaction, taking the user lock and then the global attachment lock, the same order as
    finalize:
    - **Report already stored for this request:** 200 `{sha256, finalized: true}` if it holds this image, otherwise
      409 `report_already_sent`. A stored report is never changed.
    - **Same image staged within the hour:** 200 `{sha256, finalized: false}`, a no-op.
    - **Same image staged earlier:** renewed. The row is deleted and re-inserted at now, after a budget check that
      credits its own bytes once in each window it is already counted in.
    - **Ticket full:** above 5 images or 1.75 MiB, 413 `payload_too_large`.
    - **Pending cap:** a ticket with no row from the last 24 h is admitted only while the user holds fewer than 3
      such unsent tickets, otherwise 429 `staged_reports_limit`.
    - **Budget:** the global 500 MiB/day and 5 GiB budgets include staged bytes; over them, 507 `attachment_budget`.
    - Otherwise 201 `{sha256, finalized: false}`.
- **Finalize: `POST`** with `screenshotRefs: [{sha256, contentType}]`, 1–5 distinct, in report order. It is exclusive
  with `screenshot` and `screenshots`.
  - A replay of `(user, clientRequestId)` answers the stored report first, as before.
  - Otherwise, after the rate limit and under the attachment lock:
    - Every reference must match this user's staged row on this ticket: same type, staged within the last hour.
    - If any does not, 409 `staged_images_missing` and nothing is stored. The client uploads again and retries once.
      Another user's references look the same as missing ones.
  - Then, atomically:
    - unreferenced staged rows are deleted
    - each image's `created_at` becomes now plus its position (this order is what the admin viewer shows)
    - the report row is inserted with the ticket as its id
  - The rows are under an hour old, so moving them keeps the global sums unchanged.
- **Account guard.** The shell sends `X-EZiL-Feedback-Account: <boot user id>` on every PUT and every POST it makes.
  The server compares it with the signed-in user only; it is not an identity or permission.
  - It is checked before the body is read or the DB is touched.
  - A malformed header is 400 `invalid_account_header`.
  - A different account is 409 `account_changed`, which never echoes either id.
  - The header is required on PUT and with `screenshotRefs` (400 `account_header_required`).
  - On a legacy inline POST it is optional, and is checked only when present.
  - This keeps one account's staged images from being sent under another account's cookie after a cross-tab
    account switch.
- **Visibility.** Staged rows have no report row. The reporter's list, the admin list and detail, and `findScreenshot`
  never show them.
- **Cleanup.** The existing maintenance cron deletes staged rows with no report after 24 h (`retention.ts`). Finalize
  only accepts rows under an hour old, so cleanup never races it.
- **Compatibility.** Inline `screenshot` and `screenshots` keep working, for older shells and for bodies already queued
  for retry.

## 7. Compact attachments and upload-first amendment (2026-11-11)

The visible form contains one optional Description (`You can paste screenshots here too.`),
short Diagnostics / Screenshots checkboxes selected by default, one Attach images / drop
area, local thumbnails with Edit / Remove, a collapsed exact preview, and Send. Context
and the short server-summary disclosure live inside the preview. There is no automatic
shell capture, browser capture picker, capture-options disclosure, diagnostic essay or
image-budget counter. Imported files appear immediately without a mandatory editor;
Edit opens the existing crop/redaction editor. Pixels are freshly rasterized with the
existing encoder before the thumbnail is shown. Limits remain five images, 1.75 MiB
total, 1.5 MiB per image. An older boot without the multi-image flag keeps one image.

Image paste and file drop anywhere within the dialog import sequentially in source
order and deduplicate exact encoded bytes. File drags outside the dialog are blocked
while it is open to prevent navigation; text paste/drop remains native. Document drag
listeners and pending decode/editor work are removed/aborted on close or navigation.
On a touch-primary device initial focus remains on the heading; Send stays visible.

Only `desktopState.ui.feedbackStagedUploads === true` selects the new protocol.
Explicit Send freezes the original-account local outbox copy with raw image bytes.
For each image, in preview order, it PUTs raw raster bytes to the feedback endpoint
with `?crid=<clientRequestId>`, its image Content-Type, and
`X-EZiL-Feedback-Account: <validated boot user UUID>`. A 200/201 must return the exact
SHA-256 of those bytes and a boolean `finalized`. The client then POSTs the small report
with `screenshot: null` and ordered `screenshotRefs: [{sha256, contentType}]`, omitting
`screenshots`. This exact finalize JSON is shown in the expanded preview. Every new-client POST, including legacy inline/text and compatibility replay,
carries the same expected-account header. Older servers ignore this extra header;
updated servers compare it for every POST, requiring it for staged operations. It is comparison only,
never authentication; the backend must reject missing/malformed/mismatched staged
headers before body reads or writes. Account identity comes only from
`window.__EZIL_BOOT__.user.id`, validated as UUID and normalized to lowercase.

Unanswered sends retain the original raw images, clientRequestId and transport mode
for safe same-ticket retry, including unknown-finalize replay and expired staging.
Confirmed finalize removes the local outbox entry. Definitive staged refusals
(including 400/413/415/429) retain a paused local entry and thumbnails; no online,
mount or bfcache automatic retry sends a paused entry. Reopening restores an editable
form. Explicit Send retries it; editing a paused payload gives it a fresh ticket and
atomically replaces its paused local body. Remove / screenshot opt-out discards the
corresponding raw local bytes. If screenshot capability is disabled on a later boot,
queued thumbnails and their original ticket/body remain intact, imports and Edit
are disabled, and Send is blocked until explicit removal or screenshot opt-out.
`account_changed` also pauses the original account's
entry and stops requests; it never transfers the report to another account.

Boots without upload-first, and preexisting inline outbox entries, retain the original
inline wire body and refusal behavior. No new protocol is inferred from a server
error. Payment, 3DS and runtime provisioning code are outside this amendment.
