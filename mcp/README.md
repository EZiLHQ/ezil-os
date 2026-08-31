# `@ezil-os/mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) connector for
EZiL-OS. It lets an MCP client — Claude Desktop, Claude Code, or anything else
that speaks MCP — manage a user's computers: list them, create one, open its
desktop or editor, restart it, delete it.

**This is a connector, not a component.** Nothing in `worker/`, `app/` or
`shell/` imports it. EZiL-OS runs exactly the same whether or not you ever
install it, and you can delete this directory without affecting the product.

## What it exposes

Ten tools, all computer lifecycle:

| Tool | |
| --- | --- |
| `list_computers` | read-only · start here, everything else needs an id |
| `get_computer` | read-only |
| `desktop_status` | read-only · cheap poll, boots nothing |
| `create_computer` | limit of two per user |
| `rename_computer` | |
| `open_desktop` | **cold boot, ~22s** · returns a short-lived URL |
| `open_editor` | code-server inside the container |
| `open_app_preview` | the dev server running inside the container |
| `restart_desktop` | destructive · re-runs boot in the *same* container |
| `delete_computer` | destructive · requires `confirm: true` |

### What it deliberately does not expose

**No browser automation.** There is no navigate, click, type or snapshot tool
here. That surface already exists — `ezil-works-browser` drives this project's
container sidecar over a pinned wire contract — and a second server publishing
the same verbs is how one contract quietly becomes two. This repository has
already paid for that lesson once; `docs/BROWSER-FIX-CONTRACT.md` is the
receipt.

## Configuration

| Variable | |
| --- | --- |
| `EZIL_API_URL` | **Required.** Your EZiL-OS deployment, e.g. `https://ezil-os.example`. Must be https unless it is loopback. |
| `EZIL_TOKEN` | **Required.** A Supabase access token for the user this server acts as. |
| `EZIL_TIMEOUT_MS` | Optional. Default `300000`. Must be ≥ 1000. |

🔴 **`EZIL_TOKEN` is a user's Supabase access token, and nothing else.** In
particular it is *not* the Worker's `SANDBOX_HMAC_SECRET` — that is a shared
server-to-server secret which authorises every signed Worker route including
`restart` and `DELETE`, for every user. Never put it here.

The server acts as exactly one user and can only ever see that user's
computers. Ownership is enforced server-side by scoped queries, not by this
connector.

Misconfiguration is caught before the transport connects: the server writes the
reason to stderr and exits `2`, rather than starting and failing every tool
call with something only the model can see.

## Install

```bash
cd mcp && bun install
```

Then register it with your client. For Claude Desktop
(`claude_desktop_config.json`) or Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "ezil-os": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/EZiL-OS/mcp/src/server.ts"],
      "env": {
        "EZIL_API_URL": "https://your-ezil-os-deployment.example",
        "EZIL_TOKEN": "<a Supabase access token>"
      }
    }
  }
}
```

Use an absolute path — the client does not run from this directory.

## Two behaviours worth knowing

**`open_desktop` is a cold boot.** Around 22 seconds when the container is not
already running, and sometimes much longer. If it times out, the boot may still
be in progress: the tool says so, and says to poll `desktop_status` rather than
open again, because opening again boots a second container.

**Every URL these tools return expires in about five minutes** and is
single-use. They are meant to be handed to a person immediately, not stored. A
stale one opens a blank window with no visible error — which is why each tool
that mints one says so in its own description, where the model will actually
read it.

## Development

```bash
bun run typecheck
bun run test
```

The tests are in two layers, deliberately. `tools.test.ts` calls the handlers
directly. `server.protocol.test.ts` drives *this* server with a real MCP client
over a real transport — initialize, `tools/list`, `tools/call` — stubbing
nothing but the network, because handlers that work and handlers that are
correctly *registered* are different claims.

## License

AGPL-3.0-only, like the rest of EZiL-OS. See [`../LICENSE`](../LICENSE).
