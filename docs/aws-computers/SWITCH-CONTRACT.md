# One computer, selectable configuration: switch, restart and opening progress (wire contract)

Round 3, lane L2 (server). The pinned types are in `app/src/server/billing/v3/contract.ts`
(`SwitchConfigurationInputV3`, `SwitchConfigurationOutputV3`, `SwitchRefusalV3`, `SwitchPhaseV3`,
`OpeningPathV3`, `OPENING_MILESTONES_V3`, `OpeningProgressV3`). This file states exactly what the
server sends, so the shell lanes (L4a Settings, L4b opening) can code against it.

User-facing strings in the shell must pass `scanCopy`. Every field below is a code; the shell maps
codes to copy. Copy keys suggested here are names only, not text.

## 1. Switch the configuration

### Routes

- tRPC: `computer.switchConfiguration` (mutation).
- Shell HTTP: `POST /api/shell/switch` with a JSON body. It authenticates first (`401` signed out),
  then reads the body (`400 {"error":{"code":"BAD_REQUEST"}}` for invalid JSON), then calls the
  procedure. Refusals are a `200` with a value, never a thrown error. A wrongly typed field is the
  standard shell error answer (`shellErrorResponse`, `BAD_REQUEST`). `maxDuration = 300`.
- `SHELL_API_ROUTES` needs a `switch` key for the shell to discover the route. That file belongs to
  another lane (see the L2 report, `crossLaneEdges`).

### Request

```json
{ "computerId": "<uuid>", "size": "std-2" | "cmp-4" | "cmp-8", "requestId": "<8-64 of [A-Za-z0-9_-]>" }
```

`requestId` is made once per click, for example `crypto.randomUUID()`. Re-sending the same
`requestId` (a retry, a second tab) returns the same transition. `free-cf` is accepted by the schema
and refused as `not_entitled`.

### Response (`SwitchConfigurationOutputV3`)

```json
{ "ok": true, "effective": "switching", "current": "std-2", "target": "cmp-8", "transitionId": "<uuid>" }
{ "ok": true, "effective": "next_start", "current": "std-2", "target": "cmp-8", "transitionId": "<uuid>" }
{ "ok": false, "reason": "switch_in_progress" | "not_entitled" | "capacity_unavailable" | "computer_busy" | "foreign_computer" }
```

The checks run in this order:

1. `foreign_computer`: the computer is not the caller's live computer (missing and foreign give the
   same answer), or its placement belongs to someone else.
2. `not_entitled`: the same rule as `billing.selectMachine`: an `active` `premium_monthly_v3` plan
   whose `machineChoice` lists `size`, and an active AWS compute entitlement with an allowance and no
   payment issue. A malformed `requestId`, `free-cf`, and a monthly-cap refusal at preflight
   (`user_hours_cap`, `user_egress_cap`) are also `not_entitled`.
3. An in-flight transition. The same `requestId`, or a switch to the same `target`, returns that
   transition (`ok: true`, `effective: "switching"`). Anything else is `switch_in_progress`. A
   restart in flight also blocks a switch.
4. The computer's state:
   - **RUNNING, different size**:
     - The capacity preflight runs before anything is stopped. If it fails, the answer is
       `capacity_unavailable` and the computer keeps running untouched.
     - Otherwise the server records the transition and stores `size` as the next-start preference.
       It answers `switching` at once.
     - It then stops the computer and wakes it on `size`, in the background after the answer.
   - **RUNNING, same size**: the preference is stored and the answer is `next_start`. Nothing restarts.
   - **STOPPED, no AWS computer yet, or UNCONFIRMED** (waiting for recovery): the preference is
     stored. The answer is `next_start` (offer "Start now"). The `transitionId` is fresh and no
     transition record is kept.
   - **Opening, stopping, recovering, retiring, or a provider migration in progress** (an
     unreadable migration state counts as in progress): `computer_busy`, and nothing is stored.

The preference store is the one `billing.selectMachine` writes (`ezil_billing_size_preferences`). So
`billing.summary` and the next open both see the new size.

### Capacity preflight (`capacity_unavailable`)

`preflightSwitchCapacity` (`lib/compute/aws-pool-runtime.ts`) checks two things before any stop:

1. **Admission's own rules**, read-only: kill switch, monthly caps, and the regional and global vCPU
   cap. The computer's own running slot is released for this check, so it is never counted twice.
