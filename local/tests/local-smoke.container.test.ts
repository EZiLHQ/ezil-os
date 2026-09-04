/**
 * The whole of local mode, end to end, in a real browser.
 *
 * ── What every other suite in this package structurally cannot answer ───────
 * `run-spec.test.ts` proves the argv is the argv we meant. `docker-host.test.ts`
 * proves the adapter builds it. `docker-host.container.test.ts` proves a real
 * container boots and neko answers an authenticated login.
 * `shell-contract.test.ts` proves the nine routes return the fields the shell
 * reads. All 210 of them were green on 2026-09-04 while:
 *
 *   - a cold boot on this machine answered `desktop_frame_foreign_origin` and
 *     the shell rendered `desktop_unreachable` over a healthy container, because
 *     `routes.ts#isOwnDesktopOrigin` pinned the desktop origin at port offset 0
 *     and this machine needs an offset to boot at all; and
 *   - nothing anywhere observed whether a click DID anything. The row brief and
 *     row T1's hand-off both said the desktop ignores every click unless
 *     `NEKO_SESSION_IMPLICIT_HOSTING=true`; measured here, that is FALSE for
 *     the pinned image (its launcher passes `--session.implicit_hosting=true`
 *     itself, and a flag outranks the environment). The claim was refuted by
 *     running it — which is exactly the kind of thing only this suite can do.
 *
 * Neither is visible to anything that speaks HTTP. `/health` is `true`,
 * `POST /api/login` is a 200 with an admin profile, the SPA is a 200, the
 * container is `running`. `docs/PLATFORM-NOTES.md` §16b: "a 200 from the
 * desktop origin is still not a picture". This suite is the only place in the
 * repository that asks the two questions underneath that:
 *
 *   1. DID PIXELS ARRIVE, AND ARE THEY MORE THAN ONE COLOUR — read out of the
 *      decoded `<video>` inside the desktop frame, through `../src/pixels.ts`,
 *      whose rejections are proven separately in `./pixels.test.ts` against
 *      hand-built uniform buffers.
 *   2. DOES INPUT REACH THE DESKTOP — three independent oracles, ranked below.
 *
 * ── The input oracles, and what each is blind to ────────────────────────────
 * MEASURED on the pinned image rather than taken from the row brief, which
 * proposed `is_watching` + "is host" as one signal. They are three:
 *
 *   (a) `GET /api/room/control` -> `{"has_host":false}` before the click and
 *       `{"has_host":true,"host_id":"EZiL-…"}` after it. This is NEKO
 *       ACCEPTING CONTROL. Blind to: whether X did anything with the events.
 *       (The brief's `profile.can_host` is a PERMISSION, not who holds control
 *       — see NEKO-GROUND-TRUTH.md:338. `has_host` is the fact.)
 *   (b) `xdotool getmouselocation` inside the container. This is X ITSELF
 *       reporting the pointer at the coordinate the browser sent, having
 *       travelled browser -> WebRTC -> neko -> XTEST. The STRONGEST oracle
 *       here, and the one the row brief assumed was unavailable — `xdotool` is
 *       in the image at `/usr/bin/xdotool`. Blind to: whether the application
 *       under the pointer reacted.
 *   (c) `state.is_watching` in `GET /api/sessions`. This is MEDIA REACHING THE
 *       BROWSER (§16b: its only writer is `PeerConnectionStateConnected`).
 *       Blind to input entirely — it is the pixel half, asserted here because
 *       it is also what the product's own `confirm=display` gate reads.
 *
 * NONE of them proves an application responded to a keystroke. A test that
 * claimed that would need to know what is on the desktop; this one asserts what
 * it can observe and says so.
 *
 * ── Skip semantics ──────────────────────────────────────────────────────────
 * Mirrors `../src/host/docker-host.container.test.ts`: a suite that could not
 * run must never look like a pass. Docker absent, image absent, no free port
 * offset, or Playwright unresolvable are LOUD skips through
 * `describe.skipIf` — never an early `return` from a test body, which bun
 * counts as a PASS (the failure mode `tools/test.sh`'s third gate exists for).
 * A container that boots and then misbehaves is a FAILURE.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENV_KEYS, loadConfig, type LocalConfig } from '../src/config.ts';
import {
    NEKO_PATHS,
    containerNameFor,
    localUrlFor,
    offsetPortMap,
    readAndResolveDesktopImage,
} from '../src/container/run-spec.ts';
import { DockerHost, NEKO_ROOM_SETTINGS_PATH } from '../src/host/docker-host.ts';
import { SHELL_API_ROUTES } from '../src/contract/shell-api.ts';
import { describeStats, isNonUniform, luminanceStats, type LuminanceStats } from '../src/pixels.ts';
import { resolveHost } from '../src/server/main.ts';
import { startLocalServer, type LocalServer } from '../src/server/server.ts';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/**
 * 🔴 THE ONLY DOM TYPES THIS PACKAGE HAS, AND THEY ARE DECLARED HERE ON
 * PURPOSE. `local/tsconfig.json`'s `lib` does not include `dom`, and it must
 * not: nothing under `local/src` runs in a browser, and widening the whole
 * package's lib so one test file can typecheck a `page.evaluate` callback
 * would silently let a `document` or a `fetch`-with-DOM-semantics creep into
 * the host's own code and compile. Two names, in the one file that sends a
 * function into a browser.
 */
