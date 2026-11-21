# AI interview: access and evidence — v1 (frozen for RUN-1121)

Status: **frozen** 2026-11-21 by the RUN-1121 WS1 lead. Staging only (git-qa.ezil.work, api-staging.ezil.work,
os-staging.ezil.work, ai-staging.ezil.work). Evidence only: no scoring, no WorkScore or TaskScore change, no attention
or cheating inference, no camera or face data.
Machine-readable parts: `interview-evidence-v1.schema.json` (envelope, timeline) and `interview-evidence-v1.vectors.json`
(notice bytes and sha256, valid and invalid events, state machine, refusals, buckets, ordering). Where this text and the
vectors disagree, the vectors win; say so in your report instead of choosing.

| § | Owner (lane) | Repo |
|---|---|---|
| 1-4 IDs, envelope, types, notice | contract (lead) | EZiL-OS `docs/contracts/` |
| 5 Works interview repositories | works | EZiL-Works |
| 6 OS access to git-qa by address | os-access | EZiL-OS |
| 7 OS consent, registry and activity log | os-capture | EZiL-OS |
| 8 Gateway member capture | gateway | EZiL AI Gateway |
| 9 Timeline and CLI | ws1-cli (light session) | EZiL-OS `tools/` |

## 1. Identity

- `interviewId`: lowercase UUID v4, minted by Works at create (§5). The same value keys every repo's records.
- Identity tuple, fixed when the candidate accepts the notice and never changed afterwards:
  `{interviewId, repositoryId, canonicalURL, osUserId, ezilIdSubject, worksAccountId}`.
  - `repositoryId`: the Works self-serve `repositoryRef` (decimal bigint string, `^[1-9][0-9]{0,18}$`).
  - `canonicalURL`: `https://git-qa.ezil.work/<handle>/<name>.git` (OS `STAGING_GIT_QA_REPOSITORY`).
  - `osUserId`: the OS account id (GoTrue `auth.users.id`, lowercase UUID). The gateway's member subject is
    this id (JWT `sub` → `Principal.authUserId`), so the gateway binds to it, never to the EZiL ID subject.
  - `ezilIdSubject`: the EZiL ID (`https://id.ezil.work/`) subject of the Works owner, 1-255 chars.
  - `worksAccountId`: the Works builder account id (decimal bigint string).
- The candidate is the Works owner of the repository. On OS the candidate is recognised by EZiL ID subject before
  consent and by `osUserId` after it. Anyone else is `repo_not_found` and leaves no record (§7).

## 2. Envelope `ezil.interview.event.v1`

`{v:1, interviewId, source, seq, type, at, clientAt?, data}`. No other keys.
- `source`: `works` | `os` | `gateway`. Each type belongs to exactly one source (§3). Anything else is rejected.
- `seq`: an integer ≥ 1, gapless per (interviewId, source).
  - OS stores `seq` at insert.
  - Works and gateway assign it in their evidence response, ordering by (`at`, type order in §3, natural row id).
- `at`: server time, UTC, `YYYY-MM-DDTHH:MM:SS.mmmZ`. `clientAt` has the same format, only on OS client-reported types,
  and is never used for ordering.
- `data`: exactly the keys listed for the type. The list of types is **closed**: an unknown type, a missing key or an
  extra key is rejected everywhere (ingest, evidence responses, `interview-timeline validate`).
- Refusals below are written `status code`. Each repo wraps the code in its existing error body: OS `shellRefusal`
  `{error:{code, message}}`, Works `RefusalError`, and the gateway's JSON error. Vectors `refusals` list them all.
- Successful responses carry `cache-control: no-store`. No route echoes a credential it received, and none is logged;
  the only credential any route returns is the Works seed token (§5).

## 3. Event types (18)

