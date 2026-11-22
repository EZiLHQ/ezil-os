# toolsd — the in-computer tools daemon (`EZIL-COMPUTER-TOOLS/1`, staging)

`toolsd` runs a computer's **self-built tools** and **terminal commands** as a
separate non-root user and returns their output. It is the in-container half of
the staging computer-tools slice (frozen contract `ws2-contract-cfda97e.md`,
sections 3.3–3.5, 4, 5). It is reached only by the EZiL OS Worker over
`sandbox.containerFetch`/`runningContainerFetch` on **port 9224**, authenticated
by a per-request MAC. There is no unauthenticated endpoint.

Node ≥ 20, ESM, **no dependencies**.

## Files

| File | Role |
| --- | --- |
| `server.mjs` | HTTP server. `createToolsdServer(opts)` builds it without binding (tests); `startServer()` runs when executed directly. |
| `auth.mjs` | Section 3.5 request checks (in order) + section 3.4 key/MAC derivation + the 120 s replay cache. |
| `manifest.mjs` | Section 4: pure `validateManifest(value, {dirName})` and `scanCatalog(workspaceRoot)`. Also imported by the `ezil tool validate` CLI from `/opt/ezil-toolsd/manifest.mjs`. |
| `jobs.mjs` | Section 5: the job runner — uid/gid 7001 via `setpriv --clear-groups`, from-scratch env, 4-process cap, 65 536-byte retention, timeout/cancel, retention, dedupe. |

## The authenticated wire (sections 3.4 / 3.5)

The Worker derives the same key this daemon does, from this boot's
`EZIL_AI_PROXY_TOKEN`:

```
K   = HMAC-SHA256(key = UTF-8(EZIL_AI_PROXY_TOKEN), "EZIL-TOOLSD-KEY/1")   (32 bytes)
mac = HMAC-SHA256(K, "EZIL-TOOLSD/1\n<ts>\nPOST\n/v1/<op>\n<sha256 hex of body>")
header: x-ezil-toolsd: v1.<ts>.<mac>        ts = epoch milliseconds (decimal)
```

A request is refused with **401 `tools_unauthorized`, nothing executed**, when, in
this order: the method is not POST or the path is not `/v1/{list,refresh,call,exec,job,cancel}`;
`Host` is neither `toolsd.ezil.invalid` nor `toolsd.ezil.invalid:9224`; an `Origin`
or any `Sec-Fetch-*` header is present; `Content-Type` ≠ `application/json`; the
body exceeds 40 960 bytes; the `x-ezil-toolsd` header is missing/malformed;
`|now − ts| > 60 s`; the MAC is wrong; or the MAC was already seen in the last
120 s. Each refusal logs only the failed check name (`[toolsd] refused step=…`) —
never a header value, MAC, body, command or output.

## Mutation proofs (reproduce them)

Each guard below has a test that goes **RED** when the guard is removed. Break it,
run the named command, see red, restore, see green. This is the procedure the
reviewer should repeat.

| Guard | Mutation (in the file) | Goes red |
| --- | --- | --- |
| **Host** | `auth.mjs`: make the `EXPECTED_HOSTS.includes(host)` check always true | `node --test --test-name-pattern "Host check" worker/toolsd/auth.test.mjs` |
| **Origin** | `auth.mjs`: make the `headers.origin !== undefined` check always false | `node --test --test-name-pattern "Origin check" worker/toolsd/auth.test.mjs` |
| **MAC** | `auth.mjs`: make the `timingSafeEqual(...)` check always false | `node --test --test-name-pattern "MAC check\|binding is real" worker/toolsd/auth.test.mjs` |
| **env scrub** | `jobs.mjs`: change the terminal job env to `{ ...process.env, ...JOB_BASE_ENV }` | `node --test --test-name-pattern "env scrub" worker/toolsd/jobs.root.test.mjs` (needs root) |
| **supplementary groups** | `jobs.mjs`: `--clear-groups` → `--keep-groups` in `privDropArgv` | `node --test --test-name-pattern "NO supplementary groups" worker/toolsd/jobs.root.test.mjs` (needs root; plants groups so it is host-independent) |
| **exec-time argv[0] (TOCTOU)** | `jobs.mjs`: disable the `argv0Contained(entry.dir, …)` re-check in `call` | `node --test --test-name-pattern "TOCTOU" worker/toolsd/jobs.test.mjs` |
| **digest `__proto__`** | `manifest.mjs`: `canonicalize` accumulator `Object.create(null)` → `{}` | `node --test --test-name-pattern "canonicalize keeps a __proto__" worker/toolsd/manifest.test.mjs` |
| **worker 401→503 relay** | `computer-tools.ts`: drop the `\|\| upstream.status === 401` remap | `bun test worker/src/computer-tools.test.ts -t "relays a toolsd 401"` |

