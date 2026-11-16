# O-credits Phase 2 review receipt

Phase 2 implements W0.3 §5 in 13 owned billing source/test files. Phase 1 was checkpointed before implementation and is preserved. This receipt describes source work only; no vendor/database calls, installs, commits, deployment, agents, or history replay occurred.

## Apply exactly one path

- If the reviewed Phase 1 patch is already applied: apply `o-credits-phase2-only.patch`.
- From `25c1274b5215`: apply `o-credits-full-final.patch`.
- Do not apply both patches to the same tree.

Both paths were actually applied to isolated RAM copies, then all 20 resulting files were compared byte-for-byte with the final working files. The Git index, Phase 1 checkpoint, other worktrees, and sessions were preserved.

| Artifact | SHA-256 |
| --- | --- |
| Saved Phase 1 checkpoint | `907afd5113eecf60cdc907918e06a51cda5975592f58745448a0c1fc73c48697` |
| Phase 2 incremental | `b8e3e34cb6d599daf189450f9a18c47f96154523070d8240cd955a3a5c58ff56` |
| Full final patch | `713ce202b0a815033fd5e74e7567de1ac3ef11ed81fddb20f92de53ec53cbc29` |

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

`recordAiReversal` takes the cause lock, then sorted root locks. In the transaction it rereads customer ownership, the original local grants, same-cause corrections, and all relevant root/cause outbox receipts. The immutable reversal metadata binds D/R, charge, Stripe customer, original grant IDs, user, source, subscription, meter, amount, and period. All root receipts must agree on credits, expiry, source and payer.

A new restore requires the same-D canonical dispute revoke and an exact local negative suspend for every original meter. The payer must already be frozen on the suspend receipt. The positive local corrections and `ai_restore` rows are inserted together; any conflict rolls the transaction back. Replays add neither. A same-value purchase cannot borrow another purchase's D receipt.

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

## Verification

- Nine focused suites: **615 passed, 27 PostgreSQL cases skipped**, exit 0.
- Final changed-suite run after adding the cross-purchase D case and making the PostgreSQL fixture use rollback-only transactions/savepoints: **271 processor tests passed, 16 PostgreSQL cases skipped**, exit 0. Aggregate unique focused cases: **616 passed, 27 skipped**.
- Final TypeScript `--noEmit --incremental false --pretty false`: exit 0.
- `git diff --check`: exit 0.
- Both patch application checks and byte comparisons: exit 0.
- Logs: `phase2-focused-final.log`, `phase2-final-additions.log`, `phase2-tsc-final.log`.

Meaningful coverage includes wrong D/root/user/payer/local facts, won-before-created, refund/legacy terminal receipts, overlapping D, completed successive chains retaining original whole credits, duplicate/concurrent simulated restores, transaction rollback on outbox conflict, ID limits, expired restore outcomes, 409 review/hold handling, and waits beyond ten attempts. New real-PostgreSQL source cases cover causal claim ordering, durable holds/lease fencing, payer mismatch review, and a queued refund overtaking restore. They were not executed.

## Remaining lead work

- Independently review/apply one patch path and run the real PostgreSQL cases on a disposable database. Earlier independent Phase 1 PostgreSQL results do not validate this Phase 2 SQL or fixture change.
- Integrate the independently owned Gateway G5 writer and verify the frozen 409 and success outcomes end-to-end in Stripe test mode when authorized.
- Enrollment bridge wiring and deployment remain with the lead. Existing commercial decisions (top-up conversion and team allowances) remain unset.
- Historical terminal/legacy and mismatched/overlapping receipts require explicit review. This patch includes no automatic migration, recovery write, or replay mechanism.
