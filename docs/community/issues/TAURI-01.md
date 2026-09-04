---
id: TAURI-01
title: Native installers via a Tauri wrapper
labels: [local, blocked, "size/XL"]
prereq:
state: blocked
---

## The problem

Local mode ships as a launcher pair plus a tarball (`ezil-os.sh`, `ezil-os.ps1`, `SHA256SUMS`,
cosign keyless signatures, SLSA build provenance) rather than native binaries — deliberately.
`ROADMAP.md` § "A signed download" explains why: "A script can be read before it is run; an
unsigned native binary is quarantined by Gatekeeper or SmartScreen regardless of what else
signed it, so shipping one unsigned would be worse than shipping none." A native installer (a
Tauri wrapper around the launcher, or similar) needs real code-signing to avoid exactly that
quarantine, and the same document states plainly: "**Native installers are blocked on
org-level signing prerequisites**: an Apple Developer ID with notarytool credentials, and an
Authenticode signing route. Both are account-level things a person has to obtain; no amount of
code produces them." No such Tauri wrapper, Apple Developer ID, or Authenticode certificate
exists in this repository or its CI today.

## Acceptance criteria

- A Tauri (or equivalent) native wrapper builds installers for macOS and Windows that invoke
  the same launcher logic as `ezil-os.sh`/`ezil-os.ps1` — not a second, divergent
  implementation of the boot/doctor/Docker-driving logic.
- The macOS installer is signed with a real Apple Developer ID and notarized (`notarytool`);
  the Windows installer is signed via a real Authenticode certificate.
- A downloaded installer opens with **no warning at all** from Gatekeeper or SmartScreen — the
  exact bar `ROADMAP.md`'s "what would prove it" names for this item.
- The existing tarball + launcher-pair distribution is not removed — this issue adds a second,
  optional distribution channel for people who prefer a native installer, it does not replace
  the one that already works unsigned-but-readable.

## Where to look

- `ROADMAP.md` § "A signed download" — the full reasoning for scripts-over-binaries today, and
  the explicit blocked-on statement quoted above.
- `deploy/launcher/ezil-os.sh`, `deploy/launcher/ezil-os.ps1` — the launcher logic any native
  wrapper must invoke rather than reimplement.
- `docs/RELEASE.md` and `.github/workflows/release.yml` — the existing signed-tarball release
  pipeline a native-installer build would need to plug into (or run alongside).
- No `tauri.conf.json`, `src-tauri/`, or signing-certificate reference exists anywhere in this
  repository today (verified by grep) — this is a from-scratch addition.

## How to prove it

On a clean macOS machine and a clean Windows machine, download the installer and run it with
Gatekeeper/SmartScreen at their default (non-developer) settings: no warning dialog, the app
installs and the launcher's own doctor check passes afterward.

## Prerequisite

None — but this issue is **blocked**: it needs an Apple Developer ID with notarytool
credentials and an Authenticode signing certificate, both account-level credentials the
founder must obtain. No amount of code in a pull request produces them, which is why this is
named here rather than scheduled, the same as `ARM-01`.

---

Want to work on this? Comment on the issue to claim it (the wrapper and build pipeline can be
built and tested against a **self-signed** cert while the real credentials are pending — say so
explicitly in your PR if that's the state it lands in), then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr).
