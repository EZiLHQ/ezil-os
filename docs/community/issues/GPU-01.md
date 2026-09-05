---
id: GPU-01
title: GPU passthrough on Linux
labels: [local, "help wanted", "size/M"]
prereq:
state: open
github: 54
---

## The problem

Local mode's `docker run` never asks for a GPU, and the native browser inside the container is
launched with `--disable-gpu` unconditionally — correct for Cloudflare Containers, which
`docs/PLATFORM-NOTES.md` §7 documents as having no GPU at all, but a real loss on a
developer's own Linux machine that has one. `local/src/container/run-spec.ts`'s
`buildDockerRunArgv` (the function that builds every `docker run` flag) has no `--gpus` flag
today, and `worker/scripts/start-neko.sh:2272` / `worker/scripts/start-desktop.sh:136` pass
`--disable-gpu` with no override. `docs/PLATFORM-NOTES.md` §7's Annex also flags an open
question this issue inherits: neko's own `--hwenc` flag exists in the pinned binary, but its
accepted backend values were never found in the fetched `--help` output — what it would
actually be told to use is not yet known.

## Acceptance criteria

- A `--gpus` flag is added to `buildDockerRunArgv` (`local/src/container/run-spec.ts`), gated
  behind an explicit opt-in (e.g. an env var or CLI flag) — never on by default, since
  Cloudflare Containers must stay software-only and any code path shared between local and
  hosted must not silently request a GPU there.
- `--disable-gpu` is removed from the Chrome launch in `start-neko.sh`/`start-desktop.sh`
  **only** behind that same feature check — the cloud path keeps `--disable-gpu` unconditionally.
- `local/src/doctor.ts` gains a check that reports whether a GPU was requested and whether the
  container can actually see it (e.g. `nvidia-smi` inside the container), rather than the flag
  silently doing nothing on a machine without one.
- `docker create` with the new flag is accepted (mirroring the existing proof pattern at
  `run-spec.ts`'s `buildDockerRunArgv` doc comment, which already ran a real `docker create`
  against the pinned image).
- The `--hwenc` question from `docs/PLATFORM-NOTES.md` §7's Annex is either closed (by reading
  neko's Go source or measuring the binary directly) or explicitly deferred with the same
  "NOT MEASURED" framing — this issue must not silently assert an answer to it.

## Where to look

- `local/src/container/run-spec.ts`, function `buildDockerRunArgv` — where every `docker run`
  flag is built today; no `--gpus`/GPU-related flag exists in it yet (verified by grep).
- `worker/scripts/start-neko.sh:2272` and `worker/scripts/start-desktop.sh:136` — the two
  unconditional `--disable-gpu` flags.
- `docs/PLATFORM-NOTES.md` §7 ("No GPU, no hardware encode") and its Annex — the open
  `--hwenc` question and why Cloudflare Containers must stay software-only.
- `local/src/doctor.ts`, function `runDoctor` — where a new GPU check belongs.

## How to prove it

```
bun run --cwd local typecheck && bun test local/
```
Expected: the new flag's unit test passes (including a negative control proving it is absent
when the opt-in is not set), and on a machine with an NVIDIA GPU, `docker exec <container>
nvidia-smi` succeeds inside the desktop container with the flag set.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr).
