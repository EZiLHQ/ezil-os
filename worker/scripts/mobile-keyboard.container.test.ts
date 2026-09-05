/**
 * The soft keyboard must type each character EXACTLY ONCE.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * Reported from a phone, with a screenshot: typing "fast" into the streamed
 * browser produced "fastfast", and it degraded further the longer the user
 * typed. Their words: "not usable or typable properly" — and they noted people
 * hit it while simply trying to log in on mobile.
 *
 * The cause is in the compiled neko client's Guacamole-derived keyboard, which
 * binds to the player's overlay textarea like this (deminified from
 * `/var/www/js/app.48a1d8f5.js` in the pinned image):
 *
 *     keydown:          if (!e.isComposing && e.keyCode !== 229) -> send keysym
 *     input:            if (e.data && !e.isComposing)            -> type(e.data)
 *     compositionstart: removeEventListener("input", n)
 *     compositionend:   if (e.data)                              -> type(e.data)
 *
 * Two defects fall out of that on a phone, and neither is reachable from a
 * desktop browser, which is why it shipped:
 *
 *   A. A predictive keyboard (SwiftKey, Gboard) sends REAL key codes per
 *      character AND runs a composition. `keyCode !== 229` is therefore true,
 *      so each character leaves once as a keysym from `keydown` and again as
 *      text from `compositionend`.
 *
 *   B. `compositionstart` removes the input listener and nothing adds it back,
 *      so after the first composed word a character typed WITHOUT composition
 *      has no delivery path left.
 *
 * B was invisible in production because A was masking it: the keysym path
 * happened to carry those characters. Suppressing A alone would therefore have
 * turned a duplication bug into SILENT CHARACTER LOSS — which is why this file
 * asserts both, and why the numbers below were measured before the fix as well
 * as after.
 *
 * ── WHAT IS MEASURED ────────────────────────────────────────────────────────
 * Not the textarea, and not the DOM: the frames that actually leave for the
 * server. `RTCDataChannel.prototype.send` is hooked and keydown frames are
 * counted, so this asserts what the remote desktop will really receive.
 *
 * Measured against a real container:
 *
 *     scenario                          before   after
 *     composed word "fast" (4 chars)      8        4
 *     a plain char after a composition    1        1     (0 without the
 *                                                        compositionstart guard
 *                                                        — mutation-proved)
 *     Backspace                           1        1
 *     Enter                               1        1
 *
 * ── SKIP SEMANTICS ("M1" — the honest-skip fix) ─────────────────────────────
 * A suite that could not run must never look like a pass — the same rule
 * `browser-sidecar.container.test.ts` and `neko-browser-window.container.test.ts`
 * apply. Before this fix, five of this file's eight `it` bodies did:
 *
 *     if (!available) { console.warn('...SKIPPING, not passing'); return; }
 *
 * An early `return` from inside an `it` body is a PASS to bun — the console
 * line said "skipping" and the runner recorded the opposite. `tools/test.sh`'s
 * `gate_vacuous_container_passes` (added by row O3) exists specifically to
 * catch this file doing that. Fixed the same way the sibling suites do it:
 * one `SKIP_REASON` computed once, `itIf = SKIP_REASON ? it.skip : it`, and no
 * `it` body ever returns early again.
 *
 * `IMAGE` now reads `EZIL_VALIDATE_IMAGE` first — the name every sibling
 * `*.container.test.ts` reads (see `browser-sidecar.container.test.ts` and
 * `neko-browser-window.container.test.ts`) — falling back to `EZIL_NEKO_IMAGE`,
 * which is what this file read before this fix, so a caller still setting the
 * old name keeps working. `tools/test.sh`'s own vacuous-pass gate already
 * checked both names for exactly this reason (`gate_vacuous_container_passes`);
 * this unifies the file with the gate that watches it. Two names for one fact
 * is how a run that sets one and not the other silently misses this suite.
 *
 * `SKIP_REASON` also now checks, in order: the Docker daemon, the image, that
 * the image actually carries the EZiL branding overlay that ships the
 * keyboard (`/var/www/ezil-mobile.js` — see
 * `worker/assets/neko-branding/Dockerfile`; an image built from the bare neko
 * base has no keyboard at all and asking it anything below is asking a
 * question the artifact under test cannot answer), and that `playwright` is
 * resolvable — the diagnosed cause of the 8 pre-existing failures, below.
 *
 * ── THE 8 FAILURES, DIAGNOSED (M1) ──────────────────────────────────────────
 * Measured on this host with `ezil-integrated:local` present (built from this
 * tree; confirmed via `docker image inspect` and, per the branding overlay
 * check above, confirmed to carry `/var/www/ezil-mobile.js`) — so this is NOT
 * hypothesis (a) (missing overlay: refuted, the default image has it) and NOT
 * hypothesis (c) (a real product defect: not reached, see below). It is
 * hypothesis (b): the test's own mechanism was broken, independent of the
 * product.
 *
 * `framesFor` / `remoteTextAfter` / the keyboard-affordance check all spawn a
 * plain `node -e '<script>'` subprocess (`sh('node', ['-e', script], ...)`)
 * and every one of those scripts opened with a bare `const { chromium } =
 * require('playwright');`. `playwright` is deliberately NOT a dependency of
 * any `package.json` in this repository — see `shell/run-tests.sh`'s own
 * header: "Each browser suite resolves playwright from its own location
 * first, then from a directory named by $PLAYWRIGHT_REQUIRE_DIR... CI installs
 * one into /opt/ezil-testkit for exactly this purpose" — and every OTHER
 * browser-driving file in this repository (`local/tests/local-smoke.container.test.ts`,
 * `e2e/prod-mobile-keyboard.mjs`, every `shell/` `*-browser-test.mjs`) follows
 * that convention. This file never did. With `PLAYWRIGHT_REQUIRE_DIR` unset
 * (the default on a bare CI runner, and on this host before this fix) and no
 * `playwright` in `worker/node_modules`, the spawned `node -e` process threw
 * `Cannot find module 'playwright'` in under 30ms, before touching Docker,
 * Chromium, or the container at all — measured directly:
 *
 *     $ cd worker && node -e "require('playwright')"
 *     Error: Cannot find module 'playwright'
 *
 * `sh()` swallows a subprocess's stderr into the captured result and this
 * file's callers only look at stdout's last JSON line, so the crash surfaced
 * as an empty stdout, parsed as `{}` — hence `Expected 4, Received undefined`
 * (a keydown count that was never a number), `Expected "fast.com", Received
 * ""` (a remote text read that never happened), and `found.length === 0` (a
 * DOM query that was never run) for the 8th. Every one of the "8 pre-existing
 * failures" O3 found is this same crash, not 8 independent product bugs.
 *
 * Fixed by adopting the exact convention every sibling file uses: each
 * spawned script now tries `require('playwright')` first, then falls back to
 * `createRequire(join(PLAYWRIGHT_REQUIRE_DIR, 'noop.js'))('playwright')` —
 * verified directly on this host:
 *
 *     $ node -e "const {createRequire}=require('module');
 *                 createRequire(require('path').join('/opt/ezil-testkit/node_modules','x.js'))('playwright')"
 *     # resolves clean
 *
 * and `SKIP_REASON` now names an unresolvable playwright as a loud skip
 * (matching `local/tests/local-smoke.container.test.ts`'s `loadChromium()`)
 * rather than letting the suite crash into misleading `expect()` failures.
 *
 * ── WHAT RUNNING IT FOR REAL THEN SHOWED (M1) ───────────────────────────────
 * With the playwright fix above and `PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/
 * node_modules`, this suite against `ezil-integrated:local` (as built on this
 * host) went from 0 pass/8 fail to **8 pass, 1 fail** — the 1 being "exactly
 * ONE keyboard affordance is on screen": `Expected: null, Received:
 * "ezil-kbd-btn"`. That looked like hypothesis (c) (main really broken) until
 * measured further: `docker run --rm --entrypoint sh ezil-integrated:local -c
 * 'cat /var/www/ezil-mobile.js'` is BYTE-IDENTICAL (`diff -q`, 61718 bytes) to
 * `git show wip/mobile-keyboard:worker/assets/neko-branding/www/ezil-mobile.js`
 * — whose own tip commit is literally titled "wip(mobile): keyboard work in
 * progress — container tests failing". `main`'s OWN copy of that file (53438
 * bytes) has NO `#ezil-kbd-btn` at all — it was deliberately removed by commit
 * 2877bdd ("one keyboard, the client's") in favour of enlarging the CLIENT's
 * own `.fa-keyboard` control, exactly what this test expects. So
 * `ezil-integrated:local` on this host is a stale local build tagged from
 * `wip/mobile-keyboard`, not from `main` — hypothesis (a) in the form the
 * brief didn't quite name ("the wrong image", not "no image"), not a defect
 * in `main`.
 *
 * CONFIRMED by isolation: building a throwaway single-layer image (`FROM
 * ezil-integrated:local` + `COPY` in *only* `main`'s own
 * `worker/assets/neko-branding/www/ezil-mobile.js`, nothing else changed) and
 * re-running against THAT image scored **9 pass, 0 fail** — every scenario,
 * including the affordance check. `main`'s actual mobile-keyboard code is not
 * broken; hypothesis (c) is REFUTED. This is a hand-off, not a fix owned by
 * this file: whichever process last tagged `ezil-integrated:local` on this
 * host built it from `wip/mobile-keyboard` rather than `main`, and any other
 * row or agent trusting that tag on this same host is measuring the WIP
 * branch, not `main`. See the M1 report for the exact commands.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * See the file header ("M1 — the honest-skip fix"): `EZIL_VALIDATE_IMAGE` is
 * the name every sibling `*.container.test.ts` reads; `EZIL_NEKO_IMAGE` is
 * what this file read before this fix and is kept as a fallback so an
 * existing caller of the old name is not silently broken.
 */
