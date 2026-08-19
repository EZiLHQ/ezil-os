/**
 * A user quitting the in-stream browser must not kill the whole session — and
 * a genuine crash-loop must still take the desktop down.
 *
 * ── The defect this exists to prevent ───────────────────────────────────────
 * `supervise_app` in `scripts/start-neko.sh` restarted an app on ANY exit and
 * charged EVERY exit to `NEKO_APP_MAX_RESTARTS` (5). `rc` was logged and never
 * looked at, so a clean, user-initiated quit was indistinguishable from a
 * segfault. Six quits therefore raised the fatal sentinel, and the watch loop
 * turned that into `terminate_stack` — SIGTERM/SIGKILL to every app process
 * group, `neko`, the X server, openbox and pulseaudio — plus `exit 1`. The
 * user closed a window and got a dead session.
 *
 * ── Why this runs the REAL script ───────────────────────────────────────────
 * The rule lives in bash, in one loop, and the thing that has to be true is a
 * behaviour of that loop over TIME (how many exits it takes before the
 * sentinel appears), not the presence of any string in it. A test that
 * grepped `start-neko.sh` for `rc -eq 0` would pass against an implementation
 * that classified correctly and then charged the budget anyway. So this spawns
 * the actual script with stubbed binaries — exactly like
 * `./neko-teardown-orphans.test.ts`, whose harness this mirrors — and watches
 * what the supervisor does.
 *
 * ── The three cases, and why all three are needed ───────────────────────────
 * Each one alone is passable by a wrong implementation:
 *
 *   A. exits 0 after a real run   -> the session SURVIVES more exits than the
 *                                    budget allows. (An infinite budget also
 *                                    passes A — hence B.)
 *   B. exits non-zero             -> the budget is still spent and the script
 *                                    still exits 1. (Charging every rc=0 as a
 *                                    crash also passes B — hence A.)
 *   C. exits 0 IMMEDIATELY        -> still charged, still exits 1. This is the
 *                                    hot-restart-loop guard: Chrome exits 0
 *                                    when it hands off to an already-running
 *                                    instance, and "any rc=0 is free" would
 *                                    relaunch it forever. Only an
 *                                    implementation that looks at BOTH the
 *                                    status and the uptime passes all three.
 *
 * ── Host requirements ───────────────────────────────────────────────────────
 * Linux, bash, python3. No Docker, no X server, no neko binary. The
 * container-level proof this mirrors has to be run separately against the real
 * image (a stub browser is not Chrome, and only Chrome can tell us what status
 * Chrome actually exits with when a user closes its last window).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const START_NEKO = join(import.meta.dir, '..', 'scripts', 'start-neko.sh');

const BIND_DEADLINE_MS = 45_000;

function writeStub(dir: string, name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
    chmodSync(path, 0o755);
    return path;
}

function tcpOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(1000);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function waitFor(predicate: () => Promise<boolean> | boolean, deadlineMs: number): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
        if (await predicate()) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

/** Outside the ephemeral range, and offset away from the sibling suite's. */
function pickPort(offset: number): number {
    return 23000 + offset * 4 + (process.pid % 400);
}

interface Harness {
    proc: ChildProcess;
    stderr: () => string;
    exited: Promise<number | null>;
    nekoPort: number;
    codeServerPort: number;
    /** One line appended by the stub browser per LAUNCH — written by the stub
     *  itself, so counting restarts never depends on how the script logs. */
    launchLog: string;
    root: string;
}

let running: Harness | null = null;
let workdir: string | null = null;

