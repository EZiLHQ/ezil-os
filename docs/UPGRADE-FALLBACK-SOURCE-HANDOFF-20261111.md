# Upgrade fallback source handoff — 2026-11-11

Only fallback navigation changes. Actual user's destination remains unconfirmed.

## Authority
EZIL_OS_ORIGIN is separate from EZIL_AI_BASE_URL. osBillingOriginFor reuses staging's parent map for ezil.work;
ezil.org (including existing unset production default) maps to https://os.ezil.work. Unknown/empty realms clear
the value. Request hostname, Gateway/Code proxy URL, bridge URL and caller fields never choose the destination.
The extension accepts only the two exact HTTPS OS origins. Otherwise it gives OS Settings instructions without
an external action. Successful embedded billing requests still suppress fallback; production bridge permissions
stay disabled. Existing credit/plan/window semantics are unchanged.
Cloudflare startAiDesktopUnlocked spreads boot env after launcher env. Warm launchers are reused: adoption
requires the normal separately reviewed boot/restart lifecycle. This patch starts nothing.

## AWS boundary
worker/src/index.ts awsDesktopAiConfig constructs the AWS Code proxy URL. The AWS host agent's
infra/host-agent/lib/ezil_host/desktop.py accepts only baseUrl/proxyToken/optional editorToken and provisions
no EZIL_OS_ORIGIN. An added payload field would reject desktop config, so none was added. A separately
assigned host-agent contract/provisioning change is needed for AWS external links. With this extension AWS
retains the embedded bridge where available, otherwise the actionable no-link fallback. No deployed env inspected.

## Validation/delivery
Bun 1.3.14; dependency symlinks reused; no installs/large builds.
Extension regressions on old source: 41 pass / 16 fail. Fixed: 57 pass / 0 fail.
Worker route-auth/folder/billing bridge: 238 pass / 0 fail, including forged parent/nonce.
Empty-origin Worker mutant: 1 targeted fail, 200 unrelated tests filtered out; source restored.
Both package typechecks pass. Worker uses tools/test.sh; runner has no extension selector, so extension
uses package test/typecheck commands. Full package/container/browser/live financial suites not run.

Review-only VSIX built with pinned Bun and package-vsix.py under the private artifact directory.
Tracked release VSIX intentionally unchanged: it is NOT this source build. Custodian must compose forward
and produce the reviewed release artifact before installation. No push/merge/CI/bake/registry/deploy/flags/
schema/accounts/financial actions. No MCP control or effort changes.

Original agent-authored patch, no new dependencies. Local commit uses Codex (AI agent) <codex@localhost>
with its own agent sign-off. No human certification or approval is inferred.