const IMAGE = process.env.EZIL_VALIDATE_IMAGE ?? process.env.EZIL_NEKO_IMAGE ?? 'ezil-integrated:local';
const CONTAINER = `ezil-kbd-test-${process.pid}`;

/**
 * SIGTERM/SIGINT SURVIVAL -- docs/CONFIDENCE-MAP.md section 2.10 / section 3.9,
 * reproduced against `neko-browser-window.container.test.ts` (same shape:
 * boot at module scope, cleanup only in `afterAll`). `afterAll` alone only
 * fires on a normal bun-test exit; a cancellation (Ctrl-C, a CI job
 * cancellation, a harness timeout that sends SIGTERM) skips straight past it
 * and orphans a container built from a 4.57 GB image. So this container's
 * name is registered in a module-level set that a process-level signal
 * handler removes on the way out. `spawnSync`, not an async shape, because
 * Node/Bun runs `exit` handlers SYNCHRONOUSLY -- an outstanding async
 * `docker rm -f` would never be awaited and would not survive `exit` at all.
 */
const CONTAINERS_TO_CLEAN = new Set<string>();
let cleanupOnExitInstalled = false;
function installCleanupOnExit() {
  if (cleanupOnExitInstalled) return;
  cleanupOnExitInstalled = true;
  const removeAll = () => {
    for (const name of CONTAINERS_TO_CLEAN) sh('docker', ['rm', '-f', name], 60_000);
  };
  process.on('exit', removeAll);
  process.on('SIGTERM', () => { removeAll(); process.exit(143); });
  process.on('SIGINT', () => { removeAll(); process.exit(130); });
}
installCleanupOnExit();
const PORT = 18291;
const SIDECAR_PORT = 18292;
const PAGE_PORT = 3112;   // served INSIDE the container
const BOOT_TIMEOUT_MS = 240_000;