afterEach(async () => {
    if (running?.proc.pid) {
        try { process.kill(running.proc.pid, 'SIGTERM'); } catch { /* already gone */ }
        const until = Date.now() + 15_000;
        while (Date.now() < until && running.proc.exitCode === null && running.proc.signalCode === null) {
            await new Promise((r) => setTimeout(r, 100));
        }
        try { process.kill(-running.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    running = null;
    if (workdir) {
        try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
        workdir = null;
    }
});

/**
 * Boot the real script with a browser stub whose exit is scripted:
 * it runs for `uptimeSeconds`, then exits `rc`.
 */
function boot(opts: { uptimeSeconds: string; rc: number; maxRestarts: string; restartDelay: string }): Harness {
    const root = mkdtempSync(join(tmpdir(), 'ezil-neko-appexit-'));
    workdir = root;
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'workspace'), { recursive: true });
    mkdirSync(join(root, 'www'), { recursive: true });

    const nekoPort = pickPort(0);
    const codeServerPort = pickPort(1);
    const launchLog = join(root, 'browser-launches');

    // X is "already up" so the script skips Xvfb entirely.
    writeStub(bin, 'xdpyinfo', 'exit 0');
    // The window gate resolves the browser by WM_CLASS in column 3.
    writeStub(bin, 'wmctrl', 'echo "0x01 0 chrome.Google-chrome stub EZiL OS Browser"');
    writeStub(bin, 'ezil-stub-neko', 'exec python3 -m http.server "$NEKO_HTTP_PORT" --bind 0.0.0.0');
    // code-server just has to hold its port so the readiness gate passes; this
    // suite is about the BROWSER's exits.
    writeStub(bin, 'code-server', `exec python3 -m http.server ${codeServerPort} --bind 127.0.0.1`);
    // 🔴 The subject. Records every launch, runs for a scripted time, then
    // exits with a scripted status. Chrome's real flags are ignored, exactly
    // as `sleep` ignores them in the sibling suite.
    writeStub(bin, 'ezil-stub-browser', [
        `echo launch >> "${launchLog}"`,
        `sleep ${opts.uptimeSeconds}`,
        `exit ${opts.rc}`,
    ].join('\n'));

    const proc = spawn('bash', [START_NEKO], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...(process.env as Record<string, string>),
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            NEKO_HTTP_PORT: String(nekoPort),
            NEKO_BIN: join(bin, 'ezil-stub-neko'),
            NEKO_STATIC: join(root, 'www'),
            DEVSERVER_BIN: join(root, 'no-such-devserver'),
            NEKO_BROWSER_CANDIDATES: 'ezil-stub-browser',
            CODE_SERVER_PORT: String(codeServerPort),
            EZIL_DESKTOP_APPS: `browser:window:chrome codeserver:tcp:127.0.0.1:${codeServerPort}`,
            NEKO_WINDOW_READY_TIMEOUT: '20',
            NEKO_APP_MAX_RESTARTS: opts.maxRestarts,
            NEKO_APP_RESTART_DELAY: opts.restartDelay,
            EZIL_WORKSPACE_ROOT: join(root, 'workspace'),
            EZIL_LOCAL_STATE_DIR: join(root, 'local-state'),
            CHROME_PROFILE_DIR: join(root, 'chrome-profile'),
            CHROME_HOME_FILE: join(root, 'no-such-landing-page.html'),
            NEKO_APP_HEALTH_FILE: join(root, 'health.json'),
            NEKO_APP_FATAL_SENTINEL: join(root, 'fatal'),
            NEKO_SWITCH_APP_BIN: join(root, 'neko-switch-app.sh'),
            NEKO_APP_PGID_DIR: join(root, 'pgids'),
            NEKO_SHUTDOWN_FLAG: join(root, 'shutdown'),
            NEKO_TEARDOWN_GRACE: '4',
            EZIL_TELEMETRY_NDJSON_PATH: join(root, 'telemetry.ndjson'),
            XDG_RUNTIME_DIR: join(root, 'xdg'),
            DISPLAY: ':99',
        },
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    proc.stdout?.on('data', () => { /* drained so the pipe can never fill */ });

    const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
    const harness: Harness = { proc, stderr: () => stderr, exited, nekoPort, codeServerPort, launchLog, root };
    running = harness;
    return harness;
}

function launches(h: Harness): number {
    if (!existsSync(h.launchLog)) return 0;
    return readFileSync(h.launchLog, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
}

describe('start-neko.sh: a clean app exit is not a crash', () => {
    it('A. keeps the session alive through more clean quits than the restart budget allows', async () => {
        // Budget of 1 means the OLD behaviour raised the fatal sentinel on the
        // 2nd exit. The browser here exits 0 after 6s — past the 5s minimum
        // uptime that makes an rc=0 credible as user-initiated.
        const h = boot({ uptimeSeconds: '6', rc: 0, maxRestarts: '1', restartDelay: '1' });
        expect(await waitFor(() => tcpOpen(h.nekoPort), BIND_DEADLINE_MS)).toBe(true);

        // Four launches = three exits, i.e. two more than the budget could pay
        // for. Each cycle is 6s of uptime plus the (linearly backed off) 1s,
        // 2s, 3s restart delays.
        const got4 = await waitFor(() => launches(h) >= 4, 60_000);
        expect(`launches=${launches(h)}\n${h.stderr().slice(-3000)}`)
            .toBe(`launches=4\n${h.stderr().slice(-3000)}`);
        expect(got4).toBe(true);

        // 🔴 The whole point: the desktop is still there.
        expect(h.proc.exitCode).toBe(null);
        expect(await tcpOpen(h.nekoPort)).toBe(true);
        expect(await tcpOpen(h.codeServerPort)).toBe(true);
        expect(existsSync(join(h.root, 'fatal'))).toBe(false);
        expect(h.stderr()).not.toContain('PERMANENTLY FAILED');
        // Observable rather than inferred, per the contract: the classification
        // is logged, and it is logged as CLEAN.
        expect(h.stderr()).toContain('CLEAN exit (user-initiated quit)');
        // …and it left a telemetry row behind, on the same NDJSON the Worker
        // already drains.
        const ndjson = readFileSync(join(h.root, 'telemetry.ndjson'), 'utf8');
        expect(ndjson).toContain('"site":"container:neko#app_exit"');
        expect(ndjson).toContain('"site":"container:neko#app_exit","code":"ok","outcome":"ok"');
    }, 120_000);

    it('B. still fails the desktop closed when the app really is crash-looping', async () => {
        // Same uptime, non-zero status. The budget must behave exactly as it
        // always did: 1 restart, then the fatal sentinel and exit 1.
        const h = boot({ uptimeSeconds: '6', rc: 3, maxRestarts: '1', restartDelay: '1' });
        expect(await waitFor(() => tcpOpen(h.nekoPort), BIND_DEADLINE_MS)).toBe(true);

        const code = await Promise.race([
            h.exited,
            new Promise<null>((r) => setTimeout(() => r(null), 90_000)),
        ]);
        expect(`exit=${code}\n${h.stderr().slice(-3000)}`).toBe(`exit=1\n${h.stderr().slice(-3000)}`);
        expect(h.stderr()).toContain('PERMANENTLY FAILED');
        expect(h.stderr()).toContain('charged to the restart budget');
        expect(launches(h)).toBe(2);
    }, 150_000);

    it('C. still fails closed when the app exits 0 IMMEDIATELY, over and over', async () => {
        // The hot-loop guard. rc=0, but it never ran: an implementation that
        // exempts every rc=0 would restart this forever and never exit, so
        // this case is what stops "clean" from meaning "free".
        const h = boot({ uptimeSeconds: '0.2', rc: 0, maxRestarts: '1', restartDelay: '1' });
        const code = await Promise.race([
            h.exited,
            new Promise<null>((r) => setTimeout(() => r(null), 90_000)),
        ]);
        expect(`exit=${code}\n${h.stderr().slice(-3000)}`).toBe(`exit=1\n${h.stderr().slice(-3000)}`);
        expect(h.stderr()).toContain('PERMANENTLY FAILED');
    }, 150_000);
});
