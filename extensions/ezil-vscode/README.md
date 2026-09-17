# EZiL OS native VS Code connector

This private connector targets official VS Code 1.109+ and uses the stable
activation, workspace, command, input, and `LanguageModelChatProvider` APIs. It acknowledges editor readiness
every 15 seconds and registers explicit `127.0.0.1` preview ports. There is no
provider secret storage, telemetry, URL discovery, executable selection, or
provider credential in the extension process.

Build with `bun run build`; test with `bun test`; validate the pinned API with
`bun run typecheck` after a frozen install of the reviewed `bun.lock`. The build
produces the committed CommonJS entry under `dist/`; packaging verifies and
copies those exact bytes. Publishing is not performed.

Electron launches the workspace's official VS Code instance with
`EZIL_BROKER_FILE` inherited. The descriptor must be an owner-only regular file,
inside the Electron app's private data and outside all project data; no symlink
components are accepted. Connector descriptors bind exactly one managed local
workspace folder. Their format and renewal protocol are in `../../native/README.md`.
Activation refuses a mismatched workspace or a remote/virtual workspace.

The connector commands are **EZiL: Register Loopback Preview Port** and **EZiL:
Unregister Loopback Preview Port**. Ports are explicit integers from 1024 through
65535. The helper rejects its own port. The connector does not scan ports or
claim a registered service is healthy. Deactivation reports `unknown`, never
proof that the VS Code process exited.

Electron's model-only descriptor (`url`, `capability`, explicit `operations` and
`formats`) is also accepted from a private file outside the project. It enables
the **EZiL BYOK** model provider and the diagnostic **EZiL: List Broker Models**
command. Both call only the authenticated loopback broker with no Origin header.
The provider supports text messages, Azure SSE, Bedrock event streams, streaming,
cancellation, and conservative token estimates. It deliberately advertises no
image or tool-call capability. Model-only mode does not register preview
commands or send readiness heartbeats; those require a connector descriptor.
The helper ignores optional `EZIL_NATIVE_BROKER_FILE`; Electron passes the
connector descriptor to VS Code as `EZIL_BROKER_FILE` and the model descriptor
as `EZIL_AI_BROKER_FILE`.

The implementation is compiled against exact stable VS Code 1.109 types. Electron
rejects older VS Code bundles instead of silently registering an unsupported API.
Provider registration, model discovery, Azure streaming, descriptor validation,
and activation/preview behavior against the real helper handler are checked in
CI. Bedrock binary event streaming is covered by parser tests and the official
extension-host/provider calls remain physical-Mac gates.
