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

v1 (the first ten verbs below) is pinned by
`EZiL-Works: apps/api/src/routes/mcp/browser-sidecar.contract.json`. v2 is
additive and is declared by `contract.mjs` plus
`docs/contracts/browser-verbs-v2.md`; every v1 route, member and error code is
unchanged.

Those files are the contract. This README is commentary. The producer lives
here, the consumer lives in the other repository, and neither describes the wire
in prose — both assert their own types against the same declaration, because
the failure this prevents (a client and a server agreeing on nothing, with a
fully green client suite) is on the record in the legacy Universe MCP.

`worker/src/browser-sidecar-contract.test.ts` is this side's assertion: the
pinned v1 JSON is contained in `contract.mjs` route for route and member for
member, `SIDECAR_WIRE` is exactly `V1_ROUTES` + `V2_ROUTES`, and the Worker's
allowlist (`worker/src/browser-sidecar.ts`) is exactly the route verbs. Run it
with `EZIL_BROWSER_SIDECAR_CONTRACT=<path to the JSON>` so it runs rather than
skips; a path that is set but missing fails.

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
| `POST /fill_form` (v2) | `fields` | `ok, url, filled, redacted` |
| `POST /select` (v2) | `ref, values` | `ok, url, selected` |
| `POST /scroll` (v2) | `ref?, dy?` | `ok, url, scrollY` |
| `POST /press` (v2) | `ref?, key` | `ok, url` |

The v2 rules (bounds live in `contract.mjs`):

- **`/fill_form`**: 1–20 `{ref, value}`, each `value` a string of at most 4000
  characters. Every ref is resolved, and every element checked to be fillable
  (not a button, checkbox, `<select>`, disabled or readonly control), BEFORE
  any field is filled: one bad, stale or unfillable ref fills nothing. Password
  fields register their value as a secret before the first fill, exactly like
  `/type`; `redacted` counts them, and no value is ever echoed.
- **`/select`**: 1–20 option labels or values. The ref must be a combobox or
  listbox and a real `<select>`, else `bad_ref`; a value that matches no option
  is `bad_request` at once rather than a timeout. `selected` is the option
  values now selected.
- **`/scroll`**: exactly one of `ref` (scroll it into view) or `dy` (an integer,
  `|dy| ≤ 5000`, scrolls the window). `scrollY` is the window offset after.
- **`/press`**: `key` exactly one of Enter, Tab, Shift+Tab, Escape, Backspace,
  Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown. Shift+Tab
  is the only chord, there are no character keys (text goes through `/type`),
  and the key that reaches Playwright is the list's constant, never the
  request's string.

Errors are `{ok:false, error, detail?}` with `error` one of `chrome_unreachable`,
`bad_ref`, `stale_ref`, `navigation_failed`, `timeout`, `bad_request`, and (v2)
`origin_read_only`.

## Origin tiers (v2)

`origin-policy.mjs` puts the page a verb acts on into one of three tiers. The
tier origins come ONLY from `EZIL_BROWSER_OWNER_APP_ORIGINS` and
`EZIL_BROWSER_IDP_ORIGINS`: comma lists of bare https origins (staging:
`https://universe-staging.ezil.work` and `https://id.ezil.work`), read once when
the surface is created. **A malformed entry in either variable breaks the
whole policy** (`policy.broken`): every page is then `idp_transit` — health,
navigate and `wait_for{time}` only, for every caller — until the variable is
fixed, and one boot line names each fault by variable and position, never by
value. (Emptying just the bad tier would fail open: a broken IdP list would
make the IdP `other`.) Unset or blank variables are not malformed: that tier is
empty — except that a non-empty owner list with an empty or unset IdP list is
broken too (an owner app is only safe when its IdP is known). The IdP tier
matches by **host**, whatever the scheme or port (`http://id.ezil.work/…`,
`wss://id.ezil.work/…` are `idp_transit`); the owner tier is an exact https
origin. An origin in both lists — or an owner origin on an IdP host — is
`idp_transit`. `EZIL_BROWSER_TEST_ALLOWED_ORIGINS` is never a tier source.

