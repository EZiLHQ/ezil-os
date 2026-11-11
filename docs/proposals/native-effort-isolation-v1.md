# Native session effort isolation — corrected v2 contract

Current correction supersedes the single-marker contract/checkpoint e395dc07 and
blocked implementation e9780e40. Independent review reproduced model-switch and
foreign-prior leakage; actual native manual setter also promoted low when changing
only contextSize. These are source defects, separate from the native v8 fixture's
title/primary classification issue. No native full acceptance is claimed.

Native input hook: `_ezilSessionEffortV2(resource, model, effort): boolean`.
The bridge requires this version; obsolete `_ezilSessionEffortV1` does not qualify.
Explicit effort requires Agent and matching widget/current native input resource.
Other modes reject before model/input mutation or send. Model-only/old wire
protocols remain unchanged; no DB/protocol fields are added.

Native JSON namespace remains `contrib.ezilSessionEffortV1`, with exact v2 shape:
`{version:2,resource:string,selections:[{model:string,effort:string}]}`.
At most128 unique model IDs; existing bounded ID/effort syntax. There is NO prior
preference value in the payload. The marker is context provenance, not an auth
credential, permission, secret or trusted preference source. Native session JSON
preserves all selections, including when a different model is currently selected.

The native store getter overlays the matching session/model effort. Shared-draft
projection removes our namespace and replaces only reasoningEffort from native
fallback: schema defaults plus the existing model bucket (or native global model
configuration when that bucket entry is absent), matching Code's fallback order.
It never consults `_preferences`, `_overrides` or a serialized `prior` for this.
Unrelated state/configuration is preserved. Foreign/malformed/stale/v1 payloads
cannot promote supplied values into target defaults; native target fallback wins.

Before native local configuration apply, tracked reasoning is removed from the
LOCAL preference cache using native fallback. After apply, that cache/persisted
candidate retain fallback reasoning while actual local configuration keeps the
session-selected effort. An unrelated manual patch (e.g. contextSize) therefore
persists normally without promoting effort. Only persist=true plus an OWN
reasoningEffort field retires that MODEL's selection, including same-value explicit
manual intent. Other models' selections remain. No coarse model-ID event retirement.
No global clearing, default setter or outgoing request rewrite is used.

All EZiL native session/history restoration remains nonpersistent; explicit manual
picker setters and other-vendor restore behavior remain. Active projection/getters
follow the bound input resource: native setInputModel pre-flushes the OLD input
before rebinding, while the widget key may already identify the next tab. New
control writes still require both resources to match. Native contrib merge receives
an explicit undefined tombstone when no tracked selections remain; JSON omits it.

Source hooks: helper, API, draft, annotation, prepare, restore, native getter,
before-apply and after-apply (nine exact anchors). New helper is copied by Docker.
No image/VSIX build here. Rollback to old native Code with new marked session
histories remains unqualified. Root owns fresh native wire/UI/reopen/reload testing;
A owns independent immutable review. No fixture classification changes in this lane.
