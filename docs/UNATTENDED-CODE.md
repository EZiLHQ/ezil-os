# Unattended Code: the private workbench

Staging, 2026-11-21. A computer's EZiL Chat sessions are reached through the
editor bridge (`app/src/server/agent-session/`, `worker/src/editor-bridge.ts`,
`extensions/ezil-models/src/chat-bridge-client.ts`, the `[chat-bridge]`
workbench patch). The bridge's executor is a browser window: with no Code
window open there is nothing to hand a queued instruction to, and it expires
after `QUEUE_TTL_MS`. Unattended Code keeps one such window open, privately,
inside the computer, so an instruction sent through OS (or the EZiL MCP acting
for the owner) runs with no tab of the owner's open.

Nothing new is exposed: no port, no route, no procedure. The existing bridge,
model gateway, billing gate and session APIs carry the work exactly as they do
for a window the owner opened.

## What runs

`worker/scripts/start-unattended-workbench.sh`, started by `start-neko.sh`
(`launch_unattended_workbench`) after the readiness verdict and after the
browser sidecar: it can never gate the desktop. It runs the image's Chrome as a
separate headless process against the app-owned loopback code-server,
`http://127.0.0.1:8443/?folder=<workspace>`. That window loads the workbench,
code-server starts an extension host for it, the EZiL extension's sync client
runs there, and the patched ChatViewPane registers `_ezil.chatBridge.v1` as in
any window.

## Fail closed

The launcher starts, and keeps running, only while all of these hold (re-checked
every 15 s):

| Condition | Where it comes from |
| --- | --- |
| `EZIL_EDITOR_BRIDGE_TOKEN` is this boot's 64-hex editor-bridge token | The Worker derives it from the boot nonce only for a computer it explicitly admits (`EZIL_EDITOR_BRIDGE_TARGETS`, `worker/src/editor-bridge.ts`); a restart rotates it. The launcher checks its shape only, never reads it into the window. |
| `EZIL_AI_BASE_URL` is set | The extension derives the sync route from it; without it a window could never sync. |
| `ezil.chatBridge.enabled` is `true` in the owner's settings | The bridge's own per-owner opt-in, in the owner's persisted `User/settings.json` (restored per owner by `editor-state.sh`). Default false. |
| `ezil.chatBridge.unattended` is `true` in the same file | The owner's explicit consent to a window they are not looking at. Default false. Both the launcher and the extension (in that window only) read it; the window stops, and stops syncing, when it is turned off. |
| `EZIL_UNATTENDED_WORKBENCH` is not `off` | Operator switch. |

Turning consent off, a restart or a teardown stops only the private window.
code-server, the terminal, and any window the owner has open are untouched.

## Private

- Its own fresh `--user-data-dir` under `/tmp`, recreated on every launch;
  never the live browser's profile and never a host profile.
- Scrubbed environment (`env -i`): no tokens, no `DISPLAY`. It never joins the
  Neko desktop or its stream, and the live EZiL Browser never sees it.
- No `--remote-debugging-port` and no listening port: the browser sidecar and
  the browser MCP cannot reach it, and nothing outside the process can inspect
  or drive it.
- It loads one URL and sends no prompt of its own. Everything that runs in it
  is what OS handed out through the bridge, under OS's lease and the session's
  own mode, model and approvals.

## One executor at a time

The window syncs as `unattended.<id>` (`hello` answers `unattended: true` from
the headless user agent; `chat-bridge-client.ts` renames the owner before its
first sync). OS's owner rule (`store.ts`, `attendedPreempts`): a window the
owner opens takes the lease from a live private workbench at once; the private
workbench never takes it from a live window, and waits for the lease to lapse.
Delivery stays at most once: whatever the displaced owner held becomes
`uncertain` (`owner_changed`) and is never redelivered.

## Lifecycle

The private window reports no presence and holds no keepalive. Idle stop, the
busy-load probe, the terminal hold and the platform sleep timer run exactly as
without it; an inference in flight still holds the stop through the existing
Code inference marker. A desktop restart re-runs `start-neko.sh`, whose
teardown ends the launcher (`SESSION_PID`) and whose relaunch starts it again
under the new boot's token.

## Known limit

The gateway answers `401 os_session_missing` once the owner's stored AI
credential has expired; a delegated `computer.start` pushes no credential.
Unattended work therefore needs the owner to have opened the computer recently
enough for the stored credential to be live. This document does not change
that.

## Tests

- `worker/src/unattended-workbench.test.ts`: the launcher with a stub browser.
- `app/src/server/agent-session/unattended-owner.test.ts`: the owner rule.
- `extensions/ezil-models/tests/chat-bridge-client.test.ts`: the owner id and
  consent in the client.
- `worker/copilot-chat/chat-bridge.test.cjs`: `hello`.
- `e2e/chat-bridge-unattended.mjs` (`EZIL_E2E_SUITE=unattended`): the packaged
  image, no outside browser.
