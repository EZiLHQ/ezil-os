---
id: MCP-01
title: A local MCP tool group over the ten sidecar verbs
labels: [mcp, "help wanted", "size/M"]
prereq:
state: open
github: 56
---

## The problem

`worker/sidecar/contract.mjs` pins a closed, ten-route verb set for browser automation
(`GET /health` plus nine `POST` verbs: `navigate`, `snapshot`, `click`, `type`, `get_text`,
`screenshot`, `console`, `network`, `wait_for` — `contract.mjs:54-95`), deliberately excluding
`evaluate`/`raw`/`send`/`cdp`/`exec`/`eval` (`FORBIDDEN_VERBS`, `contract.mjs:36`). The existing
`mcp/` package (`mcp/src/tools.ts`) wraps the SDK's computer tools but nothing exposes the
sidecar's browser-automation verbs as their own local MCP tool group, so an agent that wants to
drive the desktop's browser has no first-class way in.

`docs/research/local-agents.md` §5 already surveyed this and recommended exactly this shape.
Quoted verbatim:

> **1. A local MCP server (or tool group) wrapping the ten sidecar verbs (§1's table), plus a
> thin driver loop that calls an OpenAI-compatible endpoint for the next action.** No new
> capability in the sidecar or the Worker; pure plumbing plus one new small process. **What
> would prove it:** a driver completes one concrete task (e.g., navigate to a URL, read back a
> heading via `get_text`) using only the ten verbs, with `git diff` on
> `worker/sidecar/contract.mjs` empty at the end — i.e. the exact bar the ROADMAP text names,
> verifiable by re-running `worker/sidecar/wire.test.mjs` and the contract test unmodified.

This issue is the MCP tool-group half of that recommendation; `AGENT-01` is the driver-loop
half.

## Acceptance criteria

- A local MCP tool group (in `mcp/` or a new package, matching this repo's existing MCP
  server pattern in `mcp/src/server.ts`/`mcp/src/tools.ts`) exposes the ten sidecar verbs as
  MCP tools — one tool per route, no tool that maps to a forbidden verb.
- `git diff` on `worker/sidecar/contract.mjs` is empty after the change — no new capability
  added to the sidecar itself, matching the survey's own bar.
- `worker/sidecar/wire.test.mjs` and `worker/src/browser-sidecar-contract.test.ts` still pass
  unmodified.
- A real run against the sidecar (not just a mock) demonstrates one tool call succeeding
  end-to-end (e.g. `navigate` then `get_text`).

## Where to look

- `worker/sidecar/contract.mjs:24-30,36,54-95` — the pinned `TRANSPORT`, `FORBIDDEN_VERBS`, and
  `SIDECAR_WIRE` route table this tool group must mirror exactly.
- `worker/sidecar/README.md` and `SECURITY.md`'s "closed verb allowlist" line — the boundary
  this issue must not cross (no passthrough verb, ever).
- `mcp/src/tools.ts`, `mcp/src/server.ts` — the existing local MCP server pattern (8 computer
  tools over the SDK) this tool group should follow structurally.
- `docs/research/local-agents.md` §1 ("The seam the OS already has") and §5 (quoted above).

## How to prove it

```
node --test worker/sidecar/wire.test.mjs
git diff --stat worker/sidecar/contract.mjs   # must be empty
```
Expected: the wire test passes unmodified, `contract.mjs` has no diff, and the new tool
group's own test demonstrates one real sidecar call succeeding.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr).
