/**
 * Tearing the desktop down must kill the APPLICATIONS, not just their
 * supervisors.
 *
 * ── The defect this exists to prevent ───────────────────────────────────────
 * `supervise_app` runs each app inside a background subshell and records that
 * SUBSHELL's pid in `APP_PID`. `terminate_stack` used to be:
 *
 *     for p in "${APP_PID[@]}"; do kill "$p" 2>/dev/null || true; done
 *     kill "$NEKO_PID" 2>/dev/null || true
 *
 * which signals the bash loops and nothing else. Reproduced in a real
 * container on 2026-08-02: one second after that teardown, code-server and
 * Chrome were still running with PPID 1 and 8443 answered
 * `[Errno 98] Address already in use`. The next boot in that container then
 * failed in the most misleading way available — the orphaned code-server
 * ANSWERED the fail-closed readiness probe and the orphaned Chrome supplied
 * the WM_CLASS the window gate looks for, so the gate passed in 58ms, the boot
 * logged `phase=ready event=end status=ok`, and the real code-server behind it
 * failed to bind six times before exhausting its restart budget and taking the
 * desktop down 14 seconds later. Every cycle leaked more orphans.
 *
 * ── Why the stub app deliberately has a GRANDCHILD ──────────────────────────
 * The port is held by a process two levels below the supervisor, exactly like
 * production: `/usr/bin/code-server` is a wrapper that execs node, which forks
 * the node process that actually owns the listening socket (Chrome forks a
 * dozen). So this test is red for BOTH the original bug and for the obvious
 * half-fix of recording and killing the app's direct pid — only killing the
 * app's whole process GROUP frees the port. Mutation-proved against all three.
 *
 * ── Host requirements ───────────────────────────────────────────────────────
 * Linux (`/proc` is used to distinguish a live process from a zombie), bash,
 * python3. No Docker, no X server, no neko binary. The container-level proof
 * that this mirrors was run separately against the real image.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const START_NEKO = join(import.meta.dir, '..', 'scripts', 'start-neko.sh');

/** Generous: the point is whether teardown works at all, not how fast. */
const BIND_DEADLINE_MS = 45_000;
const TEARDOWN_DEADLINE_MS = 30_000;

function writeStub (dir: string, name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
    chmodSync(path, 0o755);
    return path;
}

function tcpOpen (port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(1000);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function waitFor (predicate: () => Promise<boolean> | boolean, deadlineMs: number): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
        if (await predicate()) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

/**
 * Live means "exists and is not a zombie". A reaped-but-unwaited process still
 * answers `kill -0`, so asserting on that alone would let a teardown that
 * leaves genuinely running orphans pass whenever the harness happens to have
 * zombies around — and would equally fail a correct teardown.
 */
function isLive (pid: number): boolean {
    let stat: string;
    try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
        return false;
    }
    // "pid (comm) state ppid …" — comm can contain spaces and parentheses.
    const after = stat.slice(stat.lastIndexOf(') ') + 2);
    return after.split(' ')[0] !== 'Z';
}

function readPid (path: string): number {
    return Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
}

/** Outside the ephemeral range and outside anything the real image uses, so a
 *  stray production-shaped listener cannot make any of this pass. */
function pickPort (offset: number): number {
    return 22000 + offset * 4 + (process.pid % 400);
}

interface Harness {
    proc: ChildProcess;
    stderr: () => string;
    exited: Promise<number | null>;
    nekoPort: number;
    codeServerPort: number;
    /** Written by the STUB itself, not by start-neko.sh, so these assertions
     *  stay independent of how the script chooses to track processes. */
    appPidFile: string;
    grandchildPidFile: string;
    env: Record<string, string>;
    root: string;
}

let running: Harness | null = null;
let workdir: string | null = null;

