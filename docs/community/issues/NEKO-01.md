---
id: NEKO-01
title: EZIL_NEKO_IMAGE means two different shapes
labels: [worker, local, "good first issue", "size/S"]
prereq:
state: open
---

## The problem

The same environment variable name means two different things depending on where it is read.
In `deploy/images.env:92`, `EZIL_NEKO_IMAGE=ghcr.io/ezilhq/ezil-neko-vscode` is a **bare
registry path with no tag** — `.github/workflows/image.yml:112-113` appends `:${EZIL_NEKO_TAG}`
or `:${EZIL_NEKO_OVERLAY_TAG}` to it to form a real reference. But
`.github/workflows/ci.yml:527` sets `EZIL_NEKO_IMAGE=ezil-integrated:local` — a complete
`image:tag` literal — and `worker/scripts/mobile-keyboard.container.test.ts:174` reads it the
same way: `process.env.EZIL_VALIDATE_IMAGE ?? process.env.EZIL_NEKO_IMAGE ?? 'ezil-integrated:local'`.
Anyone reading one of these two conventions and assuming it applies to the other will build the
wrong string and either produce a nonsense image reference (`registry-path:registry-path`) or
silently resolve to an unrelated image.

## Acceptance criteria

- The two usages get distinct names — e.g. `EZIL_NEKO_IMAGE` stays the bare registry path
  (`images.env`'s existing meaning, since `image.yml` already appends a tag to it) and the
  worker-test/CI convention gets a new name (e.g. `EZIL_VALIDATE_IMAGE` alone, dropping the
  `EZIL_NEKO_IMAGE` fallback, or a clearly different name) — the choice is the implementer's,
  but it must not leave one name meaning two shapes.
- Every reader of the old, ambiguous convention is updated in the same PR:
  `.github/workflows/ci.yml:527`, `worker/scripts/mobile-keyboard.container.test.ts:174`, and
  any other `*.container.test.ts` file found to read `EZIL_NEKO_IMAGE` as an `image:tag`
  literal (grep the whole `worker/` tree, not just the one file cited here).
- `deploy/images.env`'s own usage and `image.yml`'s tag-appending logic are untouched — this
  issue renames the *other* convention, not the one `images.env` already documents correctly.
- A comment at each renamed site states the shape it now unambiguously means (bare path vs.
  `image:tag`), so this cannot silently drift back into two meanings later.

## Where to look

- `deploy/images.env:92` — `EZIL_NEKO_IMAGE=ghcr.io/ezilhq/ezil-neko-vscode`, the bare
  registry-path meaning.
- `.github/workflows/image.yml:112-113` — where a tag is appended to that bare path to form
  `base_ref`/`overlay_ref`.
- `.github/workflows/ci.yml:520-527` — the comment acknowledging the ambiguity ("accepts the
  older EZIL_NEKO_IMAGE spelling as a second fallback") and the `image:tag` literal it exports.
- `worker/scripts/mobile-keyboard.container.test.ts:174` — the `image:tag`-shaped read, with a
  fallback to the literal `ezil-integrated:local`.

## How to prove it

```
./tools/test.sh worker
```
Expected: the container suites still resolve the correct image under the renamed variable(s),
with the same pass count as before the rename (32 pass / 0 fail with the image present).

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr).
