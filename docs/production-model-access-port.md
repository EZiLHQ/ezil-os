# Production model access source port

Prepared on `codex/prod-model-access-coherent-20261110-root`, based on production
`2a84198cc1500221ed56390277b93501617fdb33`. This is source preparation, not a
deployment or live acceptance result. The coordinator selects a candidate;
native DF `df0dfd44` remains the sole production custodian.

Source provenance, artifact hashes and focused checks are recorded below. Live
model availability and authenticated acceptance remain release gates.

## Qualified source and exclusions

- PR313: the complete capacity26 delta from `aee100a446ed66036b8db5306fbe59d54a5e8060`
  against its first parent. App lifecycle/rebase readers, operator registry
  validation, existing GC input validation, tests and documentation agree on 26.
  No records are changed or collected. The existing GC implementation is only
  taught the same input bound; no new GC behavior or authorization is introduced.
- PR314: the Free policy delta from `c13c8365122fce66df8f0ebe5f39800e3dcfd5cf`
  against `aee100a4`, including app owner-policy resolution, signed credential and
  plan-only pushes, bounded Worker freshness, extension plan hints and locks,
  Flash defaults/utilities, billing bridges and recovery, image settings, tests
  and documentation. The already-promoted `60d15e0f` base is not copied over main.
  Excluded: staging-union admission changes in `preview.yml`, its workflow checker
  and `e2e/cloud-ci.test.mjs`, and the historical plan-refresh run record.
  The CI billing-recovery test entry is retained; its triage citation is adjusted
  to production's line numbers. The shell bundle and VSIX are rebuilt locally.
- PR324: exact catalog/recovery changes `e117b2bd03df85b65ab4b3462963ab14af84d85b`
  and `28685438079254e03ec48e657e5dd505755ab79c`, qualified in source
  `47c630c160c118666bc7f48a2702777540a51005` / staging merge
  `458f56b90cbd557c6744053f2dfec517aadec1e7`. These add shared catalog fetches,
  invalidation of stale in-flight results, request-free token counting and
  recovery after an unread catalog. The rebuilt VSIX equals
  `63b6ff364bab40a726efbfa28cdf99f96f28dd28` byte-for-byte.
- PR324's capacity27 commit `bc6defcbddc4f64cf6907d256bbe0c19ca341813` is excluded: capacity26 is the requested
  qualified dependency, and no promotion requiring a 27th record is authorized.
  Its PR322 installer lineage through `78320f601d6f82a28319a83adc19d30d1cd08f2c`
  is excluded: these are staging installer changes, not production model-policy
  dependencies. No staging deployment path is repointed. PR321/app74e and later
  unqualified staging changes are excluded.

The reused deltas retain provenance in the references above: their model
attribution is Claude Opus 5.5 / Claude Sonnet 5.5 and their recorded maintainer
sign-off is Midhun Akash. This dispatch's additional policy hardening and
production integration are attributed separately to GPT-6.

## Production adaptations and invariants

The effective owner plan is resolved even when compute metering is off. Neither
disabled metering nor an unknown/absent plan SKU grants unrestricted access.
A failed read sends no policy update; the Worker's original 30-minute signed
policy expiry is not renewed by token-only pushes. Owner checks, signature
verification and ordering remain intact. No grants, prices or entitlements change.

Flash is the initial/default available model across tiers; valid paid saved
choices remain selectable. Free only includes Flash, including fallback and
utility calls. Locked picker actions open Standard upgrade without inference or
feedback. Actual Free balance exhaustion opens Standard upgrade; paid exhaustion
opens Add credits. Window/operational limits remain separate from purchases.

`worker/wrangler.toml`, the environment contract, production deployment workflows,
workflow checker and staging installer files remain identical to main. Production
keeps AWS routing on, origin zone/allowlist `ezil.org`, sandbox AI proxy on, and
Gateway origin `https://ai.ezil.work`; the shell origin is `https://os.ezil.work`.
The existing SDK transport/API surface is preserved and checked against the routers.