| Tier | Routes |
|---|---|
| `owner_app` | all |
| `idp_transit` | `GET /health`, `POST /navigate`, `POST /wait_for` with `time` only |
| `other` | all (v1 behaviour plus the v2 verbs) |

Everything else on an `idp_transit` page — snapshot, refs, typing, text,
screenshots, console, network, `wait_for{text}` — answers `origin_read_only`.
The tier is read immediately before acting, and reads (`snapshot`, `get_text`,
`screenshot`, `wait_for{text}`) check again after reading, so a page that
navigated onto the IdP mid-read yields nothing. On the Worker path a verb that
navigates may land on any tier; it returns the sanitised `url`.

Handlers are `(surface, body, opts = {})`. `opts.denyTiers` (a `Set` of tier
names) refuses those tiers as well: the Code loopback passes
`new Set(['owner_app', 'idp_transit'])`. For such a caller:

- a page in a denied tier answers `origin_read_only` to every route but
  `/health`;
- a verb that LANDS on a denied tier (`navigate`, `click`, `type{submit}`,
  `press`, or a page script reacting to `fill_form`, `select` or `scroll`)
  answers `origin_read_only` with no url and no title — the navigation may
  already have happened, nothing about it comes back;
- a `navigate` whose target is in a denied tier is refused before it loads;
- `console` and `network` leave out everything the tab recorded while it was in
  a denied tier.

That is agent policy, not confinement (`docs/contracts/browser-verbs-v2.md` §8:
anything in the computer can reach CDP on 9222 directly).

**URL sanitising.** `sanitizeUrl` reduces an `idp_transit` URL to origin + path.
For every URL it reads the remainder after the origin — path with its `;`
parameters, query, fragment — percent-decoded once, `+` as a space, invisible
characters removed, and looks for a sensitive name (`code`, `state`,
`id_token`, `access_token`, `refresh_token`, `token`, `session_transfer_token`,
`nonce`, `ticket`, `code_verifier`, plus `jwt` and `accesstoken`), optionally
`[]`, followed by `=` and not glued to a preceding letter or digit. So a
callback URL nested in a `redirect=` value, `/cb;code=…`, `#!code=…`,
`?code[]=…`, `?x=code=…`, `?auth_code=…` and `?%E2%80%8Bcode=…` all match. A
match strips the query, the fragment and every `;` path parameter (and the
userinfo when the name was there); if the path proper still carries one, only
the origin leaves. Every other URL is returned as the same string (under a
broken policy every URL takes the origin + path form). It is applied at the
source: console and network entries as they are recorded (including URLs
inside console text and `location`), and every `url` member of every response.

**Page text** — snapshot text, `get_text` markdown, every `title`, and
`/select`'s option values — leaves through `sanitizeText`, in four passes:
every absolute URL of any scheme through `sanitizeUrl` (the JSON-escaped
`https:\/\/…` form too); every relative reference (`/cb?code=…`,
`./x?state=…`, `?code=…`, `#access_token=…`, `//host/cb?…`); then every
sensitive `name=value` run left anywhere, name and all (the value ends at `&`,
whitespace, `#`, `)`, `]`, `|`, a quote, `<` or `>`; a quoted value goes with
its quotes), so `x|/cb?code=…|`, `Callback:/cb?code=…` and a bare
`code=…&state=…` keep no `code=`; and last, any percent-encoded token that
decodes to one. `get_text` renders links with the browser's resolved (absolute)
href, so relative hrefs reach the URL pass whole. Trailing punctuation and an
unbalanced `)` or `]` stay outside a URL, so markdown links keep their brackets.
On an `idp_transit` page — or one that crossed into or out of it while its
title was read — `title` is `''`, for every caller. The limit: a JSON
`"code":"…"` pair is neither a URL nor a `name=` run, and stays.

