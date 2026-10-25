# OS Billing staging: Code startup recovery source handoff

Date: 2026-10-25. Operation: `da9a95be-90f9-4b14-8d74-3d1e47f64fe5`.

Base: `121398c2d64d7bdf8ac3ab1de32e34ec67c877cb`.
Branch: `codex/osst-app-readiness-da9a95be`.
Worktree: `/data/openclaw/projects/ezil/EZiL-OS.worktrees/osst-app-readiness-da9a95be`.

## Scope and inventory

The candidate worktree was clean when inspected. The primary checkout had an
untracked `landing/` directory. Neither was edited. The isolated source checkout
used 26 MB initially; existing dependencies and pinned shell build tools were
reused without installation. No cloud, Stripe, database, deployment, push, SSM,
Notion or customer-charge operation was performed. The reported live-112 closed
gate/warm-adopt failure was not used as evidence of a proxy defect.

| Stage | Source path | Finding |
| --- | --- | --- |
| Dock | `shell/ezil/apps/registry.js` | Browser opens `desktop-window.js`; Code opens `code.js`. Hosted terminal is inside Code, not a separate dock app. |
| Provider wake | `shell/ezil/session.js`, `app/src/app/api/shell/code-preview-url/route.ts`, `app/src/server/api/routers/cloudflare-guacamole.ts` | Code mints for the owned computer through the existing bounded wake/migration/launch loop. Admission and paid shape remain the other writer's lane. |
| AWS handoff | `app/src/server/lib/compute/aws-preview.ts`, `worker/src/aws-origin.ts`, `worker/src/aws-ice.ts` | Owned placement/epoch and tunnel checks precede handoff. Relay readiness is distinct from an editor or browser interaction. |
| App TLS | `deploy/aws/os-staging/Caddyfile` | Staging Caddy terminates app HTTPS and proxies to Next at `127.0.0.1:3000`. Preview hosts use the Worker/tunnel path. |
| Preview auth | `worker/src/aws-origin.ts` | Sandbox-bound bootstrap sets a host-only, HttpOnly, Secure, SameSite=None, Partitioned cookie. Following requests require it. Redirects stay on the same origin. |
| Proxy and WebSocket | `worker/src/aws-origin.ts`, `infra/host-agent/lib/ezil_host/edge.py` | Worker strips untrusted forwarding/auth headers and signs the selected epoch/path. Edge verifies the gateway and accepts only the exact tenant/zone browser Host. Origin and WebSocket Upgrade are forwarded. Existing local tests pass. |
| Backend | `worker/scripts/start-neko.sh`, `infra/host-agent/lib/ezil_host/desktop.py` | Supervised Chromium and code-server; code-server binds `0.0.0.0:8443`. The startup gate checks the browser window and Code TCP port, which cannot prove command-palette or terminal input. Profile paths are persisted by the host configuration. |
| Frame confirmation | `app/src/server/api/routers/cloudflare-guacamole.ts`, `app/src/server/lib/cloudflare-guacamole-provider.ts` | Ownership/origin pin precedes a bounded HTTP probe, including same-origin bootstrap cookies. Failure reason/status are already returned to the shell. |
| Browser display | `shell/ezil/apps/desktop-window.js` | Separate decoded-frame/display gate follows HTTP health. No new browser source defect established in this investigation. |
| Reopen | `shell/ezil/runtime-recheck.js`, `shell/ezil/apps/code.js` | Long absence triggers a status recheck; a stopped runtime reboots through the existing mint path. Desktop-restarted events also remint Code. Existing checks pass; persisted content and paid shape require lead QA. |

## Evidenced defect and minimum fix

Before this change, `session.confirmFrame()` discarded the reason/status and
returned `false` for both a terminal refusal and transient origin failure. Code
stopped on the first `false`, even when an AWS host edge returned a temporary
502 while code-server was restarting. This follows directly from the host
edge's `desktop_unreachable` response and the server probe's wire contract.
Seven added regression cases failed against the original committed shell bundle.

`session.observeFrame()` now retains whether an authenticated negative is
retryable: `unreachable`, or `http_error` with 500/502/503/504. Code alone consumes
this richer result. The existing boolean API is unchanged for Browser, Preview
and native consumers. Auth failures, foreign origins, missing configuration,
410 and unclassified negatives remain terminal.

Code retries transient failures with backoff capped at five seconds, no more
than 12 requests, and the existing 45-second post-handoff deadline. When health
recovers, it reloads the same freshly minted bootstrap URL so an already-loaded
error document is replaced. The overlay remains until that navigation loads and
a fresh authenticated probe succeeds. Further recovery attempts share the same
request/deadline budget. Disposal, URL replacement and late responses cannot
reveal a stale frame. The generated shell bundle is included.

This changes HTTP startup recovery only. HTTP confirmation is not a claim that
the VSCode workbench or its terminal is usable. No new editor-ready messaging,
proxy policy, origin relaxation or subscription policy was introduced.

## Local validation

