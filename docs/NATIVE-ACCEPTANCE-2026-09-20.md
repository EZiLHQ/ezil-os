# Secure browsing and workspace recovery — September 20

Status: **implementation and internal candidate delivered; release unfinished**.
The installed EZiL app has not been replaced. It remains 0.1.0 / `53b0b4c`.
Its previously stuck process was quit through native UI before testing.

## Implemented

- Verified Google Chrome companion, dedicated persistent workspace profiles,
  HTTPS origin-only destinations, Browser toolbar and native launcher actions.
  No cookie transfer, identity spoofing, injected auth scripts or debugging flags.
  Separate Chrome profiles may coexist; repeated opens use the owned profile.
  Active or uncertain Chrome ownership blocks profile removal.
- Early per-sink EPIPE guards; best-effort diagnostics; explicit promise handling;
  serialized window close and queued Dock reopening; stale editor/gateway rejection.
- Asynchronous bounded process sampling, cancellation/draining, fresh process
  identity checks, transient recovery and fail-closed unresolved ancestry.
  Code reports startup, connection and unresolved-cleanup failures separately.
- Explicit confirmation distinguishes managed-file deletion from attachment
  removal and warns about browser data. Original attached folders are preserved.
- Developer ID/Hardened Runtime/notarization/stapling/Gatekeeper build path.
  Internal artifacts remain explicitly ad-hoc. Signing is not Google compatibility.
- Regression harness for ten native outer-window/Dock/Bun cycles (not yet run).
  Smoke probes now select the macOS SDK and wait independently for navigation.

Two local Azure CLI workers were used and their exact sessions resumed for bounded
corrections. No cloud execution, credential access or model overrides were used.

## Installed Chrome

Chrome **153.0.8010.53** was downloaded from Google's supported distribution and
installed in `/Applications/Google Chrome.app`. Google's version API reported
this as fully rolled out arm64 stable. Google bundle/team signature verification
passed and Gatekeeper reported **Notarized Developer ID** for the downloaded app.
The installed copy's deep/strict Google signature and version were rechecked.
The new host's real availability operation returned available with that version.

Version 150 was moved, not deleted, to the SSD recovery directory. Personal Chrome
profiles and defaults were not modified. Human Google sign-in, cookie persistence,
logout and expiration have **not** been validated.

## Verification ledger

| Check | Result |
| --- | --- |
| Host suite, including real sockets | 152 passed, 0 failed, 1 skipped |
| Skipped host case | Requires the removed installed 0.0.14 app; synthetic v1 migration passed |
| Native helper | 24 passed, including real Bun socket coverage; typecheck passed |
| VS Code connector | 8 passed; typecheck passed |
| Shell | Native adapter, actual-window DOM parity, persistence, 300 surface-slot cycles, style, dialog deadlines and health checks passed |
| JavaScript syntax/generated assets | Passed; generated shell drift check passed |
| Latest DMG integrity | Deep/strict ad-hoc signature passed; 5,725 file/link fingerprints match staging; zero inventory hash mismatches; DMG ejected |
| EPIPE | Real child stdout/stderr pipes disconnected; child survived subsequent console writes; synthetic synchronous/asynchronous cases passed |
| Ownership/lifecycle faults | Transient/permanent inventory failures, ancestry gaps, PID reuse, startup cancellation, queued activation, duplicate quit, diagnostic failure and stale gateways passed |
| Secure Browser policy | 12 focused module tests plus bridge/removal tests passed; real availability passed |
| Code product flow | Opened via dock; typed and saved source; verified actual bytes; built representative project via integrated terminal |
| Browser product flow | Local dev server, addresses, links and back/forward passed |
| Native controls/download/quit | Attempt failed after the Mac locked; native dialog/shortcut acceptance did not pass |
| Apple tools | Xcode 27.0 (27A266a), macOS SDK 27.0; selected-SDK Swift probe compiled and executed |
| Full Xcode app/XCTest/UI workflow | Unexecuted in this continuation; previous Developer Tools authentication gate remains unverified |
| Electron graphical smoke | Failed at native page capture/resize while screen locked; this is not a pass |
| Human Chrome Google sign-in | Unexecuted; no credential automation attempted |
| Ten outer close/Dock/Code/Bun cycles | Harness implemented; unexecuted because Mac locked |
| HMR, five launches, 30-minute session | Outstanding on final bytes |
| Developer ID/notarization | Blocked: zero valid code-signing identities found; release path itself remains unvalidated with an actual certificate |
| Installed final-byte acceptance | Unexecuted; existing EZiL installation preserved |

