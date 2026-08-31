# Performance baseline — where EZiL-OS's time actually goes

Measured against **live production** on **2026-08-19, 14:05–15:00 UTC**: the
Next.js app on Vercel, the `ezil-os-worker` Worker on Cloudflare, a `standard-3`
container (2 vCPU / 8 GiB), one test account, one computer, one sandbox.

Read-only throughout: desktops were opened and used; **nothing was deleted, no
setting was changed, nothing was deployed, no source file was modified, no
Worker var or secret was set.**

---

> ## Read this first — four limits on everything below
>
> **1. One account, one computer, one sandbox.** Every production open measured
> here went to the same Durable-Object-pinned sandbox. These numbers describe
> *that* container across cold and warm starts. They are not a fleet.
>
> **2. One client, one network.** Headless Chromium 1.61.1 on an Azure Linux
> host. Every RTT, jitter and page-load figure carries that network's
> characteristics.
>
> **3. Historical telemetry is two people.** 78 stored `boot_summary` rows from
> 4 distinct users, **76 of them (97 %) from two people**, one of whom
> contributed 18 inside a single 94-minute sitting. §8 is a case study, not a
> service level.
>
> **4. The measuring instrument was verified before its central claim was
> believed.** The headline finding is that the desktop renders a completely
> black picture. Before trusting that, the readback was calibrated: the *same*
> headless Chromium, the *same* `drawImage(video)` + `getImageData` code, fed by
> a real local `RTCPeerConnection` VP8 loop, returned `meanLuma 197.97`,
> `nonzeroFrac 1.0000`. Playwright's compositor screenshot — a path sharing no
> code with it — agrees on every open. A zero from this instrument is a real
> black picture.

---

## 0. The answer, ranked

| # | where the problem is | size | confidence |
|---|---|---|---|
| **1** | **The desktop shows nothing at all.** 13 of 13 production opens rendered every sampled pixel exactly 0, while the product reported `ready`. | total product failure | **measured, 13/13** |
| **2** | **Cold container boot** — 20.7–28.2 s of a 27–34 s cold open. | ~85 % of a cold open | measured, n=2 live + n=39 spool |
| **3** | **~6 s of fixed post-navigation cost on every open**, warm or cold, most of it a 4 s timer and a 6 s deadline rather than work. | 60–70 % of a *warm* open | measured, n=11 |
| **4** | **The first display check always fails**, costing ~5 s and showing a false "we could not verify your display" strip on healthy boots. | UX + 5 s | measured, n≥6 |
| **5** | **Neko sessions leak, unbounded** — 5 → 21 during this session, from server-side admin logins that are never reclaimed. | resource + latency | measured + mechanism read |
| **6** | **The container's desktop stack restarts and half-fails silently** — `app_exit`, `xvfb` and `stale_boot_reclaim` errors, and two-to-three overlapping boots, all under a `ready ok`. | the likely cause of #1 | measured, hypothesis for #1 |
| **7** | **TURN relay RTT ~220 ms** — architectural, per `PLATFORM-NOTES` §6. | latency floor | measured |
| **8** | **The Worker and both edges are fast and are not the problem.** | — | measured |

The single most useful output of this exercise is in §5.4: a **measurable
discriminator for the black screen**, and the seam where a verdict-quality
detector belongs.

---

## Method

**Boot.** Fresh browser context per open, cookies restored from a saved sign-in.
Clock starts at `page.goto('/os')`. Marks: `domcontentloaded`, shell painted
(taskbar exists), pointer intent on the Browser item, click, the moment the
desktop iframe's `src` stops being `about:blank` (**the mint landed**), and the
moment the window takes `.ezil-fullbleed` (**the reveal**). Every `/api/shell/*`
request recorded with TTFB and response body; the shell's own `console.info`
phase lines captured verbatim.

**Cold vs warm.** `SLEEP_AFTER = '5m'` (`worker/src/index.ts:572`). Cold opens
were attempted after ≥ 7 minutes of no requests. Classification is by mint
duration, which separates the two populations with no overlap (warm 1.4–4.9 s,
cold 20.7–28.2 s). Note that **7 minutes of idle did not reliably put the
container to sleep** — three attempts produced two warm mints — consistent with
`PLATFORM-NOTES` §22's finding that `sleepAfter` is a last-request clock that the
Worker's own alarm resets.

**Picture.** Inside the cross-origin neko frame (Playwright can evaluate there;
the parent shell cannot), the `<video>` drawn into a canvas and read back —
WebRTC `MediaStream`s do not taint a canvas. 23,040 pixels per reading, 6
readings per open over ~30 s, before and after injected mouse and keyboard input.

**Stream.** `RTCPeerConnection` hooked by an init script in every frame before the
neko client constructs one, so `getStats()` runs against the real peer.

**Container side.** Neko's own HTTP API from inside the frame (`/api/login`,
`/api/sessions`, `/api/room/screen`), and the Worker's R2 telemetry spool
(`ezil-telemetry-spool`) read directly, joined to my own opens by
`correlationId` taken from each mint response.

**Edge.** `curl` timing, n=12 and n=8. **Worker analytics.** Cloudflare GraphQL
plus a 645 s live `wrangler tail`.

---

## 1. The boot, broken down

### 1.1 The chain

| # | link | who does the work |
|---|---|---|
| 1 | page load → shell painted | Vercel + the shell bundle |
| 2 | intent → mint | shell → `POST /api/shell/desktop` → Worker `/sandbox/preview` → **container boot** |
| 3 | navigation → neko SPA loaded | the preview edge + the container's HTTP surface |
| 4 | frame confirm | app server → one plain GET to the desktop origin |
| 5 | display confirm | app server → neko `/api/login` + `/api/sessions`, held up to 4 s |
| 6 | reveal | the shell's display gate |

Two structural facts shape every number below.

**`warm()` fires on pointer intent, not on login** (`shell/ezil/boot.js:656`) — a
deliberate container-billing fix. The head start is ~100 ms, not seconds, so
**click-to-reveal really is very nearly the whole boot**.

**The screen resize is not on the critical path.** `POST /api/shell/screen` runs
concurrently with the navigation. In the one open where it failed outright
(`screen resize refused: TIMEOUT — screen_timeout: screen login exceeded
12000ms`) the desktop still revealed normally. It costs a round trip and a leaked
neko admin session (§6), not user time.

