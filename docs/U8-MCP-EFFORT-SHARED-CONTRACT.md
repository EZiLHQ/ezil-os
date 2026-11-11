# U8 session effort integration contract (source only)

Bases: OS `4c28fff2b2c0e8404f2b3f35c2d38a89a950cb2e`, MCP
`99d16a4a0519fb20983f5463a1153e51b26ceba9`. Desktop 83b35996/525af7cd/85bc7a78
and A's dade7bd9 are composed with original authors; no new human sign-off.
This document is an implementation interface, not activation/apply approval.

## A-owned Gateway publication

Add optional `effort` to each account-scoped `/v1/models` row under the existing
`ezil.gateway.models.v1` contract. Example (only if that actual selected route
supports these exact values):

```json
{"effort":{"protocol":"openai-responses","values":["low","medium","high","xhigh"],"default":null}}
```

Type `GatewayEffortCapability`:

```ts
{ protocol: 'anthropic-messages' | 'openai-responses'; values: readonly string[]; default: string | null }
```

`protocol` must match the chosen first supported protocol used for execution.
`values` is a unique nonempty list (max 16) of exact route/model-supported tokens
(max 32 ASCII letters/digits/dot/underscore/hyphen); it is not the union of
providers' enums. `default` is null unless authoritative, and otherwise is in
`values`. Omit the field for Gemini/unmapped/unknown routes. Never advertise a
value merely because the gateway's top-level grammar accepts it. No prices,
provider secrets, checkout links or registry writes are part of this contract.
Catalog freshness and availability remain the existing token-bound contract.

## Owned OS helpers, exact provider hooks for A

New module `extensions/ezil-models/src/effort.ts` exports:

- `parseGatewayEffort(value: unknown, protocol: GatewayProtocol): GatewayEffortCapability | undefined`
- `effortConfigurationSchema(model: ResolvedModel): { properties: { reasoningEffort: { type: 'string'; enum: string[]; default?: string } } } | undefined`
- `withSessionEffort(model: ResolvedModel, configuration: unknown): ResolvedModel`

The parser rejects malformed/mismatched capability; no guessed defaults. Catalog
parsing/`withGatewayModelLimits` sets `ResolvedModel.gatewayEffort` only from the
current validated account catalog/selected protocol. `sessionEffort?: string` is
an ephemeral per-request field, never saved into shared model config.

A alone integrates these hooks in its `provider.ts`:

1. In `toInformation(model)`, attach `configurationSchema` from
   `effortConfigurationSchema(model)` when present. Preserve all existing
   locked-model, billing, availability and provider metadata logic.
2. Immediately after final fresh Gateway availability/limits resolution and
   before `chat(resolved, request, ...)`, set
   `resolved = withSessionEffort(resolved, options.modelConfiguration)`.
   Code 4.141 passes this native field separately from `modelOptions`.
   No explicit reasoningEffort means no request override. Invalid/unsupported
   explicit effort throws before dispatch; never ignore it or select another
   model. Preserve mode/tool approvals, utility routing and A's origin fix.

Our Gateway body builders map validated `sessionEffort` to Responses
`reasoning.effort` or native Messages `output_config.effort`, rechecking the
capability/protocol. They never add Gemini thinkingConfig or global settings.
A's provider hooks/tests must be integrated before a VSIX build/acceptance.
No concurrent edits to A's provider or Worker origin provisioning callsites.

## Desktop/backend contract

Protocol 3 adds per-session observed `effort: string|null`, catalog efforts and
validated `defaultEffort`, control delivery `effort?: string`, and report
`effort?: string|null`; protocol 1/2 remain strict and unchanged. Effort writes
require protocol 3. Model-only control remains supported on protocol 2.
Use `input.restoreModelConfiguration(modelId,{...current,reasoningEffort:value},false)`,
`flushInputStateToModel()`, and actual readback. Never call global setters.
Control success requires the target session's observed values and current owner
fence; readback is not the requested input echoed. No approval/mode changes.

New additive migration 0026 (identifier checked on U8) adds only nullable
`ezil_agent_sessions.effort text` and `ezil_agent_operations.selected_effort text`.
Existing requested/effective control effort columns are reused. Existing
`model_at` timestamps the jointly observed session model/effort. Do not edit
0022–0025 or the reviewed staging guard/acknowledgment.

Missing/stale capability advertises no selectable effort and explicit effort
requests refuse. The model itself can remain available without effort control.
Model/effort updates are session-local; existing native input-state persistence
must survive reopen/reload without altering other chats or preference buckets.