function sh(cmd: string, args: string[], timeout = 60_000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout });
}

/**
 * The exact resolution every spawned `node -e` subprocess below needs:
 * `playwright` first from wherever `node`'s own resolution finds it, then
 * from `$PLAYWRIGHT_REQUIRE_DIR` (inherited automatically — `sh()`'s
 * `spawnSync` calls pass no `env` override, so `spawnSync` defaults to
 * inheriting this process's full environment, `PLAYWRIGHT_REQUIRE_DIR`
 * included). Interpolated at the top of every spawned script's source below;
 * see `e2e/prod-mobile-keyboard.mjs` for the same fallback shape written for
 * an ESM top-level context instead of a CommonJS `node -e` one.
 */
const PW_RESOLVE = `
      let chromium;
      try { ({ chromium } = require('playwright')); }
      catch (e) {
        const dir = process.env.PLAYWRIGHT_REQUIRE_DIR;
        if (!dir) {
          console.error('playwright not resolvable and PLAYWRIGHT_REQUIRE_DIR is unset: ' + e.message);
          process.exit(2);
        }
        try {
          const { createRequire } = require('module');
          const req = createRequire(require('path').join(dir, 'noop.js'));
          ({ chromium } = req('playwright'));
        } catch (e2) {
          console.error('playwright not resolvable via PLAYWRIGHT_REQUIRE_DIR=' + dir + ': ' + e2.message);
          process.exit(2);
        }
      }`;

