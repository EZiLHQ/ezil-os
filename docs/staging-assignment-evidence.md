# Staging assignment evidence

Use this runbook to rehearse the assignment on EZiL OS staging and produce a reviewable record from the Git checkout and evidence supplied by the operator.

## Prepare one attempt

1. Use an authorized test account and a disposable private `github.ezil.work` repository for the rehearsal. Record an opaque attempt ID, the assignment version, the Git provider's repository ID, the target branch, and the full assignment base commit. Keep the account-to-attempt mapping in the restricted operator record.
2. Open [EZiL OS staging](https://os-staging.ezil.work). Choose **Continue with EZiL ID** to create the test account on first use or sign in. Complete email verification if prompted. Give that identity access to its assignment repo and permission to push to the intended branch. Verify that the repo remains private and that the test identity can open it. The link selects the repo. The Git grant controls access.
3. Give the operator the staging link in the form `https://os-staging.ezil.work/app/code?repo=<URL-encoded HTTPS Git URL>`. Open it in a signed-out browser session and sign in as the test identity through the redirect. Verify that Code shows the intended checkout. Capture `code-ready` in UTC when the editor and expected files are visible. If OS asks to confirm EZiL ID, complete that step and retry in the same session.
4. Verify the initial commit using `git -C "$repo" rev-parse HEAD`. Match it to the recorded full base SHA. Record the selected computer or workspace ID in a scoped `workspace` attachment if available. Write the `baseline` snapshot before editing. Use the same attempt ID, assignment version, and base SHA for every subsequent snapshot.

## Collect snapshots

Run the CLI from the OS source checkout with the assignment repo available as a local worktree. Set `repo`, `evidence_root`, `attempt_id`, `assignment_version`, and `base_sha` to the approved paths and IDs. Create `evidence_root` as a restricted directory outside the assignment worktree. Pause editing while each snapshot is captured and give it a fresh destination.

```sh
node tools/assignment-evidence.mjs \
  --repo "$repo" --out "$evidence_root/baseline" \
  --attempt-id "$attempt_id" --assignment-version "$assignment_version" \
  --base-sha "$base_sha" --phase baseline \
  --observe "code-ready=$code_ready_utc"
```

Use `manual`, `agent`, or `interrupted` as the phase at the corresponding checkpoint. Attach files with `--attach "kind=/absolute/path/to/file"` and repeat the flag as needed. Record each observation when it happens with `--observe "kind=YYYY-MM-DDTHH:MM:SSZ"`. Keep the snapshot manifest and its artifacts together. Use a new destination for any retry and preserve earlier snapshots.

At submission, record `submitted` when the attempt is handed in. Take the final SHA from the submission and verify that it names the intended change. Use the full branch ref for the authorized Git remote check. Include `--submitted-sha` even if the local checkout has moved since the submission.

```sh
node tools/assignment-evidence.mjs \
  --repo "$repo" --out "$evidence_root/submission" \
  --attempt-id "$attempt_id" --assignment-version "$assignment_version" \
  --base-sha "$base_sha" --phase submission \
  --remote-ref "$remote_ref" --submitted-sha "$submitted_sha" \
  --observe "submitted=$submitted_utc" \
  --attach "tests=$test_evidence" --attach "preview=$preview_evidence"
```

Set `remote_ref` to the required branch on `origin`, such as `refs/heads/main`. If the remote check fails or reports a different tip, preserve that result. Retry after an authorized correction or flag the submission as unverified. If the checkout HEAD differs from the submitted SHA, preserve the current snapshot and capture the submitted revision from a separate checkout. The patch files describe the checkout at capture time. A successful remote lookup verifies the branch tip at that time. For a server-recorded push time, attach the receipt if the provider supplies one.

## Evidence to attach

Retrieve evidence through authorized access for this attempt only. If a source is unavailable, record the gap in the operator notes and leave the evidence absent. Keep secrets, auth headers, preview tokens, unrelated conversations, and private user identifiers out of attachments. Preserve the useful IDs and timestamps.

| Attachment kind | What to collect |
| --- | --- |
| `chat` | Saved assignment conversation or authorized export limited to the relevant user messages. Keep message or turn IDs, order, and observed send times when available. |
| `ai-trace` | Approved OS inference or admin trace for the same turn. Keep client and EZiL Gateway request IDs, trace ID, model, outcome, and timestamps where present. |
| `gateway` | Retained request metadata for the matched EZiL request ID or Cloudflare log ID. Cloudflare AI Gateway payload logging is disabled on the staging gateway path. For an eligible QA run with active consent on a staging `ezk_` project key, the authorized evaluator can fetch the private capture by EZiL request ID. Ordinary EZiL ID chats need saved assignment chat for exact user wording. |
| `tests` | Commands actually run, exit status, and the relevant result. Record what could not be run and why. |
| `preview` | A sanitized preview path or screenshot, what was checked, the observation time, and the revision or workspace confirmed. A preview can expire. |
| `comments` | Assignment-specific comments or review notes, with source and timestamp if available. Tie factual claims to the relevant artifact. |
| `workspace` | Selected computer or workspace ID and observed launch, reopen, or interruption details. Use the authenticated OS view or authorized operator source. |

The collector supplies Git evidence from the local worktree and optional remote check. Untracked files are listed by path. Attach relevant contents explicitly if needed. Capture a separate snapshot for any submodule whose internal changes matter. A prompt may lead to multiple model requests or multiple commits. Join a saved turn to a Gateway request when both records share a request ID. Use an explicit commit reference or an isolated checkpoint for change attribution. A shared repo and close timestamps support an inferred link. Save the exact wording from the user message.

## Review timing and gaps

Record `code-ready` and `submitted` to measure the elapsed assignment interval. Choose one agent turn for the first-output timing sample. Record `prompt-submitted` when that message is sent and `first-visible-output` when its output appears, then pass both observations to the same checkpoint. App wakes, heartbeat data, compute time, and Gateway latency describe their own events. Leave unobserved timestamps absent. For an interrupted or resumed attempt, record the interruption in the workspace attachment and retain both checkpoints.

```sh
node tools/assignment-evidence-review.mjs \
  "$evidence_root/baseline" "$evidence_root/submission" \
  > "$evidence_root/review.json"
```

Pass all saved snapshots from the same attempt, including intermediate phases. Review the JSON for evidence gaps, remote verification, and intervals backed by observed milestones. Keep it alongside the snapshot folders so reviewers can open the actual artifacts. Checksums detect changes relative to each snapshot manifest. Inspect the underlying evidence for any prompt-to-change claim.

## Rehearse and decide

| Case | Expected evidence |
| --- | --- |
| Manual-only | First signup and repo access succeed. Baseline, manual checkpoint, tests, preview, and remote-confirmed submission identify the work. No prompt or inference interval is expected. |
| Agent-assisted | A saved prompt links to its observed trace or request where available. The checkpoint and submission identify the resulting changes. Both timing milestones support the reported first-output interval. |
| Mixed manual and agent | Separate checkpoints preserve the manual and agent changes. Any attribution beyond the evidence stays unknown. The submitted SHA verifies against the branch. |
| Interrupted, then reopened | The interrupted snapshot preserves the state that was reached. Reopening the same repo uses the same attempt ID with a new snapshot. Missing output or submission remains explicit until observed. |

Advance only after the four staging rehearsals show that authorized operators can open the correct private repos, collect the expected evidence, verify completed submissions against Git, and distinguish evidence gaps from observed failures. Keep the reports and record any remaining blocker before inviting participants. Use the packet as the input for a later evaluation phase.
