# Direct EZiL Git URL in staging Code

Base: `74e26bfad79a842bda16d166ab35b86696818159` (`origin/staging/os-union-20261106`, verified 2026-11-10). Worktree: `EZiL-OS.worktrees/github-url-cli-20261110`. This branch is the sole OS source writer for this mission. Release writer `40003c71` and folder recovery lane `6637aa80` retain their worktrees and ownership.

## User path

`/app/code?repo=https%3A%2F%2Fgithub.ezil.work%2F<namespace>%2F<name>.git` targets the selected, owned Cloudflare staging computer. The shell already preserves that intent through Code open and refresh. The app accepts only the exact canonical production Git host and path, asks the authorized Works address-grant route, then uses the existing signed repo-open operation to place a checkout. Code opens only the Worker-returned, server-validated checkout folder. Reopen preserves the same checkout and dirty files. A scoped renewable grant supports a later `git push` from Code. AWS remains an explicit refusal for this phase.

## Owned changes

- OS app and shell: `app/src/server/works/repo-url.ts`, a narrow address-grant client under `app/src/server/works/`, `app/src/app/api/shell/code-preview-url/route.ts`, and the existing Code identity-refresh path. Preserve `github.com` handling, ownership and billing checks, provider refusal, deadline, and URL-to-Code flow. Treat missing or unauthorized as the same user message. No grant or remote credential reaches the browser.
- Worker: extend the current signed `repo-open` path for the exact EZiL Git host to invoke the checksum-pinned bundled CLI through a private descriptor. Keep the current repository ID folder contract and push-grant helper. Port only applicable reviewed pieces from OS `864126b3`; avoid a second public route or unrelated clone rewrite. Pin the reviewed CLI bundle by checksum in `worker/repo-open/` and stage it with the existing Dockerfile secret mechanism.
- Tests: narrow URL/parser, grant response, owned-computer, signed Worker request, CLI adapter, exact folder, repeated open/dirty preservation, expiration and refusal tests. Run affected app, Worker, shell and packaged-CLI checks; no image build or hosted test in this implementation lane.

## External contract and dependencies

Works lane `01a1c5f4` owns the production-host address-grant route and CLI private-grant scope/fixture. Consumer request: `POST /v1/builder/selfserve-repositories/os-grant` with retained EZiL ID bearer and exact `{computerLabel, class:'project', url:'https://github.ezil.work/<namespace>/<name>.git'}`. Require exact canonical clone URL, Works repository ID, authoritative default branch, grant token/scope/expiry and a no-store response. QA Works currently rejects this host; never silently map it to `git-qa`.

CLI `8fe38cc` private FD v1 also requires project ID and binding version that the current Works address answer lacks, and rejects write-scope grants. OS must not fabricate either field or relabel scope. Integrate only the other lane's reviewed exact private packet/fixture once supplied, or stop at a precise dependency handoff. The private CLI artifact must match its pin before any staging image promotion. Root coordinates the producer and sole release writer; this branch does not merge or deploy.

First checkpoint: within 20 minutes, report concrete code, tests, and blockers; do not treat source completion as deployed acceptance.