| source | type | data | produced when |
|---|---|---|---|
| works | `repo.created` | `{repositoryId, canonicalURL, handle, name}` | Works create (§5) |
| works | `repo.seeded` | `{headSha}` | the operator reports the template push (§5 `seeded`) |
| works | `git.grant_issued` | `{scope:'read'\|'write', reason, expiresAt, presenceGated:true}` | each `git_grants` row for the repository. Renewals tick only while the candidate is present in Code (`code.js` `sample_presence`); never read them as "repository open" |
| works | `git.push` | `{ref, before, after, commits:[{sha, message, messageTruncated, author, committedAt}], truncated}` | each `repository_push_events` row on `refs/heads/*`, except the seed push (`after == headSha` of `repo.seeded`) |
| works | `repo.frozen` | `{}` | Works finish (`lockWrites`) |
| os | `consent.accepted` | `{noticeVersion:1, noticeSha256}` | candidate accepts (§7). Always OS `seq` 1 |
| os | `interview.started` | `{}` | operator start (§7) |
| os | `computer.opened` | `{computerId}` | the OS open gate allows an `open` of the interview repository (§6, §7) |
| os | `tab.visibility` | `{state:'visible'\|'hidden'}` | `visibilitychange`, and once when recording begins |
| os | `window.focus` | `{focused:boolean}` | window `focus`/`blur`, and once when recording begins |
| os | `app.focus` | `{app}` with `app` = an app registry id `^[a-z0-9][a-z0-9._-]{0,63}$` or `unknown` | the shell's `ezil:window-focus` event, and once when recording begins |
| os | `presence.idle` | `{bucket:'<15s'\|'15-60s'\|'1-5m'\|'>5m'}` | bucket change of the time since Code was last visible and focused (§7.4) |
| os | `session.heartbeat` | `{}` | every 60 s while Code is open. Browsers may throttle hidden tabs; a gap means unknown |
| os | `agent.turn_start` | `{requestId, derived:true}` | written by the OS server with each `agent.turn_end`, `at = turn_end.at − durationMs` |
| os | `agent.turn_end` | `{requestId, gatewayRequestId, modelAlias, durationMs, outcome:'completed'\|'failed'\|'cancelled', toolCalls:{read, search, write, other}}` | each `ezil.inference.v1` trace the Code frame reports. `toolCalls` = the trace's `requested` counts; `gatewayRequestId` is a UUID or null |
| os | `interview.finished` | `{}` | operator finish (§7), when the interview had reached `consented` or `started` |
| gateway | `model.request` | `{requestId, modelAlias, upstreamModel, outcome, tokens:{input, cachedInput, cacheWrite, output, reasoning}, ttftMs, totalMs, attribution:'subject_window'}` | each `request_telemetry` row whose subject is `osUserId`, inside the consent window (§8) |
| gateway | `prompt.captured` | `{requestId, endpoint:'messages'\|'responses', truncated, reqBytes, respBytes, purged, content}`. `content` = `{request, response}` as stored, or null when `purged` | each member capture record of the interview's consent (§8) |

An "agent turn" is one `ezil-models` request from the Code frame. No turn-start signal exists in Code, so
`agent.turn_start` is derived and says so. Numbers in `tokens`, `ttftMs`, `totalMs` are integers ≥ 0 or null when the
gateway has none.

## 4. Notice v1

The candidate sees the exact bytes in `vectors.json` `notice.text` (UTF-8, LF line endings, trailing newline,
1972 bytes). They are pinned by `notice.sha256` = `a73e2521409a299375aeac8dfb21d95a7daab7e788405d6dda4e4a064f0e7336`.
OS serves exactly these bytes and refuses an accept with any other sha256. A different text is a new version, and
v1 code must refuse it. The text, for reading:

