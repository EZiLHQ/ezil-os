# Local agents — a measured survey

Research row `X1` (`docs/TASKS.csv`). Not a build: nothing in this repository
changes because of this document. Every claim below cites either a URL fetched
in this session (quoted) or a command run on this machine (output pasted or
paraphrased with the exit condition stated). A claim that could not be
verified this way is marked **NOT MEASURED** rather than left implicit.

This machine, for everything in §3: `docker --version` → `Docker version
29.1.3, build 29.1.3-0ubuntu3~24.04.2`. `nvidia-smi`, `nvidia-ctk` and `lspci`
are all absent (`command not found`); `/dev/nvidia*` does not exist. There is
no GPU on this box, measured, not assumed — which bounds what §3 can prove
here versus cite.

## 1. The seam the OS already has

### The ten verbs

`worker/sidecar/contract.mjs` is "THIS SIDE'S DECLARATION OF THE PINNED WIRE"
(line 2), checked by two tests so a drift is red before it is a production
incident (lines 9–19). Its `SIDECAR_WIRE` map (lines 54–95) is the entire
surface:

| Route | Request | Response | Line |
|---|---|---|---|
| `GET /health` | — | `ok, chromeConnected, cdpUrl` | 55–58 |
| `POST /navigate` | `url` | `ok, url, title` | 59–62 |
| `POST /snapshot` | — | `ok, snapshot, url, title` | 63–66 |
| `POST /click` | `ref` | `ok, url` | 67–70 |
| `POST /type` | `ref, text, submit?` | `ok, url, redacted` | 71–74 |
| `POST /get_text` | `ref?` | `ok, markdown, url` | 75–78 |
| `POST /screenshot` | `ref?, fullPage?` | `ok, pngBase64, sha256, byteSize, width, height` | 79–82 |
| `POST /console` | `level?` | `ok, entries` | 83–86 |
| `POST /network` | `filter?` | `ok, requests` | 87–90 |
| `POST /wait_for` | `text?, time?` | `ok, matched` | 91–94 |

`FORBIDDEN_VERBS` (line 36) names what must never appear as a route:
`evaluate`, `raw`, `send`, `cdp`, `exec`, `eval`. `verbs.mjs` asserts at load
time that its handler set and this route list are the same set (contract.mjs
lines 17–19), so a server whose routes drift from its own declaration refuses
to start.

### What the verbs cannot do

Three things bound this surface beyond the closed list:

**No raw CDP.** `worker/sidecar/verbs.mjs` states the reason directly: "CDP is
unauthenticated and total: whoever can send it arbitrary commands reads every
page, exfiltrates the profile's cookies, and runs arbitrary JS in any origin
the browser has ever been logged into… A passthrough verb does not extend the
sidecar — it deletes its reason to exist" (`worker/sidecar/verbs.mjs:1–11`).
`SECURITY.md` makes it a property, not a preference: "The browser sidecar has
a closed verb allowlist and no CDP passthrough… A way to execute an unlisted
verb is a finding" (`SECURITY.md:74–76`).

**Ref validity is scoped to a snapshot generation, not just existence.**
`worker/sidecar/browser.mjs`'s `registerRefs` bumps a `refGeneration` counter
every `/snapshot` call (lines 185–204); `resolveRef` (lines 216–242) draws
three distinct outcomes from one lookup:
```
never issued          -> bad_ref   ("you guessed")
issued, older snapshot-> stale_ref ("re-snapshot")
issued, current, gone -> stale_ref ("the page moved under you")
```
"Collapsing the last two into the first is what makes a recoverable state look
like a mistake, which is why the contract names them separately"
(`browser.mjs:212–214`). A ref from snapshot N is unconditionally invalid once
snapshot N+1 exists, even if the DOM element it pointed at is still on the
page.

