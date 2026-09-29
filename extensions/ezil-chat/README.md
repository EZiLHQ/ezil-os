# EZiL Chat (VS Code / code-server extension)

EZiL Chat puts an AI coding panel in the **secondary sidebar** of the EZiL OS
editor, the same slot Claude Code and Codex use, and drives a pinned
[OpenCode](https://opencode.ai) v2 server on loopback. OpenCode owns the agent
loop, tools, permissions, model routing and prompt caching; this extension is
the UI and the process owner. It also ships `configurationDefaults` that turn
off VS Code's built-in Copilot chat (`chat.disableAIFeatures`) and open the
secondary sidebar by default.

Phase 1 scope: the extension, its build/test/package pipeline and local tests.
Image changes (pinning code-server, removing the bundled Copilot extension,
installing the VSIX and `opencode`) are a separate change in `worker/`.

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
  with a random `OPENCODE_SERVER_PASSWORD`, polls `/api/info`, restarts with
  exponential backoff after a crash, and kills the child on dispose. With
  `ezilChat.serverUrl` set it attaches to an existing server instead.
* `src/panel/controller.ts` owns the current session and the event pump and
  turns webview requests into client calls. `src/panel/provider.ts` hosts the
  webview (`retainContextWhenHidden`, nonce CSP).
* `src/webview/` is plain TypeScript + CSS on VS Code theme variables:
  streaming text, reasoning and tool cards, permission cards (Allow once /
  Always / Reject), question (form) cards, `@file` mentions with fuzzy
  autocomplete, "Add selection" chips, model picker grouped by provider,
  agent and variant pickers, per-turn token and cache read/write readout,
  session list and Stop.
* `src/edits/diff.ts` opens every OpenCode file edit in the native diff editor.
  The "before" side is recovered by reverse-applying the patch OpenCode reports
  (`src/edits/patch.ts`), falling back to `git show HEAD:file`, and a
  notification offers Keep / Revert.

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
(`tests/controller.test.ts`), the reducer, the patch helper and the process
manager (against `tests/fixtures/fake-opencode.mjs`). `tests/integration.test.ts`
spawns a real `opencode serve` with a config that disables every provider, so
it exercises health, catalog, sessions, the event stream and a permission
round trip without calling a model. Point `EZIL_OPENCODE_BIN` at a binary to
run it; it is skipped when none is found.

## How the image installs it

The worker image (follow-up change) builds the VSIX above, installs the same
`@opencode/cli` version the extension pins (`src/opencode/version.ts`), and runs
`code-server --install-extension ezil-chat-0.1.0.vsix` into the built-in
extensions directory so users cannot remove it. Machine-scope settings carry
`chat.disableAIFeatures` for existing users whose restored User settings would
otherwise mask the extension defaults. Model credentials and routing live in
the managed `/etc/opencode/opencode.json`; the extension never stores provider
secrets.

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
