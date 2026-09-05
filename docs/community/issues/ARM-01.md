---
id: ARM-01
title: arm64 image
labels: [worker, blocked, "size/XL"]
prereq:
state: blocked
github: 48
---

## The problem

The desktop image only builds for `linux/amd64`. `worker/Dockerfile:124` installs Chrome from
`google-chrome-stable_current_amd64.deb` by direct download — there is no arm64 equivalent
available at that URL, so nothing can simply swap the architecture flag. `docs/CONFIDENCE-MAP.md`
§2.5 measured this directly during round ANYWHERE's verification pass: "no run has ever
happened on **arm64**, where the desktop image would need a different build entirely" — every
geometry, boot-time and pixel figure in that document is a Linux/amd64 figure, and Apple
Silicon developers today run the amd64 image under emulation with no warning from the local
doctor that they are doing so.

## Acceptance criteria

- The image builds for `linux/arm64` from an arm64-native Chrome (or an equivalent
  Chromium-based browser available for arm64) — not the amd64 `.deb` under emulation.
- The arm64 image boots a real desktop on an arm64 host with no emulation layer (QEMU or
  Rosetta), proven by a real boot on real arm64 hardware, not just a successful `docker build`.
- `local/src/doctor.ts` detects an arm64 host running the amd64 image (today it does not) and
  warns rather than silently running it under emulation.
- CI publishes both `linux/amd64` and `linux/arm64` manifests under one tag (a multi-arch
  manifest), so `docker pull` resolves the right one automatically per host architecture.

## Where to look

- `worker/Dockerfile:124` — the `wget`+`.deb` install that is amd64-only; also the FROM lines
  at `:86` and `:88` that would need a `--platform` build matrix.
- `docs/CONFIDENCE-MAP.md` §2.5 ("One browser, one viewport, no audio, no arm64") — the
  measurement this issue is opened from, verbatim: "no run has ever happened on **arm64**,
  where the desktop image would need a different build entirely."
- `ROADMAP.md` § "Container images on GHCR" — "arm64 is blocked on an arm64 base," and the same
  Dockerfile citation, independently confirmed here.
- `.github/workflows/image.yml` — today's single-architecture build; where a
  `linux/arm64`/`linux/amd64` matrix would need to go.

## How to prove it

```
docker buildx build --platform linux/arm64 -t ezil-os-desktop:arm64-test worker/
```
run on real arm64 hardware, then boot it and confirm a non-uniform-pixel desktop the same way
`docs/RUNBOOK.md` §"The black desktop" describes for amd64.

## Prerequisite

None — but this issue is **blocked**: it needs an arm64-compatible Chrome (or replacement
browser) that does not exist yet at the pinned amd64 download URL, and arm64 hardware or a CI
runner to build and boot on. No amount of code in this repository alone resolves that; it is
named here rather than scheduled, the same as `TAURI-01`.

---

Want to work on this? Comment on the issue to claim it (starting from the missing-arm64-browser
question, not from a build-matrix PR that would fail at the first `apt-get install`), then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr).
