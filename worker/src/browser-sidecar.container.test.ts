/**
 * The browser sidecar, against a REAL container running the REAL desktop.
 *
 * ── Why nothing here is mocked ──────────────────────────────────────────────
 * This repo's rule is that a test which mocks the thing it tests proves
 * nothing, and this feature is exactly where that rule bites. A fake CDP
 * endpoint would prove that our JSON parses. It would not prove that
 * `--remote-debugging-port` reaches a Chrome that openbox has already
 * maximised, that `connectOverCDP` adopts the tab the user is watching rather
 * than opening an invisible one, that a `/navigate` changes the window title
 * on the X display, or that a password field is a black box in the PNG. Every
 * assertion below is read off a live container:
 *
 *   - CDP answers on 127.0.0.1:9222 and is REFUSED on the container's routable
 *     address — the loopback-only property, measured rather than assumed.
 *   - the sidecar answers on 0.0.0.0:9223, which is the address
 *     `containerFetch` reaches (Cloudflare's proxy reaches containers on
 *     10.0.0.1, never loopback — see start-codeserver.sh's note).
 *   - a navigation really changes the page: `wmctrl` on the X display reports
 *     a new window title. That is the assertion a mock cannot fake, because
 *     the window belongs to the desktop, not to Playwright.
 *   - the typed password appears in NO response, and the guard is the thing
 *     doing it (see the mutation notes in `worker/sidecar/README.md`).
 *   - the pinned 1920x1080 window geometry survives all of it.
 *
 * ── Skip semantics ──────────────────────────────────────────────────────────
 * A suite that could not run must never look like a pass. Docker absent, image
 * absent, or an image that predates the sidecar are all loud skips naming the
 * exact command that fixes them. A container that boots and then misbehaves is
 * a FAILURE, never a skip — at that point everything needed was available and
 * the answer is genuinely bad news.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Same default and override as `neko-browser-window.container.test.ts`. */
const IMAGE = process.env.EZIL_VALIDATE_IMAGE ?? 'ezil-integrated:local';
const CONTAINER = `ezil-s1-sidecar-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * SIGTERM/SIGINT SURVIVAL -- docs/CONFIDENCE-MAP.md section 2.10 / section 3.9,
 * reproduced against `neko-browser-window.container.test.ts` (this suite's
 * sibling, same shape). `afterAll` alone only fires on a normal bun-test
 * exit; a cancellation (Ctrl-C, a CI job cancellation, a harness timeout that
 * sends SIGTERM) skips straight past it and orphans a container built from a
 * 4.57 GB image. So this container's name is registered in a module-level
 * set that a process-level signal handler removes on the way out.
 * `spawnSync`, not an async shape, because Node/Bun runs `exit` handlers
 * SYNCHRONOUSLY -- an outstanding async `docker rm -f` would never be
 * awaited and would not survive `exit` at all.
 */
const CONTAINERS_TO_CLEAN = new Set<string>();
let cleanupOnExitInstalled = false;
function installCleanupOnExit () {
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
const BOOT_TIMEOUT_MS = 180_000;

/** Where the in-container fixture is served. Loopback only — `/navigate`
 *  accepts http, and nothing outside the container needs to see it. */
const FIXTURE_PORT = 8099;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/login.html`;

/** The value that must never come back. Long enough to be unambiguous in a
 *  grep, and above `MIN_SECRET_LENGTH` by a wide margin. */
const SECRET = 'hunter2-correct-horse-battery-staple';

function sh (cmd: string, args: string[], timeout = 60_000) {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
}

function dexec (args: string[], timeout = 90_000) {
    return sh('docker', ['exec', CONTAINER, ...args], timeout);
}