declare const document: {
    querySelector(selector: string): any;
    createElement(tag: string): any;
};

/** A cold boot measured 5.7s script-side; a loaded machine and a 4.57GB image deserve room. A deadline is a ceiling, not an expectation. */
const BOOT_DEADLINE_MS = 180_000;
/** How long the browser may take to produce a decoded, non-uniform frame after the window opens. Measured 2.2s. */
const PIXEL_DEADLINE_MS = 60_000;

function sh(cmd: string, args: string[], timeout = 60_000) {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
}

/** A BIND, not a parse: a wildcard listener elsewhere (`docker-proxy` on `0.0.0.0:8443` here) makes the loopback bind fail, which is what `docker run` will hit. */
function tcpFree(port: number): boolean {
    try {
        const s = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() { /* unused */ } } });
        s.stop(true);
        return true;
    } catch {
        return false;
    }
}

async function udpFree(port: number): Promise<boolean> {
    try {
        const s = await Bun.udpSocket({ hostname: '127.0.0.1', port });
        s.close();
        return true;
    } catch {
        return false;
    }
}

async function pickOffset(): Promise<{ offset: number | null; busy: number[] }> {
    let lastBusy: number[] = [];
    for (const offset of [0, 10_000, 20_000, 30_000]) {
        const busy: number[] = [];
        for (const p of offsetPortMap(offset)) {
            const free = p.protocol === 'tcp' ? tcpFree(p.host) : await udpFree(p.host);
            if (!free) busy.push(p.host);
        }
        if (busy.length === 0) return { offset, busy: [] };
        lastBusy = busy;
    }
    return { offset: null, busy: lastBusy };
}

/**
 * Playwright, by the SAME convention `shell/run-tests.sh`, the shell's own
 * browser tests and `e2e/prod.mjs` use: resolvable from this file, or from
 * `$PLAYWRIGHT_REQUIRE_DIR`. NEVER a dependency of any package.json in this
 * repository — a real-browser suite that made every `bun install` pull a
 * browser would be paid for by every contributor who never runs it.
 */
function loadChromium(): { chromium: unknown } | { error: string } {
    const dir = process.env['PLAYWRIGHT_REQUIRE_DIR'];
    if (dir === undefined || dir === '') {
        return { error: 'PLAYWRIGHT_REQUIRE_DIR is unset — point it at a node_modules containing playwright (e.g. /opt/ezil-testkit/node_modules)' };
    }
    try {
        const req = createRequire(join(dir, 'noop.js'));
        return { chromium: (req('playwright') as { chromium: unknown }).chromium };
    } catch (err) {
        return { error: `playwright is not resolvable from PLAYWRIGHT_REQUIRE_DIR=${dir}: ${err instanceof Error ? err.message : String(err)}` };
    }
}