/**
 * Whether `playwright` is reachable AT ALL — from this bun process's own
 * location, or from `$PLAYWRIGHT_REQUIRE_DIR` — checked here (not just left
 * to crash a spawned subprocess) so an unresolvable playwright is a named
 * `SKIP_REASON` rather than the 8-failure crash this file shipped with.
 * Mirrors `local/tests/local-smoke.container.test.ts`'s `loadChromium()`.
 */
function playwrightUnavailableReason(): string | null {
  try {
    createRequire(import.meta.url).resolve('playwright');
    return null;
  } catch { /* fall through to the PLAYWRIGHT_REQUIRE_DIR check */ }
  const dir = process.env.PLAYWRIGHT_REQUIRE_DIR;
  if (!dir) {
    return 'playwright is not resolvable from this file and $PLAYWRIGHT_REQUIRE_DIR is unset '
      + '(CI installs one into /opt/ezil-testkit/node_modules for exactly this — point '
      + 'PLAYWRIGHT_REQUIRE_DIR at a node_modules that has it and re-run; playwright is '
      + 'deliberately never a dependency of any package.json in this repository)';
  }
  try {
    createRequire(path.join(path.resolve(dir), 'noop.js')).resolve('playwright');
    return null;
  } catch (err) {
    return `playwright is not resolvable from PLAYWRIGHT_REQUIRE_DIR=${dir}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Same shape as the sibling container suites. `null` means the suite CAN run. */
function unavailableReason(): string | null {
  const version = sh('docker', ['version', '--format', '{{.Server.Version}}'], 20_000);
  if (version.error || version.status !== 0) {
    return `the Docker daemon is not reachable (${(version.stderr || version.error?.message || '').trim().split('\n')[0]})`;
  }
  const image = sh('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], 20_000);
  if (image.status !== 0) {
    return `the image \`${IMAGE}\` is not present locally (build it with \`cd worker && docker build -t ${IMAGE} .\`)`;
  }
  // An image built from the bare neko base (no EZiL branding overlay — see
  // worker/assets/neko-branding/Dockerfile) has no mobile keyboard at all.
  // Treated as "the artifact under test is absent", exactly like a missing
  // image — NOT as a failure, and NOT as a pass. This is hypothesis (a) from
  // the M1 brief; on this host it does not fire (ezil-integrated:local was
  // confirmed to carry the overlay), but a differently-built or -tagged image
  // must not be asked a question it cannot answer.
  const probe = sh('docker', ['run', '--rm', '--entrypoint', 'test', IMAGE, '-f', '/var/www/ezil-mobile.js'], 60_000);
  if (probe.status !== 0) {
    return `\`${IMAGE}\` has no /var/www/ezil-mobile.js (it predates the EZiL branding overlay that ships `
      + `the mobile keyboard — see worker/assets/neko-branding/Dockerfile) — build or pull an image built `
      + `from that overlay`;
  }
  const pwReason = playwrightUnavailableReason();
  if (pwReason) return pwReason;
  return null;
}

const SKIP_REASON = unavailableReason();
let started = false;
let bootError: string | null = null;

if (SKIP_REASON) {
  console.warn(
    `\n${'='.repeat(78)}\n`
    + `SKIPPING the mobile keyboard container suite: ${SKIP_REASON}.\n`
    + 'Nothing about character duplication, character loss, Backspace/Enter\n'
    + 'framing, or the on-screen keyboard affordance has been verified by this\n'
    + 'run. This is a SKIP, not a pass — these behaviours are ONLY provable\n'
    + 'against a real container running the real branded image.\n'
    + `${'='.repeat(78)}\n`,
  );
}

/**
 * Boot the real container and serve the one-input fixture page it needs.
 * Throws on any failure — a container that boots and then misbehaves is a
 * FAILURE, never a skip, because at that point everything `SKIP_REASON`
 * checks for was actually available.
 */