**Redaction is one choke point, not per-handler.** `worker/sidecar/server.mjs`
states: "`respond()` below is the ONLY place a payload becomes bytes on a
socket, and `redactDeep` runs there, on success responses and error responses
alike. The verb handlers deliberately do NOT redact" (`server.mjs:26–29`);
the call site is `server.mjs:70–72`. `redact.mjs` adds the one thing text
redaction cannot reach: "The one thing this cannot do is a PNG: a password is
not text in an image. That is a genuinely different mechanism (Playwright's
`mask`)… a capture of a 4-character password and a 20-character one must be
BYTE IDENTICAL" (`redact.mjs:21–26`). `MIN_SECRET_LENGTH = 3` (`redact.mjs:42`)
is a stated trade-off, not an oversight: "redacting `a` rewrites half the
English language."

### How an agent reaches it today

**Hosted.** `worker/src/browser-sidecar.ts` is "the exposure": "an HMAC-gated
Worker route, one verb per request, drawn from a fixed allowlist, forwarded
over `containerFetch`" (lines 28–29). It duplicates the allowlist
independently of the sidecar's own ("Two locks because the property being
protected… is the one that cannot be recovered after it is lost", lines
33–38) as `BROWSER_SIDECAR_VERBS` (lines 54–65) and validates by exact string
match with no path composition (`resolveSidecarVerb`, lines 106–132) — "that
is what stops `../` or `json/new`… from arriving at 9223 dressed as a verb"
(lines 103–104). The Worker's own HMAC token is stripped before the body
reaches the container (`sidecarRequestBody`, lines 143–150). Port 9223 is
explicitly **not** `exposePort()`'d and **not** carried by `preview-bridge.ts`
— "That is a decision, not an omission" (`browser-sidecar.ts:9`) — because
both of those mechanisms mint or forward with far weaker authentication than
this surface needs.

**Local.** `local/src/host/sandbox-host.ts`'s `SandboxHost` interface has the
two primitives a local caller would use: `fetchIn(id, port, request)` —
"Replaces `sandbox.containerFetch(request, port)` — the path the Worker uses
for surfaces that must NEVER get a public hostname, above all the browser
sidecar on 9223" (lines 292–294) — and `exec(id, argv, options)` for
everything else, with `argv` as an array "never joined into a shell string"
(line 313). `fetchIn` cannot carry a WebSocket (line 296, citing
`docs/PLATFORM-NOTES.md` §19) — irrelevant to the sidecar, which is plain
HTTP, but a real constraint on anything trying to widen this seam later. A
local agent reaches the sidecar by calling `sandboxHost.fetchIn(id, 9223,
request)` directly — no HMAC envelope needed locally, since there is no public
network hop to gate.

### What a local MCP over the sidecar would expose

`mcp/src/server.ts` is the OS's existing MCP connector today, and it is
explicit about the gap: "This connector does not drive the browser inside the
desktop; it only manages computers" (line 40) — `list_computers`,
`open_desktop`, `desktop_status`, and friends, nothing that reaches 9223. A
local MCP surface over the sidecar would be a second, narrower server (or an
additional tool group on this one) with one tool per verb, same names, same
required/optional split as `contract.mjs`, and nothing else — no `raw_cdp`
tool, ever, per the same allowlist reasoning as §"What the verbs cannot do."

| MCP tool | Wraps | Args | Returns |
|---|---|---|---|
| `browser_health` | `GET /health` | — | `chromeConnected`, `cdpUrl` |
| `browser_navigate` | `POST /navigate` | `url` | `url`, `title` |
| `browser_snapshot` | `POST /snapshot` | — | `snapshot` (mints refs), `url`, `title` |
| `browser_click` | `POST /click` | `ref` | `url` |
| `browser_type` | `POST /type` | `ref`, `text`, `submit?` | `url`, `redacted` |
| `browser_get_text` | `POST /get_text` | `ref?` | `markdown`, `url` |
| `browser_screenshot` | `POST /screenshot` | `ref?`, `fullPage?` | `pngBase64`, `sha256`, dims |
| `browser_console` | `POST /console` | `level?` | `entries` |
| `browser_network` | `POST /network` | `filter?` | `requests` |
| `browser_wait_for` | `POST /wait_for` | `text?`, `time?` | `matched` |

The tool descriptions would need to teach the ref-generation rule directly
(§ above) — an MCP client that snapshots once and clicks stale refs across
turns is exactly the failure mode `stale_ref` exists to name honestly instead
of surfacing as a mystery 4xx.

