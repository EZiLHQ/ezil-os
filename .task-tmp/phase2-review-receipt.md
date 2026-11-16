# O-credits Phase 2 review receipt

Phase 2 implements W0.3 §5 in 13 owned billing source/test files, including the local double-debit repair requested after review of the prior `713ce202` patch. Phase 1 was checkpointed before implementation and is preserved. This receipt describes source work only; no vendor/database calls, installs, commits, deployment, agents, or history replay occurred.

## Apply exactly one path

- If the reviewed Phase 1 patch is already applied: apply `o-credits-phase2-only.patch`.
- From `25c1274b5215`: apply `o-credits-full-final.patch`.
- Do not apply both patches to the same tree.

Both paths were actually applied to isolated RAM copies, then all 20 resulting files were compared byte-for-byte with the final working files. The Git index, Phase 1 checkpoint, other worktrees, and sessions were preserved.

| Artifact | SHA-256 |
| --- | --- |
| Saved Phase 1 checkpoint | `907afd5113eecf60cdc907918e06a51cda5975592f58745448a0c1fc73c48697` |
| Phase 2 incremental | `3771ae3d79a55f41cbba9c95c036de023f2ccc6467e665b09798f3b74c5c9d0d` |
| Full final patch | `a6d5ed97fa3dfd2485d1fe534cccbef0d26bc369209908bd49282dc6fec837cf` |

## Wire protocol

Protocol stays `ezil-ai-credits-v1`. The signed body remains exactly `{eventId, entitlementId, accountPublicId, action, credits, expiresAt}`. `entitlementId` is always the original root E, and `credits` always the original whole-credit amount. Gateway owns head selection and fractional restoration. Expiry and payer remain frozen.

| Action | Event ID | Meaning |
| --- | --- | --- |
| grant | `E:grant` | Existing initial grant; unchanged |
| revoke | `E:revoke:dispute:D` | Restorable dispute suspension |
| revoke | `E:revoke:refund:R` | Distinct terminal full refund, including after a dispute |
| revoke | legacy `E:revoke` | Terminal; never adopted as a dispute |
| restore | `E:restore:D` | Restore only the matching D chain |

The parser validates the suffix of the exact root prefix. No truncation. Event IDs over 200 characters produce `review:invalid_ai_event_id` before financial effects.

## Financial guard and ordering

`recordAiReversal` takes the cause lock, then sorted root locks. In the transaction it rereads customer ownership, the original local grants, all corrections linked by the root receipts across dispute/refund IDs, and all relevant root/cause outbox receipts. The immutable reversal metadata binds D/R, charge, Stripe customer, original grant IDs, user, source, subscription, meter, amount, and period. All root receipts must agree on credits, expiry, source and payer.

A new restore requires the same-D canonical dispute revoke and an exact same-D local suspend for every original meter. Its restore amount is bounded by the actual suspended delta and the original allowance. The payer must already be frozen on the suspend receipt. The positive local corrections and `ai_restore` rows are inserted together; any conflict rolls the transaction back. Replays add neither. A same-value purchase cannot borrow another purchase's D receipt.

No canonical receipt means no positive restoration: legacy dollar-only, Pro, and compute-only historical restores surface `review:restore_receipt_missing`. Existing legacy negative reversal paths are retained. A won event before its own suspend returns `failed:restore_suspend_pending`; an unpinned suspend payer returns `failed:restore_account_pending`. Both preserve retryable inbox receipts without a local positive.

Full refunds always enqueue their distinct root-E event using the frozen payer. Known terminal refunds/legacy revokes prevent new restores. Overlapping disputes surface `review:restore_review_required`; successive non-overlapping disputes require the previous restore to be delivered with `restored` or `already_restored` before the next suspension can count as a new clean chain.

`ai_restore` transport is eligible only after its exact D revoke is delivered and matching owner/root/payer/terms/proof are verified. Creation timestamps never establish causality. Waiting rows consume no claim attempts. Terminal refunds or overlap evidence added after enqueue are checked at claim time too: terminal restores are completed without HTTP; overlap or mismatched receipts surface manual review without HTTP. Gateway still arbitrates concurrent deliveries on the root.

Root locking also serializes payer pinning. The existing 30-second lease, lease token/attempt fence, ten-second transport bound, backoff and ordinary ten-failure budget remain. `no_ai_account`, `account_not_found` and `restore_hold_pending` are durable dependency waits excluded from that failure budget. Restore expiry is decided by Gateway; it is not rejected as an expired grant locally. The Phase 1 recovery preview remains read-only and excludes restores from recovery eligibility.

## Outcomes and errors

| Signal | Handling |
| --- | --- |
| `restored`, `already_restored` | `delivery.status=done`, explicit `delivery.outcome` |
| `restore_refused_terminal`, `restore_expired`, `restore_nothing_forfeited` | Done, preserve explicit outcome; no new OS grant event |
| HTTP 409 `restore_hold_pending` | Durable dependency retry with existing backoff |
| HTTP 409 `restore_not_revoked`, `restore_mismatch`, `restore_review_required` | Failed with `delivery.reviewRequired=true` and fixed `last_error`; no silent retry |
| Invalid/missing/mismatched restore success response | `restore_response_invalid`, manual review |
| `event_conflict` | Existing permanent conflict handling; preserve receipt |
| Missing same-D suspend at processing | `failed:restore_suspend_pending`; no local positive |
| Missing pinned suspend account | `failed:restore_account_pending`; no local positive |
| Conflicting original/suspend/root/user/payer/cause | `review:restore_mismatch`; no local positive |
| Known terminal receipt at processing | `review:restore_refused_terminal`; no local positive |
| Missing canonical receipt | `review:restore_receipt_missing`; no local positive |
| Invalid/oversize causal event ID | `review:invalid_ai_event_id`; no financial effects |

