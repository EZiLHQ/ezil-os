/**
 * The app-preview dev server must never be able to stop the desktop booting.
 *
 * This is a BEHAVIOURAL test: it executes the real `scripts/start-neko.sh`
 * with every external binary replaced by a stub, and a `DEVSERVER_BIN` that
 * NEVER RETURNS. It then asserts that neko still binds its HTTP port. Nothing
 * here inspects the script's source text for the "right" ordering — an
 * ordering assertion passes just as happily against a script that reintroduces
 * the coupling somewhere else.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * On 2026-08-02 every EZiL OS desktop stopped answering: the Worker reported
 * `The container is not listening in the TCP address 10.0.0.1:8181`. A
 * whole-filesystem diff of the last-good container image against the first-bad
 * one found EXACTLY ONE changed file out of ~19,000 — `start-devserver.sh`,
 * whose only change (036cb21) was repairing a shell syntax error that had made
 * it unparseable. Before that repair the dev server never launched and
 * consumed nothing; after it, `bun install` on a Next project ran concurrently
 * with Xvfb, openbox, code-server, Chrome and the fail-closed window-ready
 * gate on a 2-vCPU container.
 *
 * `start-neko.sh` carried a comment asserting that "a slow or crashing dev
 * server therefore never prevents the desktop from becoming ready". That was
 * true only because the thing it described could not run. The launcher call
 * has since moved to AFTER `neko serve` binds, which makes the claim
 * structural rather than accidental — and this test is what holds it there.
 *
 * ── What would make this test red ───────────────────────────────────────────
 * Moving the `launch_devserver` call back above the window-ready gate (or
 * anywhere else upstream of the neko bind), or adding any new synchronous
 * dev-server work to the boot path. Mutation-proved both ways while writing
 * it: with the call restored to its old position the run times out with the
 * neko port never opening; with the call at the end it passes in a few
 * seconds.
 *
 * ── Host requirements ───────────────────────────────────────────────────────
 * `bash` and `python3` (the latter is already a hard runtime dependency of
 * `start-devserver.sh`'s placeholder mode and is installed by the Dockerfile).
 * No Docker, no X server, no neko binary.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const START_NEKO = join(import.meta.dir, '..', 'scripts', 'start-neko.sh');

/** How long the desktop is allowed to take to bind its port, in this stubbed
 *  environment where nothing real starts. Generous: the point is the shape of
 *  the failure (never binds at all), not a performance budget. */
const BIND_DEADLINE_MS = 45_000;

function writeStub (dir: string, name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
    chmodSync(path, 0o755);
    return path;
}

