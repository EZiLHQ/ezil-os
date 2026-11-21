/**
 * The private unattended Code workbench launcher (`scripts/start-unattended-workbench.sh`,
 * docs/UNATTENDED-CODE.md), executed for real with a stub browser and a stub
 * code-server listener. What is asserted is the contract, not the script's text:
 *
 *   - fail closed: no window without this boot's editor-bridge token, without a
 *     sync route, without the owner's explicit consent (BOTH settings true,
 *     JSONC accepted), or with the operator switch off;
 *   - private: the window gets a scrubbed environment (no tokens, no DISPLAY),
 *     its own fresh profile, no debugging port, and only the app-owned loopback
 *     code-server URL;
 *   - supervised: one instance at a time, stops when consent is withdrawn, on
 *     the desktop shutdown flag, and on SIGTERM (taking its process group);
 *   - lifecycle: it opens no listening port of its own.
 *
 * The source-text describe at the end pins where start-neko.sh calls it (after
 * the readiness verdict, never gating boot) and that the Dockerfile ships it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'start-unattended-workbench.sh');
const START_NEKO = readFileSync(join(import.meta.dir, '..', 'scripts', 'start-neko.sh'), 'utf8');
const DOCKERFILE = readFileSync(join(import.meta.dir, '..', 'Dockerfile'), 'utf8');
const TOKEN = 'a'.repeat(64);
const LINUX = process.platform === 'linux';
const describeIf = LINUX ? describe : describe.skip;

interface Fixture {
    root: string;
    bin: string;
    userData: string;
    env: Record<string, string>;
    port: number;
    settings(body: string): void;
    argvFile: string;
    envFile: string;
}

const children: ChildProcess[] = [];
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(undefined)));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listen(): Promise<{ server: Server; port: number }> {
    const server = createServer((socket) => socket.end());
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { server, port: (server.address() as { port: number }).port };
}

async function fixture(opts: { editorUp?: boolean } = {}): Promise<Fixture> {
    const root = mkdtempSync(join(tmpdir(), 'unattended-workbench-'));
    roots.push(root);
    if (process.getuid?.() === 0) chownSync(root, 65534, 65534);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const userData = join(root, 'user-data');
    mkdirSync(join(userData, 'User'), { recursive: true });
    const argvFile = join(root, 'browser.argv');
    const envFile = join(root, 'browser.env');
    // The stub browser records what it was given, then stays up like a real window would.
    writeFileSync(join(bin, 'ezil-stub-browser'), `#!/usr/bin/env bash
printf '%s\\n' "$@" >"${argvFile}"
env | sort >"${envFile}"
trap 'exit 0' TERM
while true; do sleep 1; done
`);
    chmodSync(join(bin, 'ezil-stub-browser'), 0o755);
    const port = opts.editorUp === false ? 1 : (await listen()).port;
    const env: Record<string, string> = {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        EZIL_EDITOR_BRIDGE_TOKEN: TOKEN,
        EZIL_AI_BASE_URL: 'https://8443-guac-a-b-code.example/ai/v1',
        EZIL_AI_PROXY_TOKEN: 'b'.repeat(64),
        DISPLAY: ':99',
        CODE_SERVER_PORT: String(port),
        CODE_SERVER_USER_DATA_DIR: userData,
        EZIL_WORKSPACE_ROOT: '/home/neko/project',
        EZIL_UNATTENDED_BROWSER_CANDIDATES: 'ezil-stub-browser',
        EZIL_UNATTENDED_WORKBENCH_DIR: join(root, 'profile'),
        EZIL_UNATTENDED_WORKBENCH_LOG: join(root, 'workbench.log'),
        NEKO_SHUTDOWN_FLAG: join(root, 'shutdown'),
        EZIL_UNATTENDED_WORKBENCH_RECHECK_S: '0.3',
        EZIL_UNATTENDED_WORKBENCH_EDITOR_TRIES: '6',
    };
    return {
        root, bin, userData, env, port, argvFile, envFile,
        settings: (body) => writeFileSync(join(userData, 'User', 'settings.json'), body),
    };
}

const CONSENT = '{"ezil.chatBridge.enabled": true, "ezil.chatBridge.unattended": true}';

function check(f: Fixture, extra: Record<string, string> = {}): { status: number | null; decision: string } {
    const run = spawnSync('bash', [SCRIPT, 'check'], { env: { ...f.env, ...extra }, encoding: 'utf8' });
    return { status: run.status, decision: run.stdout.trim() };
}

function start(f: Fixture, extra: Record<string, string> = {}): ChildProcess & { out: () => string } {
    const child = spawn('bash', [SCRIPT, 'run'], { env: { ...f.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcess & { out: () => string };
    let out = '';
    child.stdout!.on('data', (d) => { out += String(d); });
    child.out = () => out;
    children.push(child);
    return child;
}

const until = async (predicate: () => boolean, ms = 10_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return predicate();
};

const exited = (child: ChildProcess) => new Promise<number | null>((r) => {
    if (child.exitCode !== null) r(child.exitCode);
    else child.once('exit', (code) => r(code));
});

/** The stub browser's recorded process group is alive iff the window is. */
function browserPids(f: Fixture): number[] {
    const ps = spawnSync('pgrep', ['-f', `${f.bin}/ezil-stub-browser`], { encoding: 'utf8' });
    return ps.stdout.split('\n').filter(Boolean).map(Number);
}

