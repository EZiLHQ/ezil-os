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

Needs a Supabase Postgres instance. Copy `.env.example` to `.env.local` and fill
it in — `src/env.ts` validates the full set eagerly at boot and fails loudly if
one is missing.

```bash
bun install
bun run dev          # next dev
bun run typecheck    # tsc --noEmit
bun run lint         # eslint
bun run test         # vitest run
bun run build        # next build — run this before opening a PR that touches app/
bun run db:generate  # drizzle-kit generate, after a schema change
```

`next dev`/`next build` deliberately pass `--webpack`: Next.js 16 with Turbopack
breaks Vercel packaging for this project. That, and every other platform sharp
edge found the hard way, is written down in
[`docs/PLATFORM-NOTES.md`](../docs/PLATFORM-NOTES.md).