function hardKill (h: Harness | null): void {
    if (h?.proc.pid) {
        try { process.kill(-h.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    // Belt and braces: if the thing under test failed to clean up, do not leak
    // the stub processes into the rest of the suite. Only ever pids this test
    // recorded — never a name match.
    for (const f of [h?.appPidFile, h?.grandchildPidFile]) {
        if (!f || !existsSync(f)) continue;
        try { process.kill(readPid(f), 'SIGKILL'); } catch { /* already gone */ }
    }
}

afterEach(() => {
    hardKill(running);
    running = null;
    if (workdir) {
        try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
        workdir = null;
    }
});

function boot (reuse?: Harness): Harness {
    const root = reuse?.root ?? mkdtempSync(join(tmpdir(), 'ezil-neko-teardown-'));
    workdir = root;
    const bin = join(root, 'bin');
    if (!reuse) {
        mkdirSync(bin);
        mkdirSync(join(root, 'workspace'), { recursive: true });
        mkdirSync(join(root, 'www'), { recursive: true });
    }

    const nekoPort = reuse?.nekoPort ?? pickPort(0);
    const codeServerPort = reuse?.codeServerPort ?? pickPort(1);
    const appPidFile = join(root, 'app.pid');
    const grandchildPidFile = join(root, 'grandchild.pid');

    if (!reuse) {
        // X is "already up" so the script skips Xvfb entirely.
        writeStub(bin, 'xdpyinfo', 'exit 0');
        // The window gate resolves the browser by WM_CLASS in column 3.
        writeStub(bin, 'wmctrl', 'echo "0x01 0 chrome.Google-chrome stub EZiL OS Browser"');
        writeStub(bin, 'ezil-stub-browser', 'exec sleep 600');
        writeStub(bin, 'ezil-stub-neko', 'exec python3 -m http.server "$NEKO_HTTP_PORT" --bind 0.0.0.0');

        // The mandatory code-server stand-in. It records its OWN pid, then
        // forks a GRANDCHILD which is what actually binds the port — the same
        // shape as the real code-server wrapper/server pair, and the reason
        // killing the app's direct pid is not enough.
        writeStub(bin, 'code-server', [
            `echo $$ > "${appPidFile}"`,
            `python3 -m http.server ${codeServerPort} --bind 127.0.0.1 &`,
            `echo $! > "${grandchildPidFile}"`,
            'wait',
        ].join('\n'));
    }

    const env: Record<string, string> = {
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
        XDG_RUNTIME_DIR: join(root, 'xdg'),
        DISPLAY: ':99',
    };

    const proc = spawn('bash', [START_NEKO], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });

    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    proc.stdout?.on('data', () => { /* drained so the pipe can never fill */ });

    const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));

    const harness: Harness = {
        proc, stderr: () => stderr, exited, nekoPort, codeServerPort,
        appPidFile, grandchildPidFile, env, root,
    };
    running = harness;
    return harness;
}

async function bootToReady (reuse?: Harness): Promise<Harness> {
    const h = boot(reuse);
    const ready = await waitFor(() => tcpOpen(h.nekoPort), BIND_DEADLINE_MS);
    expect(`neko bound :${h.nekoPort} => ${ready}\n${h.stderr().slice(-3000)}`)
        .toBe(`neko bound :${h.nekoPort} => true\n${h.stderr().slice(-3000)}`);
    // The stub app really did start and really is holding its port, otherwise
    // "the port is free afterwards" would be vacuously true.
    expect(await tcpOpen(h.codeServerPort)).toBe(true);
    expect(existsSync(h.appPidFile)).toBe(true);
    expect(existsSync(h.grandchildPidFile)).toBe(true);
    return h;
}

describe('start-neko.sh: teardown leaves no orphaned applications', () => {
    it('kills the app AND its grandchild, and frees the port, on the fatal-app path', async () => {
        const h = await bootToReady();
        const appPid = readPid(h.appPidFile);
        const grandchildPid = readPid(h.grandchildPidFile);
        expect(isLive(appPid)).toBe(true);
        expect(isLive(grandchildPid)).toBe(true);

        // The production trigger: a mandatory app exhausts its restart budget
        // and raises the fatal sentinel, which the main loop turns into
        // terminate_stack + exit 1.
        writeFileSync(h.env.NEKO_APP_FATAL_SENTINEL!, 'chromium\n', 'utf8');

        const code = await Promise.race([
            h.exited,
            new Promise<null>((r) => setTimeout(() => r(null), TEARDOWN_DEADLINE_MS)),
        ]);
        expect(`exit=${code}\n${h.stderr().slice(-3000)}`).toBe(`exit=1\n${h.stderr().slice(-3000)}`);

        // Give the kernel a moment to finish closing the socket after exit.
        await waitFor(async () => !(await tcpOpen(h.codeServerPort)), 10_000);

        const survivors = [
            isLive(appPid) ? `app pid ${appPid} STILL LIVE` : null,
            isLive(grandchildPid) ? `grandchild pid ${grandchildPid} STILL LIVE` : null,
            (await tcpOpen(h.codeServerPort)) ? `port ${h.codeServerPort} STILL BOUND` : null,
        ].filter(Boolean);
        expect(`${survivors.join(', ')}\n${h.stderr().slice(-3000)}`)
            .toBe(`\n${h.stderr().slice(-3000)}`);
    }, 120_000);

    it('does the same on SIGTERM, which nothing used to catch at all', async () => {
        const h = await bootToReady();
        const appPid = readPid(h.appPidFile);
        const grandchildPid = readPid(h.grandchildPidFile);

        process.kill(h.proc.pid!, 'SIGTERM');

        const code = await Promise.race([
            h.exited,
            new Promise<null>((r) => setTimeout(() => r(null), TEARDOWN_DEADLINE_MS)),
        ]);
        expect(`exit=${code}`).toBe('exit=143');
        await waitFor(async () => !(await tcpOpen(h.codeServerPort)), 10_000);

        const survivors = [
            isLive(appPid) ? `app pid ${appPid} STILL LIVE` : null,
            isLive(grandchildPid) ? `grandchild pid ${grandchildPid} STILL LIVE` : null,
            (await tcpOpen(h.codeServerPort)) ? `port ${h.codeServerPort} STILL BOUND` : null,
        ].filter(Boolean);
        expect(`${survivors.join(', ')}\n${h.stderr().slice(-3000)}`)
            .toBe(`\n${h.stderr().slice(-3000)}`);
    }, 120_000);

    it('lets a SECOND boot succeed on the same ports afterwards', async () => {
        // The failure this reproduces end to end: the container that could
        // never boot again. Same ports, same directory, same everything.
        const first = await bootToReady();
        writeFileSync(first.env.NEKO_APP_FATAL_SENTINEL!, 'chromium\n', 'utf8');
        await Promise.race([
            first.exited,
            new Promise<null>((r) => setTimeout(() => r(null), TEARDOWN_DEADLINE_MS)),
        ]);
        await waitFor(async () => !(await tcpOpen(first.codeServerPort)), 10_000);
        rmSync(first.env.NEKO_APP_FATAL_SENTINEL!, { force: true });

        const second = await bootToReady(first);
        // Still up and serving a few seconds later — not "ready" followed by a
        // delayed collapse once the new code-server exhausts its restart
        // budget failing to bind, which is exactly how the leak used to
        // present.
        await new Promise((r) => setTimeout(r, 5_000));
        expect(await tcpOpen(second.nekoPort)).toBe(true);
        expect(await tcpOpen(second.codeServerPort)).toBe(true);
        expect(second.stderr()).not.toContain('PERMANENTLY FAILED');
    }, 180_000);
});