```text
EZiL interview recording notice (version 1)

This is a recorded interview on EZiL OS staging. Read what is recorded before your computer opens. Nothing is recorded before you accept, and recording stops when the interviewer finishes the interview.

What is recorded:
- Which EZiL ID, EZiL OS account and EZiL Works account you use for this interview.
- When this interview repository was created and prepared, and each time Git access to it is renewed. Renewals happen only while you are active in Code, so they do not show how long the repository was open.
- Your commits and pushes to this repository: branch, commit IDs, messages, authors and times. Your pushes are not run on any test runner.
- Every AI request made from your EZiL OS account during the interview: the model, timing, token counts, and the full prompt and response, including any code or file content sent with it (up to 2 MB per request).
- Whether this browser tab is visible or hidden, whether this window has focus, which EZiL OS app is focused, and how long since Code was last visible and focused, in buckets: under 15 seconds, 15 to 60 seconds, 1 to 5 minutes, over 5 minutes.
- When each AI agent request in Code starts and ends, with the number of tool calls it made of each kind: read, search, write, other.

What is not recorded: camera, microphone, face data, screenshots, keystrokes, clipboard, the web addresses you visit, or anything outside this staging account.

What cannot be known from this record: where you were or what you did while this tab was hidden; other devices or monitors; whether you were reading or away while the tab was visible but idle. A gap in the record means unknown, not away.

Retention: AI prompts and responses are kept for 14 days and activity records for 30 days. The interviewer keeps the exported timeline. This record is not scored, and no attention or cheating judgement is made from it.

After the interview is finished, this repository is read-only.
```

The notice states: identity; repository creation, preparation and presence-gated Git renewals; commits and pushes (not
run on any test runner); every AI request with full prompt and response (≤ 2 MB); tab visibility, window focus,
focused OS app and presence-idle buckets; agent request start and end with tool-call counts. It states what is not
recorded, what cannot be known, the retention (captures 14 days, activity 30 days, the export held by the
interviewer), that nothing is scored, and that the repository becomes read-only after finish.

## 5. Works: interview repositories (lane works)

Base `/v1/ops/qa/interview-repositories`.
- **Gate.** Every route answers 404 `not_found` before authentication unless both hold:
  - `c.get("deployment").name === "QA"` (api-staging, git-qa);
  - `EZIL_SELFSERVE_REPOSITORIES_V0 === "1"`.
- **Auth.** `requireQaAutomation` (403 `qa_automation_required`).
- **`POST /`** with `Idempotency-Key: <uuid>` and strict body `{candidateEmail, handle, name, title}`:
  - Refusals:
    - 409 `push_tests_enabled` while `EZIL_SELFSERVE_PUSH_TESTS_V0 === "1"` (interview pushes must never reach a runner);
    - 422 `candidate_not_builder` unless the email resolves (`accountsRepository.byEmail`) to an active, unsuspended builder account linked to an EZiL ID subject;
    - the self-serve `create` refusals pass through (handle conflict, repo limit).
  - The repository is created with `selfserveRepositoriesV0Repository.create(owner, …, {kind:'human', actorId: operator})`.
  - It answers 201 `{interviewId, repositoryId, canonicalURL, handle, name, ownerEzilIdSubject, worksAccountId, seed:{remote, token, expiresAt}}` with `cache-control: no-store`.
  - The seed is an Artifacts write token of **at most 300 s**, used as `http.extraHeader: Authorization: Bearer <token>` against `seed.remote`.
  - Replaying the same key and body answers 200 with the same ids and a fresh seed. A different body is refused with 409 `idempotency_conflict`.
- **`POST /:interviewId/seeded`** `{headSha}` (40 or 64 lowercase hex) records the seed head once.
  - The same sha again answers 200.
  - A different sha is 409 `already_seeded`.
  - After finish it is 409 `interview_finished`.
- **`GET /:interviewId/evidence`** → 200 `{v:1, interviewId, pushTestRuns, events}`, where `events` are works envelopes (§3) in `seq` order.
  - `pushTestRuns` is the number of `selfserve_push_tests_v0` rows for the repository and must be 0.
  - An unknown interview is 404 `not_found`.
- **`POST /:interviewId/finish`** → `lockWrites`. It answers 200 `{frozenAt}` and is idempotent.
  - Once frozen, owner grants are read-only, so a push is refused at the gateway.
  - The seed token is outside that rule, which is why its TTL is 300 s.
- **Storage.** `packages/schema/src/interview-repositories-v0.sql` holds one row per interview:
  - columns: `interview_id` uuid pk, `project_id` → self-serve project, unique; operator account; candidate account; `created_at`; `seed_head_sha`; `seeded_at`;
  - no PII beyond what Works already holds;
  - registered in `packages/db/src/schema-files.ts` and `.github/production-migrations.json` like its siblings.
- **Off limits.** Nothing under `apps/api/src/dispatch`, `packages/orchestration` or `apps/valuator-events` changes.

