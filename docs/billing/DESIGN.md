# Billing UI design v2 — home page, Settings → Billing, in-OS checkout

Frozen design spec for wave 3 (2026-10-12). Contract: [`CONTRACT.md`](CONTRACT.md). Research: Mobbin, 2026-10-12. The references are cited inline, and each one says what we take from it.

## 0. Principles

1. **Show the product, not a brochure.** The OS is a desktop in the browser, so the home page leads with a faithful rendering of that desktop.
   - It reuses the real "Horizon" wallpaper gradient from `shell/ezil/ui/ezil-shell.css`.
   - References: Linear and Antimetal heroes ([Linear](https://mobbin.com/sites/sections/0e464c7e-94e9-43b1-a7a3-8f33bd04a16f), [Antimetal](https://mobbin.com/sites/sections/38557cd6-0834-4d5a-b186-89ac968d8332)).
2. **Allowances are numbers, not bullet prose.** Each meter gets a tile showing a big value, a unit, and one short line.
   - Reference: [Cloudflare Workers pricing](https://mobbin.com/sites/sections/4c85f5d2-31fc-4cc9-957b-9cd9ed872086).
3. **One primary action per surface.** That is "Start free" on the home page, "Upgrade to Pro" in Billing, and "Pay" in checkout. Everything else is secondary or a link.
4. **Never leave the OS to pay.** Use Stripe Embedded Checkout inside an OS window.
   - Express wallets (Link, Apple Pay, Google Pay) come first, and the email is prefilled. Only country and postal code are collected; tax needs nothing more. The success state appears in place.
   - References: [Uxcel](https://mobbin.com/flows/ab808b02-ea56-4a1e-999f-2cf1b585a834), [Webflow](https://mobbin.com/screens/0e9f9557-987d-4061-a500-ca53c873640e), [Magnific](https://mobbin.com/screens/bcb268dc-7580-48ef-9d21-daba224c15a9), [Air](https://mobbin.com/flows/26192649-7399-4412-9247-1442379321c3).
   - Anti-patterns:
     - [Riverside](https://mobbin.com/flows/163675b7-27b2-4c7e-a15c-0452f21845ad) asks for a full street address.
     - [Perplexity](https://mobbin.com/flows/91554608-8cb1-4f62-a30c-e2e2a4fd2c9b) sends you to a full-page redirect.
5. **Honest copy.** Follow every rule in CONTRACT §8. Write "AI assistant coming soon" until G4. No speed or hardware claims.

## 1. Tokens (shared by the web app and the shell)

| token | value | use |
|---|---|---|
| `--bg` | `#04060c` | page background (the Horizon base) |
| `--surface` | `#0d1118` | cards |
| `--surface-2` | `#141a23` | tiles inside cards, hovered rows |
| `--border` | `rgba(255,255,255,0.08)` | 1px hairlines |
| `--text` | `#f5f5f4` | primary text (the existing offwhite) |
| `--muted` | `#9aa3ad` | secondary text; must reach AA 4.5:1 on `--surface` |
| `--accent` | `#00adb5` | the existing teal; primary buttons, progress bars |
| `--accent-ink` | `#04060c` | text on accent buttons |
| `--warn` | `#f5a524` | the `low` state |
| `--danger` | `#f05d5e` | the `exhausted` and `over_cap` states |
| radius | 12px for cards, 8px for buttons and tiles, 999px for pills | |
| type | system UI stack: 44/52 for the hero (28/34 on phones), 20/28 for section titles, 14/20 for body, 12/16 for captions; tabular numerals on every number | |

- **Motion:** 150 ms opacity and transform only, disabled under `prefers-reduced-motion`.
- **Focus:** a 2px `--accent` outline with a 2px offset on every interactive element.

## 2. Home page (`/` for signed-out visitors; also `/pricing`)

**Routing**
- A signed-in visitor still goes to `/os`, exactly as today.
- A signed-out visitor sees the home page when `PRICING_PAGE_ENABLED=1`, and otherwise goes to `/login` as before.
- `/pricing` renders the same page and scrolls to `#plans`.
- Every link to `/`, `/os` and `/login` is a plain `<a>`.

**Sections, in order**
1. **Top bar** (sticky, blurred `--bg` at 80% opacity):
   - left: the EZiL OS wordmark;
   - right: `Plans` (anchor), `Sign in` (quiet text button), `Start free` (small accent button).
   - Below 640px, Plans collapses into the page.
2. **Hero** (centred):
   - Eyebrow pill: `Your computer in the cloud`.
   - H1: `Open EZiL OS and get to work.`
   - Sub-line: `A full desktop with a browser and VS Code, in any tab. Start free — upgrade when you need more time, storage and AI.`
   - Buttons: `Start free` (accent, goes to `/login`) and `Sign in` (outline, goes to `/login?method=email`).
   - Caption: `No card needed for Free.`
3. **Product frame:** a rounded 16:10 window with the Horizon gradient as wallpaper, built from pure HTML and CSS (no images, no JS).
   - It contains a small taskbar and two mock windows, "Browser" and "VS Code", with skeleton lines.
   - It is decorative (`aria-hidden`), scales down on phones, and must not overflow.
4. **Three feature tiles:**
   - `A real desktop` — windows, files and apps that stay where you left them.
   - `Browser and VS Code built in` — build and preview without installing anything.
   - `AI assistant` — "coming soon", shown as a pill.
5. **Plans (`#plans`):** two cards side by side, stacked below 768px.
   - **Free card:** surface background, outline CTA.
   - **Pro card:** surface background with a 1px accent border, a `Most flexible` pill, and an accent CTA.
   - **Card layout, top to bottom:**
     1. name;
     2. price (`$0` / `$20 /month`, large tabular figures);
     3. the price note `USD · before applicable tax · cancel anytime`;
     4. the CTA, directly under the price (Slash and Clerk pattern);
     5. **three allowance tiles**, each with a big value, a unit and a caption:

| | Free | Pro |
|---|---|---|
| Workspace time | `8` h/month — "while a computer runs" | `20` h/month |
| Saved storage | `2` GB | `20` GB, or `2 GB today · 20 GB soon` before G-STOR |
| AI credits | `$0.50` one-time — "assistant coming soon" | `$3` /month — "assistant coming soon" |

   - Under both cards: `Same EZiL OS, same standard computer, same AI assistant on both plans.`
   - Free's CTA is `Start free`, which goes to `/login`.
   - Pro's CTA is `Get Pro`, which goes to `/login?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dpro`. The OS then opens Settings → Billing with the upgrade sheet already open: one click to pay after sign-in.
6. **Top-ups strip:** `Need more AI? Add credits any time — $10 or $25 packs, plus a small service fee.` with the badge `when the assistant launches`.
7. **When you run out:** a three-column row of icon, meter name and one sentence (copy from CONTRACT/pricing-content).
8. **FAQ:** six `<details>` items, as today.
9. **Closing band:** `Start building for free` with a `Start free` button (Replit pattern).
10. **Footer:** `Sold by EZiL LLC` plus Terms, Privacy, Refunds and Support.

**Quality bar:**
- no horizontal overflow at 390px;
- LCP element is text, not an image;
- zero client JS beyond Next's default;
- passes the copy scan.

## 3. Settings window and Billing tab (shell)

**Settings chrome** (all tabs, CSS-only; the DOM contract tested by `settings-test.mjs` is kept):
- **Sidebar:** 200px wide, `--surface` background, 8px item radius, a 13px label next to an 16px icon. The active item gets `--surface-2` plus the accent icon.
- **Content:** 24px padding, max width 640px. The section title is 20px semibold with a 13px `--muted` lead line.
- **Buttons:**
  - `.ezil-settings-btn` is the outline style;
  - `.ezil-settings-btn-primary` is the accent style;
  - danger keeps its red.

**Billing tab layout** (references: [Browserbase](https://mobbin.com/screens/e53c8b1d-85e9-4bde-a820-97da8cbf0720), [Vercel](https://mobbin.com/screens/69c0b6bc-7089-473d-a930-8b192eb79219), [Unify](https://mobbin.com/screens/7fedbad4-1f20-4ca8-afae-84d1ed919275)):

```
Plan & usage                                   [ Upgrade to Pro ]   ← or [ Manage billing ]
Your allowances and what renews when.

┌ EZiL Free  (Current) ─────────────────────────────────── $0 ┐
│ 8 h workspace · 2 GB storage · $0.50 AI trial                │
└──────────────────────────────────────────────────────────────┘
┌ Workspace time ─────┐┌ Saved storage ──────┐┌ AI credits ─────────┐
│ 1 h 12 m            ││ 0.4 GB              ││ Coming soon         │
│ of 8 h              ││ of 2 GB             ││ $0.50 trial ready   │
│ ▓▓▓░░░░░░░░         ││ ▓░░░░░░░░░░         ││                     │
│ Resets Nov 1        ││ Updated 2 min ago   ││                     │
└─────────────────────┘└─────────────────────┘└─────────────────────┘
(inline nudge when a meter is low or exhausted:)
│ ⚠ 12 minutes of workspace time left this month.  [ Upgrade to Pro ] │
Invoices
  Oct 11, 2026   EZiL Pro   $20.00   Paid   View ↗      (empty state: "No invoices yet.")
Support · Refund policy · Plans
```

- **Tiles:** three columns at 640px or wider, stacked below that. Each tile carries a state class (`is-ok|is-low|is-exhausted|is-over_cap|is-unavailable`). The bar colours are accent, `--warn` and `--danger`.
- **Pro plan card:**
  - status line: `Renews Nov 11 · $20/month`, `Ends Nov 11` (cancels), or `Payment failed — update your card` (past_due);
  - `Manage billing` opens the Stripe Customer Portal in a new tab;
  - `Add AI credits` appears only when `actions.topup`.
- **Loading:** skeleton tiles, never a blank pane. **Error:** an inline card with a Retry button.
- **Invoices:** `billing.history`, newest first, at most 12 rows; each link opens Stripe's hosted invoice in a new tab.

## 4. Upgrade sheet (in-OS checkout)

Opened by:
- `Upgrade to Pro` (Billing tab);
- deep link `?settings=billing&upgrade=pro`;
- a 402 or exhaustion notice.

It is a modal sheet inside the Settings window: 560px wide, full width under 600px, ESC and the × button close it.

**Layout:**
- **Left column, order summary (Webflow / Mixpanel pattern):**
  - `EZiL Pro` / `$20.00 /month`;
  - the three allowance lines;
  - `Tax calculated at checkout`;
  - **`Due today`**, which Stripe fills in;
  - the renewal sentence: `Renews monthly until you cancel in Settings → Billing.`
- **Right column, payment:**
  - a `<div id="ezil-embedded-checkout">` that mounts Stripe Embedded Checkout;
  - Stripe renders Link, Apple Pay and Google Pay at the top, prefills the email from the Stripe customer, and asks only for card, country and postal code;
  - under 600px the columns stack, with the summary collapsed to one line.

**Flow:**
1. Click → `billing.createCheckout({ sku: 'pro_monthly_v1' })` returns `{ mode:'embedded', clientSecret, publishableKey }`.
2. Load `https://js.stripe.com/v3` once, lazily, then call `Stripe(pk).initEmbeddedCheckout({ fetchClientSecret: () => clientSecret, onComplete })`.
3. `onComplete` → the sheet shows "Confirming your payment…" while polling `billing.checkoutStatus` every 1.5 s, then `billing.summary` until the plan is `pro` (at most 30 s).
4. Success state: a check icon, `You're on EZiL Pro`, `20 h workspace time · 20 GB storage · $3 AI credits each month`, and a `Done` button. Done refreshes the tab.
5. If the summary has not turned Pro after 30 s: `Payment received — your plan updates in a moment.` Pro is granted only by the webhook, so this is honest.

**Fallbacks:**
- If `mode:'redirect'` (no publishable key) or Stripe.js fails to load: `window.open(url, '_blank', 'noopener')`, plus the same polling.
- Closing the sheet mid-payment destroys the embedded instance (`checkout.destroy()`), and the next open creates a fresh session.

**Server (`createCheckout` for the embedded mode):**
- `ui_mode=embedded`, `return_url=${origin}/billing/return?session_id={CHECKOUT_SESSION_ID}`, `redirect_on_completion=if_required`;
- `billing_address_collection=auto`, `customer_update[address]=auto`, `automatic_tax[enabled]=true`;
- `saved_payment_method_options[payment_method_save]=enabled`, so returning buyers check out in one click;
- no `allow_promotion_codes`.

Link, Apple Pay and Google Pay come from the Stripe dashboard's payment-method settings. Card is always on.

## 5. Acceptance (e2e)

- **`e2e/billing-home.mjs`** (Playwright, against a running app):
  - signed-out `/` renders the home page with the flag on and redirects to `/login` with it off;
  - `/pricing` scrolls to `#plans`;
  - CTA hrefs are correct;
  - no overflow at 390 and 1280 px;
  - the copy scan passes;
  - axe-like checks: one `h1`, every button has a name, images or decor are `aria-hidden`;
  - screenshots are saved.
- **`e2e/billing-checkout.mjs`** (Playwright plus Stripe TEST mode, opt-in through `STRIPE_E2E_SECRET` and `STRIPE_E2E_PUBLISHABLE`):
  - It boots the real shell bundle and fakes `/api/trpc/*` with `page.route`. The fake answers `createCheckout` with a **real** embedded session created against Stripe test mode, and answers `summary` from a local state machine.
  - It opens Settings → Billing, clicks Upgrade, and fills test card `4242 4242 4242 4242`, `12/34`, `123`, plus country and postal code, inside the Stripe iframe. Then it pays and sees the success state.
  - It then fetches the real `checkout.session.completed` and `invoice.paid` events from Stripe and feeds them, signed, through `handleStripeWebhook` against Postgres. It asserts exactly one Pro grant.
  - It also covers closing the sheet mid-flow, a declined card (`4000 0000 0000 0002`) showing Stripe's inline error, and a double click opening only one session.
- **jsdom unit tests** cover every Billing tab state and the sheet state machine against a fake `Stripe()` object.

## 6. Pinned selectors (UI ↔ e2e contract)

| element | selector |
|---|---|
| home hero H1 | `[data-testid="home-hero"] h1` |
| home "Start free" (hero) | `[data-testid="cta-start-free"]` |
| home "Sign in" | `[data-testid="cta-sign-in"]` |
| plans section | `#plans` |
| Free / Pro card | `[data-testid="plan-free"]`, `[data-testid="plan-pro"]` |
| Pro CTA | `[data-testid="cta-get-pro"]` |
| allowance tile | `[data-testid="allowance-<plan>-<workspace|storage|ai>"]` |
| Billing pane | `.ezil-settings-pane[data-pane="billing"]` |
| Billing header action | `[data-action="checkout"]` / `[data-action="portal"]` |
| meter tile | `[data-meter="workspace|storage|ai"]` (+ state class `is-…`) |
| invoices list / empty | `[data-role="invoices"]`, `[data-role="invoices-empty"]` |
| upgrade sheet | `[data-role="upgrade-sheet"]` (role=dialog, aria-modal=true) |
| sheet close | `[data-action="close-sheet"]` |
| Stripe mount | `#ezil-embedded-checkout` |
| sheet success | `[data-role="upgrade-success"]` |

The deep link is `/os?settings=billing&upgrade=pro`. `boot.js` reads it once after boot. It opens Settings on Billing with the sheet open, then removes those query keys with `history.replaceState`.

Pro CTA href: `/login?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dpro`. The parameter is `RETURN_URL_PARAM`, and the login page already validates it through `safeReturnUrl`.
