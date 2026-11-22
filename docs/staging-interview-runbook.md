# Staging interview dry run: CLI runbook

Staging only (git-qa.ezil.work, api-staging.ezil.work, os-staging.ezil.work, ai-staging.ezil.work). The contract is
`docs/contracts/interview-evidence-v1.md` with its schema and vectors; where they disagree the vectors win. The CLI
records evidence only: it scores nothing and infers nothing about attention.

Tools: `tools/interview.mjs` (create, start, finish, export) and `tools/interview-timeline.mjs` (validate). Node
built-ins only; nothing to install.

## Preconditions

Check each before `create`. The CLI cannot check them for you, and a missing one fails late.

1. **The candidate has signed in once at universe-staging as a Builder.** Works refuses `create` with 422
   `candidate_not_builder` unless the candidate's email resolves to an active, unsuspended builder account linked to
   an EZiL ID subject.
2. **A Cloudflare computer on os-staging** is available to the candidate. AWS computers cannot open a git-qa
   repository.
3. **Push tests are off on api-staging** (`EZIL_SELFSERVE_PUSH_TESTS_V0` is not `1`). While they are on, `create`
   is refused with 409 `push_tests_enabled`, and an export would show `pushTestRuns` above 0.
4. **The staging gates are on**: Works `EZIL_SELFSERVE_REPOSITORIES_V0=1` on QA (api-staging), OS
   `stagingGitQaAccepted()`, and the gateway's member capture active (`CONTENT_CAPTURE=qa_staging`). With a gate off
   every interview route answers 404 `not_found`.
5. **Three environment variables are exported in the shell that runs the CLI.** These are the only names the CLI
   reads. Never print, paste or log their values (no `set -x`, no `env`):

   | Name | Used by |
   |---|---|
   | `EZIL_WORKS_QA_TOKEN` | create, finish, export (Works QA automation) |
   | `EZIL_OS_ADMIN_TOKEN` | create, start, finish, export (OS admin, a Supabase access token) |
   | `EZIL_AI_OPERATOR_COOKIE` | start, finish, export (gateway operator session, sent as the `Cookie` header as given) |

   Test presence without printing: `[ -n "${EZIL_WORKS_QA_TOKEN:-}" ] && echo set || echo unset`.
   A missing variable exits 64 naming it, before any request.
6. **A template directory** of files to seed the repository with (`--template DIR`). `.git` is skipped, symlinks are
   refused. The same directory always gives the same head commit.

## The four commands

Run from the repository root. Exit codes: 0 done, 1 refused or failed, 64 usage or missing variable. Every refusal
prints the status and the error code only (for example `works create: refused 409 push_tests_enabled`).

### 1. create

```sh
node tools/interview.mjs create \
  --candidate-email candidate@example.com --handle candidate-a --name interview-1121 \
  --title "Interview 1121" --template ./interview-template
```

Does, in order: Works create, push the template with the Works seed (a write token of at most 300 s, sent as a
URL-scoped `http.extraHeader` in the git child's environment, never in argv or the URL), Works `seeded`, OS
register. Expected output:

```text
works: created interview 7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13, repository 4211
git: template pushed, head 3f2a...(40 hex)
works: seeded recorded
os: registered (new)
interviewId: 7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13
canonicalURL: https://git-qa.ezil.work/candidate-a/interview-1121.git
Candidate link: https://os-staging.ezil.work/app/code?repo=https%3A%2F%2Fgit-qa.ezil.work%2Fcandidate-a%2Finterview-1121.git
```

Keep the `interviewId`; the other commands take it as `--interview`. Send the candidate the link. They open it on
their Cloudflare computer, read the notice and accept.

If a step after the Works create fails, the CLI prints
`resume by rerunning create with the same arguments and --idempotency-key <uuid>`. Rerunning with that key replays the
Works create (same ids, a fresh seed), re-pushes the same commit and continues. A different `--idempotency-key` with
the same handle fails on a handle conflict.

### 2. start

```sh
node tools/interview.mjs start --interview 7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13 --wait
```

Polls OS every 5 s (`--interval`, up to `--timeout`, default 3600 s) until the candidate has accepted (`consented`),
then grants the gateway consent for `identity.osUserId` (notice v1 hash from the vectors, 14 days retention), then
starts the interview. Expected output:

```text
os: interview 7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13 is registered
os: interview 7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13 is consented
gateway: consent recorded for 3b9e2a71-0c4d-4f5e-8a6b-1d2c3e4f5a6b (14 days)
os: interview 7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13 started
```

Without `--wait`, a `registered` interview exits 1 (the candidate has not accepted). Repeating `start` on a started
interview replays cleanly. `gateway consent: refused 409 consent_active` means another interview holds an active
consent for the same member; finish that one first. Nothing is recorded before the candidate accepts, and the
candidate's computer opens only once the interview is `started`.

### 3. finish

```sh
node tools/interview.mjs finish --interview 7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13
```

OS finish, then gateway revoke, then Works finish (the repository becomes read-only). Every step is idempotent, so
repeat the command after any failure. A gateway with no consent record is reported and skipped. Expected output:

```text
os: finished
gateway: consent revoked
works: repository frozen at 2026-11-22T09:45:02.000Z
```

### 4. export

```sh
node tools/interview.mjs export --interview 7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13 --out ./interview-1121
```

Fetches the Works, OS and gateway evidence, merges it in `(at, works < os < gateway, seq)` order, validates it, and
writes `timeline.json` (`ezil.interview.timeline.v1`) and `timeline.md`. Expected output:

```text
wrote /abs/path/interview-1121/timeline.json and /abs/path/interview-1121/timeline.md
events: works 5, os 12, gateway 2; pushTestRuns 0; observations 0
timeline valid
```

If the merged timeline fails validation the files are still written, the errors are printed one per line on
stderr and the exit code is 1. The CLI refuses to write if the output would contain a credential value.
`timeline.md` shows the identity, source counts, what cannot be known, observations and a chronological table.
Prompts appear as byte sizes plus at most 200 characters of the last user message; the full prompts are in
`timeline.json`. It states that the record is not scored.

## Check the export

```sh
node tools/interview-timeline.mjs validate ./interview-1121/timeline.json   # exit 0 and "valid: N events"
jq -e --argjson want "$(jq -c .acceptanceTypes docs/contracts/interview-evidence-v1.vectors.json)" \
  '([.events[].type] | unique) as $got | $want | all(. as $t | $got | index($t))' ./interview-1121/timeline.json
```

`validate` exits 0 when valid, 1 with one error per line on stderr, 64 on usage. It checks the schema, the closed
list of 18 types, the source/type pairing, gapless `seq` per source, ordering, `interviewId` agreement, source
counts and `pushTestRuns === 0`. The `jq` line (acceptance A1) prints `true` only when the export contains all 18
types; a short dry run (no push, no AI request) legitimately fails it.

Observations are agent turns that overlapped a recorded hidden tab, blurred window or presence idle over 5 minutes.
They say what was recorded at the same time and nothing about attention; a gap in the record means unknown, not away.

## Open points for the lead

- **Auth header shapes** are not in the contract. The CLI sends Works and OS `Authorization: Bearer <value>` and the
  gateway `Cookie: <EZIL_AI_OPERATOR_COOKIE as given>`. Each is built in one function (`authHeaders`) in
  `tools/interview.mjs`; change it there if a route expects otherwise.
- **The template source** is not in the contract; the CLI takes `--template DIR`.
- **`seed.remote` is not host-pinned**: the CLI requires https with no embedded credentials, and the header is scoped
  to that exact URL.
