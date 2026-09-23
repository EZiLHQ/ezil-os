# Local authenticated web development

This setup runs the real Next.js app against local Supabase Auth and Postgres.
It exercises password login, invitations, ownership, computer creation, and the
committed OS shell. It does not provision a cloud computer or run marketplace
applications. Browser and Code display the existing unconfigured-provider state.
The separate [local desktop mode](LOCAL-MODE.md) has a different runtime and
does not test this authentication path.

## Start

Prerequisites: Node.js 22 or newer, Bun 1.3 or newer, and a running Docker-compatible
daemon (Docker Desktop or OrbStack on macOS). The first setup downloads Supabase
images. No Supabase account, production credentials, or cloud CLI login is needed.
The Supabase CLI is pinned to **2.65.2** in `app/package.json` and `app/bun.lock`;
commands use that installed binary. Supabase CLI and `@next/env` are MIT licensed.
Docker must use a local Unix socket or Windows named pipe; setup and stop reject
remote Docker contexts before creating or stopping containers.

From the repository root:

```bash
cd app
bun install --frozen-lockfile
bun run dev:setup
bun run dev:doctor
bun run dev
```

Open [the login page](http://127.0.0.1:3000/login). Use `local-a@ezil.test` or
`local-b@ezil.test` with its generated password from `app/.local-web/accounts.json`.
Open that file locally; do not paste it into logs, issues, or a pull request.
Use password login; Google OAuth is not configured in this local project.

`dev:setup` refuses to replace a different existing `app/.env.local`. Preserve or
move your existing file yourself before choosing this local setup. It never reads
a hosted database URL to decide where to apply migrations. Generated files use
owner-only permissions; `app/.local-web/` and Supabase temporary files are ignored.

## What setup does

1. Starts only the unlinked `ezil-os-web-dev` Docker project, configured in
   `app/dev/supabase/config.toml`. API: `127.0.0.1:55321`; Postgres: `127.0.0.1:55322`.
   A setup-owned Docker network binds published ports to loopback.
   Only one checkout should use this project at a time. Port conflicts fail setup.
2. Checks CLI status for the exact local API/database destinations and verifies
   the database container's project label. Captures CLI output without printing
   its keys. Privileged Auth requests cannot follow redirects.
3. Applies `0000_massive_mole_man.sql`, `0001_telemetry.sql`, and `0002_os_access.sql`
   in one transaction with an advisory lock. A private `ezil_local_dev.migrations`
   ledger records filenames and hashes. Repeat runs apply zero migrations;
   changed or unknown history fails instead of guessing or resetting data.
4. Creates two confirmed users through the real local Auth admin API and grants
   each an explicit `ezil_os_access` invitation. Reruns reuse identities/passwords
   and restore these two local development invitations. Password sign-in is
   verified without resetting existing passwords; keep the original account file.
   Computers are created
   by the ordinary authenticated `/os` boot, never by the seed script.
5. Writes only local app configuration with invite mode enabled. The service-role
   key is used in memory for setup and is not written to the app environment.
   Cloud desktop settings are omitted. Inherited provider settings cause the
   local doctor to fail rather than starting paid compute.

`dev:doctor` loads environment files through Next's loader, reports invalid or
missing **names and codes only**, and checks local Auth/database readiness when
using the generated setup. `dev` runs it before starting Next. Optional settings
such as `CRON_SECRET` should be absent when unused; an empty value is invalid.
Production's existing `src/env.ts` validation and invite/ownership checks remain
unchanged. This setup does not add an authentication bypass.

Keep `auth.enable_signup=false` and `auth.email.enable_signup=true` in the local
Supabase config: CLI 2.65.2 uses the latter to enable the email/password provider
as well as email signup. The global setting still blocks self-service signup.
The doctor checks the running Auth settings for this distinction. After changing
Supabase config, run `dev:stop` followed by `dev:setup` to restart its services.

## Two-user browser acceptance

1. With no session, open `/os` and confirm the login redirect.
2. Sign in as local A using the form. Confirm a full navigation to `/os`, the
   rendered dock, and a working Settings window. The cloud desktop is unavailable;
   a wallpaper alone is not a successful boot.
3. Open `/computers`; confirm one computer. Reload `/os` and confirm the same
   computer remains. Do not manually create an extra computer for this check.
4. Open `/login?error=not_invited` and use its existing **Sign out** form, then
   sign in as local B. Confirm B has a different computer and only
   B's computer appears in the list. Trying A's `/computer/<id>` URL as B must fail.
5. Sign out and confirm `/os` and protected shell APIs require authentication.
6. Run `dev:setup` again; verify both users' computers are retained and it reports
   zero applied migrations. Stop/restart Supabase and repeat login.

The current shell does not expose a normal account-menu sign-out control. The
URL in step 4 renders the existing access-message/sign-out screen; visiting it
does not change invitation records. This is a development test path to the real
server sign-out action, not an authorization bypass.

With Next running on port 3000, run `bun run dev:verify` from `app/` after the two
browser logins. It uses real password authentication and HTTP API requests to
check anonymous denial, one computer per account, repeat-boot idempotency, and
cross-user read denial. It records only user/computer IDs in the private
`.local-web/verified-computers.json`; subsequent runs must recover those same IDs.
It requires existing computers and does not substitute for the browser login or
visual boot checks. Run it again after stopping/restarting Supabase.

From the repository root, run the required code checks:

```bash
./tools/test.sh app
cd app
bun run build
```

Unit tests cover redacted diagnostics, remote-target rejection, environment-file
preservation, private account files, and migration history checks. Real browser
and database checks are required in addition to those tests. They establish local
control-plane behavior, not cloud lifecycle, app hosting, or Reticle acceptance.

## Stop and recover

Stop Next with Ctrl-C, then run `bun run dev:stop` from `app/`. This stops only
the dedicated local Supabase project and retains its Docker data volumes. Start
it again with `bun run dev:setup`; identities, passwords, and computers persist.

If the doctor reports an unavailable local service, check that Docker is running
and rerun setup. If it reports a configuration name, fix or unset that setting in
the shell and Next environment files. A generated environment file whose contents
no longer match is preserved; inspect it before moving it and rerunning setup.
If migration history differs, restore the matching checkout or investigate the
local database. Ordinary recovery never requires `db reset`, `db push`, hosted
`drizzle-kit migrate`, or removal of volumes. Keep local Supabase ports private
to your development machine; do not expose this test project through a tunnel.
