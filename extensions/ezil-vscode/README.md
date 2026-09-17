# EZiL OS native VS Code connector

This private connector targets official VS Code 1.96+ and uses only stable
activation, workspace, command, and input APIs. It acknowledges editor readiness
every 15 seconds and registers explicit `127.0.0.1` preview ports. There is no
provider secret storage, telemetry, URL discovery, executable selection, or
language model implementation.

Build with `bun run build`; test with `bun test`; validate the pinned API with
`bun run typecheck` after installing the declared development dependencies in
an environment with a reviewed lockfile. The build produces the ignored
CommonJS entry under `dist/`; include it when packaging. Publishing is not performed.

Electron launches the workspace's official VS Code instance with
`EZIL_BROKER_FILE` inherited. The descriptor must be an owner-only regular file,
outside `EZIL_NATIVE_DATA_ROOT` and all project data; no symlink components are
accepted. Connector descriptors bind exactly one local workspace folder, which
may be Electron-owned outside helper storage. Their format and renewal protocol
are in `../../native/README.md`.
Activation refuses a mismatched workspace or a remote/virtual workspace.

The connector commands are **EZiL: Register Loopback Preview Port** and **EZiL:
Unregister Loopback Preview Port**. Ports are explicit integers from 1024 through
65535. The helper rejects its own port. The connector does not scan ports or
claim a registered service is healthy. Deactivation reports `unknown`, never
proof that the VS Code process exited.

Electron's model-only descriptor (`url`, `capability`, explicit `operations` and
`formats`) is also accepted from a private file outside the project. It enables
**EZiL: List Broker Models**, which calls only `GET /v1/models` with a broker
capability and no Origin header. Model-only mode does not register preview
commands or send readiness heartbeats; those require a connector descriptor.
The helper ignores optional `EZIL_NATIVE_BROKER_FILE`; Electron passes the
appropriate descriptor directly to VS Code as `EZIL_BROKER_FILE`.

## Language model compatibility gate

`LanguageModelChatProvider` is not implemented. The pinned 1.96 API is for the
connector only; it does not establish a supported provider-registration API.
Before adding a provider, choose an official VS Code release with a documented,
stable provider API, pin its exact `@types/vscode`, compile against that version,
and run an extension-host integration test. Do not substitute proposed or
invented methods. The pinned VS Code types are unavailable in this worker's
environment, and no lockfile is present for a lock-safe install. Full extension
typechecking and an official VS Code extension-host launch remain integration
checks. Bun bundling,
descriptor validation, and activation/preview behavior against the real helper
handler are independently tested here.
