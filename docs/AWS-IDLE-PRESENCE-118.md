# AWS idle presence and the minute full reconcile (r118)

Source-only assessment at `38dc3ccf`. The thresholds below are pinned by
`app/src/app/api/cron/aws-reconcile/presence-thresholds.test.ts`. This branch changes no presence
behaviour. It schedules the existing full reconcile (`/api/cron/aws-reconcile`, staging minute timer).
Background: `team/ROOT-IDLE-DOWNSCALE-REVIEW-118.md`.

## Signals

| Signal | Source | Value |
|---|---|---|
| Shell heartbeat interval | `shell/ezil/activity-heartbeat.js` `HEARTBEAT_INTERVAL_MS` | 60 s |
| Presence | `isPresent` | tab visible AND `document.hasFocus()` (counts as present only if `hasFocus` is unimplemented). No key/pointer measurement. |
| Heartbeat sent | `shouldHeartbeat` | tab visible AND presence seen within `ACTIVITY_FRESH_MS` = 30 min. A hidden tab sends nothing. |
| Lease renewal | `aws-ec2.ts` `renewLease` | only from presence fresher than `AWS_PRESENCE_FRESH_MS` = 30 min. New lease = presence + `leaseSeconds` (3600 s), never shortened, written only once more than half the lease is used. |
| Lease enforcement | `aws-receipts.ts` `sessionLimitFor` / `enforceSessionLimits` | a RUNNING row with `lease_until <= now` (or no lease) gets the ordinary lifecycle stop (it flushes). It runs on status/ensure, on every activity heartbeat, and in the fleet pass. |
| Edge presence | `infra/host-agent/.../edge.py` | every verified request, plus one tick every `WS_PRESENCE_INTERVAL` = 30 s while ANY verified WebSocket is open, regardless of traffic. Throttled to one per 15 s. |
| Guest idle stop | `config.py` idle | after `inactivitySeconds` = 600 s with no edge presence, checked every 30 s. Holds: terminal work (any tmux session or foreground terminal job) for at most 8 h after presence, load1 ≥ 0.5 (unknown counts as busy), and the flush (timeout 120 s). |
| Fleet pass bound | `FLEET_RECONCILE_LIMIT` / `RETIRE_RECONCILE_LIMIT` | 20 rows each per pass, claimed with `FOR UPDATE SKIP LOCKED`, least recently reconciled first. |

## Exact outcomes once the full reconcile runs every minute

Let *P* be the last time a heartbeat carried fresh presence (sampled every 60 s, so up to 60 s after the
last real visible+focused moment).

- **Present (visible + focused):** the lease keeps renewing, and nothing in this change affects it.
- **Hidden tab, sockets still open:** no heartbeats, so no renewal. Because of the half-lease write rule,
  the lease expires somewhere in **(P + 30 min, P + 60 min]**. The next minute pass then starts the lease
  stop. If more than 20 reconcilable rows exist, rotation can take more passes.
  - The guest never becomes idle-due while any authenticated WebSocket stays open (the 30 s edge tick).
    So in this case the control-plane lease is the only stop.
- **Visible but unfocused:** heartbeats continue for 30 min after *P*, and each one enforces limits, but
  none renews the lease past *P* + 60 min. The lease stop lands at the same (P + 30, P + 60] minute.
- **Disconnected (no socket, no tab):** the edge goes silent. With no hold, the guest begins its idle stop
  600–630 s after its last presence. The next minute pass sees the stopping/stopped instance
  (`reconcileGuestStop`) and starts the ordinary session end (release in pool mode), so accounting
  converges within about a minute instead of waiting for 04:08 UTC or an interactive call.
  - With a terminal, load or flush hold, the guest keeps running, and the lease stop above applies at
    (P + 30, P + 60] minutes.

## ⚠ Decision for the primary before deploy

The guest's terminal hold (tmux or foreground job, up to 8 h) only holds the **guest's own idle stop**.
The control-plane **lease stop** does not consult it. Until now the lease stop for an unattended computer
ran only lazily:
- on the owner's own status/ensure/heartbeat;
- in a capacity refusal;
- in the daily 04:08 UTC reap.

With the minute timer, a long-running terminal job whose owner is not present (hidden tab, unfocused
window, or closed browser) is stopped about **30–60 minutes after P** instead of surviving until one of
those lazy triggers.

This is the existing lease policy applied promptly; the stop path itself is unchanged. It can still
interrupt work that a user considers active, e.g. watching build output in a visible but unfocused
window. Root's review warns against this.

Options, all outside this branch's files:
- (a) Accept: the lease is the commercial/technical contract.
- (b) Have the minute pass observe guest stops and deleted computers but leave lease-expiry stops to the
  existing lazy triggers. This needs a policy flag in `reconcileAwsFleet`'s caller or in
  `enforceSessionLimits` (aws-receipts.ts).
- (c) Count terminal holds as presence for lease renewal.

No presence behaviour was changed here, because none is clearly safe without that decision.