## 6. OS: open a git-qa repository by address (lane os-access)

- **Gate and URL parsing.** Only when `stagingGitQaAccepted()` holds, `parseRepositoryUrl` accepts `https://git-qa.ezil.work/<owner>/<name>.git`.
  - It canonicalises exactly like github.ezil.work.
  - Otherwise `unsupported_host`, as today; every other host's behaviour is unchanged.
- **Grant.** `grantForWorksGitAddress(identity, canonicalURL, computerId)` calls `POST https://api-staging.ezil.work/v1/builder/selfserve-repositories/os-grant`.
  - Request: `Authorization: Bearer <retained EZiL ID token>` and body `{computerLabel: computerLabel(computerId), class:'project', url}`.
  - The origin is a constant, used only when `stagingGitQaAccepted()` holds.
  - Status mapping: 401 → `identity_refused`; 403/404 → `not_found`; other → `unavailable`; malformed body → `invalid_response`.
- **`code-preview-url` open of a git-qa address**, in this order:
  1. Evaluate `interviewOpenGate({purpose:'open'})` (§7.5) **before any mint, wake or grant**. A refusal answers with the gate's status and code, and nothing else happens.
  2. Mint Code as today.
  3. Obtain the Works grant.
  4. Open through the Worker's **binding (non-packet) path**, which accepts git-qa on os-staging (`repo-open.ts` `repoOpenRemotesFor`, Basic auth). It never uses the v2 `privatePacket`, which accepts github.ezil.work only.
  - A grant `not_found` answers 404 `repo_not_found`.
  - The response shape is unchanged.
- **`code-git-access` renewal** accepts git-qa under the same gate. It calls `interviewOpenGate({purpose:'renew'})` first (a refusal answers its status and code), then the Works grant.
- **Shell.** The `EZIL_GIT_ORIGIN` prefix checks in `code.js` (renewal target, identity refresh, folder focus) also accept `https://git-qa.ezil.work/`. The server stays the authority.
- **No change** to `worker/`, `aws-repo-open.ts` or the github.ezil.work standalone path. AWS computers cannot open git-qa: an interview needs a Cloudflare computer.

## 7. OS: consent, registry and activity log (lane os-capture)

### 7.1 Gate, auth
- Refusal bodies use the existing shell shape `{error:{code, message}}` (`shellRefusal`); every code below is `error.code`.
- Every interview route answers 404 `not_found` unless `stagingGitQaAccepted()` holds.
- Shell routes use the shell-http caller (401 when signed out).
- Admin routes take `Authorization: Bearer <Supabase access token>` (resolved by `createTRPCContext`) plus `isTelemetryAdmin(email)`: 401 when absent, 403 `forbidden` when not an admin. There is no page.

### 7.2 State machine (registry `ezil_interviews`, keyed by `interviewId`, unique `canonicalURL`)
`registered → consented → started → finished`, forward only; `finished` is reachable from any state.
- **Events** are written to `ezil_interview_events`, append-only.
  - UPDATE is refused; DELETE is refused unless `at < now() − 30 days`.
  - A trigger refuses an insert unless the interview is `started`. The one exception is `consent.accepted` in the transaction that moves it to `consented`.
  - Before accept, nothing is written for the interview. After finish, nothing is written except `interview.finished` (when it was `consented` or `started`).
- **Migration:** `app/drizzle/0038_interview_evidence.sql`, raw SQL, no shared schema file. Staging applies it by hand (deploy request).

### 7.3 Routes
- **`POST /api/shell/interview-consent`**
  - `{action:'status', repository:{url}}` answers one of:
    - not an interview → 200 `{interview:null}`;
    - candidate → 200 `{interview:{interviewId, state, notice:{version:1, sha256, text}}}`;
    - anyone else → 404 `repo_not_found`. Nothing is written for anyone else.
    - With no EZiL ID subject available: 409 `IDENTITY_REFRESH_REQUIRED`.
  - `{action:'accept', interviewId, noticeVersion:1, noticeSha256}` from the candidate:
    - in `registered`, it binds `osUserId` and `ezilIdSubject`, moves to `consented` and writes `consent.accepted`;
    - repeated by the same user it is idempotent;
    - a wrong sha or version → 409 `notice_mismatch`; other states → 409 `interview_state`.