## 2. Open-source computer-use drivers (2026), measured

Two repos were cloned (`git clone --depth 1`) into the scratch dir and read at
the file:line level: **trycua/cua** and **simular-ai/Agent-S**. The other four
are covered by fetched pages, quoted.

### CUA — trycua/cua

Repo: <https://github.com/trycua/cua>. Cloned at `git clone --depth 1
https://github.com/trycua/cua.git` (4,446 files). License, read directly from
the clone: `LICENSE.md` opens `MIT License`.

Input injection, three separate platform drivers in one Rust crate tree
(`libs/cua-driver/rust/crates/`):

- **Browser (CDP), trusted route.** `cua-driver-core/src/browser/pointer.rs:685`:
  `let call = |params: Value| conn.call(Some(cdp_session), "Input.dispatchMouseEvent", params);`
  — the same CDP method EZiL-OS's own sidecar deliberately never exposes.
  Keyboard: `cdp_client.rs:286`: `session.call("Input.dispatchKeyEvent", params).await?;`
- **Linux (X11), two distinct mechanisms in the same file.** Background clicks
  to a specific window use raw `XSendEvent`
  (`platform-linux/src/input/mod.rs:1041`, a `x11::xlib::XSendEvent(...)` call
  under a `SubstructureRedirectMask` — the file's own header says "Background
  input injection for Linux via X11 XSendEvent" (line 1), and "XSendEvent
  sends synthetic events directly to a window without changing input focus"
  (lines 3–4). Text typing instead
  uses the XTest extension's real core events via `x11rb`:
  `platform-linux/src/input/mod.rs:2191–2196`, e.g.
  `conn.xtest_fake_input(KEY_PRESS_EVENT, keycode, 0, x11rb::NONE, 0, 0, 0)?;`
  — the comment at lines 2162–2164 explains why: "Unlike [`send_type_text`]
  (synthetic XSendEvent, which GTK/Qt silently drop for key input), XTest
  injects *real* input events, so they actually reach the focused widget."
- **macOS.** `platform-macos/src/input/mouse.rs:1–2`: "Background mouse event
  synthesis via `SLEventPostToPid` (SkyLight SPI), with fallback to the public
  `CGEvent::post_to_pid` for older OS releases." Both fire on every click,
  belt-and-suspenders: `mouse.rs:1075` (`skylight::post_to_pid`) immediately
  followed by `mouse.rs:1079` (`event.post_to_pid`).

**Drives a desktop inside a container/VM it does not own.** Two independent
paths confirmed. First, `libs/lume/src/VNC/VNCService.swift` (Apple's
`Virtualization` framework host for macOS VMs) declares a VNC-input protocol
directly: `func sendMouseClick(at point: CGPoint, button: VNCMouseButton)
async throws` and `func sendKeyPress(_ keyCode: UInt16, modifiers:
VNCKeyModifiers) async throws` (lines 18–19) — cua drives its own VM's screen
over VNC, not the host display. Second, per the fetched README: "supports any
VM or container image — cloud or local" and lists "Linux containers, Linux
VMs, macOS, Windows, and Android" as sandbox targets — WebFetch of
<https://github.com/trycua/cua>, quoting: *"The Sandbox API supports any VM
or container image — cloud or local."*

OSes: macOS, Windows, Linux (X11 and Wayland — confirmed in code, both the
X11 path above and a `wayland/mod.rs` module exist), Android. Model
requirements: **NOT MEASURED** — the README documents the driver and sandbox
API, not a required model; cua is model-agnostic by construction (it is a
driver, an agent loop is a separate concern in the same monorepo under
`libs/python`, not inspected here).

### Agent-S — simular-ai/Agent-S

Repo: <https://github.com/simular-ai/Agent-S>. Cloned at `git clone --depth 1
https://github.com/simular-ai/Agent-S.git`. License, read directly:
`LICENSE` opens `Apache License / Version 2.0, January 2004`. `README.md`,
read directly, carries OS badges for Windows, macOS and Linux (lines 31–33).

Input mechanism: the "Agent-Computer Interface" does not call a mouse/keyboard
library in-process. It has the model **generate Python source as a string**
containing `pyautogui` calls, e.g.
`gui_agents/s3/agents/grounding.py:368`:
```python
command += f"pyautogui.click({x}, {y}, clicks={num_clicks}, button={repr(button_type)}); "
```
(more of the same pattern at lines 381, 385, 398, 400, 403–406, 428, 442,
446–447, 456, 462, 489 — hotkeys, `typewrite`, `write`, clipboard paste, all
built the same way). The generated string is then handed to Python's own
`exec()`: `gui_agents/s3/cli_app.py:215`: `exec(code[0])` — no sandbox, no
subprocess boundary, no allowlist visible at that call site. This is the
sharpest measured contrast with both EZiL-OS's sidecar and with cua's compiled
Rust drivers: an LLM's output becomes running Python in the calling process
directly.

Model requirements, quoted from the fetched README: *"For the best
configuration, we recommend using OpenAI gpt-5-2025-08-07 as the main model,
paired with UI-TARS-1.5-7B for grounding"*, with the grounding model servable
via "Azure OpenAI, Anthropic, Gemini, Open Router, and vLLM inference" —
i.e. the planning model is API-only in the recommended config, the grounding
model can be local (vLLM/HF endpoint) or API.

### UI-TARS / UI-TARS-desktop — bytedance

Repos: <https://github.com/bytedance/UI-TARS> (model), model card
<https://huggingface.co/ByteDance-Seed/UI-TARS-1.5-7B>, driver stack
<https://github.com/bytedance/UI-TARS-desktop>. Not cloned (budget spent on
the two above); read via WebFetch of GitHub pages directly.

