# Unified connect MCP trust proposal — source only

Public connector endpoint: `https://connect.ezil.work/mcp`. The connect runtime
writer (01a1c95f) owns that endpoint and the ChatGPT ZIP package; this repository
owns the OS app and computer Worker adapters. This change does not add another
public MCP endpoint or alter the retained root dispatch.

Proposed OS environment contract, for coordinator review:

| Setting | Proposed value / source |
| --- | --- |
| `EZIL_DELEGATION_ISSUER` | `https://connect.ezil.work` (bare origin, no `/mcp` or trailing slash) |
| `EZIL_DELEGATION_AUDIENCE` | Exact bare origin of the target OS app, identical to the runtime's signed audience |
| `EZIL_DELEGATION_PUBLIC_JWKS` | Reviewed public ES256 key set published by the connect runtime at `https://connect.ezil.work/.well-known/ezil-delegation-jwks.json`; pinned JSON, never private keys |
| `EZIL_DELEGATION_CLIENT_IDS` | Exact OAuth client identifiers emitted by the approved ChatGPT package flow; do not substitute redirect URIs |
| `EZIL_EDITOR_BRIDGE` | `enabled` only after migrations and Worker forwarding are applied |
| `EZIL_EDITOR_BRIDGE_CONTROLS` | `enabled` only after 0025 and the compatible editor bridge are present |

All values remain unset in source defaults. OS never downloads keys from an
assertion, and never trusts its `jku` or an arbitrary identity issuer. Key rotation
requires reviewed overlapping public keys and a coordinated runtime change.
The identity issuers stay the configured Supabase issuer and `https://id.ezil.work/`;
changing the presenter to connect does not change account linking. Subjects must
map to existing verified accounts; email matching and account creation are absent.

Every assertion is bound to one allowlisted procedure, its HTTP method, exact
input bytes, scope, audience and OAuth client. Maximum lifetime is 60 seconds;
Postgres consumes each jti once. Invalid assertions cannot fall back to cookies.
The editor sync uses a separate per-boot capability and a signed Worker-to-OS
forward, with owner/epoch fencing. Session/model operations require delivery and
editor readback; an unconfirmed operation must remain uncertain.

Release ownership remains unchanged: sole staging apply 40003c71, root dispatch
retained. Coordinator reviews target catalog observations, trust values and any
conditional desktop slice before deployment. Registry is 27/27 with no GC:
no registry mutation, image bake or source-capacity change is part of this work.
No secrets, live configuration or target catalog digests are included here.