/** Why this suite may not run. `null` means it CAN. */
async function unavailableReason(): Promise<{ reason: string } | { reason: null; image: string; offset: number; chromium: any }> {
    const version = sh('docker', ['version', '--format', '{{.Server.Version}}'], 20_000);
    if (version.error || version.status !== 0) {
        return { reason: `the Docker daemon is not reachable (${(version.stderr || version.error?.message || '').trim().split('\n')[0]})` };
    }
    const resolved = await readAndResolveDesktopImage(`${REPO_ROOT}deploy/images.env`);
    if (sh('docker', ['image', 'inspect', resolved.ref, '--format', '{{.Id}}'], 20_000).status !== 0) {
        return {
            reason: `the image \`${resolved.ref}\` (${resolved.source}${resolved.reason ? `: ${resolved.reason}` : ''}) is not present locally`
                + ` — build it with \`cd worker && docker build -t ${resolved.ref} .\``,
        };
    }
    const picked = await pickOffset();
    if (picked.offset === null) {
        return { reason: `every candidate port offset collides with something already listening (busy at the last try: ${picked.busy.join(', ')})` };
    }
    const pw = loadChromium();
    if ('error' in pw) return { reason: pw.error };
    return { reason: null, image: resolved.ref, offset: picked.offset, chromium: pw.chromium };
}

const availability = await unavailableReason();
const SKIP_REASON = availability.reason;
const OFFSET = 'offset' in availability ? availability.offset : 0;
const IMAGE = 'image' in availability ? availability.image : '';
const chromium: any = 'chromium' in availability ? availability.chromium : null;

if (SKIP_REASON !== null) {
    console.warn(
        `\n${'='.repeat(78)}\n`
        + `SKIPPING the local-mode real-browser smoke: ${SKIP_REASON}.\n`
        + 'This is a SKIP, not a pass. It is the ONLY test in this repository that\n'
        + 'observes real pixels and real input on a locally-booted desktop.\n'
        + `${'='.repeat(78)}\n`,
    );
}

// ── State shared across the ordered tests in this suite ──────────────────────

/** A fresh workspace per run: the computer id is derived from this path, so it is also what makes the container name unique. */
const WORKSPACE = mkdtempSync(join(tmpdir(), 'ezil-t5-ws-'));
const STATE_DIR = mkdtempSync(join(tmpdir(), 'ezil-t5-state-'));

let config: LocalConfig | null = null;
let server: LocalServer | null = null;
let host: DockerHost | null = null;
let browser: any = null;
let computerId = '';
let bootMs = -1;
let timeToPixelsMs = -1;
let pixelStats: LuminanceStats | null = null;
/** The page that holds the live desktop peer. Shared across the ordered tests: a second page would be a SECOND peer, and `is_watching` counts peers. */
let page: any = null;

/** neko's admin API, as the ADAPTER sees it — through the host's own credential resolution, never a literal. */
async function nekoGet(path: string): Promise<unknown> {
    const origin = localUrlFor('desktop', OFFSET);
    // `fetchIn` is request/response only and reaches the container's own port,
    // which is exactly what is wanted here; but it carries no credential, so
    // the token comes from the host's login the same way `probeDisplay` gets
    // one. Rather than reimplement that, this asks the host's own public
    // capability where it can, and only reads the raw path where the assertion
    // is about a field the capability deliberately does not surface.
    const token = await nekoAdminToken();
    try {
        const res = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
        return await res.json();
    } finally {
        await nekoLogout(token);
    }
}