describe('start-neko.sh: a genuinely unstartable app still fails closed', () => {
    it('exits non-zero when a mandatory app can never start, and cleans up anyway', async () => {
        // Guards the other direction: the teardown work above must not have
        // turned the fail-closed readiness gate into a fail-open one.
        const root = mkdtempSync(join(tmpdir(), 'ezil-neko-failclosed-'));
        workdir = root;
        const bin = join(root, 'bin');
        mkdirSync(bin);
        mkdirSync(join(root, 'workspace'), { recursive: true });
        mkdirSync(join(root, 'www'), { recursive: true });
        const nekoPort = pickPort(2);
        const codeServerPort = pickPort(3);

        writeStub(bin, 'xdpyinfo', 'exit 0');
        writeStub(bin, 'wmctrl', 'echo "0x01 0 chrome.Google-chrome stub EZiL OS Browser"');
        writeStub(bin, 'ezil-stub-browser', 'exec sleep 600');
        writeStub(bin, 'ezil-stub-neko', 'exec python3 -m http.server "$NEKO_HTTP_PORT" --bind 0.0.0.0');
        // Never listens on anything. The gate must never pass.
        writeStub(bin, 'code-server', 'exit 7');

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
                NEKO_WINDOW_READY_TIMEOUT: '5',
                NEKO_APP_MAX_RESTARTS: '1',
                NEKO_APP_RESTART_DELAY: '1',
                EZIL_WORKSPACE_ROOT: join(root, 'workspace'),
                EZIL_LOCAL_STATE_DIR: join(root, 'local-state'),
                CHROME_PROFILE_DIR: join(root, 'chrome-profile'),
                CHROME_HOME_FILE: join(root, 'no-such-landing-page.html'),
                NEKO_APP_HEALTH_FILE: join(root, 'health.json'),
                NEKO_APP_FATAL_SENTINEL: join(root, 'fatal'),
                NEKO_SWITCH_APP_BIN: join(root, 'neko-switch-app.sh'),
                NEKO_APP_PGID_DIR: join(root, 'pgids'),
                NEKO_SHUTDOWN_FLAG: join(root, 'shutdown'),
                NEKO_TEARDOWN_GRACE: '3',
                XDG_RUNTIME_DIR: join(root, 'xdg'),
                DISPLAY: ':99',
            },
        });
        let stderr = '';
        proc.stderr?.on('data', (c) => { stderr += String(c); });
        proc.stdout?.on('data', () => { /* drained */ });
        running = {
            proc, stderr: () => stderr, exited: Promise.resolve(null), nekoPort, codeServerPort,
            appPidFile: join(root, 'nope'), grandchildPidFile: join(root, 'nope2'),
            env: {}, root,
        };

        const code = await Promise.race([
            new Promise<number | null>((r) => proc.once('exit', (c) => r(c))),
            new Promise<null>((r) => setTimeout(() => r(null), 90_000)),
        ]);
        expect(`exit=${code}`).toBe('exit=1');
        // Restart budget was honoured (2 attempts for max_restarts=1) and the
        // gate refused to report readiness.
        expect(stderr).toContain('window-ready gate FAILED');
        expect(stderr).not.toContain('phase=ready event=end status=ok');
        // …and neko was never started, so nothing is serving.
        expect(await tcpOpen(nekoPort)).toBe(false);
    }, 120_000);
});