License, quoted from the fetched repo page: *"This project is licensed under
the Apache License 2.0."*

Driving mechanism, confirmed at two levels. The operator package tree
(`packages/ui-tars/operators/`, fetched directly) lists four folders: `adb`
(Android over ADB), `browser-operator`, `browserbase`, and `nut-js`. The local
one is quoted directly from `docs/sdk.md`: *"Using `nut-js`(cross-platform
computer control tool) as the operator"*, with the import
`import { NutJSOperator } from '@ui-tars/operator-nut-js';` and capability
list *"Mouse actions: click, double click, right click, drag, hover; Keyboard
input: typing, hotkeys; Scrolling; Screenshot capture."* `nut-js` drives the
process's own host display — it has no notion of a remote container. Whether
`browserbase`/`browser-operator` reach a desktop inside a container the
driver does not own (CDP into a remote Chrome, the same shape as cua's browser
path) is **NOT MEASURED** — the folder names and the fetched doc name them but
this session did not open their source.

OSes, quoted from the fetched repo page: *"Cross-platform support
(Windows/MacOS/Browser)"* — Linux desktop is not claimed in that sentence.

Model requirements: local (UI-TARS/Seed-1.5-VL series, served locally — see
§4) or API (Volcengine, Anthropic, per the fetched "Agent TARS" section).

### OS-Copilot — OS-Copilot/OS-Copilot

