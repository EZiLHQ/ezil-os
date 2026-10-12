# Billing browser acceptance

These suites follow `DESIGN.md` and `CONTRACT.md`. They require Chromium and
Playwright outside the project dependencies. Resolve Playwright through normal
Node module resolution, or set `PLAYWRIGHT_REQUIRE_DIR` to a directory from which
`require('playwright')` works (usually an external test kit's `node_modules`).
Optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium binary.
Neither suite installs dependencies, starts a server, or reads environment files.
Playwright 1.49 or newer is required for accessible-name snapshots.

## Public home page

Start an app separately with `PRICING_PAGE_ENABLED=1`, then run:

```sh
HOME_BASE_URL=http://127.0.0.1:3141 \
PLAYWRIGHT_REQUIRE_DIR=/path/to/test-kit/node_modules \
BILLING_SCREENSHOTS=/tmp/ezil-billing-screenshots \
node e2e/billing-home.mjs
```

`HOME_BASE_URL` is required. The suite uses fresh signed-out contexts for `/`
and `/pricing` at 390×844 and 1280×900. It checks pinned selectors, exact CTA
hrefs, plans scrolling, six FAQ items, copy, decorative frame semantics,
accessible control names, focus outlines, overflow and uncaught page errors.
Set `HOME_FLAG_OFF_BASE_URL` to a separately running app with the pricing flag
off to also check `/` redirects to `/login`. The flag-on route checks serve as
the positive control for that redirect.

Screenshots are written only when `BILLING_SCREENSHOTS` is set. The script prints
a JSON report of steps, passed and failed counts. Exit 0 means all selected
checks passed; exit 1 means a check failed; exit 2 means prerequisites were missing.

## Embedded Checkout (explicit opt-in)

Build the current shell using the repository's `shell/build-shell.sh` workflow
before running. The suite reads `app/public/os/icons.js`, `bundle.min.js` and
`bundle.min.css`; an old build tests old behavior. No app server is needed:
Playwright routes fulfill the document and fake API responses at `http://localhost`.
Only Stripe domains pass through to the network.

Inject `STRIPE_E2E_SECRET` and `STRIPE_E2E_PUBLISHABLE` from the same Stripe test
account into the process environment without printing them. They must start
with `sk_test_` and `pk_test_` respectively. Missing, malformed and live-mode
keys are refused before browser launch or any Stripe request. Do not put keys
in source files, screenshots, reports or shell history.

```sh
# Both Stripe test-mode variables must already be injected into the environment.
PLAYWRIGHT_REQUIRE_DIR=/path/to/test-kit/node_modules \
BILLING_SCREENSHOTS=/tmp/ezil-billing-screenshots \
node e2e/billing-checkout.mjs
```

The test account needs card payments and Stripe Tax configured for the US test
address. Sessions use automatic tax, embedded subscription mode, an inline
USD 2000 monthly price, and the pinned `pro_monthly_v1` metadata. The email is
prefilled from a synthetic customer. The suite submits `4242 4242 4242 4242`
with `12/34`, `123`, United States and ZIP `10001`; a separate session submits
`4000 0000 0000 0002` and expects Stripe's inline decline message.

Each scenario starts a signed-in real shell with `features: { billing: true }`.
The fake tRPC state machine returns Free summary and empty history, creates real
Stripe customers and sessions, and retrieves real session status. Only after
Stripe reports a complete, paid session does the harness simulate webhook
delivery by switching the fake summary to Pro. It then requires the in-place
`You're on EZiL Pro` state and the refreshed Manage billing action. It also tests
closing with the close button and Escape, a fresh session on reopening, and
one createCheckout call for a double click.

This is UI and Stripe test-payment acceptance. It does **not** replay signed
`checkout.session.completed` / `invoice.paid` events through `handleStripeWebhook`
against Postgres, or assert exactly one database Pro grant (the additional
integration requirement in DESIGN §5). The lead must validate those separately.

Objects are deliberately left in Stripe for inspection: synthetic customers,
products, prices, Checkout Sessions and successful test subscriptions. Customers
and products are named `ezil-os billing e2e`; customers, sessions and subscriptions
carry `metadata[test_suite]` with that label, and subscriptions have the matching
description. Associated prices can be traced through their product/session.
The script does not cancel subscriptions, delete objects, or affect live funds.
Use a dedicated test account and clean up labelled objects in test mode as needed.

The final JSON report is `{steps, passed, failed, sessionIds}`. Key and Checkout
client-secret patterns are redacted in diagnostics. Exit codes match the home
suite; prerequisite failure also prints the JSON report with no session IDs.

## Offline worker validation

```sh
node --check e2e/billing-home.mjs
node --check e2e/billing-checkout.mjs
node --check e2e/billing-e2e-lib.mjs
node --check e2e/billing-e2e.test.mjs
node --test e2e/billing-e2e.test.mjs
```

The pure helper tests pair allowed copy with every forbidden term, retained
diagnostic text with redaction, fitting geometry with overflowing geometry, and
accepted test keys with rejected live/missing/malformed keys. Worker validation
cannot establish browser or Stripe behavior: the lead must execute both browser
suites against the current app and shell build.
