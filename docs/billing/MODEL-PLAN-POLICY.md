# Model access by plan

With billing metering enabled, Free keeps its three curated aliases. Standard (including legacy Standard v2 and Pro v1) has the closed list in `app/src/shared/ai-model-policy.json`. Max/Premium includes all available Gateway models. The explicit legacy `compute_monthly_v2` SKU is Premium-equivalent in `v3/catalog.ts` and retains unrestricted model access while it has effective paid access; no entitlement is inferred from a price or arbitrary family. The shared list also supplies the shell's exact model hints; a hint selects a dialog and never changes entitlement or confirms payment.

`gemini-4-argon` and `gpt-6-astra` require Max/Premium. The known future alias `gemini-4-carbon` is excluded from Standard without registering or enabling it. Claude Fable 5.2 has no confirmed alias in the reviewed source or staging catalogue, so this change does not invent one or substitute another Claude model. New aliases stay outside the closed Standard list until reviewed. An included alias does not enable a disabled Gateway registration.

Standard model refusals open the normal Premium upgrade preview. Payment still requires its explicit confirmation. Free picks of a known Premium alias open the normal Premium checkout; ordinary Free locks can still offer Standard. Credit refusals keep their existing credit recovery.

The server sends the selected list through the existing signed credential/plan push. A successful refresh replaces an earlier all-model policy; Premium transitions send null. Existing activity and sweep refreshes are bounded, not instantaneous. A failed plan read leaves the prior signed policy unchanged; it does not widen access, and stale policy expires after the existing 30 minutes. Metering-off behavior is unchanged. Unknown policy is not evidence of Premium access.

No Worker production code, VSIX, Gateway registrations, provider settings or billing subscription mutation is part of this change. The actual staging catalogue read used for this list was 2026-11-12 17:55 UTC (16 rows, 13 enabled): private receipt SHA-256 `ec127a823bd0c79fb064a00d23c83d48ddd70f68a97fd7411f0f179eb4cfd95f`.