Repo: <https://github.com/OS-Copilot/OS-Copilot>. Not cloned; read via
WebFetch. License, quoted: the repo page's footer links *"[MIT
license](#MIT-1-ov-file)"*.

This is the one entry whose GUI-driving claim did not survive a direct check.
The README's architecture description (fetched) says the framework's
"universal interface consolidates common practices for OS manipulation,
including Python code interpreter, bash terminal, mouse/keyboard control, and
API calls" — but fetching the actual tool tree,
<https://github.com/OS-Copilot/OS-Copilot/tree/main/oscopilot/tool_repository/basic_tools>,
shows exactly two files: `__init__.py` and `text_extractor.py`. No
`mouse.py`, `keyboard.py`, or `screen.py` is present at that path. **NOT
MEASURED**: which library (if any) implements the README's "mouse/keyboard
control" claim, or whether it lives outside `basic_tools` — this session did
not find it within the two-fetch budget spent looking. What *is* measured is
that OS-Copilot leans on a bash/Python-code-interpreter executor rather than a
dedicated screenshot-grounded clicker (`oscopilot/tool_repository/api_tools`
and `generated_tools` were listed but not opened), which is a materially
different shape from CUA, Agent-S and UI-TARS. Model: requires an API key —
quoted, *"Configure your OpenAI API key in .env"* — no local-model path was
found in what was fetched.

### Anthropic's computer-use reference — anthropics/claude-quickstarts

Repo: <https://github.com/anthropics/claude-quickstarts>, subdirectory
`computer-use-demo`. License, fetched directly from the repo's `LICENSE`
file: first line *"MIT License"*.

This is the one entry that is explicitly, by design, "driving a desktop inside
a container it does not own" as its whole point rather than an incidental
capability. Quoted from the fetched `computer-use-demo/README.md`: *"This demo
is a deliberately minimal, containerized reference: it shows the essential
agent loop running against a Linux desktop in Docker with X11 + VNC."* The
`docker run` line it publishes exposes VNC (`5900`), a web VNC view (`6080`),
a Streamlit control UI (`8501`) and a fourth port (`8080`) — i.e. the
reference implementation's own driver reaches the desktop over VNC into a
container it starts itself but does not otherwise own, structurally the same
relationship EZiL-OS's neko container has to whatever eventually drives it.
Model: Claude via the Anthropic API, Bedrock, or Vertex — API-only, no local
model path.

### OpenOwl

This entry is itself a measurement worth recording plainly: the repository
the roadmap names by product name has gone offline mid-round. A direct
`WebFetch` of `https://github.com/mihir-kanzariya/openowl` (the URL a search
engine returned as canonical) returned **HTTP 404**, fetched in this session.
`gh search repos openowl --limit 10`, run in this session, and a follow-up
`curl -s "https://api.github.com/search/repositories?q=openowl+in:name"`
(HTTP `200`, `"total_count": 26`) both surface `BlizzHacker/openowl`, whose
own description states why it exists: *"Fork of OpenOwl by Mihir Kanzariya — MCP server giving any AI
assistant eyes and hands on your desktop. Apache-2.0, no account, no
telemetry. Preserved here after the original repo went offline."* Its README,
fetched directly, confirms: *"Apache License 2.0 — see `LICENSE` and
`NOTICE`, which credits the original author,"* and states the origin
explicitly: *"OpenOwl was created by Mihir Kanzariya and released under
Apache-2.0. The original source repository is no longer public, so this fork
preserves the open-source code and is maintained here."*

Driving mechanism, quoted from that fork's README: macOS via *"Accessibility
+ Screen Recording + Vision OCR APIs via PyObjC,"* Windows via *"pywinauto +
Win32 + RapidOCR."* Linux is explicitly *"not supported."* No container or
remote-desktop capability is mentioned anywhere in the fetched README — this
is a local-host-only driver, by design (it targets the operator's own
laptop, not a desktop it launched). This is exactly the ROADMAP item's own
caution in practice: **"no capability claimed from a vendor's marketing
page"** — the vendor's own marketing page (`openowl.dev`, fetched) makes
several claims (macOS Cocoa, "zero telemetry") that could not be checked
against source because the source that page points at was gone; the actual
license and mechanism claims above come from the preserved fork, not the
vendor page.

### Summary table

| Project | Licence | Input mechanism | OSes | Drives a desktop it doesn't own | Model |
|---|---|---|---|---|---|
| CUA (trycua/cua) | MIT | CDP / XSendEvent+XTest / SLEventPostToPid+CGEvent | macOS, Windows, Linux (X11+Wayland), Android | Yes — VNC into its own Apple VMs; sandbox API names containers | model-agnostic (driver only) |
| Agent-S | Apache-2.0 | LLM-generated Python string → `exec()` → `pyautogui` | Windows, macOS, Linux | Not by design (drives the exec()'ing host) | GPT-5 + UI-TARS-1.5-7B (API or self-hosted) |
| UI-TARS-desktop | Apache-2.0 | `nut-js` (local); `browserbase`/`browser-operator` (unmeasured) | Windows, macOS, Browser | nut-js: no; browserbase: NOT MEASURED | UI-TARS/Seed-1.5-VL (local) or Volcengine/Anthropic (API) |
| OS-Copilot | MIT | bash/code-interpreter-first; dedicated GUI driver NOT MEASURED (not found in basic_tools) | NOT MEASURED | NOT MEASURED | OpenAI API key required |
| Anthropic computer-use-demo | MIT | X11 + VNC, inside a Docker container it starts | Linux (reference desktop) | Yes, by design | Claude via API/Bedrock/Vertex |
| OpenOwl (preserved fork) | Apache-2.0 | macOS Accessibility+OCR via PyObjC; Windows pywinauto+Win32+OCR | macOS, Windows (Linux "not supported") | No (local host only) | NOT MEASURED (vendor page unreachable at source level) |

## 3. GPU/CUDA passthrough into the desktop container, per OS

### Linux — NVIDIA Container Toolkit

Docs fetched directly. `docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/sample-workload.html`
gives the verification command verbatim: *"sudo docker run --rm
--runtime=nvidia --gpus all ubuntu nvidia-smi."* Configuration is a host-side
step, quoted from
`docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html#configuring-docker`:
*"The `nvidia-ctk` command modifies the `/etc/docker/daemon.json` file on the
host. The file is updated so that Docker can use the NVIDIA Container
Runtime,"* via `sudo nvidia-ctk runtime configure --runtime=docker`.

On this machine: **neither `nvidia-smi` nor `nvidia-ctk` is present**
(`which nvidia-smi` / `which nvidia-ctk` both fail, measured), and `/dev/nvidia*`
does not exist. This box cannot run any part of the Linux GPU path measured
here — the citations above stand in for a boot this machine cannot attempt.

### Windows — Docker Desktop / WSL2

Fetched directly, `docs.docker.com/desktop/features/gpu/`: *"GPU support in
Docker Desktop is only available on Windows with the WSL2 backend."* That one
sentence is also the answer for macOS by omission — the same page describes
no macOS path at all.

### macOS — no CUDA, Metal unreachable from a Linux container

Fetched directly (a secondary source, not vendor docs — no first-party Apple
or Docker page states this as plainly): *"Apple hasn't provided an open GPU
API for their mandatory Virtualization engine"* — Docker Desktop on macOS
(Apple Silicon or Intel) runs its Linux containers inside Apple's
`Virtualization.framework`, which does not expose a GPU device to the guest,
so there is no CUDA (NVIDIA-only, irrelevant on Apple Silicon regardless) and
no path for a Linux container to reach Metal either. `docs.docker.com/desktop/features/gpu/`
corroborates by naming only Windows/WSL2 as supported.

### What `run-spec.ts` and `start-neko.sh` would need

`local/src/container/run-spec.ts`'s `buildDockerRunArgv` (lines 512–536)
builds the argv as `['run', '--detach', '--name', ...]` then pushes
`--cpus=`, `--memory=`, then the `--publish` port loop, then `--volume`, then
`--env` pairs, then the entrypoint. A `--gpus all` (or a digest-pinned
`--gpus device=...`) flag would insert as one more `argv.push(...)` after the
`--memory=` line (517) and before the port loop — no restructuring, it is a
flat argv array. The file already states its own proof method for exactly
this kind of change: *"`docker create` parses every flag and builds the
container without starting it… this exact argv was accepted"* (lines 501–510)
— a `--gpus` flag would need the same `docker create`-then-inspect proof
before anyone hands it to a real boot, and that proof is unavailable on this
machine (no GPU to request).

`worker/scripts/start-neko.sh` launches Chrome with `--disable-gpu` explicitly
(`start-neko.sh:2272`, inside the `supervise_app chromium` flag list starting
at line 2268) with the reason stated nearby: *"software rendering only — no GPU
in Cloudflare Containers, both ran --disable-gpu"* (lines 171–172).
`docs/PLATFORM-NOTES.md` §7 states the same fact at the platform level:
*"Everything is software-rendered and software-encoded. On a small instance, a
desktop streamer competes with the compiler for the same cores"*
(`PLATFORM-NOTES.md:97–98`). Neko's own encoder falls through to a hardcoded
software path when unconfigured — the script's own comment traces it to source:
*"because no `capture.video.pipeline(s)` is configured — [it resolves] to the
HARDCODED fallback in server/internal/config/capture.go's `Capture.Set()`:
software vp8enc"* (`start-neko.sh:2854–2856`).

**Measured, not assumed**: the pinned overlay image
(`ghcr.io/ezilhq/ezil-neko-vscode:d74052bb-049931d7-ezil-brand8`) is private.
`docker run --rm --entrypoint neko ghcr.io/ezilhq/ezil-neko-vscode:d74052bb-049931d7-ezil-brand8
serve --help` was run in this session and returned `unauthorized` (GHCR
denies an anonymous pull) — this matches T3's own finding in
`docs/ORCHESTRATION-LOG.md` at 2026-09-04 14:50Z: *"the new packages are
private (GHCR default) and this session's token has no packages scope."* As a
substitute, the same command was run against the exact **public, floating**
base image `docker/neko/pins.env` itself points at
(`NEKO_BASE_IMAGE=ghcr.io/m1k1o/neko/base:latest`) — floating, not
digest-pinned, a gap `pins.env` itself flags for row T7. `docker run --rm
--entrypoint neko ghcr.io/m1k1o/neko/base:latest serve --help` succeeded
(digest at pull time: `sha256:20806497c78de64700cb7befa674dbdc6bc4e8f0848a3dc911f0878a6726fa36`)
and the flag exists:
```
--hwenc string   V2: use hardware accelerated encoding
```
No `vaapi`/`nvenc`/named-backend value is enumerated anywhere in the full
`--help` output (`grep -i -E 'hwenc|nvenc|vaapi|codec'` against the captured
output shows only `--hwenc`, `--video_codec`, `--capture.video.codec` and the
deprecated `--vp8`/`--vp9`/`--h264`/`--av1` boolean flags — no accepted-value
list for `--hwenc`). **NOT MEASURED**: which encoder backends `--hwenc`
actually accepts — that would need reading neko's Go source
(`server/internal/capture` or similar), not attempted here, and this floating
base is not proven identical to the exact commit `pins.env` pins
(`NEKO_SHA=d74052bb844c...`) since `:latest` moves.

## 4. Local inference

A computer-use model needs to be served somewhere the driver can reach over
HTTP; three of the six projects above (Agent-S, UI-TARS-desktop, and
implicitly any OpenAI-compatible-client driver) name the same shape:
vLLM/SGLang/Ollama exposing an OpenAI-compatible `/v1/chat/completions`.

Fetched directly from the model card, <https://huggingface.co/ByteDance-Seed/UI-TARS-1.5-7B>:
the vLLM invocation is `vllm serve "ByteDance-Seed/UI-TARS-1.5-7B"`, the
SGLang one is `python3 -m sglang.launch_server --model-path
"ByteDance-Seed/UI-TARS-1.5-7B"`, and both are shown driven via
`http://localhost:8000/v1/chat/completions` / `http://localhost:30000/v1/chat/completions`
respectively — i.e. genuinely OpenAI-compatible, not a bespoke wire. The card
also lists the checkpoint's own metadata as `8B parameters` / `F32` tensor
type, alongside the `-1.5-7B` name — a real discrepancy this session did not
resolve (a safetensors index can report a different number than the name
implies, and `F32` on the card need not mean inference runs in FP32); flagged
rather than silently reconciled.

VRAM: **NOT MEASURED** from an authoritative first-party source (ByteDance's
own model card, fetched, states no GPU/VRAM number). A community setup guide,
fetched directly (`aicybr.com/blog/ui-tars-desktop-complete-setup-guide`),
gives concrete numbers: *"GPU VRAM: 16 GB (FP16)"* as the minimum, 24 GB
recommended, with quantized variants at *"Q8_0: ~8 GB"* and *"Q4_K_S: ~4.5
GB."* This is arithmetically consistent with the model's own scale: 7×10⁹
parameters × 2 bytes/parameter (FP16) ≈ 13.0 GiB for weights alone (computed
here, not quoted), leaving headroom for KV cache and activations to land
around the quoted 16 GB figure — a sanity check, not independent
confirmation. Serving, same source: Ollama on `http://localhost:11434/v1`,
and directly quoted: *"Any OpenAI-compatible API can be used (Ollama, vLLM,
LocalAI, etc.)"*

**How this plugs into the OS's shape without the OS depending on a model.**
The sidecar's verb set (§1) and a local MCP wrapper around it are already
model-agnostic — they take a `ref` or a `url` or `text`, never a model call.
A driver sits entirely outside that seam: it snapshots (gets refs + an
accessibility tree), sends the tree/screenshot to whatever OpenAI-compatible
endpoint is configured (a local vLLM/Ollama server, or a remote API — the
sidecar cannot tell the difference and does not need to), gets back a ref or
coordinates, and issues exactly one `/click` or `/type` per step. This is the
same separation CUA's own README states for its Sandbox API (a
driver/transport layer with the model chosen separately) and is the one
shape consistent with §"What the verbs cannot do": the model never gets a
wider surface than the ten verbs, no matter which one is plugged in.

