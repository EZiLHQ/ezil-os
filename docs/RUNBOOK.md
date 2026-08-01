# Getting EZiL-OS running — a native-feeling computer

Status: the repo is complete and tests pass, but **nothing has served a user yet.**
This is the plan from "code exists" to "a freelancer opens a real computer."

---

## What "native-feeling" actually requires

Six things, in the order a user meets them:

| # | Requirement | Status |
|---|---|---|
| 1 | It exists — deployed, reachable | ❌ nothing deployed |
| 2 | Boot is legible, not a blank spinner for ~22s | ❌ phases logged but not surfaced |
| 3 | It opens to a **populated** workspace | ❌ template absent from image |
| 4 | Keyboard/mouse actually reach apps | ✅ proven by XTEST injection |
| 5 | It feels responsive | ⚠️ encoder tuned; TURN relay is a hard floor |
| 6 | Work survives closing the tab | ✅ hydrate + 10s flush, put-only |

4 and 6 are done. 1, 2 and 3 are the gap between "works" and "feels like a computer."

---

## Wave A — make it exist

**A1. Database + environment.** Apply `app/drizzle/0000_*.sql` to Supabase. Write
`.env.local` for `app/`. The one constraint that breaks everything silently:
`CLOUDFLARE_GUACAMOLE_HMAC_SECRET` must **byte-match** the Worker's
`SANDBOX_HMAC_SECRET`.

**A2. Put the template in the image.** `/opt/ezil-sandbox-template` does not exist in
the built container — seeding has always been a silent no-op behind a `|| true` guard.
This is why a new computer boots empty. Build a real starter workspace into the image
and verify it lands.

**A3. Deploy.** Worker to its own Cloudflare project. Then the app.

## Wave B — make it feel native

**B1. Boot phase checklist.** The Worker already emits `[ezil-boot]` phases with elapsed
ms. Surface them: *Waking machine → Mounting your files → Starting desktop →
Connecting display*. Research finding: past ~5 seconds a bare spinner reads as frozen. We
have ~22 to account for, and the data to do it honestly.

**B2. Desktop chrome.** A thin strip **outside** the stream — back to computers, name,
status, fullscreen. Everything else is desktop. The reference is Codespaces: minimal
chrome, the real tool owns the viewport.

## Wave C — prove it

Live end-to-end, in this order, each gating the next:
1. Sign in → `/computers` → create → boots
2. **Type in VS Code. Click in Chrome.** Input is the difference between a computer and a video.
3. Write a file → close tab → reopen → **file is there**
4. Second computer is isolated from the first
5. Third create is refused
6. Measure real click-to-paint against the ≤80ms p50 budget

---

## Known constraints — design around these, they are not bugs

- **TURN relay is the latency floor.** Cloudflare Containers expose no UDP, so both
  WebRTC peers relay. Not tunable without leaving the platform. The HTTP iframe preview
  is lower-latency than the desktop for anything renderable as a web page.
- **No GPU.** All rendering and encoding is software, competing with the compiler.
- **Containers can vanish without notice.** Persistence must stay eager; the 10s flush is
  the design response.
- **`/os`'s first paint has a ~400-650ms floor, not the <200ms this project informally
  aimed at.** A protected page has to know the visitor really is who their cookie claims
  before it can decide to render anything (redirecting to `/login` otherwise), and that
  decision has to be made before the first byte goes out — there is no way to paint first
  and redirect later without either trusting an unverified session or moving the
  auth-vs-redirect decision to the client. So one Supabase Auth round trip
  (`supabase.auth.getUser()`, 150-300ms depending on host/network, up to ~700ms observed
  on a loaded shared dev host) plus one database lookup for the user's computer
  (~120-240ms) are both on the critical path before anything paints. MEASURED,
  production build, localhost, zero client network latency, median of 8 warm loads:
  **TTFB 410ms, taskbar on screen 618ms** (see `docs/PLATFORM-NOTES.md` §15 and §17).
  Streaming the wallpaper ahead of that lookup was considered and rejected: `/os` is not
  a React page, it is two `<script src>` tags that must run deterministically, and
  resolving them behind a React Suspense boundary reintroduces the exact hazard §14
  documents — content a streaming response inserts after the initial parse is not
  guaranteed to execute the same way a parser-inserted `<script>` does. Getting under
  200ms for real needs one of: local JWT verification (`supabase.auth.getClaims()` —
  this project already issues ES256 tokens, so this is possible; the cost is not seeing a
  revocation until the token expires) or deploying the app in the database's region.
  Neither is a change made here. Until one of those lands, **the honest target for `/os`
  is 400-650ms, not <200ms** — treat a number in that range as success, not as a miss.
- **`max_instances`** is committed at 20; the owner answered 3. At 2 computers/user, 3
  supports exactly one person. **Needs settling before real users.**

## Open, owner-side

🔴 Key rotation — `<path-redacted>/KEY-ROTATION-REQUIRED.md`, end of day.
`CLOUDFLARE_GUACAMOLE_HMAC_SECRET` and the Worker's `SANDBOX_HMAC_SECRET` rotate
**together**; Worker secrets are versioned, so a rollback silently reverts a rotated one.
