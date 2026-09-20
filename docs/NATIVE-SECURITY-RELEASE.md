# Secure browsing and recovery release

The embedded Electron Browser is not Google Chrome. Google account websites
open in a normal, Google-signed Chrome window using a private workspace profile.
The host verifies Chrome's signature and minimum supported major (153), validates
HTTPS destinations, and restarts authentication at the origin's landing page.
Google Accounts URLs restart at Google home. Cookies and credentials never cross
back into EZiL. Chrome profiles are not an operating-system security boundary.

Chrome updates use Google's distribution and updater. At each EZiL release,
check Google's version history and security releases, raise the supported minimum
when required, and retest profile compatibility. For Electron/Node/Bun/code-server,
review upstream security advisories, update pinned versions and archive digests,
regenerate the dependency inventory/SBOM, and rerun automated plus packaged UI
acceptance. Do not reuse old installers as evidence of a patched runtime.

Outer-window closure requires confirmation and stops supervised workspace
processes. Internal Code closure detaches its UI only. Dock activation during
teardown queues one reopen. Uncertain process ownership blocks unsafe cleanup;
saved files are preserved and Retry rechecks ownership. Chrome and Xcode remain
independent. Workspace removal also checks Chrome ownership and requires explicit
confirmation before clearing its browser profiles. No standalone clear-data
operation is exposed in this release.

## Developer ID release gate

Internal builds remain explicitly `internal-ad-hoc` in INVENTORY.json and the
DMG filename. They are not enterprise distribution approval.

The account owner must enroll at <https://developer.apple.com/programs/enroll/>,
complete agreements/payment and two-factor authentication, and use Xcode Accounts
or Apple Certificates to provision a **Developer ID Application** certificate with
its private key in the login Keychain. `security find-identity -v -p codesigning`
must list it as valid. Store notarization credentials with `xcrun notarytool
store-credentials` using its interactive Keychain flow; do not put passwords or API
private keys in source, worker prompts, shell history or build logs.

From macos-electron with the pinned local tool PATH and SSD staging configured:

```sh
export EZIL_SIGNING_IDENTITY='CERTIFICATE_SHA1_FINGERPRINT'
export EZIL_NOTARY_PROFILE='ezil-notary'
npm run package:release
```

The release path refuses missing/invalid identities, signs nested runtime
components with Hardened Runtime and JIT permission only, submits and staples the
app and DMG, and requires Gatekeeper acceptance. No debugger, unsigned-memory or
library-validation bypass entitlement is requested. This configuration still
requires validation against real signed runtime bytes; unit tests are not a
substitute. Authentication/payment prompts are user-controlled. No Gatekeeper
bypass, quarantine stripping, or embedded-browser identity spoofing is permitted.

Final acceptance additionally requires human Google sign-in and session persistence
without credential automation, ten confirmed close/Dock-reopen cycles, Code/Bun
and Preview recovery, Xcode build/test/run, five launches and a 30-minute session.
Record failed and unexecuted checks explicitly.

References: [Google supported browsers](https://support.google.com/accounts/answer/7675428?hl=en),
[Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies),
[Electron sandbox limitations](https://www.electronjs.org/docs/latest/tutorial/sandbox),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