All eight were verified red→restored→green on 2026-11-22.

## Running the tests

```
# all unit + logic suites (manifest, auth, jobs), node and bun:
node --test worker/toolsd/*.test.mjs          # root runs the privilege suite; non-root SKIPS it, named
cd worker/toolsd && node --test               # equivalent (cwd recursion)
cd worker && bun test toolsd/                  # the CI runner (bun) — discovers recursively
```

🔴 **`node --test worker/toolsd/` (a bare directory) does NOT work on Node ≥ ~23.**
Node resolves the directory as a *module* (via `package.json`), not as a search
root: with a `main` it imports that one file and prints a false `1 test, 1 pass`;
without a `main` it errors `Cannot find module`. Neither discovers the test files.
Use the **glob** (`worker/toolsd/*.test.mjs`) or **cwd recursion** (`cd` in, then
`node --test`). Measured on Node v24.15.0, 2026-11-22.

`jobs.root.test.mjs` needs **root** and **`setpriv`** (util-linux): the uid-7001
drop, the `EZIL_*` env scrub, and the `/proc` EACCES protection are only provable
with a real privilege drop. Without root it SKIPS (loudly, by name) — never a pass.

## Install (hand-off to the lane lead — `worker/Dockerfile`, `start-neko.sh`)

toolsd runs inside the computer image; this worker does not own those files. The
daemon needs, in the image:

1. **COPY** `worker/toolsd/{server.mjs,auth.mjs,manifest.mjs,jobs.mjs,package.json}`
   to `/opt/ezil-toolsd/`.
2. **`ezil-run`** user: uid 7001, gid 7001, home `/home/ezil-run`.
3. **`setpriv`** (util-linux) at the ABSOLUTE path `/usr/bin/setpriv` — the privilege
   drop uses `--clear-groups` (which Node's own `spawn({uid,gid})` does NOT do, so a
   job would otherwise keep root's groups, e.g. gid 0). `startServer` probes
   `/usr/bin/setpriv --version` at boot and refuses to listen (clear log, non-zero
   exit) if it is missing — the same shape as a missing seed.
4. Launch from `start-neko.sh`, after the workspace is ready:
   ```
   EZIL_TOOLSD_SEED="$EZIL_AI_PROXY_TOKEN" \
   EZIL_TOOLSD_WORKSPACE="$WORKSPACE_ROOT" \
   node /opt/ezil-toolsd/server.mjs &
   ```
   `EZIL_TOOLSD_SEED` is this boot's `EZIL_AI_PROXY_TOKEN`; toolsd derives K from it
   and then deletes it from its own environment. With no seed, toolsd exits
   non-zero without listening. Defaults: `EZIL_TOOLSD_HOST=0.0.0.0`,
   `EZIL_TOOLSD_PORT=9224`. Gate on `EZIL_TOOLSD` ≠ `off` per the contract (§8).
5. `EXPOSE 9224`. It must **never** be `exposePort`'d by the SDK and never carried
   by preview routes — it is reached only through the Worker's HMAC-gated route.