2. **The pool count** (`poolVcpuExcess`, the same function pool opens use in `validateCapacity`). It
   includes live placements, every unretired pool host not bound to one (spares count), other active
   capacity demands, and 2 vCPU per migration reservation.
   - A READY spare of the target class is adopted at net zero.
   - Otherwise the target's vCPU is added and the current vCPU is released.
   - When over the cap:
     - idle reclaimable spares that cover the excess → admitted as a capacity wait;
     - another active demand in the region → refused;
     - too little to reclaim → refused.

### Phases (`SwitchPhaseV3`)

`requested → stopping → waking → done | failed`

- `stopping`: the server's confirmed stop, budget 200 s. This is the existing `confirmAwsStop`.
- `waking`: `ensure` on the STOPPED placement, budget 600 s. Because the preference now names the
  target, this is the existing replace path:
  - same data volume, generation + 1, new fence token;
  - the old instance is stopped and terminated by the lifecycle helper;
  - a warm spare of the target class is adopted when ready, otherwise it is a cold boot;
  - for a pending warm adopt (`pool_session_pending`), the driver runs the same Worker preview
    exchange the open route runs (`prepareAwsPoolSession`) once per lease epoch, so the switch
    completes with no browser open.
- `done`: the placement is RUNNING on a later lease epoch with the target's instance type.
- `failed`: `reason` is one of:
  - `stop_timeout`, `stop_<outcome>`, `wake_timeout`;
  - `capacity_unavailable` (also UNCONFIRMED `capacity:*`), `unconfirmed`, `size_not_applied`;
  - `billing_<refusal>`, `placement_missing`, `placement_unavailable`, `computer_retired`, or another
    open refusal code.

  On failure the server reverts the preference to `current`, but only if it still equals `target`.
  `revertAvailable` is `true` for a failed switch. "Back to <current>" is an ordinary
  `switchConfiguration` to `current`: with the computer RUNNING on `current` that is `next_start`,
  and with it stopped or UNCONFIRMED it stores the preference.

Reads never trust the stored phase. Every read derives it from the placement (`resolveTransition`), so a
driver that died still reads as `failed` once a budget passes. The next `switchConfiguration` or
`restartComputer` call finalizes such a transition and reverts the preference.

### Duplicates and concurrency

- One UPDATE of one row records the transition. Two tabs racing it get one transition: the loser
  re-reads and answers the same transition when it is the same request or target.
- The one-host guarantee is the placement compare-and-swap that every lease and replace uses.
- A second wake losing that CAS (the shell's own open racing the server's wake) answers
  `computer_starting` with `retryable: true` (`error: "cas_conflict"`). The shell keeps waiting and
  never shows "Something went wrong".

## 2. Restart

### Restart the desktop service (existing button)

`POST /api/shell/restart` `{ "computerId": "<uuid>", "requestId"?: "<uuid>" }` (scope `desktop` is
the default). The answer is `{ ok, outcome?, errorCode?, correlationId, provider }`.

For an AWS computer, `errorCode` is one of:

| errorCode | meaning | suggested copy key |
|---|---|---|
| `restart_not_running` | no RUNNING AWS computer | `restart.notRunning` |
| `restart_busy` | it is opening, stopping or recovering, the lease moved (Worker 409), or the Worker reports `restart_busy` | `restart.busy` |
| `restart_budget_exhausted` | Worker 429 or `outcome: "restart_budget_exhausted"` (needs the Worker change in the report) | `restart.budget` |
| `restart_host_unreachable` | the dispatch got no answer (transport failure, 502/503/504) | `restart.unreachable` |
| `restart_timeout` | dispatched, but no new desktop was seen within 180 s | `restart.timeout` |
| `restart_unavailable` | disabled, misconfigured, or any other refusal (unchanged catch-all) | `restart.unavailable` (existing) |

The restart no longer requires the first runtime read: a frozen desktop is restartable. Completion is
detected in one of three ways:

- a runtime id different from the one read before the restart;
- with no earlier read, a desktop that answers after it was seen down;
- with no earlier read, a second identity that differs from the first one seen.

### Restart the whole computer (new)

`POST /api/shell/restart` `{ "computerId": "<uuid>", "scope": "computer", "requestId": "<8-64 of [A-Za-z0-9_-]>" }`.
The tRPC equivalent is `computer.restartComputer({ computerId, requestId })`. Any other `scope` is `400`.

```json
{ "ok": true, "transitionId": "<uuid>", "path": "restart", "size": "cmp-4" }
{ "ok": false, "errorCode": "restart_not_running" | "restart_busy" | "restart_switch_in_progress" | "restart_foreign_computer" | "restart_not_entitled" | "restart_unavailable", "reason": "<same without prefix>" }
```