describeIf('start-unattended-workbench.sh fails closed', () => {
    it('refuses without this boot\'s editor-bridge token, even with consent', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        for (const token of ['', 'short', 'g'.repeat(64), 'A'.repeat(64)]) {
            expect(check(f, { EZIL_EDITOR_BRIDGE_TOKEN: token })).toEqual({ status: 1, decision: 'no_boot_authorization' });
        }
        expect(check(f).decision).toBe('authorized');
    });

    it('refuses without a sync route or with the operator switch off', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        expect(check(f, { EZIL_AI_BASE_URL: '' })).toEqual({ status: 1, decision: 'no_sync_route' });
        for (const off of ['off', 'OFF', 'false', '0', 'disabled', 'no']) {
            expect(check(f, { EZIL_UNATTENDED_WORKBENCH: off })).toEqual({ status: 1, decision: 'disabled' });
        }
    });

    it('needs BOTH settings exactly true in the owner\'s own settings file; JSONC is accepted', async () => {
        const f = await fixture();
        expect(check(f).decision).toBe('not_opted_in'); // no file at all
        for (const body of [
            '{}',
            '{"ezil.chatBridge.enabled": true}',
            '{"ezil.chatBridge.unattended": true}',
            '{"ezil.chatBridge.enabled": true, "ezil.chatBridge.unattended": "true"}',
            '{"ezil.chatBridge.enabled": true, "ezil.chatBridge.unattended": 1}',
            '{"ezil.chatBridge.enabled": false, "ezil.chatBridge.unattended": true}',
            '[true]',
            'not json at all',
            '',
        ]) {
            f.settings(body);
            expect([body, check(f).decision]).toEqual([body, 'not_opted_in']);
        }
        f.settings('// the owner\'s own file\n{\n  "workbench.colorTheme": "Default Dark Modern", /* keep */\n  "ezil.chatBridge.enabled": true,\n  "ezil.chatBridge.unattended": true, // trailing comma\n}\n');
        expect(check(f)).toEqual({ status: 0, decision: 'authorized' });
        // A string that merely contains the keys is not consent.
        f.settings('{"note": "\\"ezil.chatBridge.enabled\\": true, \\"ezil.chatBridge.unattended\\": true"}');
        expect(check(f).decision).toBe('not_opted_in');
    });

    it('refuses when no browser binary exists; `check` never starts anything', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        expect(check(f, { EZIL_UNATTENDED_BROWSER_CANDIDATES: 'ezil-no-such-browser' }).decision).toBe('no_browser');
        expect(check(f).decision).toBe('authorized');
        expect(existsSync(f.argvFile)).toBe(false);
        expect(existsSync(join(f.root, 'profile'))).toBe(false);
    });
});

describeIf('start-unattended-workbench.sh keeps the window private', () => {
    it('launches the browser headless, on its own fresh profile, with a scrubbed environment and only the loopback editor URL', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        const child = start(f);
        expect(await until(() => existsSync(f.envFile))).toBe(true);
        expect(child.out().trim()).toBe('authorized');
        const argv = readFileSync(f.argvFile, 'utf8').split('\n').filter(Boolean);
        expect(argv).toContain('--headless=new');
        const profile = argv.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
        expect(profile?.startsWith(join(f.root, 'profile', 'window.'))).toBe(true);
        const target = new URL(argv.at(-1)!);
        expect(target.origin).toBe(`http://127.0.0.1:${f.port}`);
        expect(target.searchParams.get('folder')).toBe('/home/neko/project');
        expect(target.searchParams.get('ezilPrivateCode')).toBe('1');
        expect(argv.filter((a) => a.startsWith('http'))).toHaveLength(1);
        expect(argv.some((a) => a.startsWith('--remote-debugging'))).toBe(false);
        expect(argv).toContain('--disable-extensions');
        const env = readFileSync(f.envFile, 'utf8');
        expect(env).not.toContain(TOKEN);
        expect(env).not.toContain('b'.repeat(64));
        expect(env).not.toMatch(/^DISPLAY=/m);
        expect(env).not.toMatch(/^EZIL_/m);
        expect(env).toMatch(new RegExp(`^HOME=${profile}$`, 'm'));
        expect(existsSync(join(f.root, 'profile'))).toBe(true);
        child.kill('SIGTERM');
        expect(await exited(child)).toBe(0);
    });

    it('writes decisions to its own log, never the token', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        const child = start(f);
        expect(await until(() => existsSync(f.envFile))).toBe(true);
        child.kill('SIGTERM');
        await exited(child);
        const log = readFileSync(join(f.root, 'workbench.log'), 'utf8');
        expect(log).toContain('starting');
        expect(log).not.toContain(TOKEN);
    });
});

