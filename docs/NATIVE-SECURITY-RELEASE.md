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

## Browser-to-app login alternative (not implemented)

The September 20 follow-up proposes authenticating in the user's browser and
returning to EZiL. This is a supported architecture **when EZiL is the OAuth
client**, or when the target service explicitly provides a supported native
application integration. It does not transfer Gmail, Google Drive, or another
website's authenticated Chrome session into Electron.

For EZiL account login, use an external user-agent and an authorization-code
flow with S256 PKCE, random per-attempt state, narrowly registered redirect
destinations, timeout/cancellation, and single-use completion. Bind an attempt
to its originating workspace; reject late callbacks after close/switch. For
OpenID Connect, validate nonce, issuer, audience, and token signatures. Keep
tokens in host-owned secure storage; the renderer receives only the minimum
EZiL session capability. Never place tokens in callback URLs or logs.

Two supported transport options need provider-specific configuration:

- Apple `ASWebAuthenticationSession`: system-managed callback delivery. On
  **macOS**, Apple documents opening the default compatible browser or Safari;
  this is not a promise of an arbitrary browser view embedded in the EZiL shell.
  Its browser selection/session storage also differs from the existing dedicated
  Chrome-per-workspace companion, so do not silently replace that profile policy.
- Default/vendor-signed browser plus a short-lived loopback callback: desktop
  OAuth registration, an OS-assigned port bound only to `127.0.0.1`/`::1`, exact
  path/host/state validation, and immediate listener teardown. Provider redirect
  rules must be verified; never open a generic local URL-forwarding endpoint.

The repository's `app/src/app/auth/callback/route.ts` is a hosted Supabase web
callback. It exchanges a code in that browser's session context; it is **not** a
native Electron callback receiver. A native broker integration must be designed
against the actual hosted login/provider configuration, not by copying Chrome
cookies or forwarding an existing rejected OAuth URL.

Acceptance must distinguish: pre-login page rendering; reaching authentication
without the embedded-browser rejection; human completion using an authorized
test account; validated callback; session restoration; cancellation; expired or
replayed callbacks; and separate workspace state. An arbitrary/nonexistent email
or the absence of the warning screen proves none of the later stages. Do not
submit guessed addresses belonging to others. A reserved synthetic address can
test only form validation, not successful account authentication.

The alternate browser's identity and target login URL have not been supplied.
The Mac was initially locked, then became available for the Chrome handoff test
below. No new browser installation, Google account authentication attempt,
identity spoofing, or native callback implementation was performed for this
follow-up.

Primary sources checked: [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Apple web authentication sessions](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession),
and [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252). Local research excerpts are
saved in `.firecrawl/auth-primary-source-excerpts.md` (gitignored). Firecrawl's
developer index worked, but its page-scrape service lacked credits; primary pages
were read directly from their official HTTPS sources.

### Live handoff finding and correction

The unchanged packaged candidate refused its actual Browser toolbar action with
`profile_busy` for a new workspace. Live process inspection found that Google's
reparented Crashpad reporters had no observed browser ancestor and were treated
as unresolved profile users. This was a host ownership bug before any Google
sign-in attempt, not a Google rejection.

The source now attributes a reporter only after verifying its known Google
bundle/signature, executable identity, PID birth, and one canonical Crashpad
database argument. An ambiguous, untrusted, or changed reporter still blocks
unsafe profile operations. No process or profile is ignored by name alone.
Verification timeouts also refuse launch without labeling Chrome's signature
invalid or advising a reinstall. These changes have **not** been packaged or
installed yet; the earlier DMG does not contain them.

With the corrected development host and pinned Electron, the real toolbar
successfully launched vendor Chrome 153.0.8010.53 using the workspace's dedicated
profile and no debugging/automation flags. The marker recorded its exact process
owner. A repeated dock handoff retained that owner. EZiL then quit with its native
confirmation while Chrome stayed running independently. Existing Chrome sessions
were not quit or modified. Chrome's native first-run window was present; successful
Google account login/callback/session persistence is **not** established.

Verification after the source correction: **154 host tests passed, zero failed,
one skipped**, with `EZIL_NATIVE_SOCKET_TESTS=1`. The skip requires the removed
0.0.14 installation. This includes 13 focused Secure Browser cases, covering
reporter ownership, signature rejection, timeout classification, PID reuse,
malformed arguments, profile locks, and distinct workspace profiles. JavaScript
syntax and whitespace checks passed. Log: `host-real-socket-tests.log` below.

Evidence root:
`/Volumes/9502040569/EZiL-Local-Build/2026-09-20/staging/auth-handoff-zXfTbR`.
`ezil-secure-browser-toolbar.png` records the packaged failure;
`corrected-toolbar.png` records the development-host success. These are shell
screenshots, not authenticated website evidence. Native Chrome capture was not
available. An unintended foreground-window region capture was removed immediately
and must not be used as evidence. No account credentials were submitted.

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

The main app's device-bound Touch ID passkeys also require an authorized Developer
ID provisioning profile for `com.ezil.os.native` and its Keychain Sharing group.
Do not sign with restricted keychain entitlements without that profile. See
[the passkey implementation and signing gates](NATIVE-PASSKEYS.md).

From macos-electron with the pinned local tool PATH and SSD staging configured:

```sh
export EZIL_SIGNING_IDENTITY='CERTIFICATE_SHA1_FINGERPRINT'
export EZIL_NOTARY_PROFILE='ezil-notary'
export EZIL_PASSKEY_PROVISION_PROFILE='/absolute/path/EZiL.provisionprofile'
npm run package:release
```

The release path refuses missing/invalid identities, signs nested runtime
components with Hardened Runtime and JIT permission only, validates and embeds the
passkey provisioning profile, grants the keychain group to the main app only, submits and staples the
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