## Artifact

Built with pinned Bun 1.3.14 and checked using `worker/ezil-models/build-vsix.sh --check`:

- `worker/ezil-models/dist/ezil-models-0.1.0.vsix`: 89,633 bytes.
- SHA-256: `0ca5a52e7f1e9ed30c16e740f2aaeca4df07b5af996d5afb9e8f54ba25aa6ea1`.
- All five PR324 catalog source/test files equal qualified `47c630c1` bytes.
- Shell built from the combined production sources with pinned esbuild 0.28.1
  and clean-css-cli 5.6.3 from local caches; bundle drift check passes.

## Local validation

Checks ran serially using installed dependencies matching the package manifests
and locks. No credential files were copied or read. Logs and the complete changed
path list are in the uncommitted `work/` directory.

| Check | Exit | Result |
| --- | --- | --- |
| Extension typecheck and offline tests | 0 | 870 tests in 29 files; live test deliberately excluded |
| `tools/test.sh app` with six focused files, one Vitest worker | 0 | Typecheck, lint, 258 tests: policy, signed pushes, sweep, router sync, capacity reader |
| `tools/test.sh worker` with six focused files | 0 | Typecheck, 501 tests: proxy, route auth, billing bridge, AWS/preview routing, production configuration |
| `tools/test.sh sdk` | 0 | Typecheck and 23 tests, including router surface drift |
| `tools/test.sh tools triage.test.ts` | 0 | Typecheck and 64 tests |
| VSIX build / drift check; shell build / drift check | 0 | Artifacts match compiled source |
| Shell `--strict --only billing` | 0 | Six suites passed, including both real-browser suites; zero skips. `PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit` and the installed Chromium cache were supplied |
| Shell `--only sheet-test.mjs --no-check` | 0 | Topup and upgrade suites passed, no skips |
| Offline `deploy/aws/mum/tests/rollout.py` | 0 | 190 tests; all AWS/DB transports are synthetic |
| Offline `deploy/aws/mum/tests/registry_gc.py` | 0 | 73 tests after linking the matching runtime-validator dependencies |
| Production workflow/environment checker | 0 | YAML, embedded shell/JavaScript and release contracts |
| Linux editor-state test; messages-mock test; changed shell script parsing | 0 | Restore/default/utility settings, local mock, four scripts |
| Copilot plan-lock patch against pristine pinned code-server 4.141.0 | 0 | Seven checks passed: apply, verify, idempotence, billing/picker functions and missing-patch rejection; zero skips |
| Handwritten source whitespace check | 0 | Whole diff exits 2 for existing template whitespace reproduced in the generated shell bundle; artifact not hand-edited |

Initial app typecheck and GC tests failed on incomplete dependency stores; their
final runs above passed after linking exact existing versions. The browser suites
also passed after selecting the installed Playwright and Chromium cache. The
Copilot check passed against ten statically extracted files from the local pristine
`code-server_4.141.0_amd64.deb`, SHA-256
`f384beb4f3ba207e0bca27d0dbd36dd825d5aa909d78c6d4baa8703eaf6b77ba`,
matching the Dockerfile pin. The earlier cache was incompatible; no patch anchors
were changed. Full source/image CI must run its required checks before integration
or release.

## Remaining release gates

Independent focused source review passed: owner-plan policy, billing recovery,
capacity26 and production seams were checked against the qualified commits. Normal
full CI is still required. Local tests use synthetic inputs and mocked transports;
no production fixtures were used or created.
Full app/image builds and hosted acceptance are intentionally left to CI/custodian.

Gateway core `60ae5ca6` being live does not activate Flash: the ten new models are
disabled/unpriced; PR66 activation SQL at `5c495cab` is unexecuted. Staging Flash
was disabled after `upstream_timeout`; controlled restore/canary is pending.
**Do not deploy these Free Flash-only locks before availability is qualified.**
Actual production QA fixtures are still missing/staging-only. App-first, image,
Worker-last rollout and Worker-first rollback remain custodian actions.