- **`POST /api/shell/interview-events`** `{interviewId, events:[{type, clientAt, data}]}`, 1-20 events:
  - Allowed only for the bound candidate while `started`; otherwise 404 `not_found`.
  - Client types allowed: `tab.visibility`, `window.focus`, `app.focus`, `presence.idle`, `session.heartbeat`, `agent.turn_end`. Any other type, or invalid data, → 400 `invalid_event` and the whole batch is refused.
  - Rate limit: 120 events per minute per user, else 429 `rate_limited`.
  - The server sets `at` and `seq` and writes `agent.turn_start` before each `agent.turn_end`. A repeated `agent.turn_end.requestId` is dropped.
  - Answers 202 `{accepted}`.
- **Admin routes:**
  - `POST /api/admin/interviews` `{interviewId, repositoryId, canonicalURL, handle, ownerEzilIdSubject, worksAccountId}` → 201 `registered`. The same body again → 200; a conflicting one → 409 `conflict`.
  - `GET /api/admin/interviews/:id` → `{interviewId, state, identity, noticeSha256, registeredAt, consentedAt, startedAt, finishedAt}`. `identity.osUserId` is null before consent.
  - `POST /api/admin/interviews/:id/start` → 409 `interview_state` unless `consented`. It writes `interview.started`; it is idempotent once started.
  - `POST /api/admin/interviews/:id/finish` → `finished`, idempotent.
  - `GET /api/admin/interviews/:id/events` → `{v:1, interviewId, identity, events}` in `seq` order. It purges rows older than 30 days first.

### 7.4 Shell
- **`shell/ezil/ui/interview-consent.js`**
  - Called once at the top of `start_boot` in `code.js` for a `?repo=` git-qa address.
  - It asks `status`. For an interview not yet started it shows the notice verbatim, with Accept and Leave. After accept it shows "Waiting for the interviewer" and polls `status` every 5 s until `started`; only then does boot continue.
  - `interview:null` or a refusal continues boot unchanged; the server refuses again.
- **`shell/ezil/ui/interview-activity.js`**
  - Started for a started interview. It emits the initial `tab.visibility`, `window.focus`, `app.focus` and `presence.idle{'<15s'}`.
  - It then records on the events in §3: the presence-block hook in `code.js` feeds it `visible`/`focused` on every sample; it listens to `ezil:window-focus` on `window`; it gets each validated trace from a one-line hook in `ai-traces.js` `receive`.
  - It batches (≤ 20, ≤ 5 s) and stops for good on 404.
- **Idle buckets:** `<15s` below 15 000 ms, `15-60s` below 60 000, `1-5m` below 300 000, `>5m` from 300 000. The shell cannot see input inside the cross-origin editor frame, so this measures presence, not keystrokes.

### 7.5 Gate module `app/src/server/interview/gate.ts`
`interviewOpenGate({canonicalURL, osUserId, ezilIdSubject, computerId, purpose:'open'|'renew'})` →
`{kind:'none'} | {kind:'allow', interviewId} | {kind:'refuse', status:404|409, code:'repo_not_found'|'interview_not_started'|'interview_finished'}`.
- `none` when the gate is off or no interview has this URL.
- `repo_not_found` (404) when the caller is not the candidate.
- `interview_not_started` (409) in `registered` or `consented`.
- `interview_finished` (409) when finished.
- Otherwise `allow`; on `open` it writes `computer.opened`.
The lead commits a stub returning `{kind:'none'}`; os-capture replaces the body and keeps the signature.

## 8. Gateway: interview member capture (lane gateway)

