# Native website passkeys — implementation and acceptance

Website passkeys are integrated with the native Browser. This is **not yet a
completed installed-release feature**: this Mac has no valid Developer ID signing
identity, so embedded Touch ID remains deliberately disabled. The currently
installed app and user data were not replaced during this change.

## Supported routes and limitations

- **Device-bound Touch ID:** Electron 44's `app.configureWebAuthn({ touchID })`
  is configured only in a packaged Apple-trusted app with the matching signed
  keychain group, embedded provisioning profile and available Touch ID. These
  credentials must be created inside EZiL. They are not existing Safari/iCloud,
  Google Password Manager or Chrome credentials.
- **Existing passkeys and Google sign-in:** use the explicit **Open in Secure
  Browser** toolbar/launcher action. Authentication stays in normal Google
  Chrome; EZiL does not import cookies, passkeys or credentials. Actual transport
  availability and account success must be verified by the user in Chrome.
- **Browser tabs and user-initiated popup tabs:** share the workspace's persistent
  Chromium session and its native account-selection handler. Workspaces retain
  separate sessions. Account IDs/handles never enter the desktop bridge or logs.
- **Code/Preview iframes:** their restrictive Permissions Policy is unchanged.
  They do not have account-selection UI because their internal visibility is not
  yet independently tracked by the host. Open a development preview URL in a
  Browser tab to test passkeys. No blanket device/USB/HID permission was enabled.
- **EZiL account login:** not implemented by this change. The supplied screenshot
  concerns website passkeys. An EZiL account relying-party implementation would
  additionally require agreed RP domains, registration/recovery policy and a
  server-verifying authentication integration. Local guest workspaces remain.

The pinned Electron 44.4.1 API has Touch ID, but not `platformPasskeys`. Latest
stable was verified as 44.4.3 on September 20; this work does not change the pin.
The newer upstream system-passkey API is not a generic Google/iCloud workaround:
it requires signed Associated Domains, provisioning and the RP domain's AASA
authorization. Apple's arbitrary-RP browser entitlement requires an organization
Account Holder's application and Apple's approval. No fake entitlement, browser
identity spoofing, credential automation or native authentication interception
is used here. Review/upgrade the stable Electron patch as a release gate.

## Account selection and lifecycle

`macos-electron/src/passkeys.cjs` implements the native, paginated chooser using
Electron's `select-webauthn-account` event. Chromium retains the WebAuthn
origin/RP and authenticator checks; the host additionally binds selection to the
exact owning frame, its ancestor document chain and a visible Browser surface.
The user sees the RP and requesting origin. Cancel is the default. Labels are
bounded plain text with control/bidirectional-override characters removed.

Every request settles at most once. Hiding, occluding or destroying the tab,
window hiding/minimizing, workspace teardown, renderer loss, requesting/ancestor
navigation, timeout, or failed native UI cancels selection. Sibling iframe
navigation does not cancel a legitimate request. Responses from stale dialogs
are ignored. Native selection is not a replacement for authenticator approval.

Electron persists a per-session metadata secret for device-bound credentials.
Preserve the entire workspace Browser profile, not only cookies, on upgrades.
Removing a workspace makes its device-bound passkeys unusable; removal warns the
user to retain another sign-in method. Private keys are managed by macOS, not
exported or deleted using an EZiL credential-storage API. Chrome profiles stay
independent and remain subject to the existing profile-lock checks.

`passkeys.status` is a typed, read-only native-v2 operation. It reports
configuration/availability, not credential or site-login success. Neither keychain
group, paths, credential IDs nor arbitrary launch flags are exposed to renderers.

## Apple signing setup required to finish

1. The user enrolls/uses the appropriate Apple Developer account. Install a valid
   **Developer ID Application** certificate and its private key in Keychain.
2. Enable Keychain Sharing for `com.ezil.os.native` and obtain its **Developer ID
   provisioning profile**, authorizing the chosen certificate and
   `<TEAM_ID>.com.ezil.os.native.webauthn` group. This is distinct from a notarytool
   credentials profile. Keep the Team ID, bundle ID and group stable on upgrades.
3. Set `EZIL_SIGNING_IDENTITY` to the certificate fingerprint,
   `EZIL_NOTARY_PROFILE` to the Keychain notarytool profile name, and
   `EZIL_PASSKEY_PROVISION_PROFILE` to the absolute provisioning-profile path.
   Do not put passwords, tokens or private keys in prompts or the repository.
4. Run the existing `package:release` workflow on the SSD. It decodes and validates
   the profile's team, app, keychain group, expiration, all-device distribution and
   certificate fingerprint, embeds those exact bytes, and applies the passkey
   entitlements only to the outer app. Helpers retain only their original runtime
   entitlements. Missing/mismatched provisioning fails before signing: restricted
   entitlements without provisioning can cause macOS to refuse process launch.
