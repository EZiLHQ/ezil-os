# Provider effort metadata refresh correction

Source-only follow-up atop f71f873433b018a4b94a5b5cb4e51baee42a161b, addressing B's independent R1 in artifacts/gateway-provider-independent-review-20261111/REVIEW.md. No independent approval of my own source is claimed.

catalogSignature now includes the already-validated Gateway row effort object. Its presence, values, protocol and authoritative default therefore participate in the existing cache-to-picker refresh event. The existing Code listing path continues to construct configurationSchema through effortConfigurationSchema. No request default, global preference, model resolution, allowance, billing, entitlement, capability parser or native helper behavior changed.

Six additional real-provider/cache/transport regressions cover absent-to-present capability, enum expansion, enum revocation, full removal, changed default and equivalent freshly fetched metadata. They verify refresh events, the subsequently listed schema, refusal of revoked explicit options before transport, accepted newly offered options, no implicit request effort even with an advertised default, unchanged configured model objects, and no redundant event after re-listing or an unchanged catalog.

Before the production fix: provider-effort.test.ts had 8 pass / 5 fail; all five capability transitions failed at expected refresh-event count. After the one-line signature fix:

```
/root/.bun/bin/bun test extensions/ezil-models/tests/provider-effort.test.ts extensions/ezil-models/tests/provider.test.ts extensions/ezil-models/tests/effort.test.ts
90 pass / 0 fail; 557 assertions; 3 files
/root/.bun/bin/bun run --cwd extensions/ezil-models typecheck
PASS
```

Bun 1.3.14 and existing dependency symlink reused. No installs/builds/VSIX changes/live calls. HTTP is synthetic. Existing provider tests retain normal billing/availability/caps behavior; effort tests retain concurrent session and utility/child isolation coverage. git diff --check passed.

B's later helper/protocol corrections are not cherry-picked into this deliberately isolated branch; final composition must retain them separately. No edits to B's worktree, Gateway, schemas, flags, account/compute/financial controls or deployment. Root/B independent review and final combined artifact/native/live acceptance remain outstanding.