function boot(): void {
  sh('docker', ['rm', '-f', CONTAINER]);
  const run = sh('docker', [
    'run', '-d', '--name', CONTAINER, '--cpus=2',
    '-p', `${PORT}:8181`, '-p', `${SIDECAR_PORT}:9223`,
    '-e', 'DESKTOP_MODE=neko',
    // ON: the end-to-end checks read the remote page back through it, which is
    // the only way to assert the TEXT rather than a frame count.
    '-e', 'EZIL_BROWSER_SIDECAR=on',
    '-e', 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=s1admin',
    '-e', 'NEKO_PASSWORD_ADMIN=s1admin',
    '-e', 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD=s1user',
    '-e', 'NEKO_PASSWORD=s1user',
    '--entrypoint', '/bin/bash', IMAGE,
    '-c', 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh',
  ], 120_000);
  if (run.status !== 0) throw new Error(`docker run failed: ${(run.stderr || '').trim()}`);
  started = true;
  CONTAINERS_TO_CLEAN.add(CONTAINER);

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = sh('docker', ['exec', CONTAINER, 'grep', '-c', 'phase=ready', '/tmp/neko.log'], 20_000);
    if (probe.status === 0 && Number((probe.stdout || '0').trim()) > 0) {
      // A one-input page served from inside the container, and the sidecar up
      // to read it back. Both are prerequisites for asserting TEXT rather than
      // frame counts.
      const serve = sh('docker', ['exec', CONTAINER, 'bash', '-lc',
        'mkdir -p /tmp/tt && printf "%s" '
        + '"<!doctype html><meta charset=utf-8><input id=t autofocus style=font-size:34px;width:92%>" '
        + `> /tmp/tt/index.html; (cd /tmp/tt && nohup python3 -m http.server ${PAGE_PORT} >/dev/null 2>&1 &); sleep 1`], 60_000);
      if (serve.status !== 0) throw new Error(`fixture page did not serve: ${(serve.stderr || '').trim()}`);
      const sidecarDeadline = Date.now() + 120_000;
      while (Date.now() < sidecarDeadline) {
        const h = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${SIDECAR_PORT}/health`], 15_000);
        if ((h.stdout || '').trim() === '200') return;
        Bun.sleepSync(2000);
      }
      throw new Error(`sidecar never answered on ${SIDECAR_PORT}/health within 120000ms`);
    }
    Bun.sleepSync(1000);
  }
  throw new Error(`container never reached phase=ready within ${BOOT_TIMEOUT_MS}ms`);
}

if (!SKIP_REASON) {
  try {
    boot();
  } catch (err) {
    bootError = err instanceof Error ? err.message : String(err);
  }
}

afterAll(() => { if (started) sh('docker', ['rm', '-f', CONTAINER], 60_000); });

const itIf = SKIP_REASON ? it.skip : it;

/**
 * Replay one keyboard scenario in a real touch browser against the real
 * client, and report how many keydown frames reached the wire.
 */
async function framesFor(scenario: string): Promise<{ keydown: number; keyup: number }> {
  const script = `${PW_RESOLVE}
    (async () => {
      const b = await chromium.launch();
      const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true,
        deviceScaleFactor:3,
        userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' });
      const p = await ctx.newPage();
      await p.goto('http://127.0.0.1:${PORT}/?usr=EZiL&pwd=s1user&embed=1',{waitUntil:'domcontentloaded'});
      await p.waitForSelector('textarea.overlay',{timeout:60000}).catch(()=>{});
      await p.waitForTimeout(7000);
      await p.evaluate(() => {
        window.__sent = { keydown: 0, keyup: 0 };
        const orig = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (data) {
          try {
            const buf = data instanceof ArrayBuffer ? new Uint8Array(data)
              : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
            if (buf && buf.length >= 3) {
              if (buf[0] === 0x03) window.__sent.keydown++;
              else if (buf[0] === 0x04) window.__sent.keyup++;
            }
          } catch (e) {}
          return orig.apply(this, arguments);
        };
      });
      const out = await p.evaluate(async () => {
        const ta = document.querySelector('textarea.overlay'); ta.focus();
        const K = (t,i) => ta.dispatchEvent(new KeyboardEvent(t, Object.assign({bubbles:true}, i)));
        const C = (t,i) => ta.dispatchEvent(new CompositionEvent(t, Object.assign({bubbles:true}, i)));
        const I = (i) => ta.dispatchEvent(new InputEvent('input', Object.assign({bubbles:true}, i)));
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        ${scenario}
        await sleep(400);
        return window.__sent;
      });
      console.log(JSON.stringify(out));
      await b.close();
    })();
  `;
  const res = sh('node', ['-e', script], 180_000);
  // A non-zero exit means the subprocess crashed before printing its result
  // line (playwright unresolvable despite SKIP_REASON's own check passing,
  // a launch failure, an uncaught throw inside the script, ...). Falling
  // through to `?? '{}'` here is exactly how the 8 pre-existing failures this
  // row diagnosed presented as `Received: undefined` instead of naming the
  // real crash — throw with the child's own stderr instead of silently
  // treating a crash as "sent nothing".
  if (res.status !== 0) {
    throw new Error(`framesFor: the node subprocess exited ${res.status} instead of reporting a frame count — `
      + `stderr: ${(res.stderr || '').trim().slice(0, 2000) || '(empty)'}`);
  }
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '{}';
  return JSON.parse(line) as { keydown: number; keyup: number };
}

/**
 * Type a sequence into the client and read what the REMOTE page received.
 *
 * 🔴 Counting frames is not enough for these. A replacement delivers the RIGHT
 * NUMBER of keysyms while delivering the WRONG TEXT — "fast" then '.' arrived
 * as "fastfast." with a perfectly plausible frame count. The only honest
 * assertion is the string in the remote input, read back through the sidecar.
 */
async function remoteTextAfter(sequence: string): Promise<string> {
  const script = `${PW_RESOLVE}
    const sc = async (v, b) => (await fetch('http://127.0.0.1:${SIDECAR_PORT}/' + v, {
      method: v === 'health' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: v === 'health' ? undefined : JSON.stringify(b || {}) })).json();
    (async () => {
      await sc('navigate', { url: 'http://127.0.0.1:3112/' });
      await new Promise(r => setTimeout(r, 1800));
      const b = await chromium.launch();
      const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true,
        deviceScaleFactor:3,
        userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' });
      const p = await ctx.newPage();
      await p.goto('http://127.0.0.1:${PORT}/?usr=EZiL&pwd=s1user&embed=1',{waitUntil:'domcontentloaded'});
      await p.waitForSelector('textarea.overlay',{timeout:60000}).catch(()=>{});
      await p.waitForTimeout(8000);
      await p.evaluate(async () => {
        const ta = document.querySelector('textarea.overlay'); ta.focus();
        const K=(t,i)=>ta.dispatchEvent(new KeyboardEvent(t,Object.assign({bubbles:true},i)));
        const C=(t,i)=>ta.dispatchEvent(new CompositionEvent(t,Object.assign({bubbles:true},i)));
        const I=(i)=>ta.dispatchEvent(new InputEvent('input',Object.assign({bubbles:true},i)));
        const BI=(o)=>{ const e=new InputEvent('beforeinput',{bubbles:true,cancelable:true,data:o.data,inputType:o.inputType});
          e.getTargetRanges=()=>(o.ranges||[]).map(([a,z])=>({startOffset:a,endOffset:z}));
          ta.dispatchEvent(e); };
        const s=(ms)=>new Promise(r=>setTimeout(r,ms));
        ${sequence}
        await s(800);
      });
      await b.close();
      const snap = await sc('snapshot', {});
      const m = JSON.stringify(snap).match(/textbox[^\\n"]{0,60}/i);
      console.log(JSON.stringify((m ? m[0] : '')
        .replace(/textbox\\s*/,'').replace(/\\[ref=e\\d+\\]\\s*/,'').replace(/\\[focused\\]:?\\s*/,'').trim()));
    })();
  `;
  const res = sh('node', ['-e', script], 240_000);
  // Same reasoning as `framesFor`: a non-zero exit is a crash, not "the
  // remote received nothing" — throw with the child's stderr rather than
  // letting the `?? '""'` fallback turn a crash into a plausible-looking
  // empty string.
  if (res.status !== 0) {
    throw new Error(`remoteTextAfter: the node subprocess exited ${res.status} instead of reporting the remote text — `
      + `stderr: ${(res.stderr || '').trim().slice(0, 2000) || '(empty)'}`);
  }
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '""';
  try { return JSON.parse(line) as string; } catch { return ''; }
}

describe('the soft keyboard types each character exactly once', () => {
  itIf('booted and reached readiness (phase=ready, fixture page served, sidecar healthy)', () => {
    expect(bootError ?? 'ok').toBe('ok');
  });

  itIf('🔴 a predictive keyboard typing a 4-character word sends FOUR keydowns, not eight', async () => {
    const got = await framesFor(`
      C('compositionstart', { data: '' });
      for (const ch of 'fast') {
        const kc = ch.toUpperCase().charCodeAt(0);
        K('keydown', { key: ch, keyCode: kc, which: kc });
        ta.value += ch;
        I({ data: ch, inputType: 'insertCompositionText', isComposing: true });
        K('keyup', { key: ch, keyCode: kc, which: kc });
        await sleep(25);
      }
      C('compositionend', { data: 'fast' });
    `);
    // 8 before the fix — the reported "fastfast".
    expect(got.keydown).toBe(4);
  }, 300_000);

  itIf('🔴 a plain character AFTER a composition is still delivered (0 without the compositionstart guard)', async () => {
    const got = await framesFor(`
      C('compositionstart', { data: '' });
      ta.value += 'a';
      I({ data: 'a', inputType: 'insertCompositionText', isComposing: true });
      C('compositionend', { data: 'a' });
      await sleep(60);
      const kc = 'X'.charCodeAt(0);
      K('keydown', { key: 'x', keyCode: kc, which: kc });
      ta.value += 'x';
      I({ data: 'x', inputType: 'insertText' });
      K('keyup', { key: 'x', keyCode: kc, which: kc });
      await sleep(40);
    `);
    // The composed 'a' plus the plain 'x'. Without the guard the 'x' is lost
    // entirely and this is 1 rather than 2 — measured.
    expect(got.keydown).toBeGreaterThanOrEqual(2);
  }, 300_000);

  itIf('Backspace and Enter still reach the remote — they carry no text', async () => {
    const got = await framesFor(`
      K('keydown', { key: 'Backspace', keyCode: 8, which: 8 });
      I({ data: null, inputType: 'deleteContentBackward' });
      K('keyup', { key: 'Backspace', keyCode: 8, which: 8 });
      await sleep(40);
      K('keydown', { key: 'Enter', keyCode: 13, which: 13 });
      K('keyup', { key: 'Enter', keyCode: 13, which: 13 });
      await sleep(40);
    `);
    expect(got.keydown).toBe(2);
  }, 300_000);

  // ── what the REMOTE actually received ──────────────────────────────────
  // 🔴 These assert TEXT, not frame counts, and that distinction is the reason
  // they exist. A replacement delivers a perfectly plausible number of keysyms
  // while delivering the wrong string: typing "fast" then '.' arrived in the
  // remote page as "fastfast." because the client's keyboard types on BOTH the
  // `insertReplacementText` input and the `compositionend` that follows it.
  // A frame counter is blind to that; the input's value is not.
  itIf.each([
    // '.' commits the word and autocorrects — the reported failure.
    ['a word committed by "." ', `
      C('compositionstart',{data:''});
      for (const ch of 'fast') { const kc=ch.toUpperCase().charCodeAt(0);
        K('keydown',{key:ch,keyCode:kc,which:kc}); I({data:ch,inputType:'insertCompositionText',isComposing:true});
        K('keyup',{key:ch,keyCode:kc,which:kc}); await s(30); }
      K('keydown',{key:'.',keyCode:190,which:190});
      BI({inputType:'insertReplacementText',data:'fast',ranges:[[0,4]]});
      I({data:'fast',inputType:'insertReplacementText'});
      C('compositionend',{data:'fast'});
      I({data:'.',inputType:'insertText'});
      K('keyup',{key:'.',keyCode:190,which:190}); await s(120);
      for (const ch of 'com') { const kc=ch.toUpperCase().charCodeAt(0);
        K('keydown',{key:ch,keyCode:kc,which:kc}); I({data:ch,inputType:'insertText'});
        K('keyup',{key:ch,keyCode:kc,which:kc}); await s(30); }`, 'fast.com'],
    // the same word committed without a correction
    ['a word committed plainly', `
      C('compositionstart',{data:''});
      for (const ch of 'fast') { const kc=ch.toUpperCase().charCodeAt(0);
        K('keydown',{key:ch,keyCode:kc,which:kc}); I({data:ch,inputType:'insertCompositionText',isComposing:true});
        K('keyup',{key:ch,keyCode:kc,which:kc}); await s(30); }
      C('compositionend',{data:'fast'}); await s(80);
      K('keydown',{key:'.',keyCode:190,which:190}); I({data:'.',inputType:'insertText'});
      K('keyup',{key:'.',keyCode:190,which:190}); await s(80);
      for (const ch of 'com') { const kc=ch.toUpperCase().charCodeAt(0);
        K('keydown',{key:ch,keyCode:kc,which:kc}); I({data:ch,inputType:'insertText'});
        K('keyup',{key:ch,keyCode:kc,which:kc}); await s(30); }`, 'fast.com'],
    // 🔴 a suggestion tapped for an ALREADY-COMMITTED word: no compositionend
    // is coming, so the replacement must really replace — Backspaces first.
    ['a tapped suggestion replaces, not appends', `
      for (const ch of 'teh') { const kc=ch.toUpperCase().charCodeAt(0);
        K('keydown',{key:ch,keyCode:kc,which:kc}); I({data:ch,inputType:'insertText'});
        K('keyup',{key:ch,keyCode:kc,which:kc}); await s(30); }
      await s(80);
      BI({inputType:'insertReplacementText',data:'the',ranges:[[0,3]]});
      I({data:'the',inputType:'insertReplacementText'}); await s(150);`, 'the'],
    // Backspace deletes ONE character, not two.
    ['Backspace after a composed word', `
      C('compositionstart',{data:''});
      for (const ch of 'abcd') { const kc=ch.toUpperCase().charCodeAt(0);
        K('keydown',{key:ch,keyCode:kc,which:kc}); I({data:ch,inputType:'insertCompositionText',isComposing:true});
        K('keyup',{key:ch,keyCode:kc,which:kc}); await s(25); }
      C('compositionend',{data:'abcd'}); await s(120);
      K('keydown',{key:'Backspace',keyCode:8,which:8});
      I({data:null,inputType:'deleteContentBackward'});
      K('keyup',{key:'Backspace',keyCode:8,which:8}); await s(150);`, 'abc'],
  ])('🔴 %s -> the remote receives exactly "%s"', async (_label, sequence, expected) => {
    expect(await remoteTextAfter(sequence as string)).toBe(expected as string);
  }, 400_000);

  itIf('🔴 exactly ONE keyboard affordance is on screen, and it clears the 48px touch minimum', async () => {
    const script = `${PW_RESOLVE}
      (async () => {
        const b = await chromium.launch();
        const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true,
          deviceScaleFactor:3,
          userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' });
        const p = await ctx.newPage();
        await p.goto('http://127.0.0.1:${PORT}/?usr=EZiL&pwd=s1user&embed=1',{waitUntil:'domcontentloaded'});
        await p.waitForTimeout(9000);
        console.log(JSON.stringify(await p.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll('#ezil-kbd-btn, .fa-keyboard, [class*="keyboard"]')) {
            const r = el.getBoundingClientRect();
            if (getComputedStyle(el).display === 'none' || r.width === 0) continue;
            out.push({ id: el.id || null, w: Math.round(r.width), h: Math.round(r.height) });
          }
          return out;
        })));
        await b.close();
      })();
    `;
    const res = sh('node', ['-e', script], 180_000);
    // Same reasoning as `framesFor`/`remoteTextAfter`: a non-zero exit is a
    // crash, not "zero affordances found" — throw with the child's stderr.
    if (res.status !== 0) {
      throw new Error(`the node subprocess exited ${res.status} instead of reporting the affordance list — `
        + `stderr: ${(res.stderr || '').trim().slice(0, 2000) || '(empty)'}`);
    }
    const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '[]';
    const found = JSON.parse(line) as Array<{ id: string | null; w: number; h: number }>;
    // 🔴 ONE affordance, and it is the CLIENT'S — not one this file adds.
    //
    // This originally asserted the opposite: that our own `#ezil-kbd-btn`
    // survived and the client's was hidden. Tested on a real phone that was the
    // wrong way round. Ours is `position: fixed` OVER the streamed picture, so
    // it covered the remote browser's tab bar, and the owner reported it as not
    // working while the client's own button did. So this file no longer adds a
    // button at all; it grows the client's to a real touch target instead.
    expect(found.length).toBe(1);
    expect(found[0]!.id).toBe(null);
    expect(found[0]!.w).toBeGreaterThanOrEqual(48);
    expect(found[0]!.h).toBeGreaterThanOrEqual(48);
  }, 300_000);
});