- **Gate.** Every interview route answers 404 unless `captureActive` holds (`CONTENT_CAPTURE=qa_staging`, `EZIL_ENVIRONMENT=staging`, CAPTURE bound; i.e. `os-staging`).
- **Auth.** Admin routes run under `admin()` plus `requireFounder`. Writes need `Idempotency-Key` and a `reason`.
- **Consent:**
  - `POST /v1/admin/interview-capture-consents {interviewId, authUserId, noticeSha256, retentionDays:14, reason}` → 201 `{consentId, interviewId, authUserId, grantedAt, retentionDays:14}`.
    - `retentionDays` other than 14 → 400.
    - Another active consent for the same `authUserId` → 409 `consent_active`.
    - The same interview again is a replay.
  - `POST /v1/admin/interview-capture-consents/:interviewId/revoke {reason}` → 200 `{revokedAt}`, idempotent.
  - Table `capture_member_consents`: retention CHECK = 14; at most one active consent per `auth_user_id`.
- **Capture.**
  - A `member` caller is captured only while its `authUserId` has an active member consent.
  - Both `captureSession` call sites pass the principal.
  - `capture_insert_member` re-checks in SQL that the consent is active and is this member's, that `requests.auth_user_id` matches, and that the request was created at or after `granted_at` and before any `revoked_at`.
  - Expiry is `created_at + 14 days`.
  - Project-key capture is unchanged.
- **Events.** `GET /v1/admin/interviews/:interviewId/events` → `{v:1, interviewId, consent:{authUserId, grantedAt, revokedAt}, events}`.
  - `model.request` comes from telemetry where the subject is `authUserId` and `created_at` is in [`grantedAt`, `revokedAt` or now).
  - `prompt.captured` comes from the consent's capture records, with content read from R2.
  - 404 when the interview has no consent.
- **SQL.** `migrations/0036_member_capture_consent.sql` plus `scripts/os-staging/sql/43_member_capture_consent{,_rollback}.sql`. Both are registered as `kind:"snapshot"` and are never in the production chain. `CAPTURE_READ_HMAC_SECRET` and the evaluator API are unchanged.
- **Docs.** `docs/QA-CONTENT-CAPTURE.md`: the rule "JWT members … are never eligible" becomes "never eligible, except an OS member with an active interview consent on os-staging (this contract)".

## 9. Timeline and CLI (lane ws1-cli)

- **Commands.** `node tools/interview.mjs create|start|finish|export`. Credentials come from env names only: `EZIL_WORKS_QA_TOKEN`, `EZIL_OS_ADMIN_TOKEN`, `EZIL_AI_OPERATOR_COOKIE`. They are never printed.
  - `create`: Works create → push the template with the seed → Works `seeded` → OS register → print the `/app/code?repo=` URL.
  - `start --wait`: poll OS until `consented` → gateway consent with `authUserId = identity.osUserId` → OS start.
  - `finish`: OS finish → gateway revoke → Works finish.
  - `export --out DIR`: writes `timeline.json` (`ezil.interview.timeline.v1`, schema) and `timeline.md`.
- **Ordering.** Events are sorted by (`at`, source `works` < `os` < `gateway`, `seq`).
- **`cannotBeKnown`** is the four fixed strings in the vectors.
- **`observations`** are labelled `observation`: agent-turn spans that overlap a hidden tab, a blurred window, or `presence.idle` `>5m`.
- **Validation.** `node tools/interview-timeline.mjs validate FILE` exits 0 when valid, 1 with one error per line when not, and 64 on usage.
  - It checks the schema, the closed types, source/type pairing, gapless `seq` per source, ordering, `interviewId` agreement and `pushTestRuns === 0`.

## 10. Acceptance

| # | Check |
|---|---|
| A1 | The export contains all 18 types (`jq -e`, list in the vectors) |
| A2 | `interview-timeline validate` exits 0 |
| A3 | A second EZiL ID opening the URL gets 404 `repo_not_found`, and no source has an event or record for that user |
| A4 | Before accept, there are 0 OS event rows for the interview and 0 member capture records |
| A5 | After finish: a push is refused, a new model request is not captured, and `interview-events` answers 404 |
| A6 | With the staging gate off, unit tests show 404 from every interview route in all three repos |
| A7 | `git diff --stat ea1a93df..HEAD -- apps/api/src/dispatch packages/orchestration apps/valuator-events` is empty |
| A8 | `pushTestRuns == 0`, and create answers 409 `push_tests_enabled` while push tests are on |
