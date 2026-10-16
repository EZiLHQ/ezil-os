# AWS browser capability repair — 2026-10-16

Branch: `fix/os-port-capability-20261016`.
Security implementation reviewed at `66cc30cb1b3b884f17e7277f0395e57dad30817d`.
Starting persistence commit: `2a51bd04791653b78e7a834c0d283cbd222a606d`.
Remote main observed during the publication audit: `74f5a88cf795858b934f4f0f9ffc4ea6e77e8057`.

## Behavior

AWS bootstrap tokens and browser cookies use separate signed purposes and bind to the requested port, sandbox identifier, full computer UUID, generation and lease epoch. A truncated DNS sandbox identifier alone cannot authorize another computer. The handler verifies signature and lifetime before any tunnel lookup, then checks the authenticated binding against the current tunnel record and rechecks expiration after lookup. Rejected credentials cannot invoke origin verification or forward a request.

Each returned AWS URL has a separate five-minute bootstrap capability. The response advertises that actual lifetime; a successfully issued browser cookie lasts one hour. Old AWS bootstrap links and cookies require fresh preview URLs. Cloudflare authentication helpers, stored computer data and provider placement are unchanged by this security repair.

The existing persistence changes and review repairs remain ancestors of this branch. Their earlier local evidence is in [PERSISTENCE-LOCAL-2026-10-16.md](PERSISTENCE-LOCAL-2026-10-16.md). This repair resolves that document's held source-access/port-binding work; it does not establish hosted lifecycle acceptance.

## Review and verification

The founder approved native `gpt-6-sol` at high/xhigh effort after the runtime rejected `gpt-6.1-sol`. Implementation, independent security review and publication audit used separate worktrees; the coordinator retained integration ownership. No Azure worker or Claude lead was launched.

Independent review found and closed an intermediate regression: looking up the tunnel before authenticating could trigger repeated origin checks from an unauthenticated request. The final code verifies a self-contained signed capability first. Independent fixtures confirmed zero lookups for missing, malformed and wrong-port credentials, successful valid authentication, and refusal to issue a cookie for a replaced computer. Review of exact implementation commit `66cc30c` reported no remaining security findings in the scoped diff.

| Check | Result |
| --- | --- |
| Focused AWS origin/hook tests and Worker typecheck | 57 passed; no skips or failures; independently rerun |
| Complete app suite, typecheck and lint | 2,195 passed; one opt-in live Postgres test skipped |
| App production build | Passed with dummy loopback configuration; no production credentials |
| Tools suite and typecheck | 272 passed |
| Shell bundle drift check | Passed using cached pinned minifiers with installation disabled |
| Full Worker suite and typecheck | 1,485 passed; one documented preview-timeout parity test skipped; no failures or loader errors; 61 files, 445 seconds |

The app run includes both formerly excluded files (`aws-enroll-endpoint.test.ts`, `placement-writer.test.ts`) and the formerly excluded placement/preview source-scan cases. The live Postgres test remains disabled because production database access and account writes are outside this authorization. The Worker suite's existing `preview-timeouts.test.ts` canonical-source parity skip remains; all selected container suites ran. No permanent test exclusions were introduced.

The first full Worker attempt used system Bun 1.3.1 and encountered two loader errors in the checkpoint container suite's timeout hooks. The final run uses the already installed CI-pinned Bun 1.3.14. No global tool upgrade or image download was performed. Local container tests use cached image `ghcr.io/ezilhq/ezil-os-desktop@sha256:efffb2b46d05111cb5dbb3a0bfe498c53476f69f3231c6daa51592c0c9707bd4` (image revision `52055b8dc65f1846073d22933e7c77cc0a03887a`), temporary containers and fixture storage. They do not prove an AWS deployment or newly built image.

Local logs:

- `/tmp/ezil-port-app-final.log`
- `/tmp/ezil-port-app-build.log`
- `/tmp/ezil-port-worker-final.log`
- `/tmp/ezil-port-tools.log`
- `/tmp/ezil-port-bundle-check.log`

## Draft publication boundary

The audited workflows and `app/vercel.json` are unchanged from main. Vercel Git deployment is disabled. A new feature-branch push and draft PR run ordinary GitHub CI, CodeQL, DCO, labels and an internal macOS DMG artifact build. They do not admit image publication, staging deployment or hosted continuity tests: `preview.yml` rejects draft PRs before those jobs. The required Hosted continuity PR gate deliberately fails in that state. DCO remains unresolved; no founder signoff was added.

The PR must remain draft throughout. Marking it ready admits GHCR image publication, staging Worker/Vercel deployment and hosted continuity against production-shared authentication/database. The staging environment has no approval protection. Converting an admitted PR back to draft does not stop already-admitted work. Manual preview dispatch can also admit a draft and remains prohibited.

The installed Codex connector supports an explicit `@codex review` PR comment; repository workflows have no comment/review trigger. A review request and its result must be recorded separately against the published head. No `review:claude` label is permitted.

Ready-for-review requires a separately authorized deployment-gate design covering both image publication and staging jobs, while preserving security checks and the required hosted gate. No workflow bypass, main merge, production deployment, schema migration, credential change or production database access is part of this work. The 20-cycle hosted persistence/opencode acceptance, actual AWS startup timing and dirty-volume recovery remain held. Existing Cloudflare migration and post-deletion retention policy remain deferred.
