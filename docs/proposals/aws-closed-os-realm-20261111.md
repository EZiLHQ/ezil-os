# AWS closed OS realm — source plan and contract

Base baeeca350a823e9c8aaba6a9d6e29981138b3bb7 in a new isolated worktree.
Supersedes earlier domain-valued osRealm proposal; no runtime GO.

Trace: AWS preview bootstrap builds awsDesktopAiConfig and calls ensureAwsDesktop/
ensureAwsDesktopConfig. /restart uses a separate aws-restart.ts config-push path;
both must call the same final admitAwsOsRealm capability gate after mint/AI awaits.
aws-ice.ts reads gw1-authenticated /__ezil/control/desktop, mints relay, creates
boot-bound AI config, then posts JSON through /__ezil/control/ice/<body-sha256>.
Edge verifies request signature/placement/body digest; agent enforces HMAC, lease
and replay before host desktop config validation. Host build_spec always overrides
image AI defaults; AI_STATE records applied configuration without credentials.
Running configured desktops currently do not restart just for a missing OS origin,
so realm mismatch must enter existing bounded restart/CAS flow, not bypass it.

Optional signed ai.osRealm is exactly staging|production. Worker derives it only
from explicit trusted SANDBOX_PREVIEW_ZONE_ROOT: ezil.work=>staging,
ezil.org=>production. Missing/unknown does not select production. Host maps to
https://os-staging.ezil.work or https://os.ezil.work. Missing clears EZIL_OS_ORIGIN,
including an image default; malformed supplied realm refuses config. AI base URL
and credentials remain independent. No browser/caller/AI URL chooses realm.

New authenticated host status fields: osRealmConfigV1:true (literal only),
osRealmEpoch:{computerId,generation,leaseEpoch,bootId,observedAtMs},
osRealmApplied:staging|production|null, osRealmConfigured:staging|production|null.
Worker accepts capability only with exact matching record identity/generation/
lease, same boot ID and fresh timestamp. Just before config push, after all mint/AI
awaits, it reads status again; changed boot refuses push, missing capability omits
realm for old-reader compatibility, malformed/stale evidence never enables field.
Only this revalidated path adds ai.osRealm. Edge permits only these named status
fields, agent emits them from its own state. No new route/global flag.

Realm changes/clearing on capable running hosts use existing config push/CAS and
restart bounds. Configured-realm distinguishes an already pending desired push
from a prior applied push. Applied realm comes from host-only AI_STATE, never from
caller config as proof of runtime application. Legacy state has no realm.

CF trace: aiProxyBootEnv -> startAiDesktopUnlocked env after launcher env; warm
launcher reused, no reconfigure until normal authorized lifecycle. Existing CF
origin mapping and embedded allowlisted parent+nonce are unchanged; this optional
signed ai object is AWS-only. No extension/provider/VSIX/native patch changes.

Tests: signed mock Worker host statuses (literal/missing/malformed/stale/foreign
lease/boot), post-await boot change, initial/reconfigure/clear realm, old hosts;
host closed key sets/literal mapping/image-default clearing/state readback/restart
limits; edge filtering, existing H2 standalone Git, CF origin regressions. Offline
only. Native Docker COPY closure must remain identical; host-agent deployment
artifact and Worker runtime change and require separate future adoption review.

PR345 inspection is read-only: local13ddf421d21de1a9423f1daee6c4bd5256bb27b2
raises five registry bounds to29 with tests. It is not merged into this source;
reader28 and all immutable registry safeguards stay as in baeeca.

## Validation and integration handoff

Offline Worker typecheck and 376 tests PASS, zero failures/skips:

```
bash tools/test.sh worker src/aws-ice.test.ts src/aws-restart.test.ts src/aws-hook.test.ts src/aws-repo-open.test.ts src/route-auth.test.ts src/code-folder-bridge.test.ts
```

Host-agent 65 tests PASS, zero failures/skips (from infra/host-agent/test):

```
python3 -B -m unittest -v test_os_realm test_ice test_restart_boot_config test_desktop_restart test_standalone_git test_standalone_git_edge
```

Initial Worker runs exposed old exact request-count fixtures and a missing helper
in the extracted route fixture. Updated those for the additional authenticated
status read; final exact sequences remain asserted. No production guard was
relaxed to pass them. Logs are retained outside source under
artifacts/aws-closed-os-realm-20261111/{worker,host}.log in the project artifacts.

The adjacent closure JSON verifies all 42 native Docker COPY inputs against
baeeca. Dockerfile and .dockerignore are unchanged. No native image input or VSIX
rebind is needed for this source delta. Worker runtime and host-agent payload DO
change; native tests cannot qualify the new provisioning behavior. AI_STATE is
written when a spec is built: osRealmApplied is host spec state, not an independent
observation inside a running container or proof of successful Upgrade navigation.

Future adoption order (separately authorized): review/qualify and distribute the
host-agent/edge reader first; then Worker writer. An old host omits capability and
receives no new field. A new host with old Worker gets no realm and clears the
fallback during normal spec creation. Rollback therefore can remove the standalone
fallback after restart; it does not infer production. Existing embedded parent+
nonce navigation stays unchanged. Qualify staging and production literal mapping,
old-host omission, normal bounded restart adoption and missing-realm clearing,
then standalone Upgrade navigation to the correct authenticated OS destination.
No caller URLs, preview tokens, or AI URL can select that destination.

App, MCP, Gateway, schema, native protocol3/effort and trust flags are unchanged by
this patch. H2 repo-open/host Git payload guards and reader28 remain intact. No
migrations, flags, runtime rollout, canary, lease, registry or native acceptance
have been performed or authorized by this source receipt.

PR345 local source inspection only: 13ddf421d21de1a9423f1daee6c4bd5256bb27b2
changes five registry count guards to29 plus tests. The inspected production diff
preserves immutable-record/CAS/byte safeguards, but starts from27 whereas this
union has28. It is not composed here. GitHub status/checks were not independently
queried; future composition must review the actual reader boundary and admission.
