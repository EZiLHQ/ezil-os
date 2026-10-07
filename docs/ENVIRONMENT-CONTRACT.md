# Environment contract

`.github/environment-contract.json` states which Supabase project each kind of run may use, and
`.github/scripts/env-contract.mjs` enforces it in CI. Pull requests and staging previews are
`preview`. Pushes to `main` and `v*` release tags are `production`.

## Commands

- `node .github/scripts/env-contract.mjs check --repo ezil-os` validates the contract and the
  production migration manifest.
- `node .github/scripts/env-contract.mjs scan --repo ezil-os` checks every workflow and composite
  action. Outside the production job, it refuses:
  - production credential names, dynamic `secrets[...]`/`toJSON(secrets)` access, migration
    `apply`/`rehearse` and `supabase db push|reset`;
  - `secrets: inherit` except on the listed reusable-workflow callers;
  - a production environment.

  Both the staging preview and production jobs must run their assertion as a plain, unconditional
  step that comes before any step that uses a secret.
- `node .github/scripts/env-contract.mjs assert-job --repo ezil-os --environment preview|production`
  runs at the start of the deployment jobs. A preview job refuses if any production credential is
  present. A production job refuses pull-request events and refs other than `main` and `v*` tags.

`cloud-release-contract` runs `scan` and `e2e/env-contract.test.mjs` on every pull request.

## Changing the contract

The contract file is shared with other EZiL repositories and its checksum is pinned in
`e2e/env-contract.test.mjs`. Change it in every repository in one coordinated change, and update
the pin.
