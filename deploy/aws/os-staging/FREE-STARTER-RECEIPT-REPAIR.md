# Free starter receipt repair (os-staging)

Request `os-free-starter-fix-repair-20261105-v1`. Executor: **cb1 only**, under the shared staging
lease, **after** the reviewed source fix is live. Production is out of scope.

## What went wrong

Before the fix, `app/src/server/auth/staging-ai-enrollment.ts` inserted the sign-in Free starter
receipt by binding `JSON.stringify(payload)` to `$4::jsonb`. Its raw postgres.js client
serializes jsonb parameters itself, so the row was stored as a **jsonb string**.

The AI-credit outbox claim filters on `payload->>'protocol'`, which is null for a string. Those rows
were therefore never claimed (attempts 0), and no starter grant reached the Gateway. With
`require_entitlement` on, such a Free member is refused with `no_entitlement`, and the editor shows
"AI access needed".

## What the repair does, and does not do

`app/scripts/free-starter-receipt-repair.mjs` converts each allowlisted row's payload from the jsonb
string to the jsonb object that the string already contains, in one statement:
`payload = (payload #>> '{}')::jsonb`.

It never touches any of the following:

- **Rows:** no row is created, and no grant or credit is issued.
- **Row fields:** owner, `event_key`, kind, `attempts`, `last_error`, `delivered_at` and
  `created_at` stay as they are.
- **Payload values:** the 100 credits, the original expiry (sign-in instant + 365 days),
  `entitlementId` and `eventId` stay as they are.

The normal drain delivers on its next sweep. A second grant for a root is refused three times over:
the unique outbox `event_key`, the Gateway's `funding_events.event_id` primary key, and the
Gateway's unique `grants.entitlement_id`.

The script refuses, and writes nothing, unless all of these hold:

- **Target:** the database system identifier equals `--expect-system-id`, and the URL is not the
  production project.
- **Rows:** the allowlist has exactly `--expect` unique sha256(`event_key`) digests, each matching
  one row.
- **Locks:** it holds a repair advisory lock, every allowlisted row is locked `FOR UPDATE NOWAIT`,
  and the drain's own per-root advisory lock (`billing:ai_root:<root>`) is free.
- **Row state:** each row is `ai_grant`, undelivered, has `attempts = 0` and no error.
- **Payload:** each payload is exactly the 8-key free-once receipt of the row's **own** user, with
  protocol `ezil-ai-credits-v1`, 100 credits, and an expiry in the future that matches
  `created_at` + 365 days.
- **User:** the auth user exists and is not deleted, has **no** non-ended subscription (currently
  Free), and is enrolled (`ezil_works.ai_members`).
- **Uniqueness:** no other outbox row and no Gateway grant or funding event exists for that root.
- **After the update, inside the same REPEATABLE READ transaction:** every row is an object equal to
  its decoded original, its fixed columns are unchanged, and it is claimable. Every other outbox row
  is byte-identical (count and digest).

Modes:

- **`dry-run`** (the default) performs all of this, then **rolls back**.
- **`apply --yes`** commits.
- **`capture`** and **`verify`** are read-only.

Output is JSON lines carrying digests, timestamps, counts and fixed codes only. No id, key, email,
payload value or URL is printed.

## Scope (decided 2026-11-05 11:44Z)

The scope is only the **six** current-Free, enrolled members whose sign-in receipts were confirmed
read-only at 11:33Z: two from 2026-11-01, three from 2026-11-03 and one from 2026-11-05. Their
minute-level times are on the OS Notion task.

Excluded:

- **The Standard QA identity's row (2026-11-04).** Its owner (Universe 0e) has not agreed.
  `capture` reports it as `not_currently_free`.
- **The two `needs_ezil_id` users.** Their rows are jsonb objects parked on `no_ai_account`, so
  this script never selects them.

Any eligible row created after these six is **new**. Leave it out of the allowlist and report it
for a separate decision. Never broaden the batch.

## Checklist (cb1)

1. **Fix live first.** Install the reviewed source onto the then-live head, composed with whatever
   is live (app `85cefd09` login fix; any folder change). Read back `/api/health`. After one new
   EZiL ID sign-in, or by waiting, confirm that no new string row appears: `capture`'s
   `stringRows` must not grow.
2. **Lease and pin.** Take the shared staging lease. Get the os-staging database system identifier
   from cb1's own verified record, never from the connection under test.
3. **Stage the script.** Copy the **reviewed** blob into the web container, then compare its sha256
   with the one recorded at review.
   ```bash
   docker exec -i ezil-os-staging-web-1 sh -c 'umask 077; cat > /tmp/free-starter-receipt-repair.mjs' \
     < app/scripts/free-starter-receipt-repair.mjs
   docker exec ezil-os-staging-web-1 sha256sum /tmp/free-starter-receipt-repair.mjs
   ```
   Run every mode from the container's app working directory, so that postgres.js resolves. The app's
   existing `SUPABASE_DATABASE_URL` is used; there is no new env, flag or credential.
4. **Capture** (read-only):
   ```bash
   docker exec ezil-os-staging-web-1 node /tmp/free-starter-receipt-repair.mjs capture --expect-system-id DIGITS
   ```
   - Expect exactly **six** `eligible: true` rows, with the dates above.
   - Expect the 2026-11-04 row with `not_currently_free`.
   - Abort on any difference.
5. **Allowlist** (local only). Write the six digests to `/tmp/free-starter-allowlist.txt` (umask
   077) inside the container. Never put them in git, Notion, chat or logs.
6. **Dry run.** Run it with `--allowlist /tmp/free-starter-allowlist.txt --expect 6`. Expect
   `{"event":"dry-run","converted":6,"committed":false,...}` and nothing else. A `refused` or
   `error` line means stop.
7. **Apply.** Run the same command with `apply ... --yes`. Expect `{"event":"applied","converted":6,"committed":true}`.
   It is atomic: any refusal commits nothing.
8. **Verify** after one to two sweep minutes:
   ```bash
   docker exec ezil-os-staging-web-1 node /tmp/free-starter-receipt-repair.mjs verify \
     --expect-system-id DIGITS --allowlist /tmp/free-starter-allowlist.txt --expect 6
   ```
   - Exit **0** means all six rows read `delivered_once`: exactly one Gateway grant (source
     `entitlement`, not revoked, the original expiry) and exactly one funding event (`grant`, 100
     credits, the same expiry) per root.
   - Exit **2** means pending: run it again after the next sweep.
   - Exit **1** means a mismatch: stop and report.
   - `string-row-outside-allowlist` lines should list only the excluded 2026-11-04 row.
   - `creditsMicro` should be `100000000`. On 2026-11-05, every delivered, non-revoked 100-credit
     starter grant has that value. `starterCreditsMicroBefore` also lists `500000000`, which comes
     from legacy 500-credit starters that were later revoked. Any other value is reported, not
     corrected.
9. **Clean up.** Remove both `/tmp` files from the container, release the lease and read it back.
   Then have one consenting Free test identity, or the founder's own view, confirm the starter
   credits and the model list. No AI inference is needed.

**Rollback:** none is needed before step 7. After `apply`, the rows are ordinary valid receipts,
and the drain delivers them. Reversing a delivered starter grant would be a separate Gateway revoke
decision, out of this scope.
