# Billing and compute UI — design spec v1 (2026-10-08)

Research: Mobbin (web). The behaviour contract stays [`CONTRACT.md`](CONTRACT.md) C4 + A1–A9; this file only governs layout, hierarchy and copy.
Implementation lives in `shell/ezil/ui/Billing/**` and `shell/ezil/ui/Billing/billing.css`, reusing the Settings tokens in `shell/ezil/ui/Settings/settings.css`:
- dark surface
- `rgba(245,245,244,·)` text and borders
- teal primary `#00adb5` with `#06181a` text
- 6 px control radius

No new colours except one amber (`#f2b950`) for warnings and one red (`#f87171`) for errors, both on a 12 % tint background.

## What the references agree on

| pattern | seen in | apply as |
|---|---|---|
| **One big number, then the action.** Balance or price is the largest type in the dialog. A single primary CTA sits bottom-right; Cancel is secondary. | [Vercel Buy AI Gateway Credit](https://mobbin.com/screens/3d5fac7c-290b-493f-89ba-0ee875052871), [Bloom Buy Credits](https://mobbin.com/screens/fd6280fc-6354-46cd-81e3-8b706ee77072), [Replit Top up credits](https://mobbin.com/screens/cba4035a-8111-4fbf-a922-40fc4fbb1408) | Dialog headline states the problem. Below it, a balance block shows the shortfall as the large figure. |
| **Preset amount chips** ($10 / $20 / $50 / Custom) instead of a free text field | Vercel, Replit, [Grok Purchase credits](https://mobbin.com/screens/61c6b9ed-8ee1-4b68-9912-0268aa5dab7c) | Out of scope for this PR (checkout is hosted). The top-up button opens hosted checkout; the chips belong to the checkout page. |
| **Top-up is "without changing your plan"; upgrade is a different purchase** | Bloom subtitle "Top up without changing your plan", [Manus Add more credits](https://mobbin.com/screens/5d939f30-cac6-438d-8aa0-2a0a250a2121) (explains what changes, renewal date) | Two visually distinct cards in the 402 dialog, never two equal buttons: **Top up** ("Adds to purchased credit · plan unchanged") and **Upgrade to EZiL Cloud** ("$20 AI credit each paid period · bigger computers"). |
| **Included vs purchased shown separately, with the renewal date** | [Sora Usage](https://mobbin.com/screens/daf320d0-0f21-40e1-830c-42873761ea34) ("29 free · more available on Nov 14 / 0 paid · used when free runs out"), [Manus Usage](https://mobbin.com/screens/8e82ac30-f4c1-47eb-b2e3-b26041bf8b15), [Klaviyo Composer usage](https://mobbin.com/screens/16a19718-2429-4873-b583-0d473e84ce94) (progress bar) | Wallet popover: two rows. "Included" has a progress bar and "renews {date}". "Purchased" has the line "used after included credit". |
| **Size cards: name, spec rows with icons, price per hour; locked tiers show an upgrade banner above the grid** | [Supabase Compute and Disk](https://mobbin.com/screens/fa90b107-be68-41a2-bd91-04816a512cfd), [PlanetScale clusters](https://mobbin.com/screens/b19aa2a5-b68a-4591-8d2b-6d8b736a3ae8), [Render instance type](https://mobbin.com/screens/4ab34a01-7660-4cf9-8be5-a44f3f617402), [Railway replica limits](https://mobbin.com/screens/714a17b6-23d6-4ffe-b122-67e7da8c7d5e) ("Upgrade for higher limits") | Compute-size section becomes a 2-card radio grid. The current size has a teal ring and a "Current" pill. A locked card is dimmed to 60 % with a lock glyph and "Included with EZiL Cloud". One inline banner sits above the grid with an Upgrade button. **No prices** until the founder sets them (§4 of PLAN). |
| **Error state stays in the conversation; the composer keeps the draft** | [Obvious](https://mobbin.com/screens/0f5a43f5-12a4-4bab-b79a-2c90f83a7ce8) (slim "Something went wrong · Retry" bar above the composer), [Emergent Credit Exhausted](https://mobbin.com/screens/821ee5aa-8dbc-4885-ac84-265a17a7cc9b) (inline card with Buy Credits) | Rate-limit, service and provider failures use the **inline composer bar**, not a modal: icon, one line, countdown, Retry. Only 402 (money or plan) opens the modal, because it needs a decision. |
| **Avoid:** full-screen plan wall for a single refusal | [Krea plan wall](https://mobbin.com/screens/dffee797-6dd4-4dc2-8fb5-a26404efdf99) | We never block the whole OS. The dialog is max 440 px and Escape closes it. |

## Components

### 1. 402 dialog (`createBillingPopup`, kinds `topup` / `subscribe`)
```
┌──────────────────────────────────────────┐
│ Not enough AI credit                    × │  16/600
│ This request needs $1.20. Your draft is   │  13 secondary
│ kept and won't be sent until you resend.  │
│ ┌──────────────┬───────────────────────┐ │
│ │ Included     │ Purchased             │ │  12 secondary
│ │ $0.00        │ $0.25                 │ │  22/600 tabular-nums
│ │ renews Nov 7 │ used after included   │ │  11 tertiary
│ └──────────────┴───────────────────────┘ │
│ ┌ Top up ───────────────────────────── ›┐ │  card: teal border when the primary action
│ │ Adds purchased credit · plan unchanged│ │
│ └───────────────────────────────────────┘ │
│ ┌ Upgrade to EZiL Cloud ────────────── ›┐ │  card: neutral border
│ │ $20 AI credit each period · 4 vCPU    │ │  (copy from config; no price if unset)
│ └───────────────────────────────────────┘ │
│                        [Close] [Resend ↻] │  Resend disabled until the balance refresh shows ≥ required
└──────────────────────────────────────────┘
```
- `insufficient_credits`: the Top up card is primary. Upgrade is shown when `actions` includes `subscribe`.
- `no_entitlement`: the headline is "An EZiL Cloud plan is needed for AI". The Upgrade card is primary and there is no Top up card.
- While a checkout is open: the cards are replaced by "Waiting for payment confirmation…" with a spinner. The copy says the balance updates only after the payment is confirmed (return URL ≠ payment). Bounded polling as today. On timeout: "Payment not confirmed yet. We'll update your balance when it is."
- Focus lands on the primary card. Escape and × close the dialog. `role="dialog"`, `aria-labelledby` the headline. Everything is reachable by keyboard.

### 2. Inline composer bar (`createComposerNotice`, kinds `retry_later` / `provider` / `unknown`)
- One 36 px row above the composer: icon, message, right-aligned action.
- `retry_later`: amber. "Usage limit reached. Try again in 0:42." A live countdown from `retryAfterSeconds`; Retry is disabled until it reaches zero. A 503 service code reads "AI is temporarily paused. Try again shortly."
- `provider`: red. "The model provider failed." plus a second clause:
  - `charge:"none"`: "Nothing was charged."
  - otherwise: "Any usage will be reconciled and charged once."
  - Action: Retry.
- Never offers top-up. The draft stays in the composer. Retry calls `onResend(draft)` once per click.
- `attachToChat` routes 402 to the dialog and everything else to the bar.

### 3. Wallet badge and popover (`createWalletBadge`)
- Badge: "$20.25" in tabular numerals with a small bar showing the included fraction left. Clicking opens a 280 px popover with two rows:
  - "Included" has a progress bar (remaining ÷ period grant), the amount and "renews {date}".
  - "Purchased" has the amount and "used after included credit".
- Footer: [Top up] (secondary) and, for the free plan, [Upgrade] (primary).
- v1 (legacy) wallets show only the legacy formatted balance, with no bars.

### 4. Compute size (`mountComputeSize`)
- Header "Computer size". Sub-line: "vCPUs are virtual CPU allocations, not physical cores."
- When any shape is locked, one inline banner sits above the grid: lock glyph, "Bigger computers are included with EZiL Cloud", [Upgrade].
- Cards (2-column grid, 1 column under 520 px). Each card has the name, then three spec rows with 14 px icons: CPU "2 vCPU", Memory "6 GiB", Disk "16 GB".
- The current card has a teal 2 px ring and a "Current" pill. A locked card is at 60 % opacity with a lock glyph and "Requires EZiL Cloud".
- Selecting a different eligible card shows a confirm sheet: "Restart into Performance (4 vCPU · 12 GiB)? Your files are kept. Open apps, terminals and unsaved editor changes are closed." [Cancel] [Restart and resize].

## States to verify (Chromium, both 1000×760 and 390×844)
1. 402 insufficient, free plan
2. 402 insufficient, subscriber
3. 402 no_entitlement
4. waiting for payment
5. payment not confirmed (timeout)
6. 429 countdown
7. 503 pause
8. provider with charge none
9. provider with charge pending_review
10. wallet popover, v2 subscriber
11. wallet popover, v1 legacy
12. picker, free (locked)
13. picker, subscriber
14. resize confirm
