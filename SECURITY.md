# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/EZiLHQ/ezil-os/security/advisories/new),
or by email to **security@ezil.work** (aliased to `contact@ezil.work`). If you
prefer email and want a reply you can verify, say so and we will respond from
the same address before you send details.

Please include: what you found, the smallest set of steps that reproduces it,
what an attacker gets out of it, and any commit SHA, URL or log line you used.
A proof-of-concept is welcome; a working exploit is not required.

**What to expect.** We aim to acknowledge within 3 working days and to give you
an assessment within 10. EZiL-OS is maintained by a very small team, so please
read those as honest targets rather than a guarantee. We will tell you what we
decide and when a fix ships, and we will credit you in the advisory unless you
ask us not to.

Please give us a reasonable window to fix an issue before disclosing it
publicly. We will not pursue or support legal action against anyone who
researches and reports in good faith under this policy.

There is no paid bug bounty.

## Supported versions

EZiL-OS is developed on `main` and deployed from tags. Only the current
`main` and the most recent release receive security fixes. There are no
long-term support branches.

## Scope

In scope — this repository and the service it builds:

- The Cloudflare Worker in `worker/` and the container image it drives.
- The Next.js app in `app/`, including the `/api/shell/*` and `/api/cron/*`
  routes and the tRPC procedures behind them.
- The desktop shell in `shell/`.
- The `sdk/` client and the `mcp/` connector.

Out of scope:

- Vulnerabilities in upstream projects we package rather than author — report
  those upstream. Which components those are, and where they come from, is
  listed in [`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md). Tell us anyway if the way
  *we* configure one makes it exploitable here.
- Findings that require a compromised Cloudflare, Vercel or Supabase account,
  or physical access to a user's machine.
- Missing hardening headers, TLS configuration grades, or automated-scanner
  output with no demonstrated impact.
- Denial of service by brute volume against the hosted deployment.

## Things worth knowing before you test

These are deliberate design decisions, documented so you can tell them apart
from bugs. If you can show one is exploitable in practice, that is a finding and
we want it.

- **Every user's computer is a real Linux container** running real processes.
  Running arbitrary code *inside your own container* is the product working, not
  a vulnerability. Escaping it, or reaching another user's container, is.
- **code-server runs with `--auth none` inside the container.** It is reachable
  only through an authenticated bridge hostname gated by a signed, sandbox-bound
  cookie. Reaching it without that cookie is a finding.
- **Preview URLs are HMAC-signed and short-lived** (see `worker/src/hmac.ts`).
  The bootstrap token is single-purpose and expires in minutes; the session
  cookie it exchanges for is bound to one sandbox.
- **`GET /health` and `GET /sandbox/:name/status` are unauthenticated** by
  design and return no user data.
- **The browser sidecar has a closed verb allowlist** and no CDP passthrough.
  `worker/sidecar/README.md` states the rule: there is no passthrough verb and
  none may be added. A way to execute an unlisted verb is a finding.
- **Telemetry never carries identities, file contents, secrets or full URLs.**
  [`docs/telemetry.md`](./docs/telemetry.md) is the exact account. Telemetry
  that carries any of those is a finding.

## Please do not

Test only against your own account and your own containers. Do not access,
modify or retain other users' data; do not run denial-of-service or spam tests
against the hosted deployment; do not use social engineering. If you need a
second account to demonstrate a cross-tenant issue, ask us and we will arrange
one.