/** An admin token, through the HOST's own credential resolution — never a literal, and never printed. */
async function nekoAdminToken(): Promise<string> {
    const creds = await (host as any).credentialsFor(computerId);
    const login = await fetch(`${localUrlFor('desktop', OFFSET)}${NEKO_PATHS.login}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ezil-os-smoke', password: creds.admin }),
    });
    if (!login.ok) throw new Error(`neko login for the smoke probe answered ${login.status}`);
    return ((await login.json()) as { token: string }).token;
}

/**
 * 🔴 ALWAYS, AFTER EVERY PROBE. Every leaked session is another entry in
 * `GET /api/sessions`, which is the array `probeDisplay` counts and this suite
 * asserts `watching === 1` against — a probe that leaked would eventually be
 * measuring itself. Measured while writing this row: five un-logged-out probe
 * logins left five sessions in that array.
 */
async function nekoLogout(token: string): Promise<void> {
    await fetch(`${localUrlFor('desktop', OFFSET)}${NEKO_PATHS.logout}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
    }).catch(() => { /* best effort — a probe that could not clean up is not a failure */ });
}

/** `xdotool getmouselocation` inside the container, parsed. X's own answer about where the pointer is. */
async function pointerLocation(): Promise<{ x: number; y: number }> {
    const res = await host!.exec(computerId, ['sh', '-c', 'DISPLAY=:99 xdotool getmouselocation'], { timeoutMs: 20_000 });
    const m = /x:(\d+)\s+y:(\d+)/.exec(res.stdout);
    if (!m) throw new Error(`xdotool getmouselocation did not answer: ${res.stdout}${res.stderr}`);
    return { x: Number(m[1]), y: Number(m[2]) };
}

afterAll(async () => {
    // 🔴 TEAR EVERYTHING DOWN, IN THE ORDER THAT CANNOT LEAVE AN ORPHAN, AND
    // NEVER LET ONE FAILURE SKIP THE NEXT. A browser process, a bound port and
    // a 4.5GB container each outlive this process otherwise.
    try { if (browser) await browser.close(); } catch { /* the container matters more */ }
    try { if (server) await server.stop(); } catch { /* ditto */ }
    try { if (host && computerId !== '') await host.terminate(computerId); } catch { /* the belt-and-braces rm below */ }
    // Belt and braces: `terminate` goes through the adapter, and if the adapter
    // is what broke, the container is still there. This is unconditional.
    if (computerId !== '') sh('docker', ['rm', '--force', containerNameFor(computerId)], 60_000);
});

