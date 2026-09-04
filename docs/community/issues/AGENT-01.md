---
id: AGENT-01
title: Agent driver loop — one task, ten verbs, an OpenAI-compatible endpoint
labels: [mcp, worker, "help wanted", "size/L"]
prereq: MCP-01
state: open
---

## The problem

Nothing in this repository can complete a task on the desktop autonomously today — the sidecar
verbs (`worker/sidecar/contract.mjs`) exist, and `MCP-01` will expose them as MCP tools, but
there is no loop that reads a task, calls a model for the next action, and executes it.
`docs/research/local-agents.md` §5 surveyed the alternatives (adopting an existing
computer-use driver like Agent-S or cua) and rejected them explicitly, because both assume
unmediated access to the display or the browser's raw CDP port — exactly the passthrough this
project's `SECURITY.md` names as a finding if it existed. Quoted verbatim, the same
recommendation `MCP-01` quotes:

> **1. A local MCP server (or tool group) wrapping the ten sidecar verbs (§1's table), plus a
> thin driver loop that calls an OpenAI-compatible endpoint for the next action.** No new
> capability in the sidecar or the Worker; pure plumbing plus one new small process. **What
> would prove it:** a driver completes one concrete task (e.g., navigate to a URL, read back a
> heading via `get_text`) using only the ten verbs, with `git diff` on
> `worker/sidecar/contract.mjs` empty at the end — i.e. the exact bar the ROADMAP text names,
> verifiable by re-running `worker/sidecar/wire.test.mjs` and the contract test unmodified.

And the option explicitly **not** to take, also quoted verbatim, as the boundary this issue
must respect:

> **3. Adopt one of §2's drivers wholesale, pointed at the container's raw X11/VNC/CDP surface
> instead of the sidecar.** Explicitly the option **not** to take first. This is the ROADMAP
> text's own warning made concrete by the survey: Agent-S's `exec()` of LLM-generated
> `pyautogui` code (`cli_app.py:215`) and cua's native XTest/`Input.dispatchMouseEvent` paths
> both assume unmediated access to the display or the browser's CDP port — the same port
> `worker/sidecar/README.md` and `SECURITY.md:74–76` name as a finding if reachable outside the
> fixed verb set. Using either driver as-is against this OS's desktop would mean opening
> exactly the passthrough §1 documents as deliberately absent. **What would prove it (if ever
> pursued anyway):** a written exception to `SECURITY.md:74–76`, not a measurement — which is
> itself the reason it is not the recommendation.

## Acceptance criteria

- A driver process (Node/Bun, matching this repo's stack) takes one task description, calls
  an OpenAI-compatible chat/completions endpoint for the next action, and executes that action
  through `MCP-01`'s tool group — never a raw CDP call, never a new sidecar route.
- One concrete task (e.g. navigate to a URL, then read back a heading via `get_text`) completes
  end to end against a real sidecar, not a mock.
- `git diff` on `worker/sidecar/contract.mjs` is empty at the end — no new verb was added to
  make the task work.
- `worker/sidecar/wire.test.mjs` and the contract test (`worker/src/browser-sidecar-contract.test.ts`)
  pass unmodified.
- The loop fails visibly (a named error) rather than looping forever when the model returns an
  action outside the ten-verb set.

## Where to look

- `docs/research/local-agents.md` §5 ("Recommendation") — quoted above in full for both
  Option 1 (the one to build) and Option 3 (the one not to take).
- `SECURITY.md`'s "closed verb allowlist" line — the invariant this driver must never breach.
- `worker/sidecar/contract.mjs` — the ten verbs; this file's diff must stay empty.
- `MCP-01` (once it lands) — the tool group this driver calls into.

## How to prove it

```
node --test worker/sidecar/wire.test.mjs
git diff --stat worker/sidecar/contract.mjs   # must be empty
```
Expected: both checks pass exactly as the recommendation's own "what would prove it" states,
plus a recorded transcript of the one completed task.

## Prerequisite

`MCP-01` — this driver calls into that tool group; it does not talk to the sidecar directly.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pull-request).
