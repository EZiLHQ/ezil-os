---
id: SLIM-01
title: Slim the local desktop image
labels: [worker, "help wanted", "size/L"]
prereq:
state: open
---

## The problem

The pinned desktop image is large — `docs/CONFIDENCE-MAP.md` measured a real container from it
holding **456.2 MiB for eight minutes** after its owning process was killed (§2.10), and
separately cites the image itself as **4.57 GB** (§3.9). On a GitHub-hosted CI runner the VM is
discarded and the size costs nothing; on a contributor's own machine, every `docker pull` of
that image is 4.57 GB down the wire, and every orphaned container from a cancelled run (§2.10:
`SIGTERM` mid-run leaves a container behind because
`worker/src/neko-browser-window.container.test.ts:191` cleans up in `afterAll` with no signal
trap) occupies disk indefinitely. `worker/Dockerfile` layers Guacamole, guacd, Tomcat, a JRE,
Neko, Chrome and code-server into one image with no multi-stage slimming pass evident in the
file.

## Acceptance criteria

- The published image is measurably smaller than today's baseline (state the before/after size
  in the PR) — through multi-stage build cleanup, removing build-only dependencies from the
  final layer, or an equivalent technique, **without** removing any capability the current
  suites exercise.
- Every currently-passing suite (`worker`, `container`, `local`) still passes at the same or
  better counts against the slimmed image — no silent capability loss disguised as a size win.
- `worker/scripts/mobile-keyboard.container.test.ts` and the other `*.container.test.ts` files
  are re-run against the new image and reported explicitly in the PR.
- If a multi-stage build is used, the final stage's dependency list is documented (a comment or
  a short doc) so a future contributor does not accidentally re-add something already removed
  for size.

## Where to look

- `worker/Dockerfile:86-135` and `:189` — the two `apt-get install` blocks and the base-image
  layering (Guacamole/guacd/Tomcat/JRE at the top, Chrome installed by direct `.deb` download)
  that a slimming pass would target first.
- `docs/CONFIDENCE-MAP.md` §2.10 ("A cancelled container run orphans a container") — the
  456.2 MiB orphan measurement and the missing signal trap.
- `docs/CONFIDENCE-MAP.md` §3.9 — the 4.57 GB image-size figure, cited independently of §2.10.
- `.github/workflows/image.yml` — the build pipeline that would need to report the new size on
  every build so a regression is visible.

## How to prove it

```
docker images ezil-os-desktop --format '{{.Size}}'
./tools/test.sh worker
```
Expected: a smaller reported size than the pre-change baseline, and the container/worker
suites passing at the same counts as before (32 pass / 0 fail for the mobile-keyboard suite
with the image present, per `docs/CONFIDENCE-MAP.md`'s M1 measurement).

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pull-request).
