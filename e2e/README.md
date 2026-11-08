## Fast live deployment check

With `EZIL_E2E_EMAIL`, `EZIL_E2E_PASSWORD`, and `PLAYWRIGHT_REQUIRE_DIR` already set in the environment, run:

```sh
EZIL_E2E_APP=https://os.ezil.work EZIL_LIVE_OUT=/tmp/ezil-live-check node e2e/live-check.mjs
```

`EZIL_E2E_APP` accepts a deployment origin, including a preview URL; it defaults to production. `PLAYWRIGHT_REQUIRE_DIR` is the directory from which `require('playwright')` resolves, with Chromium installed. The shared deployment helpers scope `VERCEL_AUTOMATION_BYPASS_SECRET` to the app origin and use context cookies for API requests. Supply credentials through the environment; the script reads no credential files.

The suite signs in, waits for `/os`, opens Browser from the taskbar and verifies actual video pixels, reads and renews the relay, opens Code and a new terminal, proves tmux and `opencode --version` work, and writes `/root/.ezil-live-mark`. It closes windows, requires a real destroyed/terminated stop, reloads the same computer, checks cold Browser pixels, closes the desktop, and reads the saved marker in a new Code terminal (also checking `opencode` again). Use a dedicated test account: this stops its selected cloud computer and overwrites that marker. The cold check leaves the computer running.

Designed for a normal run under five minutes (the reference prototype passed in 160 seconds); the whole process has an eight-minute hard cap, including evidence and shutdown. Transient navigation connection changes retry up to five times within the current check's budget. `EZIL_LIVE_SKIP_COLD=1` runs only the warm checks and window close, skipping the real stop and cold persistence checks; its PASS applies only to those emitted checks.

Each executed check emits one JSON line `{check, ok, ms}`, followed by `{result: "PASS" | "FAIL", checks: [...]}`. The first failed check stops the sequence and exits 1. Evidence defaults to `/tmp/ezil-live-check`, or `EZIL_LIVE_OUT`: `live-check.json` contains the final report and `live-failure.png` is attempted on browser failures. Screenshots preserve host layout but hide text, inputs, images, and remote frames; reports omit credentials, cookies, URLs, IDs, API bodies, and driver errors. No trace or raw terminal output is saved.

Browser-free validation: `node --check e2e/live-check.mjs` and `node --test e2e/live-check.test.mjs`.

## PR preview slot smoke

`os-preview-smoke.mjs` checks one PR preview slot (`deploy/aws/os-staging/preview/README.md`) after the `os-pr-preview` workflow deploys it:

```sh
EZIL_E2E_APP=https://os-pv1.ezil.work EZIL_PREVIEW_SHA=<40-hex head> node e2e/os-preview-smoke.mjs
```

`EZIL_E2E_APP` must be exactly a slot origin (`https://os-pv<N>.ezil.work`). The script checks:
- `/api/health` reports `EZIL_PREVIEW_SHA`;
- signed-out `/login` renders without horizontal overflow at desktop and phone sizes, with every write aborted;
- Auth0's `redirect_uri` is the slot's own callback, not production.

With `EZIL_E2E_EMAIL`/`EZIL_E2E_PASSWORD` it also signs in and opens `/os` at both sizes, aborting every non-GET request, so it never starts a computer or sends chat. Exit codes: 0 PASS, 1 FAIL, 3 PARTIAL (no QA identity: never a pass), 2 unable to run. Evidence goes to `EZIL_LIVE_OUT` (default `/tmp/ezil-preview-smoke`) and is redacted like `live-check.mjs`.

Browser-free validation: `node --check e2e/os-preview-smoke.mjs` and `node --test e2e/os-preview-smoke.test.mjs`.
