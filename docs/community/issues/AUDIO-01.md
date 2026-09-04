---
id: AUDIO-01
title: Audio in the stream, exercised locally
labels: [worker, local, "help wanted", "size/M"]
prereq:
state: open
---

## The problem

EZiL OS ships no audible desktop audio, and this is deliberate today — but it is deliberate in
a specific, brittle way. `worker/scripts/start-neko.sh:1246-1294` never starts pulseaudio and
points `NEKO_CAPTURE_AUDIO_DEVICE` at a name that cannot resolve
(`worker/scripts/start-neko.sh:1293`), because neko's pinned binary has no
`capture.audio.enabled` flag to simply turn audio off — only `codec`/`device`/`pipeline`
settings, verified directly against the binary's own `--help` output and its compiled strings.
The WebRTC offer SDP unconditionally contains an `m=audio` section regardless, sharing one
`MediaStream` with video. `docs/CONFIDENCE-MAP.md` §2.5 names the resulting gap plainly:
"**audio is untouched end to end** — no test asserts a sound reaches the browser." Nobody has
built or measured a real audio path, locally or otherwise.

## Acceptance criteria

- A local-mode opt-in path exists to start pulseaudio and point
  `NEKO_CAPTURE_AUDIO_DEVICE`/`_CODEC`/`_PIPELINE` at a real device — never on by default for
  the hosted product, since the current disablement is intentional defense-in-depth
  (`start-neko.sh:1246-1254`) and the neko client's own compiled bundle also keeps its
  `<video>` element muted by default regardless of this setting.
- A real test asserts a sound produced inside the container's desktop actually reaches a
  connected WebRTC peer's audio track — not merely that the SDP offer contains `m=audio`
  (which it already does, unconditionally, and proves nothing about a real audio path).
- The change is scoped to local mode's opt-in path; the hosted Worker's behavior
  (`NEKO_CAPTURE_AUDIO_DEVICE` unresolvable, pulseaudio never started) is untouched unless a
  separate, explicitly-approved issue asks for it.
- `docs/PLATFORM-NOTES.md` gains a local-mode annex recording what was measured, following the
  pattern its existing annexes (§6, §7) already use.

## Where to look

- `worker/scripts/start-neko.sh:1246-1294` — the full audio-disablement mechanism: why
  pulseaudio is not started, why the device name is deliberately unresolvable, and what was
  verified directly against the pinned binary (`neko serve --help`, compiled-string grep, a
  live SDP negotiation).
- `docs/CONFIDENCE-MAP.md` §2.5 — "audio is untouched end to end," the measurement this issue
  is opened from.
- `docs/PLATFORM-NOTES.md` §7 and its Annex — where a local-mode audio annex belongs.

## How to prove it

A real two-machine (or two-process) WebRTC session where the container plays a known sound and
the receiving peer's captured audio track contains it — not a log line, not an SDP inspection.
State the exact command/harness used to produce that recording in the PR, since none exists
today to point to.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr).