## 5. Recommendation

Three numbered options for the ROADMAP's "Local agents" item, each with what
would prove it, framed against the ROADMAP text's own bar: *"a build item
only follows from [the survey], and its own proof would be an agent
completing a task on a local desktop with the sidecar's verb list
unchanged."*

**1. A local MCP server (or tool group) wrapping the ten sidecar verbs
(§1's table), plus a thin driver loop that calls an OpenAI-compatible
endpoint for the next action.** No new capability in the sidecar or the
Worker; pure plumbing plus one new small process. **What would prove it:** a
driver completes one concrete task (e.g., navigate to a URL, read back a
heading via `get_text`) using only the ten verbs, with `git diff` on
`worker/sidecar/contract.mjs` empty at the end — i.e. the exact bar the
ROADMAP text names, verifiable by re-running `worker/sidecar/wire.test.mjs`
and the contract test unmodified.

**2. GPU passthrough for local-mode's `docker run`, Linux + NVIDIA only** (the
only OS with a real, cited path — §3). Add a `--gpus` flag at
`run-spec.ts:517` and remove `--disable-gpu` from the Chrome launch in
`start-neko.sh:2272` behind a feature check (never unconditionally, since
Cloudflare Containers genuinely have no GPU per `PLATFORM-NOTES.md` §7 and
this must stay software-only there). **What would prove it:** `docker create`
with the new flag accepted (mirroring the existing proof at
`run-spec.ts:501–510`), then on a machine that actually has an NVIDIA GPU
(not this one — measured absent), `docker exec <container> nvidia-smi`
succeeding inside the desktop container, and a measured CPU-usage drop on the
vp8/hardware encoder path versus the software baseline. This option is
**gated on an unresolved question from §3**: `--hwenc`'s accepted values were
not found in the fetched `--help` output, so what neko would actually be told
to use is not yet known.

