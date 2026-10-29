# Computer standing contract (round 4, Phase A)

Pinned by lane R4-L1 for the shell lane (R4-L2). Source of truth:
`app/src/server/billing/v3/standing.ts` (`deriveStanding`), the additive fields in
`app/src/server/billing/v3/contract.ts` (`BillingSummaryV3`, `AdmitDecisionV3`,
`AdmitRefusalV3`) and `app/src/server/lib/compute/system-info.ts` (`SystemInfo.plan`).
Founder decisions: plan `jaunty-singing-tulip` §12 D16 to D19. D20/D21 (the move to
the Free computer and the 14-day volume retention) are Phase B: in this phase
`computer.move` is always `null` and no file is ever moved.

The standing is derived on every read from the subscription rows, the open payment
issues, the placement and the clock. Nothing new is stored.

## 1. States

| `computer.standing` | When | What opens | Dates |
|---|---|---|---|
| `paid` | A current paid period, no unresolved subscription invoice issue | The paid computer at the plan's configuration | none |
| `grace` | Raw Stripe `past_due`, or an unresolved invoice issue on the subscription's own invoices (`payment_failed`, `requires_action`, `uncollectible`) | The paid computer, unchanged (D17) | `plan.graceEndsAt` |
| `plan_ending` | `cancel_at_period_end` inside the paid period | The paid computer until the period end (D18) | `plan.planEndsAt` |
| `files_on_aws` | On Free and any of the user's live computers still has an aws-ec2 placement | That AWS computer at std-2 (2 vCPU / 8 GB, weight 1) under Free limits; a larger AWS computer stays closed (D16) | `computer.heldSince` (may be null) |
| `free` | On Free with the files on Cloudflare | The Free computer (2 vCPU / 6 GB on Cloudflare) | none |

"On Free" means any of: no subscription; an immediate cancel or a dunning cancel
(raw status `canceled` or `unpaid`, whatever the period end says); a cancel at period
end after the end; a never-paid `incomplete`; grace over.

### Grace (D17)

- `graceEndsAt = min(first unresolved issue + 7 days, first uncollectible issue)`.
  Issues are the selected subscription's own invoices only: unresolved, not `voided`,
  `invoiceKind = 'subscription'`. Upgrade and overage invoices never start grace.
- A `past_due` with no issue row anchors on the subscription's current period start.
- In grace while `now < graceEndsAt`: 6 days 23 h 59 m after the first issue is in
  grace, exactly 7 days is not.
- Stripe moving the subscription to `canceled` or `unpaid` ends grace at once.
- A failed renewal has no receipt for the new period yet. In grace the plan's own fair
  use applies; any receipt or reversal for the period (a refund) still wins.
- The Billing summary keeps `plan.status = 'past_due'` and `plan.paymentIssue =
  'payment_failed' | 'requires_action'` during grace, so the copy can say the payment
  didn't go through. The gate does not refuse for payment during grace.

### Refunds (D19)

A refund without a cancel never changes the standing. It reverses the period's
allowance, so the open is refused `fair_use_paused` when nothing is left.

### heldSince

Only for `files_on_aws`:

- grace over: `graceEndsAt`;
- the newest subscription's period ended in the past: that period end;
- an immediate cancel or an `unpaid` drop: `null`, because the row stores no cancel time. Never guessed.

## 2. Summary DTO (additive, `billing.summary`)

```ts
plan: {
  // existing fields unchanged …
  graceEndsAt?: string | null;   // ISO seconds; set only in 'grace'
  planEndsAt?: string | null;    // ISO seconds; a cancel at period end (also kept during grace)
};
computer: {
  // existing fields unchanged …
  standing?: 'paid' | 'grace' | 'plan_ending' | 'files_on_aws' | 'free';
  filesOn?: 'aws' | 'cloudflare';     // any live aws-ec2 placement → 'aws'
  heldSince?: string | null;          // files_on_aws only
  move?: ComputerMoveV3 | null;       // always null until Phase B
};
interface ComputerMoveV3 {            // reserved for Phase B; never sent now
  direction: 'to_cloudflare' | 'to_aws'; stage: string; bytesDone: string; bytesTotal: string | null;
}
```

