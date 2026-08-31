## What this changes

<!-- What behaviour is different after this PR, and why. Not a file list. -->

## How it was verified

<!-- What you actually ran, and what it printed. "Tests pass" on its own is not
     evidence — say which suites, and against what. If you could not verify
     something, say that instead; an honest gap is more useful than a claim. -->

## Checklist

- [ ] Commits are signed off (`git commit -s`) — see [CONTRIBUTING.md](../CONTRIBUTING.md#sign-off-dco).
- [ ] `bun run typecheck` passes in every package I touched.
- [ ] `bun run test` passes in every package I touched.
- [ ] If I touched `app/`: `bun run lint` and `bun run build` pass.
- [ ] If I touched `shell/`: I rebuilt the bundle (`shell/build-shell.sh`) and
      `shell/build-shell.sh --check` is clean.
- [ ] If I added or changed a `.sh` file: it passes `bash -n`, and contains no
      apostrophe inside a single-quoted `bash -c` block.
- [ ] If I added a dependency, vendored code, or a container-image component:
      I checked its license and updated [`ATTRIBUTIONS.md`](../ATTRIBUTIONS.md)
      in this PR.
- [ ] If I changed a pinned image or commit SHA in `worker/Dockerfile`:
      `ATTRIBUTIONS.md` reflects it.

<!-- Security issue? Do not open a PR. See SECURITY.md. -->
