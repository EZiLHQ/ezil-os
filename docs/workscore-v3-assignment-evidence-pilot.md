# WorkScore V3 assignment evidence pilot

Start capture explicitly in the Code window for the registered synthetic assignment. The pilot keeps an ordered timeline from Start through Stop. Reports identify the registered assignment, computer, Git provider repository, branch, and starting revision. Client observations and server boundaries have different source labels.

## Staging configuration

Apply `app/drizzle/0034_assignment_evidence_pilot.sql` and `app/drizzle/0035_assignment_evidence_transcripts.sql` in order through the reviewed Preview database migration path before enabling the route. The installer deploys the app separately from schema changes. Use the existing exact staging billing origin and supply `EZIL_ASSIGNMENT_EVIDENCE_PILOT` as one JSON string in the staging app environment. Use a disposable participant account, computer, and repository.

| Configuration field | Value |
| --- | --- |
| `id` | Assignment UUID |
| `ownerId` | OS user UUID |
| `computerId` | Dedicated assignment computer UUID |
| `repositoryId` | Provider repository ID |
| `repositoryUrl` | Exact canonical private `github.ezil.work` clone URL |
| `ref` | Branch ref returned by the authenticated Git gateway |
| `baseSha` | Full registered starting revision |
| `captureChat` | Optional `true` for a dedicated, participant-consented synthetic trial |

The server rechecks ownership of the selected computer and a current write grant to the exact registered repository before Start. The configured base SHA records the assignment setup. Git readback is required to verify the working tree's actual revision.

The route is `/api/shell/assignment-evidence`. Use the authenticated participant session to fetch `?attemptId=<uuid>` after Stop. Read subsequent pages with `&after=<nextAfter>`. The report includes immutable event IDs and server sequences. Retrying the same event ID and payload returns the same receipt. The pilot supports one attempt per assignment UUID and a six-hour write window. To run a new rehearsal, provision a new assignment ID. Clear the pilot configuration after rehearsal and apply the staging retention procedure to the synthetic rows after exporting their test evidence.

## Qualification

Use the dedicated synthetic account and repository. Open the registered Code window, read the capture notice, and start. Open a file, inspect a different range, and use the Code window controls. Close Code, reopen it, and resume the same attempt. Stop explicitly and retrieve the timeline. Check that another owner, another checkout, and post-stop writes produce no data. The PostgreSQL test exercises durable receipts, ordering, retries, scoped reads, and the Stop boundary. The Chromium harness exercises the shell capture control with a loopback fixture.

Version 2 Start discloses safe terminal commands and full inference-trace metadata. The separately configured Chat option discloses capture of already-submitted user text and completed visible-format replies. Text stays in the private assignment report. Up to 16 KiB of accepted text is preserved, while credential-shaped or over-limit text retains a status and request ID. Requests may complete without a reply. Stored request ID links are evidence of attribution and do not imply that a reply was read.

A Code Chat request can have several inference traces. Follow any `chat.request_retried` rows from the accepted Chat request to its explicit replacement. Join `chat.prompt_submitted` and `chat.response_completed` to `chat.gateway_linked` by the resulting request IDs, then join the link to `model.completed` by `requestId` within the same attempt. The validated trace includes separate client and Gateway request IDs, model outcome, duration, usage and pseudonymous tool observations. Missing IDs stay absent. A Gateway request ID alone does not establish that a raw provider payload is available. Existing private Gateway payload capture is a separate staging project-key consent and signed-read system.

Terminal evidence uses trusted Code shell-integration execution. An exact allowlisted command such as `git status` or `npm test` retains its spelling. Other commands retain the completion and timing with a null command. Exit code and duration can also be absent. Closing or changing the assigned workspace disarms capture.

Browser tests need a verified assignment-owned destination, action or test IDs, and associated observed results. Terminating the pilot does not score the attempt.
