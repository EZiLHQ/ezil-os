# `app/` — the EZiL-OS web app

The Next.js half of EZiL-OS: authentication, the "your computers" list, and the
`/os` host page that paints the desktop shell. See the
[root README](../README.md) for what the project as a whole is, and
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for the contribution rules.

## What lives here

- **`src/app/`** — routes. `/login`, `/computers`, `/computer/[id]`, `/os`,
  `/admin/telemetry`, plus the JSON transports under `/api/shell/*`, the
  scheduled jobs under `/api/cron/*`, and `/api/trpc/[trpc]`.
- **`src/server/api/`** — the tRPC routers (`computer`, `cloudflareGuacamole`).
  This is where authorization actually lives. Every `/api/shell/*` route is a
  transport only: it resolves through `appRouter.createCaller`, so there is
  exactly one implementation of who may do what (see
  `src/server/shell/http.ts`).
- **`src/server/db/`** — Drizzle schema against Supabase Postgres. Migrations
  are in `drizzle/`.
- **`src/server/telemetry/`** — ingest, sanitize, rate-limit, retention. What is
  and is not collected is documented in [`docs/telemetry.md`](../docs/telemetry.md).
- **`public/os/`** — the desktop bundle built from `shell/`. **Committed on
  purpose** so the app needs no shell build step; never edit it by hand.

`/os` renders one page whose entire job is to paint that bundle fast and hand it
a boot payload. Everything the user sees after the first paint is drawn by the
bundle talking to the Worker.

## Running it

For an authenticated local web environment, start Docker and use the pinned
local Supabase setup. It creates two invited test accounts and applies the
existing migrations only to its dedicated local database:

```bash
bun install --frozen-lockfile
bun run dev:setup
bun run dev:doctor   # names-only configuration and local service checks
bun run dev          # http://127.0.0.1:3000/login
```

Sign in with either account in `.local-web/accounts.json` (generated, ignored,
owner-only). See [the local web guide](../docs/LOCAL-WEB.md) for prerequisites,
two-user acceptance, stopping/restarting, and configuration conflicts.
This runs real Auth, Postgres, and the OS shell. Browser and Code honestly
report that the cloud desktop provider is unconfigured.

For an existing authorized hosted development environment, copy `.env.example`
to `.env.local` and fill it in instead; local setup refuses to overwrite it.
`src/env.ts` still validates production configuration eagerly and fails closed.

```bash
bun run typecheck    # tsc --noEmit
bun run lint         # eslint
bun run test         # vitest run
bun run build        # next build — run this before opening a PR that touches app/
bun run db:generate  # drizzle-kit generate, after a schema change
```

Use `../tools/test.sh app` for the complete required check sequence.

`next dev`/`next build` deliberately pass `--webpack`: Next.js 16 with Turbopack
breaks Vercel packaging for this project. That, and every other platform sharp
edge found the hard way, is written down in
[`docs/PLATFORM-NOTES.md`](../docs/PLATFORM-NOTES.md).
