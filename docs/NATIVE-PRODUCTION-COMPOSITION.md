# Native production composition — source only, default off

Source components are ordinary merges of consent/outbox `2d4fc7c8`, Host
`43d6bdd5` plus reviewed policy `b47f1bd1`, and Runtime `faccaffc`. No private Core/Gateway source is vendored.

## Trusted policy and artifact producer

Host `native_session.PROFILE` uses policy revision `bare-cli2.1.310-r2`, CLI
`2.1.310` with `--bare`, and ordered tools exactly `Bash`, `Edit`, `Read`.
The public profile schema remains `native_interactive_v1`; runtime profile
remains `ezil-native-claude-v1`. Root must assign a NEW consent policy UUID
for this revision; no previous policy UUID or consent is repurposed. `native_isolation.py` constructs
Core binding policy from that profile and the operator's `nativeGatewayOrigin`,
`nativeGatewayCaPem`, and `nativeGatewaySpkiSha256`. Core `compileNativePolicy` (also called by `validateBinding`)
compiles `{model, tools, limits, gatewayOrigin, caPem, spkiSha256}` and fingerprints
its canonical JSON. The policy excludes credentialFile and all bearer material.
The actual pinned Core contract was cross-checked from private WORK only.

The deployment packager must supply actual canonical bytes from those trusted
inputs, plus the actual artifact manifest produced by `native_artifact.manifest_bytes`.
These are deployment configuration, never browser/MCP input or an observed runtime
hash. The server independently validates them in `accepted-policy.ts`.

`EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR` is JSON with exactly:
`{v:1, policyRevision:"bare-cli2.1.310-r2", profileId:"ezil-native-claude-v1", policyId:<consent-policy-UUID>,
artifactManifestBytes:<exact canonical manifest UTF-8 string>,
hostProfileBytes:<canonical Host PROFILE UTF-8 string>,
corePolicyBytes:<canonical compiled policy UTF-8 string>}`.
All three nested values are byte strings. Canonical means sorted object keys
recursively, array order unchanged, no whitespace, UTF-8. Policy includes the
actual public CA PEM and SPKI hash; absent TLS trust is blocked.

Pin SHA-256 of the exact descriptor string in
`EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256`, and SHA-256 of the exact artifact
manifest bytes in `EZIL_NATIVE_RUNTIME_MANIFEST_SHA256`. The descriptor policyId
must equal `EZIL_NATIVE_AUTHORIZATION_POLICY_ID`. Neither is a hash of that UUID.
The server derives two distinct values: Core policyDigest is raw64 SHA-256 of
corePolicyBytes; Host policyDigest is `sha256:` plus SHA-256 of hostProfileBytes.
Readiness must return the exact pinned artifact manifest hash, with the normal
signed per-target nonce/digest/deadline checks. Actual installed/kernel witness
verification remains in Host; the descriptor cannot manufacture qualification.

## Production graph and migration order

`productionNativeConsentDeps` uses the actual sealed `nativeArtifactTaskResolver`;
approval stores `native-task:<ORIGINAL_CREATE_ID>`. The production Host factory
uses the accepted descriptor and the existing PreviewV2 authenticated channel.
`productionNativeRuntimeDeps` and both private authority routes use actual0031
history/active/revocation exports. History identifies only; live approval and
revocation stay separate. PolicyId and profile must match the accepted deployment.
Six runtime receivers forward to the existing delegation-verified HTTP handlers;
normal-cookie control consent receivers use the existing guarded handlers.

Reserved SQL dependency order: placement prerequisites, 0029, 0030, 0031, 0032,
0033. Only production snapshot metadata is extended; no journal/runner/live SQL
was applied. Use the established migration review workflow.

Existing public gates remain `EZIL_NATIVE_SESSIONS=1`,
`EZIL_NATIVE_AUTH_INTENTS=1`, `EZIL_NATIVE_RUNTIME_CONTROL=1`, and exact HTTPS
`EZIL_NATIVE_SESSIONS_ORIGIN`. Host transport needs
`EZIL_NATIVE_HOST_TRANSPORT=1`, `CLOUDFLARE_GUACAMOLE_WORKER_URL`, and the existing
PreviewV2 HMAC configuration. Native assertion/wrapping/service pins remain the
exact `NATIVE_AUTHORIZATION_ENV` list. Delegation pins stay in the existing shared
verifier. No credentials or activation values are supplied here.

## Unresolved first-journey boundary

A real installed artifact, matching deployment descriptor, Host kernel witness,
and actual reviewed-policy installed-CLI qualification must be supplied and verified.
No witness is fabricated. Renewal stays blocked pending qualified admission/revision
CAS composition. No AWS calls, live configuration, customer install, deployment,
or AWS usage acceptance occurred in this source task.


The compiler's `NATIVE_POLICY_DESCRIPTOR` supplies revision/CLI/public-profile/runtime-profile/tools/wireId provenance.
Its `canonicalBytes` result becomes descriptor `corePolicyBytes`; never substitute a fixture digest.
The actual deployment compiler input is `{model, tools, limits, gatewayOrigin, caPem, spkiSha256}`.
Both model qualification packets are source evidence, while actual installed Host/kernel evidence still gates readiness.
No real artifact manifest, policy UUID, CA/SPKI deployment values or descriptor pins are assigned by this source refresh.