The tRPC procedure returns `reason` alone. The server runs a confirmed stop, then a server-initiated
open on the SAME size it was running, even when the next-start preference differs (that preference is
kept). It goes through the same billing gate as every open. The phases are the switch phases; the
transition `kind` is `restart`. The same `requestId` again returns the same restart.

## 3. Opening progress (`computer.progress`)

The existing fields are unchanged. Added fields:

```json
{
  "stage": "leased" | "starting" | "mounting" | "switching" | "restarting" | "waiting_capacity" | "...existing",
  "operation": "opening",
  "active": true,
  "openingStartedAt": "2026-10-28T10:00:00.000Z",
  "path": "warm" | "cold" | "switch" | "migrate" | "restart",
  "expectedSeconds": 300,
  "typicalSeconds": 300,
  "milestones": [
    { "key": "requested", "at": "2026-10-28T10:00:00.000Z" },
    { "key": "host_claimed", "at": "2026-10-28T10:01:10.000Z" }
  ],
  "transition": {
    "transitionId": "<uuid>", "kind": "switch" | "restart", "current": "std-2", "target": "cmp-8",
    "phase": "requested" | "stopping" | "waking" | "done" | "failed", "reason": null,
    "requestedAt": "2026-10-28T10:00:00.000Z", "endedAt": null, "revertAvailable": false
  }
}
```

- `openingStartedAt` is stamped once per opening on the server and stored with the computer, so every
  tab and every reload sees the same value. It is `null` when nothing is opening.
  - For a switch or restart, it is the request time (one opening from the click, through the stop).
  - For a warm adopt, it is the pool lease time.
  - For a cold wake, it is the lease's enrollment-nonce issue time.
  - Otherwise it is the first server read of the opening.
- `path`:
  - `switch`/`restart` while that transition is in flight (and for the wake it caused);
  - `migrate` during a provider migration;
  - `warm` when a pool host was adopted for this lease epoch;
  - otherwise `cold`.
- `expectedSeconds`, clamped to 90–600 s:
  - warm: the median measured claim → session-ready of the class (last 20 adoptions), default 90;
  - cold: 240;
  - switch/restart: 60 for the stop, plus warm or cold for the wake;
  - migrate: the migration's own estimate.

  `typicalSeconds` carries the same value while opening.
- `milestones`, in order `requested → host_claimed → files_attached → desktop_starting → desktop_ready`:
  - `host_claimed`: LEASED, or the pool `leased_at`;
  - `files_attached`: MOUNTING, or the pool claim publish;
  - `desktop_starting`: the host enrolled;
  - `desktop_ready`: RUNNING / session-ready.

  Guarantees:
  - A milestone is stamped once and never changes.
  - A later milestone never appears without every earlier one; a gap takes the later time.
  - Times never decrease.
  - The client appends `url_received` and `first_frame` itself.
- `stage: "waiting_capacity"`: the placement is STOPPED while an active capacity demand holds its open.
  It is an opening (`operation: "opening"`, `active: true`), never "stopped".
- `stage: "switching" | "restarting"`: a transition is in flight while the old computer is still
  running or stopping. Once it leases, the ordinary stages follow.
- The L-A invariants hold:
  - an expired enrollment or UNCONFIRMED is `needs_operator`, with no opening fields;
  - a genuinely starting AWS open stays `active` with `operation: "opening"`, so `activeAws` stays true.

## 4. Settings → System (`computer.systemInfo`)

`plan.status`:

- `being_prepared` ONLY while a switch or restart is in flight.
- `ready` once the computer is on AWS (RUNNING or STOPPED), whatever the next-start choice is.
- `failed` (with `reason`) for a failed switch, until a later opening, or for a failed migration.
- `preparing` while the computer has not reached AWS yet.
- `blocked` while AWS is paused.

Added fields: `plan.current` (the size it runs, from the instance type), `plan.selected` (the next
start's choice) and `plan.transition` (the same object as in progress).

## 5. Where the records live

`ezil_computers.metadata` (an existing JSONB column) holds two keys:

- `transition`: the last switch or restart;
- `opening`: this opening's start time and milestones.

The column is owner-writable through RLS, so both records are advisory only:

- they are parsed strictly and bound to the owner;
- they never authorize a stop, a size or a host.

Sizes come from the server-written preference. The one-host guarantee is the placement CAS.
Timings are persisted through the existing telemetry ingestion (`ezil_error_events`, class
`boot_summary`), under sites `compute.pool_session_timing` and `compute.transition`.
