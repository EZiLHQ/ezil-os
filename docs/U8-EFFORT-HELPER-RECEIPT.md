# Account-scoped effort helper slice

Source only. No apply, activation, image or release authorization is implied.
Contract: `U8-MCP-EFFORT-SHARED-CONTRACT.md` at 36f2e96f17e2e7664ff237efa8b7dfae340d862a.

This slice contains only `extensions/ezil-models/src/{effort,config,gateway,gateway-messages,gateway-responses}.ts`, its focused effort tests and this receipt. Provider hooks and Gateway publication belong to A; desktop/client/backend controls are separate. No provider.ts changes.

Hooks: `effortConfigurationSchema(model)` exposes a route-scoped enum; `withSessionEffort(resolved, options.modelConfiguration)` creates an immutable per-request override after fresh route resolution. `modelOptions` is not the native configuration field. Both wire builders revalidate the override, emit only their protocol field, and preserve the no-override behavior. Account availability and effort evidence share the same fresh catalog read. Catalog-only models also receive capabilities. Missing, disabled, mismatched, paused, or expired evidence never grants effort.

Validation (2026-11-11, existing dependencies, synthetic data):

```
bun test extensions/ezil-models/tests/effort.test.ts extensions/ezil-models/tests/gateway.test.ts extensions/ezil-models/tests/gateway-messages.test.ts extensions/ezil-models/tests/gateway-responses.test.ts
bun run --cwd extensions/ezil-models typecheck
```

192 tests pass, 0 fail. Extension typecheck passes. Tests verify explicit route enums, missing/Gemini capability, max only when catalog-authorized, two independent configuration inputs to actual serialized Messages/Responses bytes, unchanged no-effort requests, revoked capabilities, catalog-only models and stale account evidence. This is helper-to-wire coverage; A's native provider-hook integration and actual editor restart persistence remain separate acceptance requirements. No real model request was sent.
