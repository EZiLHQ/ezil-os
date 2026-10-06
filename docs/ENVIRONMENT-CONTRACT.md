# EZiL Universe environment contract (v1)

This file is identical in EZiLHQ/ezil-work, EZiLHQ/ezil-os and EZiLHQ/ezil-ai-gateway. So is
`.github/environment-contract.json`, the machine-readable contract that each repo's CI test reads.
Change both files in all three repos in one coordinated change set; each repo's test pins the
contract's sha256, so a one-sided edit fails CI.

## Environments

| Trigger | Environment | Supabase project |
|---|---|---|
| local dev, unit/integration tests | preview | `projects.preview` (or a local/PGlite database) |
| same-repo pull request, preview URL, staging | preview | `projects.preview` |
| push to `main`, release tag | production | `projects.production` |

Project refs (founder-named, org `wmryhsskhwhqnmvmfgnf`):

- `EZiL-preview`: `btgqfmnzycdecmeyqubx`
- `ezil-prod`: `curomaahbwlrddzijatd`

## Phase

`phase` records where the cutover stands. Every repo's contract test enforces the invariants below.

### `pre-cutover` (current)

Production still runs on `legacyProduction` (`btgqfmnzycdecmeyqubx`), which is the database the
founder has named preview. That database therefore holds live production data, so in this phase:

- Each repo's `.github/production-migrations.json` `project` must equal `legacyProduction`.
- No pull-request, preview or staging job may name a credential from `productionCredentialNames`.
- No pull-request, preview or staging job may run a migration `apply` or `rehearse`.
- Preview database writes are therefore impossible from CI. Preview deploys keep their remote
  runtime config, which still reaches the legacy production database for reads and user traffic.

### `post-cutover`

Production has moved to `projects.production`, following `docs/CUTOVER-RUNBOOK.md` in ezil-work.

- Each repo's `production-migrations.json` `project` must equal `projects.production`.
- `projects.preview` must differ from `projects.production`.
- Preview jobs may receive preview-scoped credentials only. These must use names that do not
  appear in `productionCredentialNames`, for example `PREVIEW_DATABASE_URL`.
- Preview migrations run before production and fail closed. A failed preview migration blocks
  promotion.

Flipping the phase is one PR per repo, all landing together, with re-captured migration baselines.
It is never a side effect of another change.

## Enforcement

`.github/scripts/env-contract.mjs` (byte-identical in every repo, no dependencies) has three commands:

- `check --repo <name>` validates the contract and the repo's `production-migrations.json` against the phase.
- `scan --repo <name>` reads every `.github/workflows/*.yml` and `.github/actions/**/action.yml`.
  Matching ignores case and spacing. It refuses:
  - production credential names, `secrets[...]`, `toJSON(secrets)`, migration `apply`/`rehearse`,
    `supabase … db push|reset` and `supabase … migration up` anywhere outside the repo's
    `productionJobs`, workflow-level env and composite actions included;
  - `secrets: inherit` (quoted or commented) outside `secretInheritance`;
  - a non-production job whose environment names production or is computed with `${{ }}`;
  - a production job whose environment is not exactly `production`;
  - YAML anchors, aliases, merge keys and backslash escapes in quoted values. These would let text
    hide from the scanner, and no workflow here needs them;
  - a preview or production job whose assertion is not exactly `run: <assert command>`, with only
    `name`/`id` beside it (no `if:`, `continue-on-error`, `env`, `shell` or `|| true`);
  - any step before the assertion other than `actions/checkout`, `actions/setup-node`,
    `oven-sh/setup-bun` or `actions/download-artifact`;
  - a production job that binds a production credential at job level;
  - a repo with no unconditional non-production step that runs `scan` itself as a line of its own.
- `assert-job --repo <name> --environment preview|production` is the runtime guard. Preview jobs
  refuse if any production credential name is set. Production jobs refuse pull-request events and refs
  outside `productionRefs`. `--repo` must match `GITHUB_REPOSITORY`.

`repos.<name>` in the contract designates each repo's preview jobs, production jobs, the reusable-workflow
callers allowed to `secrets: inherit`, and the refs production may run from. Some of those callers run on
PRs (OS `preview.yml#images`); the called workflow is scanned like any other, so it still cannot name a
production credential.

Job-level secrets that are not production credentials, such as the Vercel and Cloudflare deploy tokens
and the OS E2E fixtures, are allowed in preview and production jobs. Only production credential names
are refused at job level, because those are the ones that reach a database.

**Threat model.** These checks catch *accidental* preview-to-production wiring. A deliberate bypass is
out of scope: commands assembled from variables, scripts the workflow calls, or a PR that edits the
checker and its tests together. Review and branch protection stop those. `assert-job` accepts any event
on an allowed ref, including `workflow_run` on `main`. The OS trust job is what admits that path.

What in-repo checks cannot see: Vercel/Cloudflare runtime variables, repo-level secrets
(`CLOUDFLARE_API_TOKEN`, `VERCEL_TOKEN`), the self-hosted runner's own environment and files,
credentials under names not in `productionCredentialNames`, and GitHub-side environment branch policies.

## Credentials

- Production credentials live only in the GitHub `production` environment of each repo. Each
  `production` environment has a deployment-branch policy of `main`.
- `SUPABASE_ACCESS_TOKEN` is an account-wide management token. It can reach every project in the
  org, so it is a production credential wherever it appears. It must not exist in any preview or
  staging environment.
- Preview and production never share a URL, key, password or secret value.

## Migration governance

- Each product owns its schemas: OS owns `public` (legacy and OS tables), the Gateway owns
  `ezil_ai`, and Works owns `ezil_universe` and `ezil_works`.
- The production engine (`.github/scripts/production-migrations.mjs`, protocol v1.2) serializes
  every apply through one advisory lock and the shared `ezil_ci` journal. It refuses catalog drift
  and refuses non-main runs.
- When more than one product has a pending migration, `migrationOrder` sets the order:
  `ezil-os`, then `ezil-ai-gateway`, then `ezil-work`. A later product's release waits for the
  earlier one.
- Production migrations run only from the protected `main` release job. They run after every check
  and the preview/staging stage have succeeded.

## Promotion record

Every production release records:

- the commit SHA;
- the migration journal state (manifest digest, journal ordinal);
- the target environment;
- the deploy result;
- the rollback target (the previous deployment or version).

These are captured by each repo's existing release tooling: Works `tools/ci-runtime-release.mjs`,
OS `release-state.mjs`, and Gateway `ci-release.mjs`. The artifacts are uploaded by the production
job.