The first isolated packaged product run used runtime `67df74c`: shell ready in
6,907 ms; Browser/Code dock plus file editing in 6,216 ms; terminal build in
7,639 ms. These are stage timings, not five-launch measurements. No renderer
errors were recorded. Native keyboard/upload/download reached a readiness timeout.
macOS explicitly reported `CGSSessionScreenIsLocked=Yes` and native screen capture
was black. The failed harness could not confirm Quit and used its scoped test-only
termination fallback; recorded test PIDs were subsequently absent. This does **not**
count as successful product cleanup or ten-cycle acceptance.

Supplemental packaged smoke uses direct host calls and an injected test frame;
its partial editor/authentication/toolchain passes are diagnostic only, not a
substitute for the real dock-driven product flow. One initial invocation omitted
the required artifact checksum; the subsequent attempt exposed the SDK omission.
After selecting the SDK it passed native compilation, shell startup, editor
workbench and missing-auth rejection, then failed at graphical capture while locked.

## Candidate and evidence

Build root: `/Volumes/9502040569/EZiL-Local-Build/2026-09-20`.
Latest source/runtime candidate: `c1daa8b`, version **0.1.1**, Apple Silicon,
**internal-ad-hoc**. Exact runtime commit:
`c1daa8bd89c41265e8bc15dfdf55de4ccbd9772b`.
SHA-256: `9c04a6a48e74a0d398eff183c525558c2e754717784ff33a954380d067d5bb02`.
The same checksum is recorded beside the DMG. Latest staging bundle is
`staging/build-fDR59m/EZiL OS.app`; its byte/mode/link fingerprints match the
mounted DMG. Final signature verification passed and the DMG was ejected.
The final candidate's native GUI workflow has not been run while locked.

- DMG: `dist/EZiL-OS-0.1.1-AppleSilicon-internal.dmg`
- Dependency inventory and CycloneDX SBOM: `dist/INVENTORY.json`, `dist/SBOM.json`
- Host/native/connector logs: `evidence/host-tests-final.log`,
  `native-real-socket-tests.log`, `connector-tests.log`
- Product report/screenshots: `evidence/product-flow/`, including
  `code-saved.png`, `terminal-build.png`, `browser-shell.png`, `browser-content.png`
- Screenshots above are from the earlier isolated `67df74c` candidate, not final
  installed bytes. Shell and native Browser content captures are separate.
- Earlier review candidates are retained under `dist/review-*`; they are not the
  latest candidate and are not accepted releases.

## Recovery and remaining user actions

Private recovery root: `/Volumes/9502040569/EZiL-Local-Build/2026-09-20/recovery`.
It contains `EZiL OS-0.1.0.app`, `EZiL OS Native` metadata/profiles, and
`Google Chrome-150.app`. EZiL backup signature verification and metadata/profile
comparison passed. The unchanged legacy data backup remains in the September 19
recovery root. No original projects were removed or moved.

EZiL rollback is currently unnecessary: the old app and original data are still
installed. After a future tested replacement, quit EZiL normally, move that newer
app aside, and copy the verified 0.1.0 backup back as `/Applications/EZiL OS.app`.
Keep the existing original data directory. Do not blindly restore copied workspace
metadata: stored inode identities must be reconciled with restored directories.
Use the saved snapshot for targeted recovery with the original projects preserved.
Retain Chrome 150 only for recovery investigation; do not downgrade daily browsing
to an outdated security version.

At handoff, no test EZiL/helper/editor processes remained in the September 20
build paths. Free space was approximately 7.1 GiB internally and 144 GiB on the
SSD. No personal Downloads cleanup was needed for this implementation.

Next: unlock the Mac and keep it unlocked for native controls, Chrome and Xcode.
Complete human Google sign-in only in the genuine Chrome window. Provision the
Developer ID certificate and notarization Keychain profile using
`docs/NATIVE-SECURITY-RELEASE.md`. Do not transmit account passwords or signing keys
to workers. Finish isolated acceptance, then install the verified candidate and
repeat the principal workflow against those exact bytes before declaring completion.
