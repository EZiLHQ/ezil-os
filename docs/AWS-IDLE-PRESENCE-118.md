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

Root chose option (b) (`team/ROOT-IDLE-POLICY-118.md`), and after the 2026-10-25 incident
(`team/ROOT-FLEET-LEASE-INCIDENT-118.md`) it holds for EVERY fleet pass: `reconcileAwsFleet` (the minute route, the
daily 04:08 UTC reap and a capacity refusal's direct reconcile) never stops a still-running guest solely because its
technical lease lapsed. Weighted user/global hour caps still stop it, and guest-initiated stops, recorded receipts and
deleted computers are still settled. The owner's automatic status/ensure/activity heartbeat are caps-only too (root
POLICY DECISION 14:57Z); only an explicit owner Stop ends a session regardless of its lease.

Let *P* be the last time a heartbeat carried fresh presence (sampled every 60 s, so up to 60 s after the
last real visible+focused moment).

- **Present (visible + focused):** the lease keeps renewing, and nothing in this change affects it.
- **Disconnected (no socket, no tab), no hold:** the edge goes silent and the guest begins its idle stop
  600–630 s after its last presence. The next minute pass sees the stopping/stopped instance
  (`reconcileGuestStop`) and starts the ordinary session end (release in pool mode), so accounting
  converges within about a minute instead of waiting for 04:08 UTC or an interactive call.
  **This is the acceptance case for the minute trigger.**
- **Disconnected with a terminal, load or flush hold:** the guest keeps running (up to its own 8 h terminal
  hold). The minute pass does NOT stop it for a lapsed lease; only a reached hour cap does. When the hold ends
  and the guest stops itself, the next pass settles it.
- **Hidden tab, sockets still open (known gap):** the guest never becomes idle-due while any authenticated
  WebSocket stays open (the 30 s edge tick), and the minute pass does not enforce the lapsed lease. So this
  case does NOT promptly downscale: nothing automatic enforces the lapsed lease. It stops when the sockets close (the
  guest idle stop, then the next minute pass), at an hour cap, or on an explicit Stop. No shutdown time is promised.
- **Visible but unfocused:** heartbeats continue for 30 min after *P*; they enforce hour caps only, never the lapsed
  lease, so this case behaves like the hidden tab once presence goes stale.

Quiet foreground reading and active work are not stopped by this pass. Aligning guest presence with terminal
holds (a new hold signal) is deliberately not part of 1.0.18.