### 1.2 Measured, warm — n = 11 opens

| segment | p50 | min | max |
|---|---|---|---|
| page load → shell painted | 2,331 ms | 1,943 | 4,058 |
| click → **mint landed** | **2,632 ms** | 1,419 | 4,852 |
| navigation → frame confirmed | 4,942 ms | 4,667 | 5,463 |
| navigation → **reveal** | **5,987 ms** | 4,845 | 7,497 |
| **click → reveal** | **9,113 ms** | 6,473 | 10,384 |
| page load → reveal (end to end) | 11,618 ms | 8,845 | 14,466 |

**The dominant phase of a warm open is link 3–6, not the mint.** The mint is
2.6 s; everything after the navigation is 6.0 s, i.e. **66 % of a warm open**.

And most of that 6 s is not work. Reading the same opens' timelines:

- the neko SPA's own subresources (`app.js`, `chunk-vendors.js`, fonts,
  `emoji.json`, `chat.mp3`) take ~2.5–3 s, and the frame check waits on the
  iframe `load` event, which fires only after all of them;
- `FRAME_CONFIRM_FALLBACK_MS` is 4,000 ms, and on these opens the fallback timer
  is what fires the check — measured navigation→confirm 4.67–5.46 s, clustered
  just past the 4 s timer;
- the reveal is then gated by `DISPLAY_UNVERIFIED_DEADLINE_MS` = 6,000 ms from
  the navigation, which is why navigation→reveal clusters at ~6 s.

So a warm open's tail is **a 4 s timer, then a 6 s deadline**, not a slow server.

### 1.3 Measured, cold — n = 2 live opens

| segment | run c01 | run pilot1 |
|---|---|---|
| click → **mint landed** | **20,711 ms** | **28,166 ms** |
| navigation → reveal | 6,786 ms | 6,067 ms |
| **click → reveal** | **27,497 ms** | **34,233 ms** |

**The mint owns 75–82 % of a cold open**, and the post-navigation tail is the same
~6 s as warm. n=2 is small; §1.4 backs it with 39 server-side cold mints.

