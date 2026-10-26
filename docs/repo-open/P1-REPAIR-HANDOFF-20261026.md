# P1 review repairs — current narrow review handoff

Supersedes the v5 launch correlation and ref behavior in SHARED-IDENTITY-HANDOFF-20261026.md. Base review targets: OS 6be334b9, CLI 554c561. Only the two identified P1s, affected tests, private package/pin and bounded error mapping changed. No staging deployment, lease operations or infrastructure repair.

## Immutable document intent

The cross-site launch POST still accepts exactly one code and an exact trusted Origin. Its response is now a no-store HTML handoff document with nonce CSP and Referrer-Policy: origin. It initializes only a random, non-bearer correlation ID in sessionStorage, then form-POSTs that ID to the same-origin continuation. Code and Git/Auth0 credentials never enter the HTML, browser storage or URLs.

Each intent has its own `__Host-ezil-project-launch-<correlation>` HttpOnly/Secure/Lax cookie containing a separate proof handle. New tabs do not overwrite an older intent's proof. The continuation checks the exact per-intent proof, stores the verified OS session binding when available, and otherwise uses existing Auth0 SSO. The OS shell consumes the pending correlation into the history entry's immutable state and captures it for that Code window and preview/retry calls. Refresh/back uses that history entry, not a later pending launch. The preview POST requires the explicit correlation, current OS session and owned computer; there is no latest-cookie selection or missing-correlation fallback. The server checks correlation/proof/intent/session/computer equality. Signout removes every per-intent proof.

Tests cover overlapping A/B launches with shared cookies and concurrent redemption, old A refresh/reuse, legacy latest-cookie irrelevance, substituted/missing proof, missing preview correlation, session/computer mismatch, per-tab storage and old history entries. Real Chromium verifies the updated HTML handoff preserves exact Origin and restores SameSite=Lax session cookies; Origin:null still fails. No code/token/handle is placed in a URL.

## Authoritative full Git ref

The CLI carries the packet's validated full branch ref into the private transport. Fresh clones explicitly select the branch using single-branch/no-tags and verify full symbolic HEAD plus its commit against the exact origin tracking ref before destination publication. A same-basename tag cannot substitute its commit; a tag-only name fails closed. Existing checkouts must already have the exact full symbolic ref. Ref mismatch returns repository-ref-mismatch (OS repo_ref_mismatch) without changing branch, local commits, dirty files or untracked files. No checkout/reset/pull modifies reused data. Existing FD containment, lock ownership and timeout cleanup/recovery are preserved.

CLI source: 8fe38cc94ba7c7fc1a44a5945ee21030a1e8e1a9.
Private version: 0.2.1-repo-url-open.20261026.6.
Bundle SHA256: e40f8f60709338c49716c605e2c4bbe52a9f9d6894bebf59c72e0014e2e7b0ef.
Tarball SHA256: bb16abe73cf58b0a3ccb6dd17835a671702fcb8dcf13e312702738a615ad83e5.
Separate private directory: EZiL-CLI-private-artifacts/project-repo-grant-20261026-v6. Built with Bun 1.3.14; prior artifacts preserved. No private CLI source or bundle in the OS repository.

## Affected validation receipt

- App: 27 focused tests including real Chromium handoff; app typecheck passed.
- CLI: 49 scoped Git tests and CLI typecheck passed.
- The real-Git authoritative-ref regression also passed against the exact packaged Node CLI: remote HEAD main, topic branch and differing same-name tag, tag-only denial, local-commit/dirty/untracked reuse and mismatched-ref preservation.
- Exact pinned package through OS supervisor: 14 tests passed, zero skips. Both legacy/private modes, normal timeout/retry, CLI escalation, OS forced recovery, PID exit, secret containment and unknown/unrelated state preservation. Three-second cleanup grace unchanged.
- Shell: rebuilt bundle; project-launch, repo-link and app-link checks passed. CSS/icons unchanged.
- Worker repo wire tests: 2 passed.

No full image/build or broad suite repetition for this narrow repair. Requires independent exact-commit/artifact rereview. Works 80cbd201 allows the intentional shared Auth0 client in source; that is no longer an OS source blocker and no new global Auth0 client is required. Effective OS launch settings are still absent, local Docker storage is full, and another release owns staging. No new live metadata/configuration or lease changes in this repair turn. Real staging acceptance remains outstanding.
