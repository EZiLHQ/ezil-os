# Billing UI design v2 — home page, Settings → Billing, in-OS checkout

Historical v1 design for wave 3 (2026-10-12), retained below. **Billing catalog v2 supersedes the marked portions in §7 (2026-10-18).** Contract: [`CONTRACT.md`](CONTRACT.md). Research: Mobbin, 2026-10-12. The references are cited inline, and each one says what we take from it.

## 0. Principles

1. **Show the product, not a brochure.** The OS is a desktop in the browser, so the home page leads with a faithful rendering of that desktop.
   - It reuses the real "Horizon" wallpaper gradient from `shell/ezil/ui/ezil-shell.css`.
   - References: Linear and Antimetal heroes ([Linear](https://mobbin.com/sites/sections/0e464c7e-94e9-43b1-a7a3-8f33bd04a16f), [Antimetal](https://mobbin.com/sites/sections/38557cd6-0834-4d5a-b186-89ac968d8332)).
2. **Allowances are numbers, not bullet prose.** Each meter gets a tile showing a big value, a unit, and one short line.
   - Reference: [Cloudflare Workers pricing](https://mobbin.com/sites/sections/4c85f5d2-31fc-4cc9-957b-9cd9ed872086).
3. **One primary action per surface.** That is "Start free" on the home page, "Upgrade to Pro" in Billing, and "Pay" in checkout. **Superseded for v2:** paid actions use Standard and Compute (§7). Everything else is secondary or a link.
4. **Never leave the OS to pay.** Use Stripe Embedded Checkout inside an OS window.
   - Express wallets (Link, Apple Pay, Google Pay) come first, and the email is prefilled. Only country and postal code are collected; tax needs nothing more. The success state appears in place.
   - References: [Uxcel](https://mobbin.com/flows/ab808b02-ea56-4a1e-999f-2cf1b585a834), [Webflow](https://mobbin.com/screens/0e9f9557-987d-4061-a500-ca53c873640e), [Magnific](https://mobbin.com/screens/bcb268dc-7580-48ef-9d21-daba224c15a9), [Air](https://mobbin.com/flows/26192649-7399-4412-9247-1442379321c3).
   - Anti-patterns:
     - [Riverside](https://mobbin.com/flows/163675b7-27b2-4c7e-a15c-0452f21845ad) asks for a full street address.
     - [Perplexity](https://mobbin.com/flows/91554608-8cb1-4f62-a30c-e2e2a4fd2c9b) sends you to a full-page redirect.
5. **Honest copy.** Follow every rule in CONTRACT §8. Write "AI assistant coming soon" until G4. No speed or hardware claims. **Superseded for v2:** accurate vCPU/GiB sizes are required; §7 replaces the v1 copy ban.

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
- `/pricing` renders the same page and scrolls to `#plans`. **Superseded:** it now renders plans first, without scrolling or autofocus (§7).
- Every link to `/`, `/os` and `/login` is a plain `<a>`.

**Sections, in order**
1. **Top bar** (sticky, blurred `--bg` at 80% opacity):
   - left: the EZiL OS wordmark;
   - right: `Plans` (anchor), `Sign in` (quiet text button), `Start free` (small accent button).
   - Below 640px, Plans collapses into the page.
2. **Hero** (centred):
   - Eyebrow pill: `Your computer in the cloud`.
   - H1: `Open EZiL OS and get to work.`
   - Sub-line: `A full desktop with a browser and VS Code, in any tab. Start free — upgrade when you need more time, storage and AI.` **Superseded:** v2 describes more compute time or a larger computer.
   - Buttons: `Start free` (accent, goes to `/login`) and `Sign in` (outline, goes to `/login?method=email`).
   - Caption: `No card needed for Free.`
3. **Product frame:** a rounded 16:10 window with the Horizon gradient as wallpaper, built from pure HTML and CSS (no images, no JS).
   - It contains a small taskbar and two mock windows, "Browser" and "VS Code", with skeleton lines.
   - It is decorative (`aria-hidden`), scales down on phones, and must not overflow.
4. **Three feature tiles:**
   - `A real desktop` — windows, files and apps that stay where you left them.
   - `Browser and VS Code built in` — build and preview without installing anything.
   - `AI assistant` — "coming soon", shown as a pill.
5. **Plans (`#plans`):** two cards side by side, stacked below 768px. **Superseded:** three v2 cards and compute/computer/storage tiles (§7); the v1 table below is historical.
   - **Free card:** surface background, outline CTA.
   - **Pro card (superseded; never sold again):** surface background with a 1px accent border, a `Most flexible` pill, and an accent CTA.
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

   - Under both cards: `Same EZiL OS, same standard computer, same AI assistant on both plans.` **Superseded:** "Prices before tax. One computer runs at a time on each plan."
   - Free's CTA is `Start free`, which goes to `/login`.
   - Pro's CTA is `Get Pro`, which goes to `/login?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dpro`. The OS then opens Settings → Billing with the upgrade sheet already open: one click to pay after sign-in.
6. **Top-ups strip (superseded by the informational Compute overage section; no public AI amounts):** `Need more AI? Add credits any time — $10 or $25 packs, plus a small service fee.` with the badge `when the assistant launches`.
7. **When you run out (superseded: compute and storage only):** a three-column row of icon, meter name and one sentence (copy from CONTRACT/pricing-content).
8. **FAQ (superseded):** six `<details>` items. v2 uses visible `<h3>` + `<p>` answers (§7).
9. **Closing band:** `Start building for free` with a `Start free` button (Replit pattern).
10. **Footer:** `Sold by EZiL LLC` plus Terms, Privacy, Refunds and Support.

**Quality bar:**
- no horizontal overflow at 390px;
- LCP element is text, not an image;
- zero client JS beyond Next's default;
- passes the copy scan.

## 3. Settings window and Billing tab (shell)

**Historical layout:** §7 supersedes the Pro actions, workspace meter, AI trial amounts and three-meter hierarchy below. The shared tokens remain.

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

**Historical v1 flow:** §7 supersedes the sold SKU, allowances, completion timeout, responsive frame and fallback behavior. New subscriptions select Standard or Compute; Pro remains legacy only.

Opened by:
- `Upgrade to Pro` (Billing tab);
- deep link `?settings=billing&upgrade=pro`;
- a 402 or exhaustion notice.

It is a modal sheet inside the Settings window: 560px wide, full width under 600px, ESC and the × button close it.

**Layout:**
- **Left column, order summary (Webflow / Mixpanel pattern):**
  - `EZiL Pro` / `$20.00 /month`;
  - the three allowance lines;
  - `Any applicable tax is shown before you pay` (Stripe Tax is opt-in: `BILLING_AUTOMATIC_TAX=1`);
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

**v1 harnesses:** the two browser suites below still need the v2 updates listed in §7; their old selectors and fake DTOs are not v2 acceptance evidence.

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

**Historical v1 pins:** §7 replaces the Pro CTA/card and workspace/AI allowance pins. Legacy `upgrade=pro` now leads to plan selection, not a new Pro purchase.

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

## 7. v2 (2026-10-18): Standard, Compute, overage and sessions

This section replaces the marked v1 behavior above and records the current implementation in `shell/ezil/ui/Settings/tabs/billing.js`, `billing-sheets.js`, `upgrade-sheet.js`, and the shared marketing document. The sources of truth are [`CONTRACT-v2.md`](CONTRACT-v2.md) and [`contract.ts`](../../app/src/server/billing/v2/contract.ts), including the Wire DTOs. No new flags are introduced. Legacy Pro is honoured as sold, never sold again. The shell reads v2 DTOs only: `enabled === false` or `version !== 2` renders “Billing isn't available yet.”

### References and what they contribute

Mobbin research dated **2026-10-18**, supplied with the v2 brief:

| Reference | Contribution to this implementation |
| --- | --- |
| [Mintlify usage + billing controls](https://mobbin.com/screens/b575a8a4-10cb-4178-81b2-c1746672f416) | Overage is off by default; the rate belongs beside the control. EZiL uses explicit Turn on… / Change cap / Turn off buttons and a consent sheet, rather than an immediately billable toggle. |
| [Browserbase usage & billing](https://mobbin.com/screens/e53c8b1d-85e9-4bde-a820-97da8cbf0720) | A “Current” plan pill, the “of 60 minute (1%)” meter, and “Plan resets” date inform the plan status, used/of allowance, and UTC reset date. |
| [Unify plans & billing](https://mobbin.com/screens/7fedbad4-1f20-4ca8-afae-84d1ed919275) | The “385 / 500 used” credits bar with end date informs the compute meter; its invoice table informs the dated invoice list and kind badges. |
| [Klaviyo change plan](https://mobbin.com/screens/b0d877ea-542e-4cfa-bcef-afd5f04c2aa5) | The payment summary column separates subtotal, tax and today's total. Checkout leaves the payable total to Stripe; upgrade preview shows the returned signed lines and Due now. The DTO has no separate tax/subtotal fields, so the shell does not invent them. |
| [Square plan switch](https://mobbin.com/screens/c1b701da-2166-4b48-ae96-aea5ca5a4355) | The explicit effective date informs “Switch on <date>” and the scheduled-change line. |
| [Buffer downgrade](https://mobbin.com/screens/58e7f787-dbf2-46bf-bb99-4dd2f135ae1e) | “Here's what changes” before confirmation informs the Standard allowance/size comparison and the loss of larger sizes and overage. |
| [hilos billing](https://mobbin.com/screens/33f3074a-8dd4-48d5-b8ab-f8bbfc12554a) | One large number, bar and “498 of 500 left” inform the compute hierarchy and included-time-left detail. |

Mobbin had no direct machine-size radio-card reference in this research. The Compute selector follows native radio cards, informed by Mintlify/Klaviyo choice cards; it is not attributed to a machine selector screenshot.

### Billing tab: hierarchy and action gates

The header offers Manage billing only when `actions.portal`. The main stack is:

```text
Plan & usage                                      [Manage billing]
Your plan, compute and what renews when.

[Payment banner, when needed]                    [payment action]
┌ EZiL <plan>  (status)                               <price> ┐
│ Allowance · offered sizes                                  │
│ Renews / ends / pending payment / scheduled change         │
│ [Upgrade to Compute] [Switch to Standard] [Cancel / Resume] │
└────────────────────────────────────────────────────────────┘
[Plan picker, when actions.checkout: Standard | Compute]
┌ Compute ───────────────────────────────────────────────────┐
│ <used> of <allowance> standard-hours       ▓▓▓░░░░░░░        │
│ Resets <date> (UTC) · Included time left at each size       │
│ Standard-hour definition and size weights                  │
└────────────────────────────────────────────────────────────┘
[Computer size: native Compute radios / locked plan card]
[Session note; active-session countdown when supplied]
[Usage beyond your allowance: off / on / paused / new terms]
[Next charges: subscription, usage so far, cap on separate lines]
[Saved storage]                            [AI: Coming soon]
[Attention nudge, when a meter needs it]
[Inline action error, when needed]
Invoices: date · Subscription / Usage / Other · amount · View
Support · Refund policy · Plans
```

All purchase and mutation controls use the server's action flags, including at click time; family/status only affect their wording. `checkout` gates the picker, `portal` gates Manage billing and payment-method links, `upgrade` gates Compute upgrades, `downgrade` gates the Standard switch, `cancel` gates cancel/resume, `overage` gates overage controls, and `selectSize` gates radio input. Existing eligible invoice links can open without portal access; a portal fallback still requires `actions.portal`. Requests disable competing controls while pending. A document-wide sheet guard covers checkout and the four billing sheets.

### Plans, payments and meter states

Plan labels are EZiL Free, EZiL Standard, EZiL Compute and EZiL Pro. Free shows $0. Standard/Compute use the matching offer's price; legacy Pro uses `estimate.subscriptionCents` when available. The plan card's allowance comes from the offer when one matches the SKU, otherwise from the meter. The usage meter itself always uses the DTO allowance, including prorated grants.

| `plan.status` | Chip and supporting line | Chip colour (`settings.css`) |
| --- | --- | --- |
| `free` | Current | Neutral: `--surface-2` background, `--muted` text |
| `active` | Active; “Renews <renewsAt>” | Accent tint, `#4fd8de` text |
| `cancels` | Cancels <date>; “Your plan ends <cancelsAt>. You can resume before then.” | Warning tint and `--warn` text |
| `past_due` | Payment failed | Danger tint and `--danger` text |
| `incomplete` | Payment incomplete | Warning tint and `--warn` text |
| `upgrade_pending` | Upgrade pending | Warning tint and `--warn` text |

When the plan is cancelling and `actions.cancel` permits it, Resume plan is the primary action; any eligible Compute upgrade is secondary.

A pending upgrade additionally says “Compute starts once payment is confirmed. This upgrade expires <expiresAt>.” A scheduled downgrade says “Switches to Standard on <effectiveAt>.” It is read-only: there is no undo procedure. Legacy Pro adds “Your original Pro plan, honoured as sold.”

| `plan.paymentIssue` | Banner and resolution |
| --- | --- |
| `payment_failed` | “Your last payment didn't go through. Update your payment method to keep your plan.” Update payment method opens the portal when allowed. |
| `requires_action` | “Your bank needs you to confirm a payment.” Confirm payment resolves the pending-upgrade invoice first, then the newest open subscription invoice with a valid URL, then the permitted portal. |
| `overage_unpaid` | “Overage is paused until your usage invoice is paid. Your computer stops at your included allowance; saved files are kept.” Pay usage invoice resolves the newest open overage invoice, then the permitted portal. |
| `null` | No payment banner. |

Invoice URLs are resolved at click time and validated as HTTP(S); links opened by script use `_blank` with `noopener`. Missing or unsafe URLs never become executable links.

| Meter state | Display |
| --- | --- |
| `ok` | Accent progress bar and normal usage. |
| `low` | Warning colour; attention nudge describing time left or nearly full storage. |
| `exhausted` | Danger colour; allowance-used message and an eligible next action. |
| `over_cap` | Danger colour; compute reports the amount over or storage reports over allowance. The bar clamps at 100%. |
| `unavailable` | No progress bar. Unavailable AI says “Coming soon” / “AI assistant coming soon”, with no amounts or credit-ready claim. |

Paid compute shows used standard-hours rounded up to one decimal and the allowance; Free uses floored hours/minutes and “of <N> h”. When usage exceeds the allowance, “· N over” follows the allowance, with N in standard-hours rounded up. Reset dates are UTC. A single “Included time left: ≈ <time> at 2 vCPU · …” line uses only allowed sizes from `remainingActualSecondsBySize`, with whole hours floored (minutes when below an hour), wrapping as needed. When all remaining values are zero, it reads “No included time left this period.” Paid plans explain “1 standard-hour = 1 hour at 2 vCPU”; Compute also explains the 4/8 vCPU weights. These numbers are driven by the catalog/DTOs.

Storage keeps the existing v1 quota and measured-at display; no future storage target is offered. Available AI retains the v1 balance behavior, while unavailable AI has no dollar amount. Loading uses skeletons and `aria-busy`; a summary error has Retry. Invoices load independently with their own loading, empty and Retry states. The inline action error is `role="alert"`; tRPC failures map `message` (the billing code), not `code` (the transport code), through shared `errorCopy` with a plain fallback.

### Computer size and sessions

Compute uses `fieldset[data-role="size-selector"]` with one native radio inside a label per allowed size: CPU/GiB, “Uses N standard-hour(s) per hour”, and approximate included time left. Changing it calls `selectSize`, locks controls until completion, restores the old selection on failure, and announces “Size saved.” on success. It promises no timing for when the change takes effect.

Standard, legacy Pro and Free show their included size as a static card: `section[data-role="size-selector"]` containing `[data-role="size-locked"]`, captioned “Included with <plan name>”. Free displays its actual 2 vCPU · 6 GiB size; Standard and legacy Pro display 2 vCPU · 8 GiB. The section adds one “Upgrade to Compute for 4 or 8 vCPU” button only when `actions.upgrade`. This is a deliberate design decision after the rendered review: a checked, disabled radio read as a broken control.

The session note appears in a muted callout card: “Sessions run up to 6 hours, then your work is saved and the computer restarts. Files and installed tools are kept; running processes start fresh.” The Billing tab derives the duration from `session.maxSeconds`. When `activeDeadline` exists, the countdown says “This session saves and restarts in <duration>.” and refreshes every 30 seconds. It warns at `warnSeconds[0]`; after the deadline it says “This session is saving and restarting now.” Reload, deactivation, window removal and close clear the interval. The public FAQ also explains idle sleep after 10 minutes, the editor state on disk, and that restarting does not reset the allowance.

### Overage, consent and separate estimates

Overage renders only when the DTO exists and `available`; controls additionally require `actions.overage`. Its included allowance comes from the Compute offer, not a possibly prorated meter.

| State | Copy and controls |
| --- | --- |
| Off | “Off. When your <500> standard-hours are used up, your computer saves and pauses until the next period.” Turn on… opens consent. |
| On | “On · up to <$25.00> a period at <$0.25> per standard-hour.” Accrued this period is shown separately, with Change cap and Turn off. |
| Paused: `cap_reached` | “Overage reached your <$25.00> cap. Your computer saves and pauses until the next period, or raise the cap.” |
| Paused: `payment_failed` | “Overage is off because a usage invoice wasn't paid.” |
| Terms changed | Enabled with unequal accepted/current versions: “The overage terms changed. Review them to keep overage on.” Review terms opens consent again. |

The sheet states the rate, included allowance and separate invoice timing before a **Monthly cap (USD)** numeric input. It accepts whole dollars from 0 through `maxCapCents / 100`; the initial value is the existing cap when enabled, otherwise `defaultCapCents`. The helper translates the cap to extra standard-hours and approximate hours at the largest offered size. The unchecked native consent box reads:

> I agree that usage beyond my allowance is billed separately after each billing period, up to my cap of <$25>.

The displayed amount follows the input. Submit remains disabled unless consent is checked and the cap is a valid integer in range. It sends `setOverage({ enabled:true, capCents, termsVersion })`; errors preserve the entered cap and consent for retry. Turn off needs no new consent and directly sends `enabled:false` with the existing cap and current terms version. Rate, default cap, maximum and terms all come from the DTO.

The estimate never adds subscription and usage into one total. A non-Free plan with both date and amount shows “Next charge on <date>: <$X> subscription before tax.” Missing either shows “No upcoming subscription charge.” Compute with enabled or accrued overage shows “Usage so far: <$Y>, billed separately.” Enabled overage also shows “At your cap: up to <$Z>, billed separately.” Free has no estimate section.

Invoices are newest first, at most 12, with Subscription / Usage / Other badges. In a narrow container, each invoice stacks date + kind pill, description, then amount · status · View. At a container width of 640px or more, it becomes one row: date, description, kind pill, amount, status, View. Paid invoices use `amountPaidCents`; all others use `amountDueCents`. Missing descriptions fall back to `EZiL <kind>`. Money formatting is BigInt-safe; server text is encoded or assigned through `textContent`. An invalid URL leaves a readable invoice row with “Link unavailable”.

### Sheets and payment outcomes

The shared frame is a page-level modal, outside Settings geometry, with a compact layout at 760px. It traps focus, makes the background inert, restores focus and scrolling, and handles Escape, × and owner removal. Backdrop dismissal is suppressed during mutations and pending payment confirmation. Close releases the one-sheet guard and cancels timers/late updates. The Done result action calls `onDone` to reload summary and history; `onClose` fires on every close.

| Sheet | Review and result behavior |
| --- | --- |
| New subscription checkout | `openUpgradeSheet({ sku, offer, sizes, ... })` reviews Standard or Compute with catalog price, standard-hours, offered sizes and a session line. Compute mentions optional overage is off. Stripe supplies the payable total/tax. The compact order summary collapses; Embedded Checkout mounts alongside it when there is room. |
| Compute upgrade | Preview shows each signed invoice line, Due now, the remaining-period grant rounded down, end date and “Your usage so far carries over.” Pay echoes the preview's `prorationDate`; no client amount is sent. Not now is the secondary dismiss button. Preview failure has Retry and no Pay action. |
| Upgrade: `applied` | “You're on EZiL Compute”; Done refreshes the tab. |
| Upgrade: `requires_action` | Ask for bank confirmation; show the validated invoice link when present and explain that the plan changes once payment is confirmed. |
| Upgrade: `payment_failed` | Explain the failed payment and, when supplied, the held-upgrade expiry date/time in UTC. Offer the validated invoice link. A null expiry does not invent a deadline. |
| Downgrade | Before confirmation, show how Standard changes the allowance and size, removes larger sizes and overage, and takes effect at period end. Confirm says Switch on <date>; success uses the returned `effectiveAt`. Keep Compute is the secondary dismiss button, with no mutation. |
| Cancel | Explain that the plan stays active until period end, then moves to Free; resume is possible before then. Cancel plan is the danger action; Keep plan is the secondary dismiss button. Success uses `cancelsAt`. Resume in the tab directly sends `cancel:false`. |
| Overage | The explicit cap/consent flow above; success uses the returned cap. |

Checkout creates only a v2 sellable SKU. A Stripe loader failure retries the same session. The current Stripe Embedded Checkout initializer is preferred with the older initializer retained as fallback. A redirect DTO opens HTTPS checkout in a new tab. While the form is open, a 4-second status watcher can notice a paid session even when Stripe omits its completion callback. Confirmation polls every 1.5 seconds, with a 60-second bound; success requires the exact purchased SKU in `billing.summary`. A timeout distinguishes known payment receipt from unconfirmed payment, and never grants locally. Closing destroys the Stripe instance and ignores late responses. The checkout session line currently uses the pinned six-hour text; unlike the Billing tab, its supplied `OfferDTO` has no session policy field.

### Public pricing and home plans

Both routes use `MarketingHome`; home keeps the hero, decorative desktop, feature tiles, plans, overage, limits, FAQ, closing band and footer. `/pricing` starts directly at Plans, followed by overage, limits, FAQ, closing and footer, with one h1 on either route. `readBillingConfig()` and the existing page call sites are unchanged. `freeV2EffectiveAt?: string | null` defaults to the contract constant and passes through to `getPricingContent` for date-specific rendering.

| Card | Price / included time | Computer | Saved storage |
| --- | --- | --- | --- |
| Free | $0; 8 h/month until the effective date is configured, then 2 h/month for new accounts | 2 vCPU / 6 GiB | `FREE_PLAN.storageBytes` |
| Standard | $20/month; 60 standard-hours/period | 2 vCPU / 8 GiB | `storageCapBytes('pro', largeStorageEnabled)` |
| Compute | $100/month; 500 standard-hours/period | 2–8 vCPU / up to 32 GiB | Same existing paid cap |

These examples come from `CATALOG_V2` and `SIZES`; prices, allowances, session/idle timing, rate and caps are interpolated from the contract. Storage deliberately stays on the existing storage catalog. Cards retain name → price → billing note → CTA → three allowance tiles (compute, computer, storage); Free's effective-date disclosure and Compute's overage note follow the tiles. Compute alone has the accent border and “Larger computers” badge. Free says “USD · no card needed”; paid says “USD · before tax · cancel anytime”. Visible below the cards: “Prices before tax. One computer runs at a time on each plan.”

When `FREE_V2_EFFECTIVE_AT` is set, the Free card says “Accounts created from <date> get 2 h a month; earlier accounts keep 8 h.” The date is formatted in UTC and both allowances are derived from the catalog. With null, Free stays at 8 h and has no transition disclosure. Free links to `/login`; Get Standard / Get Compute preserve `/os?settings=billing&upgrade=standard|compute` through the encoded login `returnUrl`. No Pro card is sold.

The overage section is informational, labelled `overage-title`, and has no purchase controls. It explains the off-by-default rate, whole-dollar cap from $0 to $100 (default $25), saved work and pausing at the cap, and a separate invoice after each billing period. “When you run out” covers compute and saved storage only. Public AI appears only as the AI assistant / coming soon feature tile; no AI dollar amounts, top-ups or plan entitlements.

The FAQ uses visible h3 + p pairs for standard-hours (including 500/250/125 actual hours derived from size weights), every plan's sizes, six-hour sessions and idle sleep, files/editor state on disk/installed tools surviving restarts with processes starting fresh, saved storage, overage caps, monthly advance Stripe billing, overage in arrears on its own invoice, period-end cancel/Standard switches, Compute upgrades after successful prorated payment, tax and shared-capacity availability.

Metadata: “Start free. Upgrade for more compute time and larger computers.” The hero describes upgrading for more compute time or a larger computer. Marketing adds no client code, scripts, images or soft navigation links. Cards stack through 767px, use two columns between 768px and 1023px, and three at 1024px and above. The existing 639px phone breakpoint, `min-width:0`, zero-minimum grid tracks and wrapping protect the 390px layout.

### Copy ban and accessibility

All five specified copy-ban sites use these **16 terms in this order** (`vcpu` is removed); the additional `billing-sheets-test.mjs` regex is identical too:

```js
['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'fair use', 'gpt', 'claude', 'gemini', 'llama', 'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai']
/faster|instant|unlimited|priority|gpu|heavy\s+use|fair\s+use|gpt|claude|gemini|llama|memory\s+is\s+kept|memory\s+survives|processes\s+keep\s+running|ai\s+included|includes\s+ai/i
```

The sites are `shell/ezil/ui/Settings/billing-test.mjs`, `shell/ezil/ui/Settings/upgrade-sheet-test.mjs`, `app/src/app/(marketing)/pricing/pricing.test.ts`, `e2e/billing-e2e-lib.mjs` (`scanCopy` array), and `e2e/billing-e2e.test.mjs` (positive controls). Substring matching is case-insensitive; whitespace within phrases is normalized. The required session sentence passes. Pricing scans content, metadata, rendered HTML/accessibility labels and comment-free sources, including both storage and Free-policy branches.

Keep §1's tokens, 12px cards, 8px controls, 999px pills, tabular numerals, 2px accent focus-visible outlines and reduced motion. Shell layout uses the existing Settings container queries with wrapping and zero minimum widths for 360–1280px windows. Every control has an accessible name; selectable sizes use native labelled radios and an announced status. Meters carry named progressbar semantics, numeric bounds and usage text; unavailable meters omit the bar. Sheets have a labelled dialog with `aria-modal`, focus trapping/restoration and native labelled number/checkbox inputs. Server strings use `html_encode` or `textContent`; money is formatted without unsafe BigInt conversion.

`e2e/billing-v2-screens.mjs` boots the committed shell bundle in headless Chromium behind `page.route`-style interception on `http://localhost` (implemented with `context.route` to cover popups). It uses no listening port or Stripe connection: a fake `window.Stripe` supplies the payment placeholder, and v2 DTO fixtures answer tRPC. It captures every tab state (15), every sheet state (10), and pricing/home including the Free effective-date variant at 390×844 and 1280×800. Page errors, missing selectors, horizontal overflow or banned copy fail the run. Usage (output must be outside the repository):

```sh
PLAYWRIGHT_REQUIRE_DIR=<dir with playwright> node e2e/billing-v2-screens.mjs --out <dir> [--only <substring>]
```

### v2 pinned selectors

Shell selectors are scoped to `.ezil-settings-pane[data-pane="billing"]`, except page-level sheets. This table records the implemented selectors, including both computer-size forms.

| Element | Selector |
| --- | --- |
| Body / loading / error | `[data-role="billing-body"]`, `.ezil-billing-skeleton`, `[data-action="retry"]` |
| Payment banner | `[data-role="payment-banner"][data-issue="payment_failed\|requires_action\|overage_unpaid"]` |
| Banner actions | `[data-action="portal"]` (Update payment method), `[data-action="open-invoice"][data-kind="subscription\|overage"]` (Confirm payment / Pay usage invoice) |
| Header action | `[data-action="portal"]` (Manage billing) |
| Plan card / status | `[data-role="plan-card"][data-family="free\|standard\|compute\|pro_legacy"]`, `[data-role="plan-status"][data-status="<PlanStatusV2>"]` |
| Plan actions | `[data-role="plan-actions"]` with `[data-action="upgrade"]`, `[data-action="downgrade"]`, `[data-action="cancel"]`, `[data-action="resume"]` |
| Plan picker | `[data-role="plan-picker"]`, `[data-action="checkout"][data-sku="standard_monthly_v2\|compute_monthly_v2"]` |
| Compute meter | `[data-meter="compute"].is-<MeterState>`, `[role="progressbar"]`, `[data-role="size-hours"] [data-size="<SizeCode>"]` |
| Size selector | Compute: `fieldset[data-role="size-selector"]` with `input[type="radio"][name="ezil-billing-size"][value="<SizeCode>"]`; otherwise: `section[data-role="size-selector"]` containing `[data-role="size-locked"]`; both: `[data-role="size-status"]` |
| Session | `[data-role="session-note"]`, `[data-role="session-countdown"]` |
| Overage | `[data-role="overage"][data-enabled="true\|false"]`, `[data-action="overage"]`, `[data-action="overage-off"]`, `[data-role="overage-paused"][data-reason="cap_reached\|payment_failed"]` |
| Estimate | `[data-role="estimate"]` |
| Storage / AI meters | `[data-meter="storage"]`, `[data-meter="ai"]` |
| Nudge | `[data-role="billing-nudge"]` |
| Action error | `[data-role="billing-action-error"]` (`role="alert"`) |
| Invoices | `[data-role="invoices"]`, `[data-role="invoice-rows"]`, `[data-role="invoices-empty"]`, `.ezil-billing-invoice`, `[data-role="invoice-kind"][data-kind="subscription\|overage\|other"]` |
| Billing sheets | `[data-role="billing-sheet"][data-sheet="upgrade\|downgrade\|cancel\|overage"]` (`role="dialog"`, `aria-modal="true"`) |
| Sheet close / confirm / result | `[data-action="close-sheet"]`, `[data-action="confirm"]`, `[data-action="done"]` |
| Checkout sheet / mount / success | `[data-role="upgrade-sheet"]`, `#ezil-embedded-checkout`, `[data-role="upgrade-success"]` |
| Home hero / primary / sign-in | `[data-testid="home-hero"] h1`, `[data-testid="cta-start-free"]`, `[data-testid="cta-sign-in"]` |
| Public plan section / cards | `#plans`, `[data-testid="plan-free"]`, `[data-testid="plan-standard"]`, `[data-testid="plan-compute"]` |
| Paid public CTAs | `[data-testid="cta-get-standard"]`, `[data-testid="cta-get-compute"]` |
| Public allowance tiles | `[data-testid="allowance-<free\|standard\|compute>-<compute\|computer\|storage>"]` |
| Public overage section | `[aria-labelledby="overage-title"]`, `#overage-title` |

The pipe-separated values above enumerate alternatives; they are not literal CSS attribute values.

### Open integration items

`e2e/billing-home.mjs` still targets the Pro CTA/card and v1 allowance text; its assertions need to follow the three public cards. `e2e/billing-checkout.mjs` still supplies a v1 fake and asserts `pro_monthly_v1`, so it cannot validate the v2 checkout. `CONTRACT.md` §8 still bans `vcpu`; v2's list above is authoritative for these surfaces.

A `requires_action` renewal has no hosted-invoice URL in `PlanSummaryV2`; only `pendingUpgrade.hostedInvoiceUrl` is supplied. The UI therefore falls back to the newest open subscription invoice with a valid URL in history, then the portal when `actions.portal` permits it. The checkout sheet's session line is fixed six-hour text because `OfferDTO` carries no session policy. No new DTO fields were invented.
