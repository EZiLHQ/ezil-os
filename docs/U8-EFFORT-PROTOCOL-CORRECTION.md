# Configured-model effort protocol correction

Source-only correction atop 20ff69f9402901f3314431125f4d6a7622cf7192. No provider.ts, model execution behavior, auth, migration, flag or live changes.

Confirmed semantics: config.ts preserves an omitted gatewayProtocol; gatewayModelAvailable, withGatewayModelLimits and effort.ts capability() interpret it as anthropic-messages. gatewayChat selects Responses only for an explicit openai-responses value. Catalog-only models instead select their supported protocol from the catalog.

accountAvailableIds previously used configured?.gatewayProtocol ?? catalog-first, allowing a configured default-Messages model to advertise Responses effort which execution rejected. The correction branches on the existence of the configured model first, applying the same Messages default as execution. Only catalog-only models use catalog-first. Account model availability behavior itself is unchanged; this fix narrows effort evidence, not model selection or global settings.

Focused regression compares accountModelEvidence against withGatewayModelLimits/effortConfigurationSchema and actual wire builders for Responses-only and Responses-first rows: configured default Messages has no effort offer, catalog-only Responses retains its capability and serializes the requested effort, and explicit configured Responses remains supported. Existing missing/stale/mismatched capability tests also run.

Validation:

```
bun test extensions/ezil-models/tests/effort.test.ts
bun run --cwd extensions/ezil-models typecheck
```

4 tests passed, 0 failed, 52 assertions; extension typecheck passed. Synthetic local fixtures only. A can cherry-pick this correction after helper e498b1ac438beeab04c0a733ecf971c69173757d in its own worktree; it does not require the intervening desktop/backend/schema slices to apply. No human DCO sign-off added. All prior integration/persistence/staging qualification limits remain.
