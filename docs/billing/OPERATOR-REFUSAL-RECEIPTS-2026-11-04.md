# OS operator refusal receipts — 4 November 2026

Authored correction from 3ac2ec122c2bb0d14f9f0f6b1e550db85dd9cb04. Independent
delta review and release decisions remain separate.

## Durable boundary

A correctly authenticated command that passes structural parsing and resolves
one live OS user to the supplied Gateway account now records either its applied
result or its business refusal under the existing global command ID and canonical
payload hash. The hash covers the original command except command_id, including
target, operator, SKU, validity and reason.

An identical business-refusal resend returns the original refused result and
access snapshot, even after a paid conflict clears or the expected revision later
exists. A changed payload under that ID is payload_mismatch before a new target
identity decision. A new attempt after conditions change needs a new command ID.
Well-formed unknown product refs are business refusals and reserve their IDs.

The durable boundary excludes authentication/configuration failures, invalid
JSON/IDs/command structure and initially unresolved or ambiguous identity. These
requests have no receipt. An initially unlinked pair may therefore be retried
after a real link exists; it is then evaluated as a new eligible command.
No claim of durable idempotency is made before this boundary.

Applied retries retain outcome=replayed. Refused retries retain outcome=refused:
the frozen v1 parser requires a non-null refusal exactly when outcome is refused.
Public command/result formats and fields are unchanged.

## Transaction and audit

The existing command advisory lock is acquired before the target account lock.
Both remain outside the access savepoint. Grant updates, lapsed-row closure and
applied event insertion occur inside it. A typed business refusal rolls that work
back first, then appends only its refusal receipt in the outer transaction.
Unexpected storage errors still abort the command transaction.

Migration 0020 extends the existing append-only event ledger rather than
fabricating an assignment: refused rows have null assignment_ref and revision;
applied rows require both. Command uniqueness, payload hash, actor/via, sender kid,
reason, user ownership, RLS and the append-only trigger stay in place. Refusal
result.assignment and audit_receipt stay null; the internal audit row records the
attempt without claiming an access change. Operator email is not stored.

Paid precedence/conflicts and all existing activation/admission rules stay the
same. No Stripe subscription, invoice, payment, receipt or AI credit is created.

## Migration and rollback

Apply immutable 0019 and then additive 0020_operator_refusal_receipts.sql before
this corrected application. 0020 is registered in the staging runner and immutable
snapshot inventory; production apply/baseline is explicitly refused.

Preserve the additive schema and append-only receipt history on image rollback.
Do not restore NOT NULL or delete refusal rows. The old 3ac2 reader changes every
stored result to replayed, so a stored refusal would violate the v1 result parser.
A rollback to that reader must retain the corrected replay behavior or leave the
command endpoint inert with no configured sender keys. Earlier pre-operator images
ignore the tables. No schema rollback or audit-history deletion is part of this
correction.

This work performs no deployment, key installation or real assignment. A real
Standard/Premium license can cause AWS compute consumption through the existing
admission/migration path and remains separately gated.