The fields are optional in the type for older servers. This server always sends them
for v3 summaries. `filesOn` is `cloudflare` when placement reads are off or the
placement cannot be read: the summary never fails on it.

When the standing is `files_on_aws` or `free` but the subscription is still `past_due`,
`unpaid` or `incomplete`, the `plan` block still describes that subscription so the
user can pay. `computer.standing` decides what opens.

## 3. Opening (the start gate)

Refusals come back from `previewUrl`, `appPreviewUrl`, `codePreviewUrl` and
`restartDesktop` as `{ ok: false, errorCode: 'billing_<reason>', billingRefusal: '<reason>' }`.

| Standing | Computer | Result |
|---|---|---|
| paid, plan_ending | any | as before |
| grace | AWS | admitted at the paid configuration |
| grace | Cloudflare (paid user) | admitted, rated std-2 |
| files_on_aws | aws-ec2 `m6i.large` (std-2) | admitted at std-2, Free session cap (1 h), Free fair use (5 h, legacy Free 8 h), weight 1; the decision carries `hold: true` |
| files_on_aws | aws-ec2 `m6i.xlarge` / `m6i.2xlarge` | refused `billing_files_on_aws` (new code) |
| files_on_aws | Free fair use spent | refused `billing_fair_use_paused` |
| free | Cloudflare | admitted, Free limits |
| free | AWS canary with no recorded type | refused `billing_size_not_allowed` (unchanged) |

The hold is never a resize. A lost instance is replaced onto the same `m6i.large`
and the same volume. The hold is decided again at readiness, so the session deadline
is `ready + min(1 h, Free time left)`, never `ready`.

New refusal reason: `files_on_aws`, meaning "your files are kept on your AWS computer;
upgrade to open it". It is deterministic, so it must not be auto-retried.

## 4. System tab (`computer.systemInfo` → `plan`)

`plan` is now set for a Free user instead of being absent. New fields:
`name: 'Free' | 'Standard' | 'Premium'`, `provider: 'aws' | 'cloudflare'` and, on
Free, `standing`. `region` may be `null`.

| Case | plan |
|---|---|
| Free on Cloudflare, or not placed yet | `{ name: 'Free', provider: 'cloudflare', standing: 'free', vcpu: 2, memoryGB: 6, region: null, status: 'ready', current: 'free-cf' }` |
| Free with an aws-ec2 placement | `{ name: 'Free', provider: 'aws', standing: 'files_on_aws', vcpu, memoryGB, region: 'ap-south-1', status: 'ready', current: 'std-2' \| 'cmp-4' \| 'cmp-8' \| null }` (from the recorded type) |
| Paid | as before, plus `name` and `provider: 'aws'` |

A client must branch on `plan.provider` before writing "on AWS (India)". The old
`describePlan` writes "on AWS (India)" for every plan, which would be false for Free on
Cloudflare.

## 5. Copy constraints for the shell

- Say "AWS (India)". Never name a city or a region code.
- Never claim the files were moved. In this phase they stay where they are.
- `grace`: the payment didn't go through; the computer keeps working until
  `graceEndsAt`; update the payment method.
- `plan_ending`: "<Plan> ends on <planEndsAt>. After that your files stay on your AWS
  computer until they are moved to your Free computer. Nothing is deleted."
- `files_on_aws`: your files are still on your AWS computer; it opens with Free limits
  (sessions up to 1 hour); upgrading restores full use. For `billing_files_on_aws`:
  your files are kept on your AWS computer; upgrade to open it.
- Banned in user copy: faster, instant, unlimited, priority, gpu, heavy use, model
  names, compute hours, standard-hour.
