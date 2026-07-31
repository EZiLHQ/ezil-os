# Puter provenance — what came from where

This is the **authoritative, file-by-file index** of the Puter-derived code in
EZiL-OS. `../ATTRIBUTIONS.md` §1 and `../NOTICE` summarise; this file is the
record. Where they disagree, this file is correct.

- **Upstream:** Puter — https://github.com/HeyPuter/puter
- **Upstream licence:** AGPL-3.0-only
- **This repository's licence:** AGPL-3.0-only (`../LICENSE`)

There is no licence conflict and no relicensing. EZiL-OS is already
AGPL-3.0-only, so the fork simply stays AGPL-3.0-only.

---

## What the obligation actually is

AGPL-3.0 §5(a) requires that modified files carry **prominent notices stating
that you changed them, and the date** of any change. That is the whole
obligation, and this file plus `../NOTICE` discharge it. The licence does not
ask us to avoid modifying Puter — **this is a fork, not a dependency, and
Puter's internals are modified freely.** What it asks is that we *say so*,
which is what the table below is for.

## The trademark position — a requirement, not a preference

Puter's `TRADEMARK.md` (v1.0, 2025-01-01) is explicit that the open-source
copyright licence **"does not include a licence to use our trademark."** The
copyright grant and the trademark grant are separate, and only the first one
was given.

For a modified distribution — which EZiL-OS is — that document requires the
distributor to:

- **remove all Puter logos** from the modified software;
- **clearly indicate that the software has been modified**;
- include the notice *"This software is a modified version of Puter software
  and is not endorsed by Puter Technologies Inc."*

It also forbids using the marks, or variations of them, as part of a product
name, company name or domain — `MyPuter` and `PuterFooBar` are given as
examples of what is too close.

**Consequently, removing the Puter name and marks from ported code is a legal
requirement of this fork, not a branding preference.** Every port must strip
Puter logos, favicons, wordmarks, `puter.com` URLs and product-name strings
from anything user-visible, and must not reintroduce them. The word mark may
appear in attribution and provenance prose — this file, `../ATTRIBUTIONS.md`,
`../NOTICE` — because accurately describing origin is a use the policy
permits. It may not appear in shipped UI, asset names, or branding.

Puter is a trademark of Puter Technologies Inc. EZiL-OS is not affiliated
with, sponsored by, or endorsed by Puter Technologies Inc.

## What is deliberately NOT ported

Puter's GUI is written against a cloud backend that does not exist here. The
EZiL shell runs in the browser and talks only to EZiL's own Worker and
container. So the following are removed rather than reimplemented, and any
port that still references them is unfinished:

| Upstream | Disposition |
|---|---|
| `puter.kv` (~40 call sites) | Replaced by browser `localStorage` — `ezil/session.js` |
| `puter.fs` (~71 call sites) | Removed |
| `puter.apps`, `puter.auth` | Removed |
| socket.io realtime | Removed |
| `src/gui/src/services/*` | Removed |
| `src/gui/src/IPC.js` | Removed |
| `src/backend/**` (~165k lines) | Removed |
| Puter's webpack build | Not used — see `build-shell.sh` (esbuild + `cat`) |

---

## Index

Layout: `src/` is the Puter-derived tree — **it is the only place in this
repository where Puter-derived code may live.** `ezil/` is EZiL-authored.

### Taken verbatim

Byte-identical to upstream. Still AGPL-3.0-only; still Puter's copyright.

| EZiL path | Upstream path | Upstream commit | Date taken |
|---|---|---|---|
| _(none yet)_ | | | |

### Taken and modified

🔴 Modified by EZiL. Each row states what changed and when — this is the
AGPL §5(a) record.

| EZiL path | Upstream path | Upstream commit | Date modified | What changed |
|---|---|---|---|---|
| _(none yet)_ | | | | |

### Written fresh

EZiL-authored. No Puter code. Listed here only because some of it sits inside
`src/` so that CSS cascade order works, and it would otherwise be mistaken for
upstream.

| Path | Purpose |
|---|---|
| `src/css/ezil-tokens.css` | Overrides the `:root` design-token block in upstream `src/gui/src/css/style.css` (~L86-116) from which the whole chrome derives. Lives under `src/` so the build concatenates it *after* upstream's sheets. |
| `ezil/boot.js` | Bundle entry point. |
| `ezil/session.js` | localStorage replacement for `puter.kv`. |
| `build-shell.sh` | Bundles `src/` + `ezil/` to `app/public/os/`. |

---

## Keeping this file honest

- A port is not finished until its row is in the table above.
- `build-shell.sh --check` guards the *build output* against drift. **Nothing
  automatically guards this table** — it is maintained by hand, and reviewing
  it is part of reviewing any change under `shell/src/`.
- Record the upstream commit, not just the path. "Taken from Puter" is not a
  provenance record; "taken from `<path>` at `<sha>`" is.
- Reference clone used while porting: a read-only checkout of upstream kept
  outside this repository. It is never modified and never committed here. At
  the time this index was created it was at upstream commit
  `5a157197b6ea166d5c5c04cc1d2816bcf9cc05f9` ("fix: PUT-1398 (#3478)"), which
  is the baseline the first ported files should be recorded against unless
  they say otherwise.
