## Fast live deployment check

With `EZIL_E2E_EMAIL`, `EZIL_E2E_PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `PLAYWRIGHT_REQUIRE_DIR` already set in the environment, run:

```sh
EZIL_E2E_APP=https://os.ezil.work EZIL_LIVE_OUT=/tmp/ezil-live-check node e2e/live-check.mjs
```

`EZIL_E2E_APP` accepts a deployment origin, including a preview URL; it defaults to production. `PLAYWRIGHT_REQUIRE_DIR` is the directory from which `require('playwright')` resolves, with Chromium installed. The shared deployment helpers scope `VERCEL_AUTOMATION_BYPASS_SECRET` to the app origin and use context cookies for API requests. Supply credentials through the environment; the script reads no credential files.

The suite signs in without the login UI (see below), waits for `/os`, opens Browser from the taskbar and verifies actual video pixels, reads and renews the relay, opens Code and a new terminal, proves tmux and `opencode --version` work, and writes `/root/.ezil-live-mark`. It closes windows, requires a real destroyed/terminated stop, reloads the same computer, checks cold Browser pixels, closes the desktop, and reads the saved marker in a new Code terminal (also checking `opencode` again). Use a dedicated test account: this stops its selected cloud computer and overwrites that marker. The cold check leaves the computer running.

Designed for a normal run under five minutes (the reference prototype passed in 160 seconds); the whole process has an eight-minute hard cap, including evidence and shutdown. Transient navigation connection changes retry up to five times within the current check's budget. `EZIL_LIVE_SKIP_COLD=1` runs only the warm checks and window close, skipping the real stop and cold persistence checks; its PASS applies only to those emitted checks.

Each executed check emits one JSON line `{check, ok, ms}`, followed by `{result: "PASS" | "FAIL", checks: [...]}`. The first failed check stops the sequence and exits 1. Evidence defaults to `/tmp/ezil-live-check`, or `EZIL_LIVE_OUT`: `live-check.json` contains the final report and `live-failure.png` is attempted on browser failures. Screenshots preserve host layout but hide text, inputs, images, and remote frames; reports omit credentials, cookies, URLs, IDs, API bodies, and driver errors. No trace or raw terminal output is saved.

Browser-free validation: `node --check e2e/live-check.mjs` and `node --test e2e/live-check.test.mjs`.

## Signing in without the UI

`/login` offers only "Continue with EZiL ID" (Auth0), which automation cannot drive, so every hosted harness signs in through `e2e/sign-in.mjs` instead. It performs the Supabase Auth password grant for `EZIL_E2E_EMAIL` (`POST $NEXT_PUBLIC_SUPABASE_URL/auth/v1/token?grant_type=password` with the anon key), writes the session into the browser context as the app's Supabase SSR auth cookie exactly as `@supabase/ssr` would (`__Host-ezil-os-auth`, split into `.0`, `.1`, … chunks when large, on HTTPS; `sb-<ref>-auth-token` on loopback HTTP), then loads the destination and fails if it lands on `/login`.

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are the target app's own public values (the anon key ships in every browser bundle). The test account needs an email/password identity on that Supabase project, and the project must allow the password grant. Failures are fixed messages (`refused (HTTP <status> <code>)`, `request failed`, `cookie was not accepted`, `did not reach its destination`) that never include credentials, cookies or tokens. Browser-free validation: `node --test e2e/sign-in.test.mjs`; its `@supabase/ssr` parity case runs where the app's dependencies are installed.

## Production user journeys

`e2e/prod-journeys.mjs` runs what a signed-in user does, against a deployed host, and makes a failure diagnosable. `live-check.mjs` says whether a deployment is healthy and keeps no detail on purpose; this suite is for "the user clicked Code and got *Something went wrong*, and feedback only said `unauthorized`". On any failed step it records, in the JSON report and next to it as a screenshot:

- the HTTP status and body error **code** of every failing `/api/*` response (pathname only, no query, no message text, never a token or cookie). Refusals that arrive as HTTP 200 (`{ ok: false, error: 'computer_stopped' }` from the shell routes) count; the wake loop's expected `sandbox_starting` is flagged `pending` and counted once;
- console errors and uncaught page errors (redacted, URL queries stripped);
- the error text the user can see (a failed opening panel, Code's "isn't reachable" panel, alerts, the feedback result);
- a screenshot of the shell. Remote pixels, frames, form values and Settings' Account pane are hidden; shell text is not, because the error copy is the evidence.

```sh
EZIL_E2E_APP=https://os-prod.ezil.work EZIL_E2E_EMAIL=… EZIL_E2E_PASSWORD=… \
NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… PLAYWRIGHT_REQUIRE_DIR=/path/with/playwright \
EZIL_E2E_JOURNEYS=free-open-apps,feedback-diagnostics,billing-view node e2e/prod-journeys.mjs
```

| Variable | Meaning |
| --- | --- |
| `EZIL_E2E_APP` | Required, an HTTPS origin. There is no default: a run never lands on a host you did not name. |
| `EZIL_E2E_EMAIL`, `EZIL_E2E_PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `PLAYWRIGHT_REQUIRE_DIR` | Required; sign-in is `e2e/sign-in.mjs` (see below). |
| `EZIL_E2E_JOURNEYS` | Comma list of `free-open-apps`, `paid-aws-computer`, `feedback-diagnostics`, `billing-view`. Default: all but `paid-aws-computer`. Unknown names are an error. |
| `EZIL_E2E_OUT` | Evidence directory (default `<tmpdir>/ezil-prod-journeys`): `prod-journeys.json`, rewritten after every step, plus `<journey>-<step>.png`. |
| `EZIL_E2E_APP_TIMEOUT_MS` | Code or Browser ready, per app (default 240000). |
| `EZIL_E2E_AWS_TIMEOUT_MS`, `EZIL_E2E_AWS_WAKE_TIMEOUT_MS`, `EZIL_E2E_AWS_STOPPED_TIMEOUT_MS` | First-boot desktop (default 900000), wake (600000), and wait for `STOPPED` (300000). |
| `EZIL_E2E_AWS_COMPUTER` | `new` (default) or `reuse` this suite's computer from an earlier run. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Optional, scoped to the app origin by `deployed-target.mjs`. |

"Ready" means what the user sees. Code is ready when `.monaco-workbench` is visible AND no opening overlay covers its window; Browser when its `<video>` (or, with no video element, a visible canvas) has non-blank pixels AND no overlay covers its window. The overlay is any visible `.ezil-app-spinner`, `.ezil-boot`, `.ezil-code-unavailable` or `.ezil-preview-unavailable` in that window, judged by computed style (`hidden`, `display:none`, `visibility:hidden`, opacity near 0 and a collapsed box all count as gone), and the ready state must hold for 700 ms. The viewer streams behind the opening surface before the shell retires it, so pixels alone are not ready. A timeout names what was still on screen (`video pixels present but opening overlay visible ("Opening the window")`).

Each app's evidence has `firstPixelsMs` (Browser) or `firstEditorMs` (Code), `overlaySeenMs`, `overlayGoneMs` and `readyMs`, all from the click. Right after an app is ready the suite brings its window to the front (its title bar, else the window manager's focus) and takes `<journey>-<app>-ready.png` (`free-open-apps-code-ready.png`, `free-open-apps-browser-ready.png`; in the paid journey `-browser-ready`, `-code-ready` and `-browser-wake-ready`). These ready shots show the app's own pixels, so use a dedicated QA account; shots of failures hide remote frames.

Every dock click goes through one routine. A ready Browser goes full-bleed (`go_fullbleed`), which hides the taskbar and the window head, so the next dock icon (the paid journey's Code) cannot be clicked. The suite checks that the icon is painted and topmost at its centre; if not, and a full-bleed window is the cause, it reveals the dock as a user does: open that window's control drawer (the handle labelled "Window controls") and press **Minimise**, which restores the taskbar before it hides the window. If the drawer cannot be driven it calls the window's own minimise hook, the function that button calls. It never closes a window. `evidence.dock` lists each click as `{app, path, minimised?}` with `path` one of `direct`, `drawer-minimise`, `minimise-hook`; a dock that cannot be reached fails the step with the reason (`Code icon is not clickable (the dock is hidden behind a full-bleed window; desktop was minimised via drawer-minimise)`).

Journeys, in this order (each step is `{name, ok, ms, error?}`; time-to-ready is the step's `ms`):

- `free-open-apps`: sign in, `/os` session ready, click **Code**, run a nonce `printf` in a new Code terminal, click **Browser**.
- `paid-aws-computer`: a paid account only. Checks `billing.summary` is not Free and that no other computer of the account already runs on AWS (the server refuses a second one), creates a **new** computer, makes it the shell's current computer, opens the Browser and waits for pixels (`timeToDesktopMs`), asserts `computer.progress` shows an EC2 placement, opens Code, stops it and waits for `STOPPED`, wakes it through the Browser and waits for pixels again, then stops it. The final stop runs even after a failure and prints the computer id (`{"event":"computer", …}`).
- `feedback-diagnostics`: Settings → Feedback → send `[QA automated] …` with diagnostics, assert a 2xx and report what the request carried: field names only, whether `traceId` (the correlation id) and server error codes (`api_failure` events) were present. The description is never recorded.
- `billing-view`: Settings → Billing, read only (no checkout, no `upgrade=` link): plan, AI credits, computer-time allowance, storage as the user sees them.

Exit 0 when every selected journey passed, 1 when one failed, 2 when the inputs are unusable. A hard deadline (the sum of the selected journeys' budgets, plus the final-stop reserve) writes the report and exits 1.

Safety:

- **Use dedicated QA accounts only.** Journeys open apps and wake computers on whatever account signs in. Nothing is deleted, reset, switched or restarted.
- **`paid-aws-computer` costs money while it runs.** It creates one computer named `[QA automated] aws-journey <id>`, stops only that computer (by explicit id, and it refuses any other), and stops it again at the end. The web shell has no "new computer" button, so it calls the app's own `computer.create` and selects the result in the shell. An account holds at most two computers; delete the suite's computer afterwards (Settings → Computer → Older computer), or run with `EZIL_E2E_AWS_COMPUTER=reuse` to reuse it. Opening it makes it the account's most recently opened computer, which `/os` then boots into.
- Feedback reports are left in place; their `[QA automated]` prefix is how to filter them. The diagnostics come from the page that sends them, so whether failure codes reach a report is only visible when `feedback-diagnostics` runs in the same invocation as an app journey (its `recentEvents` hold that page's earlier `api_failure` codes).
- `free-open-apps` wakes whatever computer the account signs in to, so on a paid account it wakes the AWS computer and leaves it running until it idles out. Code and Browser are measured independently: a failed Code does not skip Browser, and in the paid journey a failed Code does not skip the stop and wake checks.
- `PLAYWRIGHT_REQUIRE_DIR` must hold a Playwright whose browser is installed (`chromium_headless_shell` for the headless launch); otherwise every journey fails at `browser-launch`.
- Nothing credential-like is printed or saved: emails are masked as `q***@domain`, and tokens, bearer values, auth cookies, the password and the anon key are scrubbed from every log line and report.

Browser-free validation: `node --check e2e/prod-journeys.mjs` and `node --test e2e/prod-journeys.test.mjs`. With `PLAYWRIGHT_REQUIRE_DIR` set, extra tests drive the in-page overlay detection and the dock reveal in Chromium over markup mirroring the shell's (still offline); without it they are skipped.
