# Protocol 3 source proposal: session-local effort

Not deployed, not applied, no flags or trust enabled. No new apply acknowledgment exists. Sole staging execution custody remains 40003c71; root must review and authorize staging separately.

Base: signed U8 4c28fff2b2c0e8404f2b3f35c2d38a89a950cb2e. Reviewed desktop changes were cherry-picked with `-x`; A's dade7bd9 billing-origin fix is included. Provider.ts and Worker trusted-origin callsites remain untouched by this slice. Shared helper contract: U8-MCP-EFFORT-SHARED-CONTRACT.md; helper commit e498b1ac438beeab04c0a733ecf971c69173757d.

## Negotiation across all three participants

A new extension begins with the unchanged strict protocol-1 body: no model, effort, catalog or capability request fields. A controls-enabled backend replies protocol 2 to protocol-1/2 requests. Only when the separate effort gate is enabled does it also advertise `supportedProtocols: [1,2,3]`. New extensions choose the minimum of workbench support and advertised server support. Old extensions ignore the added response field and stay at 2. Protocol-3 requests receive protocol 3 only with both gates enabled. Without the effort gate, replies revert to 2 and new fields are not persisted; subsequent extension bodies strip session/report effort and advertise empty effort choices. Protocol-1/2 request schemas still reject effort fields.

| Worker | Backend | New client outcome |
| --- | --- | --- |
| U8 bridge transport | old protocol-1 backend | initial body accepted, remains 1; no controls/effort |
| U8 bridge transport | protocol-2 backend, no advertisement | remains 2; model controls work, effort refuses |
| U8 bridge transport | protocol-3 backend with effort off | remains 2 |
| U8 bridge transport | protocol-3 backend with both gates on | upgrades from initial 1 to 3 when workbench also supports 3 |
| deployed source daae2ae86c2d389b881f769fec3588c3d8e00b72 | any | lacks bridge module/routing in inspected source; unsupported, compatible Worker required |

U8 and this candidate's `worker/src/editor-bridge.ts` are byte-identical blob 88afa70d3e1815f243191bec82798b69262604d0. It does not interpret JSON: it authenticates boot-scoped tokens, signs unchanged bounded request bytes, and returns unchanged bounded response bytes. `editor-effort-transport.test.ts` exercises protocol-3 forwarding and capability preservation using that real transport implementation. This is source evidence, not a claim about arbitrary older Worker builds or a live deployment. Old deployed Worker has not been contacted.

## Contract and persistence

Protocol 3 adds session `effort: string|null`, catalog `efforts: string[]` and `defaultEffort: string|null`, control delivery `effort?: string`, and report `effort?: string|null` / `selectedEffort?: string|null`. Capability choices are the intersection of the native picker and fresh account/route Gateway evidence. Missing or stale evidence means unavailable. No model-name variants, global effort enum, guessed default, hidden command executor, mode change or approval bypass.

The workbench uses `restoreModelConfiguration(modelId, {...current, reasoningEffort}, false)` and `flushInputStateToModel()`. It reads the native configuration, current input snapshot, and bound `_inputModel.state.get()` back; session binding must match. Missing persistence APIs fail capability detection. Native bundle inspection confirms flush invokes `_syncInputStateToModel`, which calls `_inputModel.setState`, and that modelConfiguration belongs to input state. Stub tests prove adapter independence and fences, NOT native close/reopen/reload durability. Actual native persistence remains REQUIRED acceptance evidence before effort activation. A provider hooks and fresh Gateway field publication are also required; helper-to-wire tests do not substitute for actual provider-hook integration.

## Storage and fences

NEW additive 0026_session_effort proposes nullable `ezil_agent_sessions.effort`, `ezil_agent_sessions.effort_observed_at` and `ezil_agent_operations.selected_effort`; existing control requested/effective columns are reused. `model_at` timestamps jointly observed model/effort. Drizzle journal registers source only. Production migration engine/manifest, 0022–25 and the earlier guard remain byte-identical. No observed schema digest or migration approval is claimed. 0026 needs its own reviewed capture/guard before any staging DDL; old acknowledgment is void.

Writes require current owner, lease/epoch, attempt and sequence fences. Stable client/procedure/user/key idempotency is retained; changed selection under the same key conflicts. A control with mismatched observed selection becomes uncertain. New create uses a fresh native chat; existing resources cannot become successful creates. Uncertain delivered work is reconciled, never resent under a new key. Pending tool approval, blocked input, pending requests and active requests all prevent configure. Output remains bounded actual editor output; user code is not censored. Provider/system metadata is schema-filtered at the MCP boundary.

## Staged acceptance and rollback limits

1. Review source slices and A's provider-hook/Gateway changes together; confirm H32/model behavior and billing-origin fix remain intact. Rebuild/check VSIX from the final composed source. This candidate's retained VSIX predates these changes and is NOT a release artifact.
2. Obtain fresh schema capture, compatible Worker/app qualification and explicit approval through root/C. Apply only separately reviewed additive migration guards; no approval is implied by this document. Deploy compatible readers before enabling protocol 3. No publication before real staging acceptance.
3. With explicitly authorized synthetic staging fixtures, verify start allowance refusals, authenticated OS links, fresh NEW chats, actual account models, two different session efforts, provider request wire mapping, pending approvals, disconnect/reconnect, close/reopen and full editor reload. Read actual progress/output; no pricing/checkout or preview credentials in MCP.
4. Exercise old-client/new-backend and new-client/old-backend through the actual compatible Worker. Record exact app/Worker/desktop source/image versions. Existing fake backend replies alone are insufficient deployment evidence.
5. To roll back, stop new effort controls and drain/reconcile delivered operations first; disabling the effort gate downgrades new syncs to 2. Preserve nullable columns and immutable operation history. Do not assume older binaries can deliver or correctly report in-flight effort commands: any unresolved outcome stays uncertain. Do not roll back to a Worker without the bridge while active chat controls are expected to work.

Review corrections: see U8-WORKBENCH-NEGOTIATION-CORRECTION.md for legacy hello negotiation and U8-EFFORT-WITNESS-CORRECTION.md for the revised unapplied observation witness and required PostgreSQL regressions.