/** Why this suite may not run. `null` means it CAN. */
function unavailableReason (): string | null {
    const version = sh('docker', ['version', '--format', '{{.Server.Version}}'], 20_000);
    if (version.error || version.status !== 0) {
        return `the Docker daemon is not reachable (${(version.stderr || version.error?.message || '').trim().split('\n')[0]})`;
    }
    const image = sh('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], 20_000);
    if (image.status !== 0) {
        return `the image \`${IMAGE}\` is not present locally (build it with \`cd worker && docker build -t ${IMAGE} .\`)`;
    }
    // An image that predates this feature cannot answer any question below.
    // Treated as "the artifact under test is absent", exactly like a missing
    // image — NOT as a failure, and NOT as a pass.
    const probe = sh('docker', ['run', '--rm', '--entrypoint', 'test', IMAGE, '-f', '/opt/ezil-sidecar/server.mjs'], 60_000);
    if (probe.status !== 0) {
        return `\`${IMAGE}\` has no /opt/ezil-sidecar (it predates the browser sidecar) — rebuild it with \`cd worker && docker build -t ${IMAGE} .\``;
    }
    return null;
}

const SKIP_REASON = unavailableReason();
let started = false;

interface SidecarResponse { [k: string]: unknown }

/** POST a verb from INSIDE the container, over its own loopback. */
function verb (name: string, body: unknown): SidecarResponse {
    const res = dexec([
        'curl', '-s', '--max-time', '90',
        '-X', 'POST', '-H', 'content-type: application/json',
        '--data-binary', JSON.stringify(body),
        `http://127.0.0.1:9223/${name}`,
    ]);
    const raw = (res.stdout || '').trim();
    if (!raw) throw new Error(`/${name} returned nothing (stderr: ${(res.stderr || '').trim()})`);
    try {
        return JSON.parse(raw) as SidecarResponse;
    } catch {
        throw new Error(`/${name} returned non-JSON: ${raw.slice(0, 400)}`);
    }
}

/** The window title openbox/X report for the browser — NOT anything Playwright
 *  told us. This is what makes "the navigation really happened" checkable. */
function xWindowTitle (): string {
    const res = dexec(['bash', '-lc', 'DISPLAY=:99 wmctrl -l']);
    return (res.stdout || '').trim();
}

function boot (): void {
    const run = sh('docker', [
        'run', '-d', '--name', CONTAINER, '--cpus=2',
        '-e', 'DESKTOP_MODE=neko',
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
    let ready = false;
    while (Date.now() < deadline) {
        const probe = dexec(['grep', '-c', 'phase=ready', '/tmp/neko.log'], 20_000);
        if (probe.status === 0 && Number((probe.stdout || '0').trim()) > 0) { ready = true; break; }
        const alive = sh('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], 20_000);
        if ((alive.stdout || '').trim() !== 'true') {
            const logs = sh('docker', ['logs', '--tail', '40', CONTAINER], 20_000);
            throw new Error(`container exited before becoming ready:\n${logs.stdout}\n${logs.stderr}`);
        }
        Bun.sleepSync(1000);
    }
    if (!ready) throw new Error(`container never reached phase=ready within ${BOOT_TIMEOUT_MS}ms`);

    // The sidecar is launched AFTER readiness (see `launch_browser_sidecar` in
    // start-neko.sh — it is deliberately downstream of the boot verdict), so
    // wait for its port separately rather than assuming readiness covers it.
    const sidecarDeadline = Date.now() + 60_000;
    while (Date.now() < sidecarDeadline) {
        const h = dexec(['curl', '-s', '--max-time', '3', 'http://127.0.0.1:9223/health'], 20_000);
        if ((h.stdout || '').includes('"ok":true')) return;
        Bun.sleepSync(1000);
    }
    const log = dexec(['tail', '-20', '/tmp/ezil-sidecar.log'], 20_000);
    throw new Error(`sidecar never answered on 9223:\n${log.stdout}\n${log.stderr}`);
}

/**
 * A login page with a real `input[type=password]`, served over http inside the
 * container. Written with a heredoc rather than `docker cp` so the whole
 * fixture is visible here, in the test that depends on it.
 */
function serveFixture (): void {
    const html = [
        '<!doctype html><html><head><title>S1 Login Fixture</title></head><body><main>',
        '<h1>Sign in to EZiL</h1>',
        '<p>Fixture for the browser-sidecar container suite.</p>',
        '<form id="f">',
        '<label for="email">Email</label><input id="email" name="email" type="text" placeholder="you@example.com">',
        '<label for="pw">Password</label><input id="pw" name="password" type="password" placeholder="password">',
        '<button id="go" type="button" onclick="document.getElementById(\'out\').textContent=\'CLICKED\'">Sign in</button>',
        '</form>',
        '<p id="out">not clicked</p>',
        '</main></body></html>',
    ].join('\n');
    const write = dexec(['bash', '-lc',
        `mkdir -p /tmp/s1web && cat > /tmp/s1web/login.html <<'EZILFIXTURE'\n${html}\nEZILFIXTURE\n`
        + `cat > /tmp/s1web/other.html <<'EZILFIXTURE'\n<!doctype html><title>S1 Other</title><h1>Other page</h1>\nEZILFIXTURE\n`
        + `cd /tmp/s1web && (setsid python3 -m http.server ${FIXTURE_PORT} --bind 127.0.0.1 >/tmp/s1web.log 2>&1 &) ; sleep 1 ; `
        + `curl -s -o /dev/null -w '%{http_code}' ${FIXTURE_URL}`]);
    if ((write.stdout || '').trim().slice(-3) !== '200') {
        throw new Error(`fixture did not serve: ${(write.stdout || '').trim()} ${(write.stderr || '').trim()}`);
    }
}

let bootError: string | null = null;

if (SKIP_REASON) {
    console.warn(
        `\n${'='.repeat(78)}\n`
        + `SKIPPING the browser-sidecar container suite: ${SKIP_REASON}.\n`
        + `Nothing about CDP, the sidecar, password redaction, or the window geometry\n`
        + `has been verified by this run. These behaviours are ONLY provable in a\n`
        + `container — the unit suites beside this one check wire SHAPE, not behaviour.\n`
        + `${'='.repeat(78)}\n`,
    );
} else {
    try {
        boot();
        serveFixture();
    } catch (err) {
        bootError = err instanceof Error ? err.message : String(err);
    }
}

afterAll(() => {
    if (started) sh('docker', ['rm', '-f', CONTAINER], 60_000);
});

const itIf = SKIP_REASON ? it.skip : it;

describe('browser sidecar: a real container, a real Chrome', () => {
    itIf('booted and reached the sidecar', () => {
        expect(bootError ?? 'ok').toBe('ok');
    });

    itIf('CDP answers on 127.0.0.1:9222 — the flag reached a real Chrome', () => {
        const res = dexec(['curl', '-s', '--max-time', '5', 'http://127.0.0.1:9222/json/version']);
        const body = JSON.parse((res.stdout || '{}').trim()) as { Browser?: string; webSocketDebuggerUrl?: string };
        expect(body.Browser ?? '').toContain('Chrome/');
        // The endpoint advertises itself on loopback, which is the shape the
        // sidecar connects to.
        expect(body.webSocketDebuggerUrl ?? '').toContain('ws://127.0.0.1:9222/');
    });

    itIf('CDP is REFUSED on the container\'s routable address', () => {
        // 🔴 The security property, measured. Chromium M113+ pins
        // `--remote-debugging-address` to 127.0.0.1 regardless of flags, and
        // nothing in this repo may undo that: whatever reaches CDP reads every
        // page, exfiltrates the profile's cookies and runs arbitrary JS.
        const ip = (sh('docker', ['inspect', '-f',
            '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', CONTAINER]).stdout || '').trim();
        expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        const res = dexec(['curl', '-s', '--max-time', '5', '-o', '/dev/null',
            '-w', '%{http_code}', `http://${ip}:9222/json/version`]);
        // curl exit 7 = connection refused; http_code 000 = nothing answered.
        expect(`${(res.stdout || '').trim()}|${res.status}`).toBe('000|7');
    });

    itIf('the sidecar answers on the routable address — the containerFetch path', () => {
        const ip = (sh('docker', ['inspect', '-f',
            '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', CONTAINER]).stdout || '').trim();
        const res = dexec(['curl', '-s', '--max-time', '10', `http://${ip}:9223/health`]);
        const body = JSON.parse((res.stdout || '{}').trim()) as { ok?: boolean; chromeConnected?: boolean };
        expect(body.ok).toBe(true);
        expect(body.chromeConnected).toBe(true);
    });

    itIf('a navigation changes the page the DESKTOP is showing', () => {
        const before = xWindowTitle();
        expect(before).toContain('EZiL OS Browser');
        const nav = verb('navigate', { url: FIXTURE_URL });
        expect(nav.ok).toBe(true);
        expect(nav.title).toBe('S1 Login Fixture');
        // The load-bearing half: the title on the X display changed, so the
        // page that moved is the one in the window the user is watching —
        // `connectOverCDP` adopted the live tab rather than opening its own.
        const after = xWindowTitle();
        expect(after).toContain('S1 Login Fixture');
        expect(after).not.toContain('EZiL OS Browser');
    });

    itIf('a snapshot is an accessibility tree with exact refs, not a screenshot', () => {
        const snap = verb('snapshot', {}) as { ok: boolean; snapshot: string };
        expect(snap.ok).toBe(true);
        expect(snap.snapshot).toContain('heading "Sign in to EZiL" [ref=');
        expect(snap.snapshot).toContain('textbox "Password" [ref=');
        expect(snap.snapshot).toContain('button "Sign in" [ref=');
        // The token argument, made checkable: a whole login page of structure
        // in a few hundred characters, where a screenshot of it is ~22 KB of
        // PNG (and a model-legible fraction of that in tokens).
        expect(snap.snapshot.length).toBeLessThan(2000);
    });

    itIf('a click delivers real input — the page changes underneath it', () => {
        const snap = verb('snapshot', {}) as { snapshot: string };
        const ref = /button "Sign in" \[ref=(e\d+)\]/.exec(snap.snapshot)?.[1];
        expect(ref).toBeTruthy();
        expect(verb('click', { ref }).ok).toBe(true);
        const text = verb('get_text', {}) as { markdown: string };
        expect(text.markdown).toContain('CLICKED');
        expect(text.markdown).not.toContain('not clicked');
    });

    itIf('bad_ref and stale_ref are DIFFERENT answers', () => {
        // A ref nobody ever issued: the agent guessed.
        const bad = verb('click', { ref: 'e99999' });
        expect(bad.ok).toBe(false);
        expect(bad.error).toBe('bad_ref');

        // A ref that WAS valid, then the page navigated: re-snapshot.
        verb('navigate', { url: FIXTURE_URL });
        const snap = verb('snapshot', {}) as { snapshot: string };
        const ref = /button "Sign in" \[ref=(e\d+)\]/.exec(snap.snapshot)?.[1];
        verb('navigate', { url: `http://127.0.0.1:${FIXTURE_PORT}/other.html` });
        const stale = verb('click', { ref });
        expect(stale.ok).toBe(false);
        expect(stale.error).toBe('stale_ref');
    });

    itIf('the typed password appears in NO response', () => {
        verb('navigate', { url: FIXTURE_URL });
        const snap = verb('snapshot', {}) as { snapshot: string };
        const pwRef = /textbox "Password" \[ref=(e\d+)\]/.exec(snap.snapshot)?.[1];
        expect(pwRef).toBeTruthy();

        const typed = verb('type', { ref: pwRef, text: SECRET });
        expect(typed.ok).toBe(true);
        // Told, not silently omitted: a silent omission would be a lie to an
        // agent trying to confirm what it typed.
        expect(typed.redacted).toBe(true);

        // Every response surface the contract's redaction block names, plus an
        // error response (a Playwright message can quote the value).
        const responses = [
            JSON.stringify(typed),
            JSON.stringify(verb('snapshot', {})),
            JSON.stringify(verb('get_text', {})),
            JSON.stringify(verb('console', {})),
            JSON.stringify(verb('network', {})),
            JSON.stringify(verb('click', { ref: 'e99999' })),
            JSON.stringify(verb('screenshot', {})),
        ].join('\n');
        expect(responses).not.toContain(SECRET);

        // …and the snapshot really did reach the password field — otherwise
        // this whole test could pass by never looking at it.
        const after = verb('snapshot', {}) as { snapshot: string };
        const line = after.snapshot.split('\n').find((l) => l.includes('[type=password]'));
        expect(line).toBeTruthy();
        expect(line).toContain('[redacted]');
    });

    itIf('a screenshot MASKS the password field (byte-identical for 4 and 28 characters)', () => {
        // 🔴 The proof for the pixel half of the redaction rule, and it is a
        // mechanism-level one. A masked field is the same black box whatever
        // it holds; an unmasked one renders a different number of dots. So
        // byte identity across two different password LENGTHS is only possible
        // if the mask is really being applied. Mutation-proved by removing
        // `mask:` from the screenshot options in `verbs.mjs` — the two shas
        // then differ from each other AND from the masked one.
        verb('navigate', { url: FIXTURE_URL });
        const snap = verb('snapshot', {}) as { snapshot: string };
        const pwRef = /textbox "Password" \[ref=(e\d+)\]/.exec(snap.snapshot)?.[1];

        verb('type', { ref: pwRef, text: 'aaaa' });
        const short = verb('screenshot', {}) as { sha256: string; byteSize: number };
        verb('type', { ref: pwRef, text: 'a'.repeat(28) });
        const long = verb('screenshot', {}) as { sha256: string; byteSize: number };

        expect(long.sha256).toBe(short.sha256);
        expect(long.byteSize).toBe(short.byteSize);
    });

    itIf('the sha256 is of the bytes, computed by the sidecar', () => {
        // It becomes `evidence_artifacts.content_sha256` unchanged, so it has
        // to be produced where the bytes are produced — a digest the caller
        // supplies is the caller's word for what it captured.
        const shot = verb('screenshot', {}) as { pngBase64: string; sha256: string; byteSize: number; width: number; height: number };
        const bytes = Buffer.from(shot.pngBase64, 'base64');
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(shot.sha256);
        expect(bytes.length).toBe(shot.byteSize);
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(shot.width).toBe(1920);
        expect(shot.height).toBeGreaterThan(500);
    });

    itIf('there is no CDP passthrough verb, on the wire', () => {
        for (const path of ['evaluate', 'raw', 'send', 'cdp', 'exec', 'eval', 'json/version']) {
            const res = dexec(['curl', '-s', '--max-time', '20', '-o', '/dev/null', '-w', '%{http_code}',
                '-X', 'POST', '-H', 'content-type: application/json', '-d', '{}',
                `http://127.0.0.1:9223/${path}`]);
            expect(`${path}=${(res.stdout || '').trim()}`).toBe(`${path}=404`);
        }
        // And the refusal says so, rather than 404-ing anonymously.
        const body = dexec(['curl', '-s', '--max-time', '20', '-X', 'POST',
            '-H', 'content-type: application/json', '-d', '{}', 'http://127.0.0.1:9223/evaluate']);
        expect(body.stdout).toContain('no CDP passthrough');
    });

    itIf('navigate refuses javascript:, data: and file: — passthrough in disguise', () => {
        for (const url of ['javascript:fetch(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'chrome://settings']) {
            const res = verb('navigate', { url });
            expect(`${url} => ${res.ok} ${res.error}`).toBe(`${url} => false bad_request`);
        }
    });

    itIf('the pinned window geometry survived every one of the above', () => {
        // 🔴 The reason this test is in this file and not a separate one: the
        // question is not "is the geometry right on a fresh boot" (the
        // window-ready gate and `validate-neko-browser-window.sh` answer that)
        // but "did an automation session take it away". `connectOverCDP`
        // adopts an existing context rather than creating one, so it SHOULD be
        // inert — but this project has been bitten three times this month by
        // checks that passed in Docker and failed elsewhere, so it is measured
        // AFTER the navigations, clicks, types and screenshots above.
        const info = dexec(['bash', '-lc',
            'DISPLAY=:99 xwininfo -id 0x400003 | grep -E "Width:|Height:|Map State:|Absolute upper-left"']);
        const text = info.stdout || '';
        expect(text).toContain('Width: 1920');
        expect(text).toContain('Height: 1080');
        expect(text).toContain('Map State: IsViewable');
        expect(text).toMatch(/Absolute upper-left X:\s+0/);
        expect(text).toMatch(/Absolute upper-left Y:\s+0/);

        const props = dexec(['bash', '-lc',
            'DISPLAY=:99 xprop -id 0x400003 _NET_FRAME_EXTENTS _NET_WM_STATE']);
        expect(props.stdout).toContain('_NET_FRAME_EXTENTS(CARDINAL) = 0, 0, 0, 0');
        expect(props.stdout).toContain('_OB_WM_STATE_UNDECORATED');
        expect(props.stdout).toContain('_NET_WM_STATE_MAXIMIZED_VERT');
    });

    itIf('the boot log records the sidecar phase, and nothing about it reached /tmp/neko.log beyond names', () => {
        const log = dexec(['grep', '-E', 'phase=sidecar_launch|browser sidecar', '/tmp/neko.log']);
        expect(log.stdout).toContain('phase=sidecar_launch event=start');
        expect(log.stdout).toContain('phase=sidecar_launch event=end status=ok');
        expect(log.stdout).toContain('browser sidecar is serving on 9223');
        // `neko-logs.test.ts` enumerates every writer into this file and
        // demands a per-writer safety argument. The sidecar is not one: its own
        // output — which handles page content and typed input — goes to
        // /tmp/ezil-sidecar.log instead.
        const sidecarLog = dexec(['test', '-f', '/tmp/ezil-sidecar.log']);
        expect(sidecarLog.status).toBe(0);
        const leaked = dexec(['grep', '-c', SECRET, '/tmp/neko.log']);
        expect((leaked.stdout || '0').trim()).toBe('0');
    });
});
