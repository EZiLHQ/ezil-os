# `worker/sidecar` — the browser's narrow automation surface

A small Node service, baked into the desktop image at `/opt/ezil-sidecar`,
launched by `scripts/start-neko.sh` (`launch_browser_sidecar`) after the boot
readiness verdict is already decided.

```
Chrome (neko desktop) ──CDP──▶ 127.0.0.1:9222        loopback only, never exposed
                                     ▲
                       playwright-core connectOverCDP
                                     │
 sidecar (this) ────────────── 0.0.0.0:9223          reached by sandbox.containerFetch
```

## The one rule

**There is no CDP passthrough verb, and none may be added.** Not `evaluate`,
not `raw`, not `send`, not "just forward this one command". CDP is
unauthenticated and total: whatever can speak it reads every page, exfiltrates
the profile's cookies, and runs arbitrary JS in any origin the browser has ever
been logged into. The sidecar's entire value is that the surface reachable from
outside the container is the verb list below and nothing else. A passthrough
verb does not extend it, it deletes its reason to exist — at which point the
CDP port might as well have been bound to `0.0.0.0` and the sidecar deleted.

`/navigate` refusing `javascript:` and `data:` is the same rule: both are
arbitrary script execution wearing a URL.

## The wire is pinned, not described

`EZiL-Works: apps/api/src/routes/mcp/browser-sidecar.contract.json`.

That file is the contract. This README is commentary. The producer lives here,
the consumer lives in the other repository, and neither describes the wire in
prose — both assert their own types against the same JSON, because the failure
this prevents (a client and a server agreeing on nothing, with a fully green
client suite) is on the record in the legacy Universe MCP.

`worker/src/browser-sidecar-contract.test.ts` is this side's assertion.

## Verbs

| Verb | Request | Response |
|---|---|---|
| `GET /health` | — | `ok, chromeConnected, cdpUrl` |
| `POST /navigate` | `url` | `ok, url, title` |
| `POST /snapshot` | — | `ok, snapshot, url, title` |
| `POST /click` | `ref` | `ok, url` |
| `POST /type` | `ref, text, submit?` | `ok, url, redacted` |
| `POST /get_text` | `ref?` | `ok, markdown, url` |
| `POST /screenshot` | `ref?, fullPage?` | `ok, pngBase64, sha256, byteSize, width, height` |
| `POST /console` | `level?` | `ok, entries` |
| `POST /network` | `filter?` | `ok, requests` |
| `POST /wait_for` | `text?, time?` | `ok, matched` |

Errors are `{ok:false, error, detail?}` with `error` one of `chrome_unreachable`,
`bad_ref`, `stale_ref`, `navigation_failed`, `timeout`, `bad_request`.

A verb-level failure answers **HTTP 200** with `ok:false` — the contract makes
`ok` the channel, and folding verb failure into transport failure is how a
caller ends up reporting "the sidecar is down" for a typo in a ref. Only
genuinely non-contract conditions (unknown path 404, wrong method 405,
oversized body 413) use a non-2xx status, and those carry the error shape too.

## Perception model: snapshot first

`/snapshot` returns an accessibility tree with exact refs — roughly 200–400
tokens where a screenshot is 3 000–5 000, and the ref is exact where a
coordinate is approximate. `click` and `type` take refs, so the agent never
guesses a selector. `/screenshot` is the escape hatch for genuinely visual
questions, not the default way to look at a page.

**Refs are valid only within the snapshot that produced them, and they reset on
navigation.** The sidecar remembers which refs it issued and under which
generation, so:

- a ref it never issued → `bad_ref` — you guessed;
- a ref from an earlier snapshot, or one whose element has gone → `stale_ref` —
  re-snapshot.

Collapsing those two would make a recoverable state look like a mistake.

## Redaction

A value typed into an `input[type=password]` must never appear in **any**
response — not in `/type`'s echo (there is none; `redacted: true` says why),
not in a snapshot, not in `/get_text`, not in `/console` or `/network`, and a
screenshot masks the field.

There are exactly **two** guards, because there are two kinds of response:

1. **Text** — `redactDeep` in `redact.mjs`, called from `respond()` in
   `server.mjs`, which is the only place in this process that writes a body.
   The verb handlers deliberately do **not** redact; they emit what they see.
   One guard, one place, so deleting it goes red.
2. **Pixels** — Playwright's `mask` in `/screenshot`'s handler. A password is
   not text in a PNG, so this is a genuinely different mechanism and has its
   own proof.

### Mutation procedure (run it; do not take the test's word for it)

Text guard:

```bash
cd worker/sidecar
bun test redaction.test.mjs            # green

# mutate: make the choke point a no-op
sed -i 's|^export function redactSecrets (text, secrets) {|export function redactSecrets (text, secrets) { return text;|' redact.mjs
bun test redaction.test.mjs            # MUST be red
git checkout redact.mjs
```

Screenshot guard: the container suite
(`worker/src/browser-sidecar.container.test.ts`) captures the same page twice
with a 4-character and a 20-character password in the field and asserts the two
PNGs are **byte identical** — a masked box is the same box, unmasked dots are
not. Remove `mask` from the screenshot options in `verbs.mjs` and that test goes
red.

## Running it by hand

```bash
EZIL_CDP_PORT=9222 EZIL_SIDECAR_PORT=9223 node server.mjs
curl -s localhost:9223/health
curl -s -XPOST localhost:9223/snapshot -d '{}' -H 'content-type: application/json'
```

## What it must never do to the desktop

`connectOverCDP` **adopts** the running browser: it does not launch one, does
not create a context, does not open a tab. The page an agent drives is the page
the user is watching. That also makes this process a guest — it must not resize
the window, change the viewport, or close pages it did not open. The desktop's
pinned window geometry is maintained by the boot gate and
`validate-neko-browser-window.sh`, and nothing here has any business fighting
either.