**Page scope.** `console` and `network` return only entries recorded from the
active tab (entries carry an internal page tag; the public entry shape is
unchanged). Console text recorded while that tab was on an `idp_transit` origin
is not returned after it leaves; the IdP hops stay visible, sanitised, in
`network`.

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
navigation.** The sidecar remembers which refs it issued, under which
generation, and (v2) on which tab and origin, so:

- a ref it never issued → `bad_ref` — you guessed;
- a ref from an earlier snapshot, or one whose element has gone → `stale_ref` —
  re-snapshot;
- a ref used on another tab, or after its tab's origin changed → `stale_ref`,
  checked before the DOM is queried, so a leftover `data-ezil-ref` on another
  tab never matches.

Collapsing those would make a recoverable state look like a mistake.

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
red. (`verbs-v2.test.mjs` asserts the same identity offline, against a fake that
renders the dots when unmasked; only the container suite proves the pixels.)

### v2 guards: mutation procedure

`verbs-v2.test.mjs` drives the real `BrowserSurface` over a fake browser;
`origin-policy.test.mjs` covers the pure policy. Break each guard, run
`bun test` (all suites), expect red, restore with `git checkout <file>`:

| Guard | Mutation | Recorded (2026-11-22, 324 tests) |
|---|---|---|
| tier gate (`verbs.mjs` `assertTierAllows`) | `if (!routeAllowedOnTier(…) \|\| deny.has(tier))` → `if (false)` | 40 fail |
| idp route table (`origin-policy.mjs` `routeAllowedOnTier`) | `if (tier !== 'idp_transit') return true;` → `return true;` | 31 fail |
| `sanitizeUrl` | return `url` unchanged before parsing | 57 fail |
| ref tab binding (`browser.mjs` `resolveRef`) | the `pageKey` check → `if (false)` | 2 fail |
| ref origin binding (`browser.mjs` `resolveRef`) | the `origin` check → `if (false)` | 1 fail |
| broken policy (`origin-policy.mjs` `classify`) | delete `if (sets.broken) return 'idp_transit';` | 46 fail |
| broken policy (`loadOriginPolicy`) | `const broken = false;` | 48 fail |
| owner list without IdP list (`loadOriginPolicy`) | `const ownerWithoutIdp = false;` | 2 fail |
| IdP by host (`origin-policy.mjs` `classify`) | delete the `idpHosts` check | 56 fail |
| Code landing rule (`verbs.mjs` `assertNotLandedOnDenied`) | its check → `if (false)` | 18 fail |
| Code navigate-target refusal (`verbs.mjs` `/navigate`) | its check → `if (false)` | 1 fail |
| Code console history (`browser.mjs` `consoleEntries`) | drop the `denyTiers` filter | 1 fail |
| Code network history (`browser.mjs` `networkEntries`) | drop the `denyTiers` filter | 1 fail |
| decoded-remainder check (`carriesSensitive`) | always `false` | 24 fail |
| …percent-decoding (`decodeOnce`) | return the text as is | 13 fail |
| …invisible characters (`carriesSensitive`) | keep them | 1 fail |
| …`;` path parameters (`withoutPathParams`) | keep them | 4 fail |
| …safety net (`reduced`) | always return what is left | 4 fail |
| page text (`verbs.mjs` `textOf`) | return `text` unchanged | 3 fail |
| IdP title (`verbs.mjs` `titleOf`) | return the title anyway | 5 fail |
| relative references (`sanitizeText` pass 2) | skip it | 5 fail |
| `name=value` runs (`sanitizeText` pass 3) | skip it | 11 fail |
| encoded tokens (`sanitizeText` pass 4) | skip it | 3 fail |
| any-scheme URLs (`sanitizeText` pass 1) | `https?:` only | 3 fail |
| resolved hrefs (`page-scripts.mjs` `pageMarkdown`) | the raw `href` attribute | 2 fail |

A mutant that does not parse is not a result: run `node --check` on the
mutated file first (a syntax error can hang `bun test` rather than fail it).

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
