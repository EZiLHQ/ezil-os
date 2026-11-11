# Native session effort isolation v1 — source proposal

Base: 137922554da5230c8121fafe5caa66bdde0d11d1. Clean native v7 demonstrated
A low/B high leaking into new C through native shared draft/restore paths.
This document pins implementation interfaces, not native acceptance.

Native input hook: `_ezilSessionEffortV1(resource, model, effort)` returns boolean.
It validates bound input resource, current model, Agent mode and persistence APIs;
sets only session-local native configuration with restore(..., false), then flushes.
The bridge requires this hook for effort capability/admission; old Code remains
model-only. No new wire fields, DB migration, mode or permission changes.

Native input state `contrib.ezilSessionEffortV1` contains exactly:
`{version:1,resource:string,model:string,effort:string,prior:{present:boolean,value?:string}}`.
Resource and model bind provenance; `prior` records the pre-override native effort
(including an existing manual preference) solely for shared-draft projection.
Repeated override of the same session/model preserves the original prior value.
This marker persists in native session input JSON, not only bridge memory.

Native hooks annotate current session input, project shared untitled draft state,
and validate conversation restoration. Shared projection removes the marker and
replaces only the marked reasoningEffort with its prior value (or omits that key
when absent); all other fields survive. Session state keeps actual selected effort.
All matching marked restoration uses persistence=false, including deferred model
restoration. Invalid resource/model provenance cannot promote effort into defaults.
Manual selections differing from the marker are not claimed as bridge overrides.

Configure explicit effort refuses unsupported/unknown modes before model or input
mutation. Send refuses selected explicit effort outside Agent before sendRequest.
New create checks actual new widget before model/effort mutation; post-creation
refusal is uncertain with retained command/resource, never safe-to-retry creation.
Model-only/legacy behavior stays unchanged. No global setters or default clearing.

Tests must execute extracted pinned native methods and actual serializer paths,
show the old shared-write failure, then check draft/bucket isolation, restore,
resource/model mismatch, pre-existing preference preservation and Agent admission.
Native clean v8 close/reopen/reload/wire acceptance remains root-owned and pending.