5. Require real launch, Keychain/Touch ID registration and assertion, restart and
   workspace-isolation testing, then notarization/stapling/Gatekeeper and exact
   installed-byte acceptance. Static checks and virtual authenticators do not
   establish these gates. The existing internal DMG has none of this new work.

## Verification

The local fixture is intentionally **not** a reusable production authentication
server. It uses a synthetic account on loopback, one-use challenges and an
in-memory public key. Assertions verify the challenge, type, origin, RP hash,
UP/UV flags, counter and cryptographic signature. Virtual private keys are not
saved to disk. CDP is confined to the disposable test application; no production
browser or real account is automated.

Executed on September 20, 2026:

- Host unit/integration suite: **167 passed, 0 failed, 1 skipped** (the skip is
  the unavailable historical 0.0.14 installation fixture), with real socket
  coverage enabled. Tests include signing/profile rejection, real macOS
  `plutil` extraction, account cancellation/ownership, credential redaction,
  sibling-vs-ancestor navigation and negative signature fixtures.
- Actual development Browser dock and UI: signing-blocked status, sandbox/no
  privileged bridge, virtual registration and verified assertion, wrong-RP
  rejection, pending-request abort and a second Browser tab passed. The final
  repeat also passed creation/assertion in a user-link popup tab: **7 automated
  Browser/WebAuthn checks passed** at `staging/passkeys-RvEbPe/result.json` under
  the SSD evidence root below. That repeat ran locked and skipped native input.
- Native helper suite: **24 passed, 0 failed**, including the real Bun socket
  test. Native TypeScript typecheck passed.
- Evidence: `/Volumes/9502040569/EZiL-Local-Build/2026-09-20/staging/passkeys-nbMrOc/`.
  `result.json`, `passkeys-shell.png` and `passkey-assertion.png` are from the
  unlocked run. Screenshots are isolated shell/content captures, not a composite
  capture of arbitrary desktop windows. A later locked-desktop repeat at
  `passkeys-p9OYao` passed the synthetic tests and explicitly skipped native UI.
- Source helper selection matters: the old packaged helper resolves its own old
  shell assets. The fixture now runs `native/src/main.ts` to test current source.
  Earlier runs that loaded the old shell failed the status check; they are not
  accepted evidence. One stalled fixture required test-scoped forced cleanup;
  later runs exited through the harness's explicit test-only quit confirmation.
- Shell Browser tabs/runtime/composition/native parity, host syntax and generated
  asset drift checks passed. Bun's package downloader stalled; the build gained
  `EZIL_SHELL_PACKAGE_RUNNER=npx` using the same exact minifier versions. Full
  `git diff --check` still flags two inherited whitespace sequences inside the
  regenerated vendored JavaScript template literals; non-generated source passes.

Unexecuted: real Touch ID/iCloud/phone/security-key ceremonies, persistent real
credentials after quit/restart, native discoverable-account chooser interaction,
website Google sign-in, signed package/notarization and installed-byte acceptance.
The native synthetic chooser scenario is implemented in the harness but requires
an unlocked Mac. The seven virtual checks alone are not full passkey acceptance.

Reproduce with the repository's pinned Node/Bun on PATH:

```sh
EZIL_NATIVE_SOCKET_TESTS=1 node --test --test-isolation=none macos-electron/test/*.test.cjs
EZIL_SHELL_PACKAGE_RUNNER=npx bash shell/build-shell.sh --check
EZIL_PASSKEY_EVIDENCE=/absolute/ssd/evidence node macos-electron/test/passkeys-flow.cjs
```

One local Azure review session was used and resumed for final review:
`01a0bed1-1421-7df3-b068-6d54d1225c89`. It was read-only; the coordinator owns all
implementation. The final review's iframe visibility and unrelated-navigation
findings were addressed. No new cloud workspace or model override was used.

## Primary sources read

- [Electron 44.4.1 WebAuthn API](https://github.com/electron/electron/blob/v44.4.1/docs/api/app.md#appconfigurewebauthnoptions-macos)
- [Electron account-selection event](https://github.com/electron/electron/blob/v44.4.1/docs/api/session.md#event-select-webauthn-account)
- [Electron authenticator implementation](https://github.com/electron/electron/tree/v44.4.1/shell/browser/webauthn)
- [Upstream system-passkey change and requirements](https://github.com/electron/electron/pull/51563)
- [Apple arbitrary-RP browser entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential)
- [Apple Keychain access groups](https://developer.apple.com/documentation/bundleresources/entitlements/keychain-access-groups)
- [Provisioning omission causing application launch failure](https://github.com/different-ai/openwork/pull/3478)

Firecrawl's developer index was used for primary-source discovery, then exact
upstream versioned sources and Apple's documentation JSON were read directly
because the scraping service had already reported insufficient credits.