Successful restore response parsing uses Gateway's `{event_id, outcome}` fields, checked against the outbound event. Provider text is not logged or stored. The client continues accepting the existing grant/revoke success responses.

## Files

Phase 2 source: `ai-credits.ts`, `processor.ts`, `store.ts`, `ports.ts`, `ai-credit-outbox.ts`, `ai-credit-outbox-store.ts`, `ai-gateway-client.ts`.

Matching tests: `ai-credits.test.ts`, `processor.test.ts`, `store.test.ts`, `ai-credit-outbox.test.ts`, `ai-credit-outbox.pg.test.ts`, `ai-gateway-client.test.ts`.

All paths are under `app/src/server/billing/`. Catalog, catalog contract tests, checkout client/tests, inbox webhook/tests and `types.ts` are byte-for-byte identical to the Phase 1 checkpoint. No O-API router/read/UI, bridge, proxy, compute lifecycle, Gateway source, dependencies or config changed. Subscription/Free IDs, allowances, expiry and prices are retained; both live top-up policies remain null.

## Local double-debit repair

Only `ai-credits.ts`, `store.ts`, `processor.test.ts`, and `store.test.ts` changed after the reviewed `713ce202` version. All other 16 final product/test files are byte-for-byte unchanged. The previous patches/receipts are archived under `pre-local-delta-repair/`; the original Phase 1 checkpoint is unchanged.

Under the existing root lock, the store reads the root's receipt history first, gathers every explicitly bound D/R cause, and loads their local ledger rows. The planner verifies original grant IDs, ownership, charge/customer, meter, subscription, period, sign and amount bounds. It counts each local ledger key once even if multiple root receipts reference it.

For each original grant:

`remaining local amount = original amount + sum(verified root-linked suspend/revoke/restore deltas)`

A new suspend/full refund writes `-remaining`, including a zero-value audit row when the allowance is already removed. Each new outbox receipt freezes an internal `localDeltas` audit array with original grant IDs and amounts. Existing valid receipts without that optional field remain supported. Replays retain the previously committed delta. A restore can restore only its own D's actual suspend amount within the original limit; it cannot offset a terminal refund. Missing or contradictory history is reviewed, never repaired by minting a positive entry.

The Gateway refund event remains distinct and terminal. Its body still carries the original root, original whole credits and frozen payer; a zero **local** delta does not change Gateway's `credits` field.

| Receipt sequence | Local deltas after the original +144000 | Final local amount |
| --- | --- | --- |
| Suspend → full refund | -144000, 0 | 0 |
| Full refund → suspend → won | -144000, 0; won refused | 0 |
| Suspend → earned restore → full refund | -144000, +144000, -144000 | 0 |
| Overlapping suspends → full refund | -144000, 0, 0 | 0 |
| Additional refund IDs or repeated deliveries | New terminal IDs get zero local delta; replays add nothing | 0 |

An independent +100000 paid upgrade remains +100000 in both the raw ledger sum and `fairUseAllowance`. Renewal grants and old-period replays remain isolated by original grant/root/period. Partial-refund review, payer binding, checkout policy and inbox integrity are unchanged.

`review:local_reversal_mismatch` is the explicit processing outcome for a negative correction with unproven/corrupt local history. Restore mismatches retain `review:restore_mismatch`. Neither outcome writes a financial correction. Existing already-corrupt history is not migrated or replayed by this source patch.

## Verification

- Nine focused suites: **631 passed, 27 PostgreSQL cases skipped**, exit 0.
- Supplied ordinary reproduction: **2 passed**, with 271 unrelated tests filtered out. The scratch copy changes only its in-memory correction loader to return all D/R rows, matching the revised store contract; the supplied original file and assertions are preserved. Both original assertions now pass: `+144000, -144000, 0` and independent allowance `100000`.
- Final TypeScript `--noEmit --incremental false --pretty false`: exit 0.
- `git diff --check`: exit 0.
- Both refreshed patch paths actually apply to isolated copies and reproduce all 20 final files byte-for-byte.
- Logs: `local-delta-final-focused.log`, `local-delta-review-repro.log`, `local-delta-final-tsc.log`.

New cases cover normal suspend/refund, refund/won, earned restore/refund both before and after AI delivery, interleaved duplicate D/refund IDs, distinct refund IDs, overlapping disputes, concurrent simulated suspend/refund, legacy-compatible receipt audit fields, independent upgrades, actual allowance calculation, renewal isolation, store cross-cause loading, zero-audit transaction rollback, and corrupt history refusal. The existing protocol, retry, checkout and inbox tests also pass.

## Remaining lead work

- Independently review/apply one patch path and run the real PostgreSQL cases on a disposable database. The prior independent 643-case result (including 27 real PostgreSQL cases) was for `713ce202`; it does not validate this new local-delta calculation or expanded store query.
- Integrate the independently owned Gateway G5 writer and verify the frozen 409 and success outcomes end-to-end in Stripe test mode when authorized.
- Enrollment bridge wiring and deployment remain with the lead. Existing commercial decisions (top-up conversion and team allowances) remain unset.
- Historical terminal/legacy and mismatched/overlapping receipts require explicit review. This patch includes no automatic migration, recovery write, or replay mechanism.