| Command (relative to repository unless noted) | Result |
| --- | --- |
| `node --test shell/ezil/apps/frame-confirmation-test.mjs` | 33 passed: transient recovery, bounded failures, reload/reconfirmation, auth/origin refusal, stale URL, repeated recovery, disposal; existing Code/Preview cases retained. |
| `node shell/ezil/apps/code-test.mjs` | 58 checks passed, including same-origin calls, close/reopen and restart remint behavior. |
| `node shell/ezil/runtime-recheck-test.mjs` | 10 checks passed. |
| From `app/`: `node node_modules/vitest/vitest.mjs run src/server/lib/desktop-frame-honesty.test.ts src/server/lib/app-preview-frame-honesty.test.ts src/server/lib/compute/aws-preview-cookies.test.ts --maxWorkers=1` | 53 passed. The 21-test desktop suite was rerun after adding real loopback HTTP assertions for the richer observation. |
| From `worker/`: `bun test src/aws-origin.test.ts src/aws-hook.test.ts` | 59 passed, including auth, epoch binding, forwarding and restart registration. |
| From `infra/host-agent/test/`: `python3 -m unittest -q test_edge` | 32 passed using scratch state and ephemeral local sockets, including real WebSocket upgrade piping. |
| `./shell/build-shell.sh --check` | Passed; committed assets match source. |
| `git diff --check -- . ':!app/public/os/bundle.min.js'` | Passed. The rebuilt minified JS retains whitespace from a pre-existing template literal (also present at base line 18); it was not hand-edited. |

Raw local logs use `/tmp/osst-app-readiness-da9a95be-*.log`. No full Next build,
container build, package install or live QA was run in this lane.

## Lead integration and runtime acceptance

Review/cherry-pick this local branch into the combined staging candidate only.
If other shell edits are integrated, regenerate the bundle once from combined
source and run the focused shell suite. Root/Claude lead owns push, build 113,
deployment, budget accounting and authenticated runtime QA. Main/production are
outside this change.

Use the existing authenticated QA context only. After the combined candidate's
admission gate permits launch:

1. Open Code from the dock after a paid upgrade. Record the selected computer,
   generation/epoch and provider-reported shape without recording auth tokens.
   Observe code-preview mint, bootstrap redirect, Code document/assets, and its
   WebSocket upgrade. A hidden loader or HTTP 200 is insufficient.
2. Open the VSCode command palette, type `Preferences: Open Settings (UI)`, and
   verify the characters and matching command appear. Dismiss it; create a
   small file under the configured workspace, type a unique marker and save.
3. Create an integrated terminal through the command palette/menu. Run
   `printf 'OSST_TERMINAL_READY\n'` and verify the terminal output contains the
   marker. This checks the workbench-to-terminal WebSocket/PTY path.
4. Open Browser. Verify decoded frames and input control, navigate to
   `https://example.com/`, and verify its address and visible page content.
5. Exercise a genuine cold/restarting backend or an existing lead-owned harness
   that can return transient failures through the normal authenticated route.
   Confirm progress stays pending, Code reloads after recovery and the same
   command-palette/file/terminal checks succeed without a user page refresh.
   A continuously unavailable backend must end in the retryable UI within the
   45-second post-handoff budget. Verify auth/origin refusals still fail closed.
6. Leave the saved file and browser state, follow the existing authorized idle
   stop/reopen flow, and verify the persisted marker, applicable editor/browser
   profile state, terminal history and a new terminal echo. Compare the paid
   shape and owned computer before/after through the lead's existing context.
   Do not equate process survival with durable file/history recovery.

Until those interaction checks pass, usable staging readiness remains unverified.

## Independent review follow-up (operation fdc5b93c)

Review `3a2c52c2` found two response-classification defects in `5e647d20`:
actual HTTP 401/403 responses were treated as unknown and retried, and Code
accepted contradictory or incomplete positive confirmation bodies. These were
fail-closed UI contract defects, not a demonstrated authorization bypass.

The follow-up changes `session.js` only in production source:

- HTTP 401/403 are terminal negative observations, including non-JSON bodies or
  bodies claiming success. The shared boolean API therefore also reports these
  transport refusals as negative rather than unknown.
- Code's positive HTTP observation requires `ok: true`, `confirmed: true`, an
  integer status from 200 through 399, and no `reason` property. That matches the
  hosted/local HTTP probe success shape. A malformed positive is terminal and
  cannot trigger another probe/reload or remove the overlay after recovery.
  Other surfaces retain their previous positive-response interpretation.
- Recovery scheduling, the 12-request cap, and the fixed 45-second cold
  post-handoff deadline are unchanged. No provider-open calls were added. The
  warm usability criterion remains separately **at most 30 seconds**; the cold
  budget is not a relaxation of that criterion. Live timing remains lead QA.

The expanded frame suite uses real `Response` envelopes for HTTP 401/403 and
contradictory/malformed post-reload responses, with subsequent healthy responses
that must never be consumed. It asserts probe counts, reload counts and one
original mint. Valid HTTP controls and the prior load/reprobe, late-result,
disposal, URL-change and deadline tests remain in place. Valid local/migration
fixtures now include the status supplied by their actual provider contract.

Validation on the follow-up:

- Frame suite: **54 passed**; the same expanded suite on `5e647d20` was 37 passed,
  **17 failed**.
- Existing Code suite: **58 checks passed**, including restart/new-attempt and
  close-during-restart behavior.
- Existing real HTTP/honesty/cookie suites: **53 passed**.
- Migration/launch progress suite: **15 passed**.
- Local Code/Preview suite: **both passed**, now asserting the valid local
  confirmation actually removes the overlay.
- Shell bundle parity and full `git diff --check`: **passed**.

Follow-up logs: `/tmp/osst-app-readiness-fdc5b93c-*.log`. Source and generated
bundle only; no live QA, push, deployment, cloud/Stripe/DB writes or Notion call.