function tcpOpen (port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(1000);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function waitForPort (port: number, deadlineMs: number): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
        if (await tcpOpen(port)) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

/** Ports well outside the ephemeral range and outside anything the real image
 *  uses, so a stray production-shaped listener cannot make this pass. */
function pickPort (offset: number): number {
    return 21000 + offset + (process.pid % 500);
}

interface Harness {
    proc: ChildProcess;
    stderr: () => string;
    nekoPort: number;
    devserverCalledMarker: string;
}

let running: Harness | null = null;
let workdir: string | null = null;

afterEach(() => {
    if (running?.proc.pid) {
        // The script ends in an intentional `while true` supervision loop and
        // leaves background children (supervisors, monitor, the stubs), so kill
        // the whole process group rather than just the leader.
        try { process.kill(-running.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    running = null;
    if (workdir) {
        try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
        workdir = null;
    }
});

/**
 * Boot the real script against stubs. `devserverBody` is the body of the
 * stubbed `DEVSERVER_BIN` — the knob each test turns.
 */
function bootWithDevserver (devserverBody: string): Harness {
    const root = mkdtempSync(join(tmpdir(), 'ezil-neko-boot-'));
    workdir = root;
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'workspace'), { recursive: true });
    mkdirSync(join(root, 'www'), { recursive: true });

    const nekoPort = pickPort(0);
    const codeServerPort = pickPort(1);
    const devserverCalledMarker = join(root, 'devserver-was-called');

    // X is "already up" so the script skips Xvfb entirely.
    writeStub(bin, 'xdpyinfo', 'exit 0');
    // The window-ready gate resolves Chrome by WM_CLASS in column 3 of
    // `wmctrl -x -l`. Report a matching window immediately.
    writeStub(bin, 'wmctrl', 'echo "0x01 0 chrome.Google-chrome stub EZiL OS Browser"');
    // Mandatory browser: named via NEKO_BROWSER_CANDIDATES below so the
    // preflight resolves this stub instead of a real Chrome on the host.
    writeStub(bin, 'ezil-stub-browser', 'exec sleep 600');
    // Mandatory code-server: must actually LISTEN, because the gate probes it
    // over TCP (`codeserver:tcp:...`).
    writeStub(bin, 'code-server', `exec python3 -m http.server ${codeServerPort} --bind 127.0.0.1`);
    // neko itself: the thing whose port is the whole point of this test.
    writeStub(bin, 'ezil-stub-neko', 'exec python3 -m http.server "$NEKO_HTTP_PORT" --bind 0.0.0.0');

    const devserver = writeStub(bin, 'ezil-stub-devserver', devserverBody);

    const proc = spawn('bash', [START_NEKO], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            NEKO_HTTP_PORT: String(nekoPort),
            NEKO_BIN: join(bin, 'ezil-stub-neko'),
            NEKO_STATIC: join(root, 'www'),
            DEVSERVER_BIN: devserver,
            EZIL_DEVSERVER_CALLED_MARKER: devserverCalledMarker,
            NEKO_BROWSER_CANDIDATES: 'ezil-stub-browser',
            EZIL_DESKTOP_APPS: `browser:window:chrome codeserver:tcp:127.0.0.1:${codeServerPort}`,
            NEKO_WINDOW_READY_TIMEOUT: '20',
            EZIL_WORKSPACE_ROOT: join(root, 'workspace'),
            EZIL_LOCAL_STATE_DIR: join(root, 'local-state'),
            CHROME_PROFILE_DIR: join(root, 'chrome-profile'),
            CHROME_HOME_FILE: join(root, 'no-such-landing-page.html'),
            NEKO_APP_HEALTH_FILE: join(root, 'health.json'),
            NEKO_APP_FATAL_SENTINEL: join(root, 'fatal'),
            NEKO_SWITCH_APP_BIN: join(root, 'neko-switch-app.sh'),
            XDG_RUNTIME_DIR: join(root, 'xdg'),
            DISPLAY: ':99',
        },
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    proc.stdout?.on('data', () => { /* drained so the pipe can never fill */ });

    const harness: Harness = { proc, stderr: () => stderr, nekoPort, devserverCalledMarker };
    running = harness;
    return harness;
}

describe('start-neko.sh: the dev server cannot block the desktop', () => {
    it('binds neko even when the dev-server launcher never returns', async () => {
        // The worst case the old ordering could not survive: a launcher that
        // hangs forever. A real `bun install` on a cold Next project is the
        // bounded version of the same thing.
        const h = bootWithDevserver(
            'touch "${EZIL_DEVSERVER_CALLED_MARKER:-/dev/null}"\nexec sleep 600',
        );

        const bound = await waitForPort(h.nekoPort, BIND_DEADLINE_MS);
        expect(`neko bound :${h.nekoPort} => ${bound}\n${h.stderr().slice(-2000)}`)
            .toBe(`neko bound :${h.nekoPort} => true\n${h.stderr().slice(-2000)}`);

        // …and the dev server really was launched, so this cannot pass by the
        // preview having been quietly dropped from boot altogether.
        const until = Date.now() + 10_000;
        while (Date.now() < until && !existsSync(h.devserverCalledMarker)) {
            await new Promise((r) => setTimeout(r, 200));
        }
        expect(existsSync(h.devserverCalledMarker)).toBe(true);
    }, 90_000);

    it('reports the ready verdict before it ever touches the dev server', async () => {
        const h = bootWithDevserver(
            'touch "${EZIL_DEVSERVER_CALLED_MARKER:-/dev/null}"\nexec sleep 600',
        );
        await waitForPort(h.nekoPort, BIND_DEADLINE_MS);
        const until = Date.now() + 10_000;
        while (Date.now() < until && !existsSync(h.devserverCalledMarker)) {
            await new Promise((r) => setTimeout(r, 200));
        }
        await new Promise((r) => setTimeout(r, 500));

        const log = h.stderr();
        const readyOk = log.indexOf('phase=ready event=end status=ok');
        const devserverStart = log.indexOf('phase=devserver_launch event=start');

        // Both must be present. `readyOk` doubles as a guard on wait_tcp's
        // fd-closing `exec`: it used to carry a bare `2>/dev/null`, which an
        // `exec` with no command applies to the whole shell permanently, so
        // every log line from the successful neko bind onwards vanished from
        // stderr — i.e. from `wrangler tail`, the only window into a live boot.
        expect(readyOk).toBeGreaterThan(-1);
        expect(devserverStart).toBeGreaterThan(-1);
        expect(readyOk).toBeLessThan(devserverStart);
    }, 90_000);

    it('still comes up when the dev-server launcher fails outright', async () => {
        const h = bootWithDevserver(
            'touch "${EZIL_DEVSERVER_CALLED_MARKER:-/dev/null}"\nexit 3',
        );
        const bound = await waitForPort(h.nekoPort, BIND_DEADLINE_MS);
        expect(bound).toBe(true);
        const until = Date.now() + 10_000;
        while (Date.now() < until && !h.stderr().includes('phase=devserver_launch event=end')) {
            await new Promise((r) => setTimeout(r, 200));
        }
        expect(h.stderr()).toContain('phase=devserver_launch event=end status=error');
        // Non-fatal: the supervision loop keeps running and neko stays up.
        expect(await tcpOpen(h.nekoPort)).toBe(true);
    }, 90_000);
});

describe('start-neko.sh: the ordering is documented where it is enforced', () => {
    it('has no dev-server launch upstream of the window-ready gate', () => {
        const src = readFileSync(START_NEKO, 'utf8');
        const gate = src.indexOf('phase_start window_ready_gate');
        const bind = src.indexOf('phase_start neko_serve_bind');
        // The only CALL of launch_devserver (its definition is `launch_devserver() {`).
        const callMatches = [...src.matchAll(/^launch_devserver\s*$/gm)];
        expect(gate).toBeGreaterThan(-1);
        expect(bind).toBeGreaterThan(gate);
        expect(callMatches.length).toBe(1);
        expect(callMatches[0]!.index!).toBeGreaterThan(bind);
    });
});