**3. Adopt one of §2's drivers wholesale, pointed at the container's raw
X11/VNC/CDP surface instead of the sidecar.** Explicitly the option **not**
to take first. This is the ROADMAP text's own warning made concrete by the
survey: Agent-S's `exec()` of LLM-generated `pyautogui` code
(`cli_app.py:215`) and cua's native XTest/`Input.dispatchMouseEvent` paths
both assume unmediated access to the display or the browser's CDP port — the
same port `worker/sidecar/README.md` and `SECURITY.md:74–76` name as a
finding if reachable outside the fixed verb set. Using either driver as-is
against this OS's desktop would mean opening exactly the passthrough §1
documents as deliberately absent. **What would prove it (if ever pursued
anyway):** a written exception to `SECURITY.md:74–76`, not a measurement —
which is itself the reason it is not the recommendation.

**Recommended first: Option 1.** It is the only one of the three that needs
zero changes to a security-relevant file, is buildable regardless of which OS
or GPU the developer's machine has (this machine included, GPU absent and
all), and is verifiable against the ROADMAP text's own stated proof rather
than a new one invented for this document. Option 2 is real and worth doing
next, but §3 leaves one open question (`--hwenc`'s value set) that should be
closed by reading neko's Go source before committing a flag that might do
nothing. Option 3 is recorded only so the choice not to take it is visible
next to the two that were.
