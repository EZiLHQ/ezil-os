---
id: SAMPLE-01
title: A sample backlog issue — used only by the issues.ts tests
labels: [tools, "help wanted", "size/S"]
prereq:
state: open
---

## The problem

A controlled fixture body. This exact sentence is asserted verbatim by the
render test, so the publisher must copy the body through unchanged.

## Acceptance criteria

- The rendered body contains this list, unaltered.
- The footer line and the hidden marker are appended after it.
- Nothing else is added or removed.

## Where to look

- `tools/issues.ts` — the renderer under test.

## How to prove it

```
./tools/test.sh tools
```

## Links (exercises absolutizeLinks — row I6c)

Read [How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr)
(a relative file, with an anchor) and
[Building an app for the desktop](../../CONTRIBUTING-APPS.md) (relative to a
sibling directory of this file's own `docs/community/issues/`). An
already-absolute link like [Bun](https://bun.sh) is left untouched.

## Prerequisite

None. This file is a test fixture and is never published to GitHub.