`pilot1` also shows what a bad cold open costs: a `net::ERR_NETWORK_CHANGED`
mid-mint triggered `session#openDesktop`'s one retry (`fetch_failed on the first
attempt; retrying once in 1500ms`), adding ~7 s.

### 1.4 Server-side confirmation, from the Worker's own telemetry spool

Read from R2 (`ezil-telemetry-spool`), 7-day window, deduped on
`(correlationId, site, occurredAt, outcome)` — 946 raw records → 523 unique, 76
correlations. Classified cold/warm by presence of container-side phases.

| | n | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| warm `desktop_ready` (Worker-observed) | 36 | **4 ms** | 8 | — | 9 |
| cold `desktop_ready` (Worker-observed) | 39 | **8,944 ms** | 19,022 | 27,989 | 28,414 |
| container-side `ready` cumulative | 37 | 10,899 ms | 13,643 | — | 15,909 |

Per container phase (ms):

| phase | n | p50 | p90 | max | % of `ready` p50 |
|---|---|---|---|---|---|
| **`window_ready_gate`** | 40 | **3,673** | **6,344** | 7,030 | **33.7 %** |
| `xvfb` | 40 | 1,638 | 2,322 | 2,406 | 15.0 % |
| `container_start` | 40 | 1,049 | 1,084 | 1,767 | 9.6 % |
| `neko_serve_bind` | 37 | 1,044 | 1,096 | 1,123 | 9.6 % |
| `stale_boot_reclaim` | 40 | 1,027 | 1,034 | 1,039 | 9.4 % |
| `openbox` | 40 | 1,021 | 1,024 | 1,029 | 9.4 % |
| `chrome_launch` | 40 | 196 | 628 | 714 | 1.8 % |
| `devserver_launch` | 35 | 36 | 229 | 242 | 0.3 % |
| `codeserver_launch` | 40 | 20 | 29 | 35 | 0.2 % |
| `workspace_hydration` | 40 | 11 | 13 | 14 | 0.1 % |

**`window_ready_gate` owns the largest share of a cold boot** — 33.7 % at p50 and
39.9 % at p90 — followed by `xvfb`. Four phases sit at almost exactly 1.0 s each
(`container_start`, `neko_serve_bind`, `stale_boot_reclaim`, `openbox`), which is
the signature of a fixed poll interval rather than measured work; ~4 s of a
~11 s container boot is spent waiting for the next tick of something.

### 1.5 🔴 `PLATFORM-NOTES` §11's reference numbers are stale, in both directions

§11 records 21.9 s total, `desktop_ready_wait` ~15.3 s, `workspace_mount` ~5.9 s,
`container_start` ~0.3 s. Measured today:

| §11 claim | measured now |
|---|---|
| full boot 21.9 s | cold `desktop_ready` **p50 8.9 s**, p90 19.0 s |
| `desktop_ready_wait` ~15.3 s | **no such site exists in the spool.** Nearest analogue `window_ready_gate` = 3.7 s p50 |
| `workspace_mount` ~5.9 s | `workspace_hydration` **11 ms** (always `skipped`, `already_hydrated_this_container`); Worker-side `workspace_mount` stage 169 ms p50 / 597 ms max (n=8, warm) |
| `container_start` ~0.3 s | **1.05 s**, ~3.5× larger |

The boot got roughly twice as fast at the median and the phase vocabulary changed.
Anyone budgeting timeouts against §11 is budgeting against a system that no longer
exists.

### 1.6 A real gap: 1.4 s of every warm preview is uninstrumented

A warm `/sandbox/preview` logs `received` → `authorize` (0 ms) →
`screen`/`identity` (+69 ms) → `workspace_hydrate` skipped (109–128 ms) →
`container_start` skipped (4–5 ms) → `desktop_ready` at **+245 ms** — while total
wall time is **1,641 ms**. **~1.4 s, 85 % of the route's cost, happens after the
last log line with no instrumentation at all.**

The same gap is far larger on the cold path: run `c01`'s own correlation id shows
`sandbox.preview.desktop_ready ok 9 ms` in the spool while the client measured a
**20,711 ms** mint for that exact request. The Worker believes it answered
instantly. Whatever consumed the other 20.7 s is not in any log.

---

## 2. Worker-side latency

### 2.1 What could and could not be measured

`workersInvocationsAdaptive`, `durableObjectsInvocationsAdaptiveGroups`,
`containersMetricsAdaptiveGroups` and `workersSubrequestsAdaptiveGroups` all work
and **do expose quantiles including wall time** — that is not a gap.

🔴 **COULD-NOT-DETERMINE: per-route historical attribution.** Two datasets are
denied to the current API token:

- every path under `/accounts/{acct}/workers/observability/*` returns
  `{"code":10000,"message":"Authentication error"}` while the same token lists
  `/workers/scripts` fine — a missing **Workers Observability → Read** scope;
- zone analytics (`httpRequestsAdaptiveGroups`, the dataset carrying
  `clientRequestPath` and `edgeResponseStatus`) returns *"does not have permission
  `com.cloudflare.api.account.zone.analytics.read`"*.

`workersInvocationsAdaptive` has no path, hostname or HTTP-status dimension. So
per-route numbers below come from a **645-second live `wrangler tail`
(14:07:53–14:18:38 UTC, 513 trace events)** and are labelled with their small n.
Granting those two scopes turns every COULD-NOT-DETERMINE here into a query.

### 2.2 Volume

| window | requests |
|---|---|
| 7 d | 1,304 |
| 24 h | 1,173 |
| live rate during the tail | 0.35 req/s (223 Worker + 290 DO invocations in 645 s) |

**90 % of the week's traffic is today**, and today's traffic is largely this
measurement session. Five of the seven days carry 1–2 requests. Sampling caveat:
`avg.sampleInterval = 1.283` for successes, so the 1,134 successes in 24 h are
extrapolated from ≈ 884 raw samples.

### 2.3 CPU and wall time, account-wide

24 h, µs:

| status | n | cpu p50 | cpu p90 | cpu p99 | cpu max | wall p50 | wall p90 | wall p99 | wall max |
|---|---|---|---|---|---|---|---|---|---|
| success | 1,134 | 810 | 2,690 | 17,256 | 54,393 | 76,464 | 1,072,984 | **26,186,260** | 779,459,892 |
| clientDisconnected | 36 | 2,437 | 3,379 | 21,034 | 21,034 | 18,273,836 | 49,257,420 | 117,472,730 | 117,472,730 |
| responseStreamDisconnected | 3 | 2,021 | 2,214 | 2,214 | 2,214 | 711,672,260 | 716,734,500 | — | 716,734,506 |

**CPU is trivial. Wall time is not.** p50 wall is 76 ms; p99 is **26.2 s**.

### 2.4 Per route — live tail, n as stated

**Worker (stateless), n = 223:**

| route | n | cpu p50 | cpu p99 | wall p50 | wall p90 | wall p99 | w99/w50 | statuses |
|---|---|---|---|---|---|---|---|---|
| `[nekodesktop]` static asset | 101 | 0.0 ms | 3.0 | 284 ms | 327 | 706 | 2.5× | 200×93, 206×7, 301×1 |
| `[nekodesktop] GET /api/*` | 75 | 0.0 | 1.5 | 44 ms | 59 | 100 | 2.3× | 200×73, 2 canceled |
| `[nekodesktop] POST /api/*` | 17 | 1.0 | 2.0 | 50 ms | 75 | 76 | 1.5× | 200×17 |
| **`POST /sandbox/preview`** | **8** | **10.0** | **16.6** | **1,676 ms** | **2,085** | **2,809** | **1.7×** | **200×8** |
| `[nekodesktop] WS /ws` | 7 | 2.0 | 2.9 | 296 ms | 333 | 342 | 1.2× | 7 upgrade |
| `GET /sandbox/:name/status` | 6 | 1.0 | 2.0 | 11.5 ms | 16 | 19 | 1.6× | 200×6 |
| **`POST /sandbox/:name/screen`** | **6** | **4.5** | **5.0** | **155 ms** | **194** | **220** | **1.4×** | **200×6** |
| `POST /sandbox/:name/activity` | 3 | 3.0 | 3.0 | 451 ms | 6,406 | 7,746 | 17.2× | 200×3 |

**Durable Object, n = 290:**

| route | n | cpu p50 | cpu max | wall p50 | wall p90 | wall p99 | w99/w50 |
|---|---|---|---|---|---|---|---|
| NON-REQUEST (internal) | 96 | 0.0 ms | 6 | 57 ms | 1,091 | 16,675 | **293×** |
| `[nekodesktop]` static asset | 89 | 1.0 | 26 | 103 ms | 638 | 10,561 | **103×** |
| `[nekodesktop] GET /api/*` | 62 | 1.0 | 18 | 356 ms | 1,068 | 16,777 | **47×** |
| ALARM | 20 | 4.0 | 12 | 30,987 ms | 60,998 | 61,668 | 2.0× |
| `[nekodesktop] POST /api/*` | 16 | 0.5 | 2 | 57 ms | 68 | 111 | 1.9× |
| `[nekodesktop] WS /ws` | 7 | 6.0 | 9 | 31,541 ms | 91,279 | 92,202 | 2.9× |

**The three routes asked about:**

- **`/sandbox/preview`** — n=8, all warm, all 200. CPU p50 10 ms, wall p50
  **1,676 ms**, tail ratio 1.7×. **Not a tail problem — a flat-cost problem**, and
  85 % of that flat cost is the uninstrumented 1.4 s in §1.6.
- **`/sandbox/:name/screen`** — n=6, wall p50 155 ms, max 223 ms, 6/6 → 200.
  Cheap and well behaved. (Its 12 s client-visible timeout is a container-side
  neko login stall, not Worker cost.)
- **`/sandbox/:name/logs`** — **n = 0. Not invoked once** in 645 s, and no
  historical per-route data exists. **COULD-NOT-DETERMINE.** The route is present
  and HMAC-gated (`worker/src/index.ts`); it simply is not being used.

### 2.5 🔴 Tail ratios — p99 ≥ 10× p50

| metric | window | n | p50 | p99 | ratio |
|---|---|---|---|---|---|
| Worker success **wall** | 24 h | 1,134 | 76.5 ms | 26,186 ms | **342×** |
| Worker success **wall** | 7 d | 1,258 | 81.8 ms | 29,320 ms | **358×** |
| Worker success `requestDuration` | 24 h | 1,134 | 76.4 ms | 19,507 ms | **255×** |
| Worker success **CPU** | 24 h | 1,134 | 810 µs | 17,256 µs | **21.3×** |
| DO `http` scriptThrewException wall | 7 d | 62 | 657 ms | 716,400 ms | **1,091×** |
| DO `alarm` clientDisconnected wall | 7 d | 40 | 94 ms | 62,100 ms | **658×** |
| DO `http` success wall | 7 d | 748 | 264 ms | 113,300 ms | **429×** |
| DO `jsrpc` success wall | 7 d | 1,211 | 245 ms | 18,980 ms | **77×** |
| DO `alarm` success wall | 7 d | 261 | 11,000 ms | 180,000 ms | **16×** |

**The Worker's own hot path is flat and fast; the fat tail lives entirely on the
Durable Object side.** The *same* request classes are ~2.5× slower at p50 and
40–100× worse at p99 once they cross into the Sandbox DO. Not flagged (all under
10×): `/sandbox/preview` 1.7×, `/sandbox/:name/screen` 1.4×,
`/sandbox/:name/status` 1.6×, Worker-served static assets 2.5×.

### 2.6 🔴 Error rate — the Worker reports zero, and that is wrong

`sum.errors = 0` on **every** `workersInvocationsAdaptive` row, 24 h and 7 d.
**0 / 1,304.** Meanwhile, for the same script:

- **Durable Objects, 7 d: 201 errors of 2,421 invocations (8.30 %)**, including
  **62 `scriptThrewException`** and 137 `clientDisconnected`. 24 h: 189 of 2,195,
  of which 64 are `scriptThrewException` (2.9 %).
- **Outbound subrequests, 24 h, n=892:** 10 × `401`, 7 × `503`, 1 × `500`, 75 ×
  `notDone` — 8 outbound 5xx (0.9 %).
- **The telemetry spool: 1 hard preview failure in 76** (1.3 %) —
  `worker_exception`, `sandbox.preview.failed`, `desktop_failed_to_start`, at
  13:03:06Z: *"Process exited with code 2 before becoming ready. Waiting for: port
  8181 (HTTP /) | port probe: wget exit=4 | desktop stderr (tail): neko process
  exited on its own."* The Worker analytics dataset reports **zero errors** for
  that same window.

**A dashboard built on the Worker error counter is blind to every failure this
product actually has.** The two datasets also disagree by construction — DO counts
`clientDisconnected` as an error, the Worker dataset does not — so they cannot be
compared without saying which convention is in use.

### 2.7 Containers

Peak concurrency **2 instances** against `max_instances = 20`; 3 distinct instance
ids over 24 h across `mia04` and `lhr21`; ~1,317 container cpu-seconds in 24 h;
avg memory 1.9–2.4 GB of 8 GiB; avg CPU utilisation 8–27 %. **The self-imposed
instance cap is nowhere near binding.** No container activity at all on five of
the last seven days.

DO CPU time is **COULD-NOT-DETERMINE — dataset field missing**:
`durableObjectsInvocationsAdaptiveGroups` exposes `wallTime` only.

---

## 3. The streaming path

### 3.1 Transport — TURN-relayed exactly as designed

| property | value |
|---|---|
| selected local candidate | `type: relay`, `protocol: udp`, **`relayProtocol: udp`** |
| relay | `turn.cloudflare.com`, ephemeral per-session credential |
| remote candidate | `type: prflx` |
| DTLS | `connected` |
| codec | **VP8**, software encode (`vp8enc`, `threads=2`, `cpu-used=4`) |

`relayProtocol: udp` confirms `PLATFORM-NOTES` §6: there is no direct path, media
goes through TURN, and that hop is not tunable from inside this architecture.

**Candidate-pair RTT: p50 220 ms, range 213–227 ms (n=15 readings across 11
opens).** That is *this* client to the Cloudflare TURN relay and back. It is not a
user's RTT and it is not glass-to-glass latency — it is the floor beneath it. The
honest statement: **the floor is one TURN round trip from wherever the user sits,
and no application change removes it.** Note `responsesReceived: 1` on the
selected pair — Chromium stops issuing consent probes after connection, so
**COULD-NOT-DETERMINE: RTT variance during a session**; the browser stops
measuring.

### 3.2 Media — n = 11 opens, ~25–30 s observed each

| metric | p50 | min | max |
|---|---|---|---|
| frame rate | **15.00 fps** | 6.2 | 15.01 |
| freeze count | **0** | 0 | **0** |
| total freeze duration | **0 s** | 0 | **0 s** |
| packets lost | **0** | 0 | **0** |
| jitter buffer delay | 8 ms | 7 | 13 |
| keyframe interval | 1.66 s | 1.53 | 4.31 |
| video bitrate | 48.1 kbps | 19.5 | 73.7 |
| resolution | 1440×900 (1920×1080 on one run) | | |

### 3.3 Is it smooth enough to work in?

**As a transport: yes, comfortably.** Zero freezes and zero lost packets across
every open, a steady 15 fps that never fell below its configured rate except
during connection ramp-up, and an 8 ms jitter buffer. The pipe is healthy.

**As a product: no — because it carries nothing.** See §5. The latency floor is
~220 ms of TURN round trip plus ~8 ms of jitter buffer plus one 15 fps frame
interval (67 ms) — call it **~300 ms from an X-server repaint to a pixel on the
user's screen, before any encode or decode time**. That is usable for a coding
desktop and poor for anything with fine pointer feedback, which is precisely the
trade `PLATFORM-NOTES` §6 already names: *"make the desktop the fallback, not the
default"* for anything renderable as a web page.

---

## 4. Container CPU

### 4.1 The production sampler is off, and cannot be turned on read-only

`EZIL_NEKO_CPU_DIAG_ENABLED` is **not set** on the deployed Worker. Verified three
independent ways: `wrangler secret list` (three secrets only —
`SANDBOX_HMAC_SECRET`, `SANDBOX_NEKO_TURN_API_TOKEN`, `SANDBOX_NEKO_TURN_KEY_ID`);
the script settings API (bindings are those three, `SANDBOX_NEKO_ICE_POLICY`, the
`Sandbox` DO and two R2 buckets — ruling out a dashboard-set var, which the
`wrangler.toml` `[vars]` block alone could not); and `wrangler versions view` on
the version at 100 % (deployed 14:00:23Z), same list. `SANDBOX_CPU_DIAG` is also
unset, so `POST /sandbox/:name/cpu-diag` is reachable but can only answer
`exists: false`.

🔴 **COULD-NOT-DETERMINE: production container CPU.** The flag is read in
`ensureDesktop` at container-launch time (`worker/src/index.ts:1000`), so it only
affects desktops booted *after* it is set. Real samples need a Worker var change
**and** a restart of a live desktop — both outside a read-only remit.

### 4.2 Local proxy — clearly labelled as such

Image `ezil-os-worker-sandbox:f8f5c08a`, whose `start-neko.sh` is md5-identical to
repo HEAD (`ezil-integrated:local` was 5 hours stale and was not used). `--cpus=2`
(cgroup `cpu.max = 200000 100000` verified). CPU from cgroup v2 `cpu.stat`
`usage_usec` deltas read host-side, cross-checked against `docker stats`.

| state | n | median cores | p90 | max | memory |
|---|---|---|---|---|---|
| boot (launch → ready) | 6 @1 s | 0.320 | — | **1.608 peak** | — |
| desktop up, **no** client attached | 95 @2 s | **0.0029** | 0.0054 | 0.0138 | 688 MiB |
| desktop up, **client attached, idle** | 95 @2 s | **0.2822** | 0.3620 | 0.4832 | 776 MiB |

**Marginal cost of one attached, idle viewer: +0.279 cores** — ~14 % of a 2-vCPU
instance for an audience doing nothing. This reproduces `PLATFORM-NOTES` §23's
0.237 cores and is ~19 % worse.

**Where the quarter-core goes — it is all neko.** Cumulative `/proc/PID/stat`
deltas over the attached window (81.51 cpu-s):

| process | cores | share |
|---|---|---|
| **neko** (the software VP8 encoder) | 0.409 | **95.4 %** |
| Xvfb | 0.017 | 4.0 % |
| bash supervisors | 0.001 | 0.3 % |
| Chrome (all 12 processes) | 0.001 | 0.2 % |
| code-server (2 processes) | ~0 | < 0.1 % |

Two corrections worth carrying forward:

- **`x11vnc`, `guacd` and Tomcat do not run at all in neko mode.** `ps -e` shows
  no such processes; they are the guacamole branch of `start-desktop.sh`. Any CPU
  budget including them for a neko desktop budgets for processes that do not exist.
- **neko consumes nothing until a peer attaches** (0.0029 cores unattached). The
  entire quarter-core *is* the attach transition, and it is spent encoding.

Local boot reached ready in **5.3 s** — but that is a warm boot with no image
pull, no container cold start and no hydration, which is why it is nowhere near
production's cold figure.

🔴 **COULD-NOT-DETERMINE: CPU under real user load.** No workspace was mounted, so
`launch_devserver` fell back to a Python `http.server` placeholder. A real Next.js
dev server — the dominant consumer in production — is absent from every figure
above. **These are floor numbers.**

---

## 5. 🔴 The black screen

### 5.1 What was observed

**Every one of 13 production desktop opens rendered a completely black picture.**
Not dim, not partially painted: `maxLuma = 0` across 23,040 sampled pixels, on
every sample, of every open — warm and cold, at 1440×900 and at 1920×1080, before
and after injected mouse and keyboard input, sustained over ~30 s per open.

Meanwhile every health signal said the desktop was fine:

| signal | what it said |
|---|---|
| container window-ready gate | passed (it requires both mandatory apps' X windows) |
| Worker `sandbox.preview.desktop_ready` | `ok` |
| `?confirm=frame` | `{"ok":true,"confirmed":true,"status":200}` |
| `?confirm=display` | `{"ok":true,"display":"live","watching":1,…}` |
| `GET /api/room/screen` on the container | `{"width":1440,"height":900,"rate":60}` |
| the shell | `data-kind="ready"` on 8 of 13 opens — its **highest-confidence state** |
| the client trace | `outcome: 'ok'`, breadcrumb `display_live` |

**A black desktop is currently recorded as a successful boot.** No
`display_failure` is emitted; no error-rate dashboard can see it.

### 5.2 It is not the transport, and it is not the instrument

| | production (black), n=11 | local reference (healthy), n=8 |
|---|---|---|
| frame rate | **15.00 fps** | 15.01 fps |
| keyframe interval | 1.66 s | 1.69 s |
| freezes | **0** | 0 |
| packets lost | **0** | 0 |
| jitter buffer | 8 ms | 13 ms |
| codec | VP8 | VP8 |
| **video bitrate** | **48.1 kbps @ 1440×900** | **294.3 kbps @ 1920×1080** |
| **bytes per frame** | **~400 B** | **2,451 B** |
| picture `meanLuma` | **0.000** | 33.63 |
| picture `nonzeroFrac` | **0.0000** | 1.0000 |
| container framebuffer (`shot.jpg`) | 403 — see §5.5 | 70,124 B, meanLuma 34.66 |

Frame rate, keyframe cadence, codec, loss and freeze counts are *identical*. The
encoder is running exactly as configured. The **only** thing that differs is how
many bytes a frame is worth — and a frame worth 400 bytes at 1440×900 is a frame
of almost nothing.

The reference desktop was **also static** (idle Chrome landing page, nobody
typing) and still sustained 294 kbps, so *"nothing is moving"* does not explain
48 kbps. And on the local container the decoded video and the encoder-bypassing
framebuffer agree to ~1 luma unit, so the encode path is faithful when the source
has content.

**The fault is therefore upstream of the encoder, on the X display.** The X server
is up and correctly sized; what is missing is painted content in it. The image's
`openbox` root is unpainted black by default, so *"no mapped, painted application
window"* and *"the screen is exactly black"* are the same observation.

### 5.3 What the timing data does and does not discriminate

Checked against every dimension available. **None of them separates a black open
from a good one, because in this session there were no good ones:**

- **cold vs warm** — no. A genuinely cold container (fresh instance, 20.7 s mint)
  was black; so was every warm re-open.
- **container age / instance identity** — no. Blackness survived container sleep
  and restart. It is **not** a property of one poisoned long-lived instance, which
  is what the earlier 13-of-19 run had suggested — the fault recurs on fresh boots.
- **resolution** — no. 1920×1080 was black too, at the same normalised bitrate.
- **boot phase timings** — no. Black opens have the ordinary profile of §1.
- **frames decoded, encoder start, freeze counts, packet loss** — no. All nominal.
- **`ready` vs `ready_unverified`** — no. Both occurred; both were black. The strip
  the user sees is uncorrelated with whether they can see anything.
- **injected user input** — no. Twelve mouse moves, a click and a keypress changed
  nothing, on any open.

### 5.4 ✅ The discriminator that does work

**Video bitrate normalised by frame area, from `getStats()` alone.**

| | bitrate | frame area | **normalised** |
|---|---|---|---|
| black, 1440×900 (n=10) | 48.1 kbps | 1.296 Mpx | **0.0371 kbps/kpx** |
| black, 1920×1080 (n=1) | 73.7 kbps | 2.074 Mpx | **0.0355 kbps/kpx** |
| healthy local, 1920×1080, equally idle | 294.3 kbps | 2.074 Mpx | **0.1419 kbps/kpx** |

**~3.8× separation, and it holds across resolutions** — the two black runs at
different resolutions normalise to within 5 % of each other, which is what a
*content-determined* metric should do. The encoder is configured for a ~2.0 Mbps
CBR target (`start-neko.sh`'s `NEKO_CAPTURE_VIDEO_PIPELINES`), so the black stream
is running at **2.4 % of its configured bitrate**.

This needs no pixel access, no new endpoint and no cross-origin escape: it is
available to the shell today from any `RTCPeerConnection` it can reach. **But
3.8× is a proxy with an unmeasured false-positive rate** — a legitimately frozen
desktop could approach it — so it belongs as a *screening* threshold that raises
telemetry, not as a verdict that refuses a desktop.

**The verdict-quality detector is one step further, and its seam already exists.**
`worker/assets/neko-branding/www/ezil-mobile.js` is EZiL's own script, baked into
the image and served **same-origin with the `<video>`** — it can read the picture
directly, which no code in the parent shell can. It already calls
`window.parent.postMessage({source:'ezil-mobile', …})`, with a documented
convention and a comment noting *"nothing listens for this yet"*. A ~15-line
addition — `drawImage` the video into a small canvas a second or two after the
peer connects, sample the luma, `postMessage` the result — turns the shell's
unverifiable *"is there a picture?"* into a measured one, and gives
`start_display_gate` real evidence instead of neko's `is_watching` bookkeeping.

That is the single highest-value change this exercise points at: **the product's
definition of "ready" currently cannot fail on a black screen, and the one place
that can see the pixels is already shipped and already talking to the shell.**

### 5.5 The most likely cause — evidence, and what would settle it

Three independent observations, all from today:

**(a) A mandatory app is dead.** `code-server` is one of two mandatory apps the
window-ready gate requires. Requesting its bridge URL on the live container
returns *"Error proxying request to container: The container is not listening in
the TCP address 10.0.0.1:8443"* — while the desktop reported `ready`.

**(b) The container is booting its desktop stack two-to-three times over.** The
telemetry spool for the 14:22 boot (which is run `c01`'s own window) contains,
under a single drain: three `container_start` (1,084 / 1,047 / 1,256 ms), three
`xvfb` (2,188 / 14 / 81 ms — the 14 ms one did not start an X server), three
`openbox`, three `stale_boot_reclaim`, two `window_ready_gate` (2,177 / 3,220 ms),
two `neko_serve_bind`, and **two `ready ok`** (10,058 / 7,258 ms). Plus
`container:neko#app_exit` **error** (1,599 ms) and `stale_boot_reclaim` **error**
(631 ms).

**(c) These failures are chronic, not a one-off.** Over hours 12–14 today, with
549 deduped spool records: `xvfb` **error** ×4 (12:21:27–28), `stale_boot_reclaim`
**error** ×2 (13:27:46) and ×1 (14:22:13), `container:neko#app_exit` **error** at
14:22:13 and again at 14:46:30, and one hard `desktop_failed_to_start` at 13:03.

This is, almost exactly, the defect that
`worker/src/neko-teardown-orphans.test.ts` was written to prevent and documents in
its own header: *"the orphaned code-server ANSWERED the fail-closed readiness
probe and the orphaned Chrome supplied the WM_CLASS the window gate looks for, so
the gate passed in 58 ms … and the real code-server behind it failed to bind six
times before exhausting its restart budget. Every cycle leaked more orphans."*
A stale stack satisfies the gate; the real stack never paints; the root stays
black.

**Stated honestly: this is a well-supported hypothesis, not a proven cause.** The
picture was already black at 14:07, before the 14:22 restart, so the app exits
observed today are not *necessary* for blackness — whatever poisons the stack
happened earlier too. What is proven is that the desktop stack is restarting and
half-failing in production while reporting success.

🔴 **COULD-NOT-DETERMINE, and it is the one request that would settle this:**
`GET /api/room/screen/shot.jpg` renders the X framebuffer server-side and bypasses
the encoder entirely. It requires a neko **admin** session. Production's admin
password is HMAC-derived (`deriveNekoAdminValue`, `NEKO_PASSWORD_ADMIN`) and only
the app server holds the secret; the password embedded in the desktop URL is the
**user** role, so my probe got `403 session is not admin` on every attempt.
(`/api/room/screen/cast.jpg` answers `400 screencast pipeline is not enabled`.)
**Anyone with the HMAC secret can settle "is the X display black, or is only the
capture black?" in one request** — and `POST /sandbox/:name/logs`, which is
HMAC-gated and was invoked **zero** times in 645 s of production traffic, would
hand over the container's own boot log at the same time.

---

## 6. A leak found on the way: neko sessions accumulate without bound

`?confirm=display` reports a `sessions` count. Across this session it climbed
monotonically — **5 → 7 → 8 → 8 → 10 → 11 → 12 → 15 → 17 → 19 → 20 → 21** over 12 opens in
31 minutes — while `watching` stayed at 1 throughout. The container's own `/api/sessions` shows what they are:

```
ezil-os-screen-SS8Ji    admin  is_connected:false  is_watching:false   ← orphan
ezil-os-screen-M-oSp    admin  is_connected:false  is_watching:false   ← orphan
ezil-os-control-gQuPi   admin  is_connected:false  is_watching:false   ← orphan
EZiL-A0mmu              user   is_connected:true   is_watching:true    ← the real viewer
```

The orphans are `ezil-os-screen-*` and `ezil-os-control-*` — the **app server's own
admin logins**, from the screen-resize and implicit-hosting paths. They are never
logged out.

The mechanism is in `app/src/server/lib/cloudflare-guacamole-provider.ts`: the
admin token lives in a **module-level `Map` (`nekoAdminTokens`)** with a 120 s TTL,
and `cacheNekoAdminToken` logs out only the token it replaces *in that Map*. On
Vercel that Map is per-lambda-instance state. A request landing on a fresh
instance finds an empty cache, mints a new neko session, and the instance holding
the old token may never serve that origin again — so nothing ever logs it out.
**The cleanup is in-process; the platform is not.**

Two consequences:

1. Unbounded session growth on a long-lived container, with nothing reaping it.
   These orphans are `is_connected:false` so they should not be encoding — but
   §4.2 measures 0.28 cores for a session that *is* watching, and nothing bounds
   how many of those can accumulate either.
2. It is why the **first** `?confirm=display` of a boot so often answers
   `{"display":"unknown","reason":"unreachable"}` after ~4.8 s: a cache miss forces
   a login plus a list inside a 6 s probe deadline, on top of the 4 s long-poll
   hold. That single wasted round trip is what produces the false "unverified"
   strip in §8.1.

**Honesty note: this measurement is contaminated by the act of measuring.** Each
of my 13 opens left an orphan, and my diagnostic logins added more. The *count* is
inflated by me. The *mechanism* — server-side admin sessions with no reliable
logout on a serverless host — is not.

---

## 7. The edges in front of everything — measured, and fast

| target | n | TTFB p50 | min | max |
|---|---|---|---|---|
| `https://ezil-os.vercel.app/login` (Vercel SSR) | 12 | **344 ms** | 285 ms | 521 ms |
| `https://api-desktop.ezil.org/health` (Worker) | 8 | **56 ms** | 50 ms | 238 ms |
| `https://ezil-os-worker.ezil.workers.dev/health` | 8 | — | — | — |

**Neither the Vercel edge nor the Worker edge is where the time goes**, and tuning
either moves nothing. `workers.dev` did not resolve from this host (`curl` HTTP
`000`) — a DNS/egress fact about the measuring machine, noted so the blank row is
not read as a Worker failure.

`app/vercel.json` declares three crons and `maxDuration = 300` on the desktop
route, so **Vercel function limits are not binding on the mint** even at the
190 s worst case seen in stored telemetry.

---

## 8. What stored telemetry adds — and one correction to how it reads

Read-only against `ezil_error_events` (project `<project-ref>`), snapshot
pinned at `received_at < 2026-08-19 14:09:08+00`. Retention is 14 days, so "the
last 30 days" and "the whole table" are the same 144 rows.

> **Not a fleet.** 78 `boot_summary` rows, 4 distinct `user_hash`, **76 of 78
> (97 %) from two people** — one of whom contributed 18 inside a single 94-minute
> sitting. Percentiles below describe those two machines.

Desktop opens (`ezil-os:trace#desktop`), n = 42, per segment (ms):

| segment | n | p25 | **p50** | p75 | p90 | max |
|---|---|---|---|---|---|---|
| t0 → `launch_start` | 42 | 0 | 0 | 0 | 0 | 0 |
| `launch_start` → `open_resolved` | 40 | 30 | 43 | 86 | 117 | 203 |
| `open_resolved` → `drawer_ready` | 42 | 0 | 0 | 1 | 2 | 4 |
| **`drawer_ready` → `mint_ok`** | 27 | 1,961 | **17,314** | 20,931 | 28,116 | 36,575 |
| `mint_ok` → `confirm_ok` | 27 | 3,341 | 4,826 | 4,988 | 5,320 | 7,007 |
| `confirm_ok` → `display_live` | 22 | 1,779 | 2,042 | 2,721 | 3,424 | 5,438 |
| `confirm_ok` → `display_unverified` | 7 | 945 | 1,100 | 3,640 | 19,459 | 42,334 |
| **`drawer_ready` → `mint_error`** | 12 | 6,166 | **33,398** | 44,952 | 162,598 | 190,468 |
| **TOTAL** | 42 | 8,668 | **23,989** | 34,160 | 49,470 | 190,499 |

**The mint owns 71.7 % of the median stored desktop open.** At p90 it stops being
a slow boot and becomes a hung one: four of the five slowest traces are a single
`mint_error` segment consuming ≥ 99.9 % of the trace (190 s, 175 s, 50 s).

Warmth proxy (elapsed since the same user's previous open): median mint segment
**2,859 ms when the previous open was under 5 minutes ago** vs **22–33 s in every
colder bucket** (n = 23 vs 19).

Other classes, 14 d: `api_failure` n = 62 from 2 users — top codes
`screen_upstream` ×25, `desktop_unreachable` ×12, `auto_retry_desktop_unreachable`
×11. `display_failure` n = 4, all `frame_not_answering`, **none on the desktop
app**. `crash`, `window_error`, `contract_violation`, `boot_phase`, `boot_stall`
and `worker_exception`: **zero rows** — the container/Worker half of the pipeline
is invisible in this table because the R2 spool is not drained into it.

Two gaps worth one line of code each:

- **`attrs` is NULL on all 62 `api_failure` rows**, although
  `ATTRS_ALLOW_LIST.api_failure` already permits `status` and `retryable`. The
  HTTP status of every production API failure is unrecorded.
- 🔴 **COULD-NOT-DETERMINE: cold vs warm, from stored data.** No column or
  `attrs` key records container state, and `ATTRS_ALLOW_LIST.boot_summary` permits
  only `phases` and `total_ms`. The Worker knows at mint time whether it started a
  container or reused one; nothing carries that to the row. One `cold` attribute
  makes every future boot number splittable with no new probe.

### 8.1 A correction — `display_unverified` is not a synchronous give-up

A cluster of `confirm_ok → display_unverified` segments at ~1.1 s (one at 6 ms)
reads, from stored data alone, like the shell abandoning the display check
instantly. **Live measurement shows the opposite.** The display gate starts at the
*navigation*, not at `confirm_ok`, and `DISPLAY_UNVERIFIED_DEADLINE_MS` is
6,000 ms measured from there. Observed in a live boot: navigation t = 5,019 ms,
`confirm_ok` t = 9,866 ms, unverified t = 11,019 ms — exactly 6,000 ms after
navigation, 1,153 ms after `confirm_ok`. **The ~1.1 s mode is that arithmetic.**
The trace's segment boundaries simply do not line up with the gate's own clock.

That points at a different fix. The deadline is not short by 1 s; it is racing a
display probe whose *first* ask systematically costs ~5 s (a 4 s server-side
long-poll hold plus a cold admin login, §6). On several opens the shell told the
user *"we could not verify your display"*, then upgraded to verified 0.6–1.2 s
later. **The unverified strip on a healthy boot is a race, not a fault** — and it
trains users to ignore the one notice that would matter on a genuinely broken one.

---

## 9. Does local reproduce production?

| number | local reproduces it? |
|---|---|
| cold boot ~9–28 s | **No.** Local boots in 5.3 s with the image present, no container cold start and no hydration. Cold start is production-only. |
| TURN relay, ~220 ms RTT | **No.** Local peers connect on direct host candidates. Relay is production-only (`PLATFORM-NOTES` §6). |
| ~6 s post-navigation tail | **Partly.** The 4 s frame-confirm fallback and 6 s display deadline are client constants and reproduce anywhere; the neko SPA's ~3 s subresource load is faster locally. |
| idle attached CPU 0.28 cores | **Yes** — 0.2822 local vs §23's 0.237. Encode cost does not depend on the relay. |
| unattached idle ~0.003 cores | **Yes.** |
| 15 fps, 0 freezes, 0 loss | **Yes.** |
| **the black screen** | **No — and that is the finding.** The same image, same script (md5-identical `start-neko.sh`), boots a *healthy, non-black* desktop locally: meanLuma 33.6, nonzeroFrac 1.0, 294 kbps, and a 70 KB framebuffer JPEG that agrees with the decoded video to ~1 luma unit. **Whatever is black is production-only.** |
| the ~1.4 s uninstrumented warm preview | Untested locally. |
| session leak | Untested locally; the mechanism (per-lambda token cache) is Vercel-specific and **cannot** reproduce on a single-process local server. |

The production-only factors named in the brief all check out: TURN relay
(confirmed, §3.1), the public edge in front of the preview origin (fast, §7),
Vercel function limits (not binding, §7), and genuinely cold containers (§1.3–1.4).
**And the black screen joins that list** — it is production-only, on an image that
is byte-identical to the one that renders correctly on this machine.

---

## 10. What to do, in order

1. **Make "ready" able to fail on a black screen.** Add a luma check to
   `ezil-mobile.js` and a listener for it in the shell (§5.4). Until this exists,
   the product cannot detect its own most severe failure, and no amount of further
   measurement changes that.
2. **Pull `POST /sandbox/:name/logs` and `GET /api/room/screen/shot.jpg` on a
   black production container** (§5.5). Two HMAC-gated requests split the search
   space between "X is black" and "capture is black". The logs route was invoked
   zero times in 645 s of production traffic — it is built and unused.
3. **Fix the desktop-stack restarts** (§5.5b–c): `app_exit`, `xvfb` and
   `stale_boot_reclaim` errors under a `ready ok`, with two-to-three overlapping
   boots per container. `neko-teardown-orphans.test.ts` already documents this
   exact failure mode.
4. **Reclaim neko admin sessions** (§6). The in-process token cache cannot work on
   Vercel. Either log out explicitly at the end of each request, or give the
   container a session reaper.
5. **Take ~4 s off every warm open**: fire the frame confirm on a real signal
   rather than the 4 s fallback timer, and let the display gate reveal on the
   *first* good answer rather than waiting out a 6 s deadline that a ~5 s first
   probe is guaranteed to lose (§1.2, §8.1).
6. **Instrument the 1.4 s hole in `/sandbox/preview`** (§1.6) — 85 % of the warm
   route's cost, and 20.7 s of one cold mint, is currently after the last log line.
7. **Stop trusting the Worker error counter** (§2.6). It reports 0 / 1,304 while
   the DO dataset reports 8.3 % and the spool holds a hard `desktop_failed_to_start`.
8. **Grant the API token Workers Observability → Read and Zone Analytics → Read**
   (§2.1). Every COULD-NOT-DETERMINE in §2 becomes a query.
9. **Update `PLATFORM-NOTES` §11** (§1.5). Its phase names no longer exist and its
   numbers are off by 2–4× in both directions.
10. **Add a `cold` attribute to `boot_summary`** (§8). One field makes every future
    boot number splittable.

---

## Appendix — things this document deliberately does not claim

- **It does not claim a black-screen rate.** 13 of 13 is 13 of 13 on one sandbox
  in one hour. It is not "100 % of production desktops"; it is "every open of this
  computer today". The earlier 13-of-19 figure and this one are consistent with a
  fault that is sometimes on and sometimes off per container, and neither sample
  can measure how often.
- **It does not claim the cause of the black screen.** §5.5 gives a
  well-supported hypothesis and names the two requests that would settle it.
- **It does not present its own session counts as a fleet property.** §6's
  5 → 21 growth includes sessions this measurement created.
- **It does not treat the local container as production.** Every local figure is
  labelled, and the two places where local and production genuinely diverge (cold
  start, and the black screen itself) are called out rather than smoothed over.
