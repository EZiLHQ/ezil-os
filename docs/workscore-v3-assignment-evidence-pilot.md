# WorkScore V3 assignment evidence pilot

Start capture explicitly in the Code window for the registered synthetic assignment. The pilot keeps an ordered timeline from Start through Stop. Reports identify the registered assignment, computer, Git provider repository, branch, and starting revision. Client observations and server boundaries have different source labels.

## Staging configuration

Apply `app/drizzle/0034_assignment_evidence_pilot.sql` through the reviewed Preview database migration path before enabling the route. The installer deploys the app separately from schema changes. Use the existing exact staging billing origin and supply `EZIL_ASSIGNMENT_EVIDENCE_PILOT` as one JSON string in the staging app environment. Use a disposable participant account, computer, and repository.

| Configuration field | Value |
| --- | --- |
| `id` | Assignment UUID |
| `ownerId` | OS user UUID |
| `computerId` | Dedicated assignment computer UUID |
| `repositoryId` | Provider repository ID |
| `repositoryUrl` | Exact canonical private `github.ezil.work` clone URL |
| `ref` | Branch ref returned by the authenticated Git gateway |
| `baseSha` | Full registered starting revision |

The server rechecks ownership of the selected computer and a current write grant to the exact registered repository before Start. The configured base SHA records the assignment setup. Git readback is required to verify the working tree's actual revision.

The route is `/api/shell/assignment-evidence`. Use the authenticated participant session to fetch `?attemptId=<uuid>` after Stop. Read subsequent pages with `&after=<nextAfter>`. The report includes immutable event IDs and server sequences. Retrying the same event ID and payload returns the same receipt. The pilot supports one attempt per assignment UUID and a six-hour write window. To run a new rehearsal, provision a new assignment ID. Clear the pilot configuration after rehearsal and apply the staging retention procedure to the synthetic rows after exporting their test evidence.

## Qualification

Use the dedicated synthetic account and repository. Open the registered Code window, read the capture notice, and start. Open a file, inspect a different range, and use the Code window controls. Close Code, reopen it, and resume the same attempt. Stop explicitly and retrieve the timeline. Check that another owner, another checkout, and post-stop writes produce no data. The PostgreSQL test exercises durable receipts, ordering, retries, scoped reads, and the Stop boundary. The Chromium harness exercises the shell capture control with a loopback fixture.

Current producer coverage belongs to the Code workspace. Full user-submitted prompts and rendered responses require a dedicated consented transcript producer. Browser tests need a verified assignment-owned destination, action or test IDs, and associated observed results. Terminating the current pilot does not score the attempt.
