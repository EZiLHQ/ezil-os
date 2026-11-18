# Native preview policy: bare-cli2.1.310-r2

Root explicitly approved this new unreleased preview policy on 17 November2026 after installed CLI2.1.310 in `--bare` mode advertised only Bash, Edit and Read. It replaces the unqualified seven-tool prototype for this new revision; old seven-tool source receipts remain historical evidence.

The ordered tools are exactly `Bash`, `Edit`, `Read`. The host fixed profile now includes `policyRevision: bare-cli2.1.310-r2`. CLIversion, model, acceptEdits, limits, workspace/HOME arrangement, bare mode, root identity/resource/network/credential fences and public profile identifiers remain unchanged. No tool aliases or omitted-tool claims are accepted. File creation and build/test commands use Bash; Read and Edit need actual installed-CLI qualification.

This is a new policy identity. The deployment descriptor must use a new Root-assigned policy UUID and bind this revision, the host profile digest and the accepted artifact manifest. Never reuse the old seven-tool policy UUID or consent. No new policy UUID or live descriptor is installed by this source change.

Host profile digest: `sha256:669f2e04be8d8183727f1e750f4b9fe1bad3bd1b991babbbd549debc5a305e3e` over the full canonical `native_session.PROFILE` JSON, including revision. This is distinct from Core's bare64 policy fingerprint over `{model,tools,limits,gatewayOrigin,caPem,spkiSha256}`. The production composition owner must derive that Core fingerprint from the actual operator-installed TLS/configuration and artifact descriptor; no placeholder TLS values or caller pins qualify it.

Default production remains blocked until descriptor/policy/artifact composition and installed root/driver/Core qualification pass. This source update performs no deployment, model/provider call or AWS/customer acceptance. Installed `tool_progress` remains unsupported until positively observed.