describe.skipIf(SKIP_REASON !== null)('local mode, in a real browser', () => {
    beforeAll(async () => {
        config = await loadConfig({
            [ENV_KEYS.port]: '0',
            [ENV_KEYS.portOffset]: String(OFFSET),
            [ENV_KEYS.workspace]: WORKSPACE,
            [ENV_KEYS.stateDir]: STATE_DIR,
        });
        // 🔴 THE PRODUCTION WIRING, NOT A HOST THIS TEST BUILT. `resolveHost`
        // is the one place a user's `bun run start` constructs an adapter, and
        // a smoke test that composed its own `DockerHost` would prove the
        // adapter works while leaving the only function anybody actually runs
        // untested. It returned a THROW until this row.
        const resolved = resolveHost([], config);
        expect(resolved).toBeInstanceOf(DockerHost);
        host = resolved as DockerHost;
        server = await startLocalServer({ config, host });
        computerId = server.computer.id();
    }, 60_000);

    it('the production wiring boots a real desktop through the shell API', async () => {
        // The shell's own first two calls, in the shell's own order.
        const session = await fetch(`${server!.url}${SHELL_API_ROUTES.session}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        expect(session.status).toBe(200);
        const payload = (await session.json()) as { computer: { id: string }; desktopState: { configured: boolean } };
        expect(payload.computer.id).toBe(computerId);
        expect(payload.desktopState.configured).toBe(true);

        const t0 = Date.now();
        const res = await fetch(`${server!.url}${SHELL_API_ROUTES.desktop}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ computerId }),
        });
        bootMs = Date.now() - t0;
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            ok: boolean;
            error?: string;
            guacamoleUrl?: string;
            controlMode?: string;
            frame?: { confirmed: boolean };
        };
        // 🔴 THE ASSERTION THAT WAS RED BEFORE THIS ROW. With a port offset,
        // this answered `{ok: false, error: 'desktop_frame_foreign_origin'}`
        // because the SSRF pin in `routes.ts` was offset-blind. The message is
        // asserted rather than only `ok`, so a regression names itself.
        expect(`${body.ok} ${body.error ?? ''}`.trim()).toBe('true');
        expect(body.frame?.confirmed).toBe(true);
        expect(typeof body.guacamoleUrl).toBe('string');
        expect(body.guacamoleUrl).toContain(`:${offsetPortMap(OFFSET).find((p) => p.name === 'desktop')!.host}`);

        // 🔴 `implicit`, AND IT IS A READ-BACK. `readControlMode` GETs
        // `/api/room/settings`; the pinned image's own yaml says
        // `implicit_hosting: false`, so this value can only be `implicit`
        // because `NEKO_SESSION_IMPLICIT_HOSTING=true` reached the container
        // AND neko honoured it.
        expect(body.controlMode).toBe('implicit');
        console.log(`\n[T5 measured] cold boot through POST ${SHELL_API_ROUTES.desktop}: ${(bootMs / 1000).toFixed(1)}s (offset ${OFFSET}, image ${IMAGE})\n`);
    }, BOOT_DEADLINE_MS);

    it('readControlMode is a READ: turn implicit hosting off on the live container and it says manual', async () => {
        // The read-back's own source, read independently of the route that
        // reports it.
        const settings = (await nekoGet(NEKO_ROOM_SETTINGS_PATH)) as Record<string, unknown>;
        expect(settings['implicit_hosting']).toBe(true);
        expect(await host!.readControlMode(computerId)).toBe('implicit');

        // 🔴 THE CONTAINER-LEVEL CONTROL, AND IT EXISTS BECAUSE THE ROW BRIEF
        // WAS REFUTED. The brief (and row T1's hand-off) said the desktop
        // ignores every click unless `NEKO_SESSION_IMPLICIT_HOSTING=true`.
        // MEASURED against `ezil-os-worker-sandbox:ff199202`: booting with NO
        // such variable, and booting with it set to `false`, BOTH report
        // `implicit_hosting: true` — because the image's own
        // `/usr/local/bin/start-neko.sh:3122` passes
        // `--session.implicit_hosting=true` as an explicit flag, which Viper
        // ranks above the environment. So dropping the variable is NOT a
        // mutation that can redden anything on this image, and a suite whose
        // only control was "the variable is present" would be asserting a
        // constant about itself.
        //
        // The real control is this: change the thing being READ, on a live
        // container, and watch the read-back follow it. `POST /api/room/settings`
        // is a WHOLE-OBJECT REPLACE (the hosted `enableImplicitHosting` records
        // this: posting without `heartbeat_interval` reset the room's 10 to 0),
        // so the current object is sent back with exactly one field changed.
        const set = async (value: boolean): Promise<void> => {
            const token = await nekoAdminToken();
            try {
                const res = await fetch(`${localUrlFor('desktop', OFFSET)}${NEKO_ROOM_SETTINGS_PATH}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ ...settings, implicit_hosting: value }),
                });
                // MEASURED: neko answers **204 No Content**, not 200. The
                // hosted `enableImplicitHosting` reads `setRes.ok`, which
                // covers both — asserting 200 here went RED on the first run
                // and is recorded rather than quietly loosened.
                expect(`${res.status} ok=${res.ok}`).toBe(`${res.status} ok=true`);
                expect(res.status).toBe(204);
            } finally {
                await nekoLogout(token);
            }
        };

        // 🔴 THE RESTORE IS IN A `finally`. This test deliberately breaks the
        // desktop it shares with the tests after it, and an assertion that
        // failed mid-way would leave implicit hosting OFF — which showed up on
        // the first run as the INPUT test failing with `has_host=false`, a
        // second red that had nothing to do with input. One failure must
        // produce one failure.
        let observedOff = '(not reached)';
        let routeOff = '(not reached)';
        try {
            await set(false);
            observedOff = await host!.readControlMode(computerId);
            // And the route the shell reads follows it, so `controlMode` is not
            // computed once at boot and cached.
            const off = await fetch(`${server!.url}${SHELL_API_ROUTES.desktop}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ computerId }),
            });
            routeOff = ((await off.json()) as { controlMode?: string }).controlMode ?? '(absent)';
        } finally {
            await set(true).catch(() => { /* asserted below */ });
        }
        expect(observedOff).toBe('manual');
        expect(routeOff).toBe('manual');
        // Prove the restore took, rather than assuming it.
        expect(await host!.readControlMode(computerId)).toBe('implicit');
        console.log('\n[T5 measured] readControlMode discriminates: implicit -> (settings flipped) manual -> (restored) implicit\n');
    }, 120_000);

    it('the shell mounts, the desktop window opens, and REAL PIXELS ARRIVE', async () => {
        // `--use-gl=swiftshader` is not decoration: headless Chromium needs a
        // software rasteriser to decode and composite the VP8 stream at all,
        // and `e2e/prod.mjs` launches with exactly these two flags.
        browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        const failedRequests: string[] = [];
        page.on('response', (r: any) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

        await page.goto(`${server!.url}/os`, { waitUntil: 'domcontentloaded' });
        // The shell's own mount signal: the taskbar item the boot log calls
        // `desktop`. Waiting on this rather than a timeout is what makes a
        // bundle that failed to load a FAILURE here rather than a slow pass.
        await page.waitForSelector('.taskbar-item[data-app="desktop"]', { timeout: 60_000 });

        const tOpen = Date.now();
        await page.locator('.taskbar-item[data-app="desktop"]').click();
        // The same selector `e2e/prod.mjs` waits on in production.
        await page.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe', { timeout: 120_000 });

        const desktopPort = offsetPortMap(OFFSET).find((p) => p.name === 'desktop')!.host;
        const deadline = Date.now() + PIXEL_DEADLINE_MS;
        let last = 'the desktop frame never appeared';
        while (Date.now() < deadline) {
            await page.waitForTimeout(500);
            const frame = page.frames().find((f: any) => f.url().includes(`:${desktopPort}`));
            if (!frame) continue;
            // 🔴 THE PIXELS COME OUT OF THE FRAME AS BYTES AND THE VERDICT IS
            // REACHED HERE. The in-page half only draws and reads; the
            // statistic is `../src/pixels.ts`, the same function
            // `./pixels.test.ts` proves rejects a uniform buffer. A threshold
            // evaluated inside `page.evaluate` could never be shown to fail.
            //
            // NOT a `page.screenshot()`: a cross-origin iframe playing WebRTC
            // video composites black in a headless screenshot often enough that
            // the oracle would be measuring the compositor, not the stream.
            const captured = await frame.evaluate(() => {
                const v = document.querySelector('video');
                if (!v) return { reason: 'no <video> element in the desktop frame' };
                if (!v.videoWidth) {
                    // §16b's exact measured symptom, reported in its own words.
                    return { reason: `videoWidth: 0, paused: ${v.paused}, readyState: ${v.readyState}, srcObject: ${!!v.srcObject}` };
                }
                const canvas = document.createElement('canvas');
                canvas.width = 160;
                canvas.height = 100;
                const ctx = canvas.getContext('2d');
                if (!ctx) return { reason: 'no 2d context' };
                ctx.drawImage(v, 0, 0, 160, 100);
                return {
                    width: v.videoWidth,
                    height: v.videoHeight,
                    data: [...ctx.getImageData(0, 0, 160, 100).data],
                };
            }).catch((err: unknown) => ({ reason: `frame evaluate failed: ${String(err).slice(0, 160)}` }));

            if ('reason' in captured) { last = captured.reason as string; continue; }
            const stats = luminanceStats((captured as { data: number[] }).data);
            if (isNonUniform(stats)) {
                pixelStats = stats;
                timeToPixelsMs = Date.now() - tOpen;
                expect((captured as { width: number }).width).toBeGreaterThan(0);
                break;
            }
            last = describeStats(stats);
        }

        // Asserting on the DESCRIPTION rather than a boolean: a red run then
        // prints what was actually seen ("ALL BLACK", "videoWidth: 0, paused:
        // true, …") instead of `expected true, got false`.
        expect(pixelStats === null ? `NOT NON-UNIFORM — ${last}` : 'NON-UNIFORM').toBe('NON-UNIFORM');
        console.log(
            `\n[T5 measured] time to non-uniform pixels after the window opened: ${timeToPixelsMs}ms`
            + `\n[T5 measured] ${describeStats(pixelStats!)}\n`,
        );

        // The defect `e2e/prod.mjs` was written for: a 404 on a client-critical
        // asset kills the neko client silently. Locally the only assets that can
        // 404 are this host's own three, and a 404 on any of them means `/os`
        // is a blank page. Non-critical 4xx (jQuery-UI theme sprites the shell
        // asks for and this host does not serve) are printed, not failed —
        // split so the check that matters cannot be drowned by the one that
        // does not.
        const critical = failedRequests.filter((u) => /bundle\.min\.(js|css)|icons\.js|\/api\/shell\//.test(u));
        expect(critical).toEqual([]);
        const cosmetic = failedRequests.filter((u) => !critical.includes(u));
        if (cosmetic.length > 0) console.log(`      note: ${cosmetic.length} non-critical 4xx — ${cosmetic.slice(0, 3).join(' | ')}`);

    }, BOOT_DEADLINE_MS);

    it('neko reports a watching peer, and the product\'s own display gate says live', async () => {
        // (c) The media oracle. §16b: `state.is_watching` has exactly one
        // writer, `PeerConnectionStateConnected`.
        const sessions = (await nekoGet(NEKO_PATHS.sessions)) as Array<{ state?: { is_watching?: boolean; is_connected?: boolean } }>;
        const watching = sessions.filter((s) => s.state?.is_watching === true);
        expect(`watching=${watching.length} of ${sessions.length} sessions`).toBe(`watching=1 of ${sessions.length} sessions`);

        // The same fact through the adapter's own capability...
        const probe = await host!.probeDisplay(computerId);
        expect(probe.display).toBe('live');
        expect(probe.watching).toBe(1);

        // ...and through the route the SHELL actually calls. This is the answer
        // that was hardcoded `unknown` before this row, so the desktop was
        // always revealed as `ready_unverified`.
        const gate = await fetch(
            `${server!.url}${SHELL_API_ROUTES.desktop}?computerId=${computerId}&confirm=display&frameUrl=x`,
        );
        const body = (await gate.json()) as { ok: boolean; display: string; watching?: number };
        expect(`${body.ok} ${body.display}`).toBe('true live');
        expect(body.watching).toBe(1);
    }, 60_000);

    it('INPUT REACHES THE DESKTOP: neko grants control and X moves the pointer', async () => {
        expect(page).not.toBeNull();

        // (a) Before: nobody holds control. The positive control for the
        // assertion after the click — without it, `has_host: true` could mean
        // "it was always true".
        const before = (await nekoGet('/api/room/control')) as { has_host?: boolean };
        expect(before.has_host).toBe(false);
        const pointerBefore = await pointerLocation();

        const box = await (await page.$('.window[data-app="desktop"] iframe.window-app-iframe')).boundingBox();
        expect(box).not.toBeNull();

        // Click the middle, then move to a point whose X coordinate is
        // arithmetically predictable. Two actions because the click is what
        // requests control and the move is what proves the coordinates
        // survived the trip.
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await page.waitForTimeout(1_500);
        const targetFracX = 0.2;
        const targetFracY = 0.25;
        await page.mouse.move(box.x + box.width * targetFracX, box.y + box.height * targetFracY, { steps: 8 });
        await page.keyboard.type('ezil');
        await page.waitForTimeout(1_500);

        // (a) After: neko accepted control and named the session that holds it.
        const after = (await nekoGet('/api/room/control')) as { has_host?: boolean; host_id?: string };
        expect(`has_host=${after.has_host} host=${(after.host_id ?? '').startsWith('EZiL')}`).toBe('has_host=true host=true');

        // (b) The strongest oracle: X's own pointer, at the coordinate the
        // browser sent. The stream is `stream.w x stream.h` scaled into the
        // iframe box, so the expected X coordinate is the fraction times the
        // stream width.
        const screen = await host!.readScreen(computerId);
        expect(screen.ok && screen.verified).toBe(true);
        const pointerAfter = await pointerLocation();
        const expectedX = Math.round(screen.width * targetFracX);
        const expectedY = Math.round(screen.height * targetFracY);
        // 🔴 THE TOLERANCE IS DERIVED, NOT PICKED. One CSS pixel of the iframe
        // maps to `screen.width / box.width` device pixels (1920/1440 = 1.33
        // here), and both ends round. Six device pixels is ~4 CSS pixels of
        // slack on a 1920-wide stream — tight enough that a pointer that never
        // moved (measured start: 960,960) fails by 500+, and loose enough to
        // survive rounding. Measured on the real run: expected 384,270 and X
        // reported 383,268.
        const tolerance = 6;
        const dx = Math.abs(pointerAfter.x - expectedX);
        const dy = Math.abs(pointerAfter.y - expectedY);
        expect(`dx=${dx <= tolerance} dy=${dy <= tolerance}`).toBe('dx=true dy=true');
        // And it genuinely MOVED — the same assertion would pass by accident if
        // the pointer happened to start there.
        expect(pointerBefore.x !== pointerAfter.x || pointerBefore.y !== pointerAfter.y).toBe(true);

        // (c) neko's own log, ANSI-stripped: the host-change line, which is the
        // event `enableImplicitHosting` exists to make reachable.
        //
        // 🔴 `/tmp/neko.log`, NOT `docker logs`, AND THAT IS A MEASUREMENT.
        // The first run of this test asserted on `DockerHost.logs()` and went
        // RED: the container's stdout carries only `start-neko.sh`'s own
        // `[ezil-boot]` phase lines (the whole 8.4s boot, ending at
        // `sidecar_launch`), because neko is launched with its output going to
        // `/tmp/neko.log` inside the container. A test that had asserted the
        // ABSENCE of something in `docker logs` would have "passed" on the same
        // mistake forever.
        const log = stripAnsi(
            (await host!.exec(computerId, ['sh', '-c', 'cat /tmp/neko.log'], { timeoutMs: 20_000 })).stdout,
        );
        expect(log).toContain('session host changed');
        // Positive control on the same file: it really is neko's log and it
        // really was read, so the line above is a fact about hosting and not
        // about a file that happened to contain the string.
        expect(log).toContain('webrtc starting');

        console.log(
            `\n[T5 measured] input oracle (a) /api/room/control: has_host false -> true, host_id ${after.host_id}`
            + `\n[T5 measured] input oracle (b) xdotool: pointer ${pointerBefore.x},${pointerBefore.y}`
            + ` -> ${pointerAfter.x},${pointerAfter.y} (expected ${expectedX},${expectedY} from a ${screen.width}x${screen.height} stream in a ${Math.round(box.width)}x${Math.round(box.height)} box)`
            + '\n[T5 measured] input oracle (c) /tmp/neko.log: "session host changed"'
            + '\n[T5 blind to] whether the APPLICATION under the pointer reacted — no oracle here reads the desktop\'s own UI\n',
        );
    }, BOOT_DEADLINE_MS);

    it('leaves nothing behind: the container is gone after terminate', async () => {
        // Runs last, and duplicates what `afterAll` does, because "the teardown
        // worked" is itself an assertion — `docker ps -a` after a run is the
        // evidence this row reports.
        const res = await host!.terminate(computerId);
        expect(res).toEqual({ ok: true, terminated: true });
        const inspected = sh('docker', ['inspect', containerNameFor(computerId)], 20_000);
        expect(inspected.status).not.toBe(0);
        const status = await host!.status(computerId);
        expect(status.containerState).toBe('absent');
    }, 120_000);
});

/** neko colourises its own log; a substring assertion has to see the bytes it means. */
function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\[[0-9;]*m/g, '');
}
