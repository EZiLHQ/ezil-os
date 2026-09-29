# EZiL Chat (VS Code / code-server extension)

EZiL Chat puts an AI coding panel in the **secondary sidebar** of the EZiL OS
editor, the same slot Claude Code and Codex use, and drives a pinned
[OpenCode](https://opencode.ai) v2 server on loopback. OpenCode owns the agent
loop, tools, permissions, model routing and prompt caching; this extension is
the UI and the process owner. It ships `configurationDefaults` that turn off
VS Code's built-in Copilot chat (`chat.disableAIFeatures`) and open the
secondary sidebar by default — defaults the desktop image deliberately
overrides (see "How the image installs it": there, the bundled Copilot Chat
UI on EZiL models is the primary panel and this one is optional).

Phase 1 scope: the extension, its build/test/package pipeline and local tests.
Image changes (pinning code-server, installing the VSIX and `opencode`) are a
separate change in `worker/`.

## Architecture

```
BROWSER (via *-code.ezil.org)              CODE-SERVER CONTAINER
+---------------------------+   postMessage   +-----------------------------+
| Webview  (dist/webview.js)| <-------------> | Extension host              |
| messages, tool cards,     |                 |  src/extension.ts           |
| permissions, pickers      |                 |  panel/controller.ts        |
+---------------------------+                 |  opencode/v2.ts (adapter)   |
   CSP: default-src 'none'                    |  server/manager.ts          |
   never talks to OpenCode                    +-------------+---------------+
                                                            | HTTP + SSE, 127.0.0.1:<random>
                                                            | basic auth, random password
                                              +-------------v---------------+
                                              | opencode serve (pinned 2.x) |
                                              | cwd = workspace folder      |
                                              | /etc/opencode/opencode.json |
                                              +-------------+---------------+
                                                            | HTTPS
                                              Azure AI Foundry / any provider
```

* `src/opencode/adapter.ts` is the transport-neutral contract (`OpenCodeClient`,
  `ChatEvent`, `ChatMessage`, ...). `src/opencode/v2.ts` implements it over
  `@opencode/client` 2.0.19 and `src/opencode/normalize.ts` maps v2 wire shapes.
  A v1 or v3 client is a second file, not a rewrite.
* `src/server/manager.ts` spawns `opencode serve --hostname 127.0.0.1 --port <free>`
  in its own process group with a random `OPENCODE_SERVER_PASSWORD`, polls
  `/api/info`, restarts with exponential backoff after a crash (never after an
  intentional stop), and kills the whole group (bash tools, MCP servers) on
  dispose or when a launch fails. The spawned pid is recorded in
  `workspaceState`, so a server orphaned by an extension-host crash is reaped on
  the next activation once it is confirmed to be ours. With `ezilChat.serverUrl`
  set it attaches to an existing server instead. Without a workspace folder the
  extension does not start a server and asks you to open one.
* `src/panel/controller.ts` owns the current session and the event pump and
  turns webview requests into client calls. Every webview message is
  runtime-checked (`src/panel/validate.ts`) and file paths are confined to the
  workspace folder (`src/paths.ts`). When the SSE stream reconnects the
  controller reloads catalog, sessions and the open transcript. Permission and
  question cards raised by subagent sessions are tagged with their root session
  and shown on the parent transcript. `src/panel/provider.ts` hosts the webview
  (`retainContextWhenHidden`, nonce CSP).
* `src/webview/` is plain TypeScript + CSS on VS Code theme variables:
  streaming text, reasoning and tool cards, permission cards (Allow once /
  Always / Reject), question (form) cards, `@file` mentions with fuzzy
  autocomplete, "Add selection" chips, model picker grouped by provider,
  agent and variant pickers, per-turn token and cache read/write readout,
  session list and Stop.
* `src/edits/diff.ts` opens OpenCode's file edits in the native diff editor,
  one at a time so a burst of edits does not flood the editor area. The "before"
  side is recovered by reverse-applying the patch OpenCode reports
  (`src/edits/patch.ts`); when that no longer applies, `git show HEAD:file` is
  shown as a labelled approximation. A notification offers Keep / Revert, and
  Revert (`src/edits/revert.ts`) recomputes from the file as it is at click time
  and refuses when the edit can no longer be undone on its own (a later edit,
  the user or a formatter touched the same lines). It never writes HEAD content.

## Settings (`ezilChat.*`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `opencodePath` | `opencode` | Binary the extension spawns. The image installs the pinned version on `PATH`. |
| `serverUrl` | empty | Attach to an external OpenCode v2 server instead of spawning one. |
| `serverPassword` | empty | Basic-auth password for `serverUrl`. Spawned servers get a random one. |
| `configPath` | empty | Passed to the child as `OPENCODE_CONFIG`. Managed `/etc/opencode/opencode.json` always wins on Linux. |
| `defaultAgent` | `build` | Agent for new sessions (`build`, `plan`, or any primary agent the server lists). |
| `defaultModel` | empty | `providerID/modelID[#variant]` for new sessions; empty uses the server default. |
| `autoStart` | `true` | Start the server on `onStartupFinished` instead of on first panel open. |
| `revealOnStartup` | `true` | Focus the panel the first time this workspace activates the extension. |

Commands: `EZiL Chat: Open` (Ctrl/Cmd+Alt+L), `New Session`, `Add Selection to
Chat` (Ctrl/Cmd+Alt+K), `Pick Model`, `Restart OpenCode Server`. Logs go to the
"EZiL Chat" output channel.

## Build, test, package

```sh
cd extensions/ezil-chat
bun install --frozen-lockfile
bun run typecheck      # tsc for the extension host and the webview
bun test               # unit + integration (integration skips without an opencode binary)
bun run build          # dist/extension.js, dist/webview.js, dist/webview.css
bun run package:vsix   # ezil-chat-0.1.0.vsix via @vscode/vsce (bundled, --no-dependencies)
```

Unit tests mock the v2 HTTP/SSE server (`tests/adapter.test.ts`), the relay
including message validation, SSE re-sync and subagent cards
(`tests/controller.test.ts`), the reducer, the patch/revert helpers, path
confinement, the manifest-vs-source contract and the process manager (launch
cleanup, spawn errors, restart-vs-stop, process groups and orphan reaping,
against `tests/fixtures/fake-opencode.mjs`). `tests/integration.test.ts`
spawns a real `opencode serve` with a config that disables every provider, so
it exercises health, catalog, sessions, the event stream and a permission
round trip without calling a model. Point `EZIL_OPENCODE_BIN` at a binary to
run it; it is skipped when none is found.

## How the image installs it

`worker/Dockerfile` (the desktop image local mode and the hosted Worker run).
**Since image revision 2 this panel is installed but optional**: the primary
chat panel is the open-source Copilot Chat that code-server bundles, running
on EZiL-configured models through the built-in `extensions/ezil-models`
provider (see that README, "How the image installs it"). EZiL Chat stays a
built-in so OpenCode is one click away — its "EZiL" icon in the secondary
sidebar, or the command "EZiL Chat: Open" — but it does not start `opencode
serve` or take over the sidebar on its own.

* **code-server is pinned** (`CODE_SERVER_VERSION` / `CODE_SERVER_SHA256`, the
  amd64 `.deb` from the GitHub release, checksummed) instead of `curl
  install.sh | sh`. The bundled GitHub Copilot Chat built-in that code-server
  >= 4.139 ships (`lib/vscode/extensions/copilot`, MIT) is KEPT and
  `product.json` is left as shipped; a build gate fails if the built-in goes
  missing.
* **This extension is a built-in.** `worker/ezil-chat/build-vsix.sh` packages
  `extensions/ezil-chat` into the committed
  `worker/ezil-chat/dist/ezil-chat-<version>.vsix` (the source is outside the
  `worker/` build context, same arrangement as `worker/bootstrap/dist`); the
  Dockerfile unpacks it into `/usr/lib/code-server/lib/vscode/extensions/ezil-chat`.
  A system extension cannot be uninstalled from the Extensions view, needs no
  install step at boot, and is invisible to start-neko.sh's
  `.ezil/extensions.txt` capture/restore. It does NOT show up in
  `code-server --list-extensions` (that lists the user `--extensions-dir`
  only). After changing extension source, rerun `build-vsix.sh` and commit the
  VSIX; `build-vsix.sh --check` fails when the committed VSIX is stale.
* **`opencode` v2.0.19** (`OPENCODE_VERSION`, the version `src/opencode/version.ts`
  pins) is the standalone binary from the `@opencode/cli-linux-x64` npm
  tarball, checksummed, at `/usr/local/bin/opencode`. OpenCode 2.x has no
  GitHub release assets; npm is the only distribution.
* **Managed config** `worker/opencode/opencode.json` is installed at
  `/etc/opencode/opencode.json`, OpenCode's highest-precedence layer on Linux:
  `autoupdate: false`, `share: "disabled"`, a `small_model` placeholder and an
  `azure` provider whose `resourceName`/`apiKey` are `{env:AZURE_RESOURCE_NAME}`
  / `{env:AZURE_API_KEY}` references with example deployment names. No secrets
  in the image; the extension never stores provider credentials either.
* **Machine-scope settings keep it dormant.** `worker/scripts/start-neko.sh`
  writes `<user-data-dir>/Machine/settings.json` on every boot; among the
  chat keys that put Copilot Chat on EZiL models it sets
  `chat.disableAIFeatures: false` (overriding this extension's
  `configurationDefaults`), `ezilChat.autoStart: false` and
  `ezilChat.revealOnStartup: false`, plus
  `workbench.secondarySideBar.defaultVisibility: "visible"`. That layer
  outranks User settings and extension defaults, so the Chat view is what
  the sidebar opens on and no OpenCode server is spawned until the panel is
  opened. Everything else about the panel (pickers, permission cards, diff
  review, token readout) is unchanged once it is open.

`e2e/ezil-chat-image.sh <image>` proves the OpenCode path on a built image: it
boots the container like local mode, checks the in-image facts, then drives a
real browser (`e2e/ezil-chat.mjs`) that opens the EZiL panel explicitly and
sends a prompt answered by `e2e/ezil-chat-mock-provider.mjs`, an
OpenAI-compatible mock wired in through a project-level `opencode.json`, so no
model credentials are needed — and boots again as a returning user with a
Copilot-era `.ezil/extensions.txt` and a masking User `settings.json`. The
Copilot-Chat-on-EZiL-models path has its own runner,
`e2e/copilot-ezil-image.sh`. Both need docker, node and a Playwright install
(`PLAYWRIGHT_REQUIRE_DIR`, like `e2e/prod.mjs`).

## Running locally with code-server

```sh
bun run package:vsix
npm i -g @opencode/cli@2.0.19                # or set ezilChat.opencodePath
code-server --install-extension ezil-chat-0.1.0.vsix
code-server --auth none --bind-addr 127.0.0.1:8080 /path/to/project
```

Open http://127.0.0.1:8080 (webviews need localhost or HTTPS), and the EZiL panel
appears in the secondary sidebar. Give OpenCode a provider (for example
`opencode auth login`, or `AZURE_RESOURCE_NAME` + `AZURE_API_KEY` with an
`opencode.json` that lists the deployments) and send a prompt. Without a
provider the panel still opens; the model picker is empty and turns fail with
a visible error.