describeIf('start-unattended-workbench.sh is supervised and stays out of the lifecycle', () => {
    it('runs one instance at a time', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        const first = start(f);
        expect(await until(() => existsSync(f.envFile))).toBe(true);
        const second = start(f);
        expect(await exited(second)).toBe(0);
        expect(second.out().trim()).toBe('already_running');
        expect(browserPids(f)).toHaveLength(1);
        first.kill('SIGTERM');
        await exited(first);
    });

    it('stops only its own window when consent is withdrawn', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        const child = start(f);
        expect(await until(() => browserPids(f).length === 1)).toBe(true);
        f.settings('{"ezil.chatBridge.enabled": true, "ezil.chatBridge.unattended": false}');
        expect(await until(() => browserPids(f).length === 0)).toBe(true);
        expect(readFileSync(join(f.root, 'workbench.log'), 'utf8')).toContain('no longer authorized (not_opted_in)');
        f.settings(CONSENT);
        expect(await until(() => browserPids(f).length === 1)).toBe(true);
        child.kill('SIGTERM');
        expect(await exited(child)).toBe(0);
        // The stub editor listener (code-server's stand-in) was never touched.
        expect(servers[0]!.listening).toBe(true);
    });

    it('stops on the desktop shutdown flag', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        const child = start(f);
        expect(await until(() => browserPids(f).length === 1)).toBe(true);
        writeFileSync(join(f.root, 'shutdown'), '');
        expect(await exited(child)).toBe(0);
        expect(await until(() => browserPids(f).length === 0)).toBe(true);
    });

    it('SIGTERM (what start-neko.sh\'s teardown sends) takes the browser\'s process group with it', async () => {
        const f = await fixture();
        f.settings(CONSENT);
        const child = start(f);
        expect(await until(() => browserPids(f).length === 1)).toBe(true);
        child.kill('SIGTERM');
        expect(await exited(child)).toBe(0);
        expect(await until(() => browserPids(f).length === 0)).toBe(true);
    });

    it('gives up, without a window, when code-server never listens', async () => {
        const f = await fixture({ editorUp: false });
        f.settings(CONSENT);
        const child = start(f);
        expect(await exited(child)).toBe(1);
        expect(existsSync(f.argvFile)).toBe(false);
        expect(readFileSync(join(f.root, 'workbench.log'), 'utf8')).toContain('never listened');
    });
});

describe('where the launcher is wired (source text)', () => {
    it('start-neko.sh calls it after the readiness verdict and the sidecar, tracked in SESSION_PID, never into $LOG', () => {
        const call = START_NEKO.indexOf('\nlaunch_unattended_workbench\n');
        expect(call).toBeGreaterThan(START_NEKO.indexOf('\nlaunch_browser_sidecar\n'));
        expect(call).toBeGreaterThan(START_NEKO.indexOf('phase_end ready ok'));
        expect(call).toBeLessThan(START_NEKO.indexOf('Fatal-failure watch'));
        const fn = START_NEKO.slice(START_NEKO.indexOf('launch_unattended_workbench() {'), call);
        expect(fn).toContain('SESSION_PID+=("$!")');
        expect(fn).toContain('"$EZIL_UNATTENDED_WORKBENCH_ENTRY" check');
        expect(fn).not.toContain('$LOG');
        expect(fn).not.toContain('supervise_app');
    });

    it('the Dockerfile ships the launcher next to the other boot scripts', () => {
        expect(DOCKERFILE).toContain('COPY scripts/start-unattended-workbench.sh /usr/local/bin/start-unattended-workbench.sh');
        expect(DOCKERFILE).toMatch(/RUN chmod \+x [^\n]*\/usr\/local\/bin\/start-unattended-workbench\.sh/);
    });
});
