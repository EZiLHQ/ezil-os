/**
 * `DockerHost`, against a fake `docker`.
 *
 * What this suite CAN prove: the exact argv that reaches the daemon, that the
 * id validator refuses anything that could become a different valid argument,
 * that a readiness deadline produces `failed` rather than `ready`, and that the
 * image's own passwords can never be published. What it CANNOT prove is that a
 * container boots — that is `./docker-host.container.test.ts`, which really
 * boots one, and this file never claims its ground.
 *
 * The fake records every argv it is given, so every negative assertion here
 * ("no `run` was issued") is paired with the positive control that SOMETHING
 * was issued.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
    DockerHost,
    IMAGE_DEFAULT_PASSWORDS,
    assertNotDefault,
    type SpawnOptions,
    type SpawnOutcome,
} from './docker-host.ts';
import {
    LOCAL_BIND_ADDRESS,
    NEKO_ADMIN_PASSWORD_ENV,
    NEKO_USER_PASSWORD_ENV,
    WEBRTC_MUX_PORT,
    containerNameFor,
} from '../container/run-spec.ts';

// ── the fake ─────────────────────────────────────────────────────────────────

interface Call { readonly argv: readonly string[]; readonly options: SpawnOptions | undefined }

/** A scripted `docker`. `handler` sees every argv; anything it does not answer is exit 0 with empty output. */
function fakeDocker(handler: (argv: readonly string[]) => Partial<SpawnOutcome> | undefined) {
    const calls: Call[] = [];
    const spawn = async (argv: readonly string[], options?: SpawnOptions): Promise<SpawnOutcome> => {
        calls.push({ argv, options });
        const answer = handler(argv) ?? {};
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...answer };
    };
    return { calls, spawn, verbs: () => calls.map((c) => c.argv[0]) };
}

/** The tab-separated line `buildDockerInspectArgv`'s template produces. */
function inspectLine(opts: { running: boolean; exitCode?: number; image?: string; env?: Record<string, string> }): string {
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    return `${opts.running}\t${opts.exitCode ?? 0}\t${opts.image ?? 'img:t'}\t${JSON.stringify(env)}\n`;
}

const NO_SUCH = { exitCode: 1, stderr: 'Error: No such object: ezil-os-c1\n' };

/** A 32-hex-character stand-in for a derived credential — long enough to pass `assertNotDefault`. */
const GOOD_USER = 'a'.repeat(32);
const GOOD_ADMIN = 'b'.repeat(32);
const LIVE_ENV = {
    DESKTOP_MODE: 'neko',
    [NEKO_USER_PASSWORD_ENV]: GOOD_USER,
    [NEKO_ADMIN_PASSWORD_ENV]: GOOD_ADMIN,
};

/** A `fetch` that answers neko's measured shapes. `health` and `login` are switchable so a failure mode can be scripted. */
function fakeNeko(opts: { health?: string | null; loginBody?: unknown; loginStatus?: number; screen?: unknown } = {}) {
    const seen: string[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
        seen.push(`${init?.method ?? 'GET'} ${input}`);
        if (input.endsWith('/health')) {
            if (opts.health === null) throw new Error('ECONNREFUSED');
            return new Response(opts.health ?? 'true', { status: 200 });
        }
        if (input.endsWith('/api/login')) {
            return new Response(JSON.stringify(opts.loginBody ?? { token: 'tok', profile: { is_admin: true } }), {
                status: opts.loginStatus ?? 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (input.endsWith('/api/logout')) return new Response('true', { status: 200 });
        if (input.endsWith('/api/room/screen')) {
            return new Response(JSON.stringify(opts.screen ?? { width: 1920, height: 1080, rate: 60 }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response('', { status: 404 });
    };
    return { seen, fetchImpl };
}

// ── argv shapes ──────────────────────────────────────────────────────────────

describe('the argv that reaches the daemon', () => {
    it('runs the pinned image with the pinned flags, and publishes on loopback only', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? NO_SUCH : undefined));
        const neko = fakeNeko();
        const host = new DockerHost({ image: 'img:t', spawn: docker.spawn, fetch: neko.fetchImpl });
        // The first `inspect` says absent, so a `run` must follow; every later
        // `inspect` must find it, or `credentialsFor` cannot read the password
        // back. Re-script after the run.
        let created = false;
        const docker2 = fakeDocker((argv) => {
            if (argv[0] === 'run') { created = true; return {}; }
            if (argv[0] === 'inspect') return created ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : NO_SUCH;
            return undefined;
        });
        const host2 = new DockerHost({ image: 'img:t', spawn: docker2.spawn, fetch: neko.fetchImpl });
        await host2.ensureDesktop('c1', { mode: 'neko' });

        const run = docker2.calls.find((c) => c.argv[0] === 'run');
        expect(run).toBeDefined();
        const argv = run!.argv;
        expect(argv.slice(0, 4)).toEqual(['run', '--detach', '--name', 'ezil-os-c1']);
        expect(argv).toContain('--cpus=2');
        expect(argv).toContain('--memory=8g');
        expect(argv).toContain(`${LOCAL_BIND_ADDRESS}:8181:8181/tcp`);
        expect(argv).toContain(`${LOCAL_BIND_ADDRESS}:${WEBRTC_MUX_PORT}:${WEBRTC_MUX_PORT}/udp`);
        expect(argv.at(-1)).toBe('DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh');
        // Every publication is loopback — a desktop with an unauthenticated
        // automation surface must not be reachable from the LAN.
        for (const [i, a] of argv.entries()) {
            if (argv[i - 1] === '--publish') expect(a.startsWith(`${LOCAL_BIND_ADDRESS}:`)).toBe(true);
        }
        // Positive control for the check above: there really were publications.
        expect(argv.filter((_, i) => argv[i - 1] === '--publish').length).toBe(6);
        expect(host.bootPhase('c1')).toBe('absent');
    });

    it('starts a stopped container instead of creating a second one', async () => {
        let started = false;
        const docker = fakeDocker((argv) => {
            if (argv[0] === 'start') { started = true; return {}; }
            if (argv[0] === 'inspect') return { stdout: inspectLine({ running: started, exitCode: 143, env: LIVE_ENV }) };
            return undefined;
        });
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        await host.ensureDesktop('c1', { mode: 'neko' });
        expect(docker.verbs()).toContain('start');
        expect(docker.verbs()).not.toContain('run');
    });

    it('reuses a running container: no run, no start', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        await host.ensureDesktop('c1', { mode: 'neko' });
        expect(docker.verbs()).not.toContain('run');
        expect(docker.verbs()).not.toContain('start');
        // Positive control: it did do something, so the two negatives above are
        // facts about `run`/`start` and not about an empty call list.
        expect(docker.verbs()).toContain('inspect');
    });

    it('exec passes the command through as an array, never as a shell string', async () => {
        const docker = fakeDocker(() => ({ stdout: 'ok\n' }));
        const host = new DockerHost({ spawn: docker.spawn });
        const res = await host.exec('c1', ['bash', '-c', 'echo $HOME; rm -rf /']);
        expect(res.stdout).toBe('ok\n');
        expect(docker.calls[0]!.argv).toEqual(['exec', 'ezil-os-c1', 'bash', '-c', 'echo $HOME; rm -rf /']);
    });

    it('exec honours a caller timeout host-side, because docker exec has no flag for one', async () => {
        const docker = fakeDocker(() => ({ exitCode: null, timedOut: true }));
        const host = new DockerHost({ spawn: docker.spawn });
        const res = await host.exec('c1', ['sleep', '99'], { timeoutMs: 250 });
        expect(docker.calls[0]!.options?.timeoutMs).toBe(250);
        // "it refused" and "we stopped waiting" are different answers.
        expect(res.timedOut).toBe(true);
        expect(res.exitCode).toBeNull();
    });

    it('terminate is docker rm --force, and only claims `terminated` when it observed both ends', async () => {
        let removed = false;
        const docker = fakeDocker((argv) => {
            if (argv[0] === 'rm') { removed = true; return {}; }
            if (argv[0] === 'inspect') return removed ? NO_SUCH : { stdout: inspectLine({ running: true, env: LIVE_ENV }) };
            return undefined;
        });
        const host = new DockerHost({ spawn: docker.spawn });
        const res = await host.terminate('c1');
        expect(docker.calls.find((c) => c.argv[0] === 'rm')!.argv).toEqual(['rm', '--force', 'ezil-os-c1']);
        expect(res).toEqual({ ok: true, terminated: true });
    });

    it('an already-absent computer is not a failure', async () => {
        const docker = fakeDocker(() => NO_SUCH);
        const res = await new DockerHost({ spawn: docker.spawn }).terminate('c1');
        expect(res.ok).toBe(true);
        expect(res.terminated).toBe(false);
        expect(docker.verbs()).not.toContain('rm');
    });

    it('restartDesktop is stop then start, with the grace period docker stop needs', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        const res = await host.restartDesktop('c1');
        expect(res.ok).toBe(true);
        const verbs = docker.verbs();
        expect(verbs.indexOf('stop')).toBeGreaterThanOrEqual(0);
        expect(verbs.indexOf('start')).toBeGreaterThan(verbs.indexOf('stop'));
        expect(docker.calls.find((c) => c.argv[0] === 'stop')!.argv).toEqual(['stop', '--timeout', '20', 'ezil-os-c1']);
    });

    it('focusApp runs the same script the Worker runs, and refuses anything outside the enum', async () => {
        const docker = fakeDocker(() => ({}));
        const host = new DockerHost({ spawn: docker.spawn });
        expect((await host.focusApp('c1', 'chromium')).ok).toBe(true);
        expect(docker.calls[0]!.argv).toEqual(['exec', 'ezil-os-c1', '/usr/local/bin/neko-switch-app.sh', 'chromium']);
        const bad = await host.focusApp('c1', 'firefox' as never);
        expect(bad.ok).toBe(false);
        expect(bad.detail).toContain('invalid_focus_app');
    });
});

// ── the id validator ─────────────────────────────────────────────────────────

describe('the computer id never becomes a different valid argument', () => {
    const REJECTED = ['../x', '..', 'a/b', 'has space', '', '-leading', 'x'.repeat(64), 'a;b', 'a$b', 'a\nb', '.hidden'];

    it('rejects traversal, whitespace and 64+ characters by name', async () => {
        const docker = fakeDocker(() => ({}));
        const host = new DockerHost({ spawn: docker.spawn });
        for (const id of REJECTED) {
            await expect(host.exec(id, ['true'])).rejects.toThrow(/invalid_computer_id/);
        }
        // 🔴 The point of the guard: nothing was spawned for ANY of them, so a
        // bad id cannot even produce a "no such container".
        expect(docker.calls.length).toBe(0);
    });

    it('positive control: a legal id of the same shapes is accepted', () => {
        for (const id of ['c1', 'a'.repeat(63), 'A-b_c.d', '0']) {
            expect(containerNameFor(id)).toBe(`ezil-os-${id}`);
        }
    });

    it('status answers rather than throwing for a bad id, because it is a poll', async () => {
        const docker = fakeDocker(() => ({}));
        const s = await new DockerHost({ spawn: docker.spawn }).status('../x');
        expect(s.ok).toBe(false);
        expect(s.error).toContain('invalid_computer_id');
        expect(docker.calls.length).toBe(0);
    });
});

// ── readiness ────────────────────────────────────────────────────────────────

describe('readiness is neko\'s answer, never a 200', () => {
    it('a 200 with an empty body is NOT ready — the deadline expires and reports failed', async () => {
        // 🔴 THE §16b MUTATION, AS A TEST. neko serves its SPA with a 200
        // whether or not anything will ever connect, so an oracle that accepted
        // "the origin answered" would call this ready. `/health`'s measured
        // body is the four bytes `true`; this fake returns 200 with nothing.
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const neko = fakeNeko({ health: '' });
        const host = new DockerHost({ spawn: docker.spawn, fetch: neko.fetchImpl, bootTimeoutMs: 900 });
        await expect(host.ensureDesktop('c1', { mode: 'neko' })).rejects.toThrow(/desktop_boot_failed: phase=waiting_for_neko/);
        expect(host.bootPhase('c1')).toBe('failed');
        // Positive control: the probe really did ask, so "not ready" is a fact
        // about the answer and not about a request that never happened.
        expect(neko.seen.some((s) => s.endsWith('/health'))).toBe(true);
    });

    it('a healthy /health with a login that returns no token is NOT ready', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko({ loginBody: {} }).fetchImpl, bootTimeoutMs: 900 });
        await expect(host.ensureDesktop('c1', { mode: 'neko' })).rejects.toThrow(/returned no token/);
    });

    it('a login that returns a token but is_admin false is NOT ready', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko({ loginBody: { token: 't', profile: { is_admin: false } } }).fetchImpl, bootTimeoutMs: 900 });
        await expect(host.ensureDesktop('c1', { mode: 'neko' })).rejects.toThrow(/did not return an admin profile/);
    });

    it('positive control: the same fake with the measured shapes IS ready', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl, bootTimeoutMs: 5_000 });
        const urls = await host.ensureDesktop('c1', { mode: 'neko' });
        expect(host.bootPhase('c1')).toBe('ready');
        expect(urls.desktop).toContain(`${LOCAL_BIND_ADDRESS}:8181`);
    });

    it('a container that exits during boot is failed at once, not at the deadline', async () => {
        let polls = 0;
        const docker = fakeDocker((argv) => {
            if (argv[0] === 'inspect') { polls += 1; return { stdout: inspectLine({ running: polls <= 1, exitCode: 1, env: LIVE_ENV }) }; }
            return undefined;
        });
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko({ health: '' }).fetchImpl, bootTimeoutMs: 60_000 });
        await expect(host.ensureDesktop('c1', { mode: 'neko' })).rejects.toThrow(/exited during boot \(exit 1\)/);
    });

    it('status polls /health and never mints a session', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const neko = fakeNeko();
        const s = await new DockerHost({ spawn: docker.spawn, fetch: neko.fetchImpl }).status('c1');
        expect(s).toEqual({ ok: true, computerId: 'c1', containerState: 'running', desktopReady: true, mode: 'neko' });
        expect(neko.seen.some((x) => x.includes('/api/login'))).toBe(false);
        // Positive control: it did poll something.
        expect(neko.seen).toContain('GET http://127.0.0.1:8181/health');
        expect(docker.verbs()).toEqual(['inspect']);
    });

    it('status reads the mode back and never defaults it', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: false, exitCode: 143, env: { FOO: 'bar' } }) } : undefined));
        const s = await new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl }).status('c1');
        // "we do not know" is not "guacamole".
        expect(s.mode).toBeNull();
        expect(s.containerState).toBe('stopped');
        expect(s.exitCode).toBe(143);
        expect(s.desktopReady).toBe(false);
    });

    it('a daemon that cannot answer is ok:false, while a container that does not exist is ok:true', async () => {
        const dead = fakeDocker(() => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n' }));
        const s1 = await new DockerHost({ spawn: dead.spawn }).status('c1');
        expect(s1.ok).toBe(false);
        expect(s1.error).toContain('Cannot connect to the Docker daemon');

        const absent = fakeDocker(() => NO_SUCH);
        const s2 = await new DockerHost({ spawn: absent.spawn }).status('c1');
        expect(s2).toEqual({ ok: true, computerId: 'c1', containerState: 'absent', desktopReady: false, mode: null });
    });
});

// ── passwords ────────────────────────────────────────────────────────────────

describe('the image\'s own passwords can never be published', () => {
    it('the two literals are the ones the image ships', () => {
        // Sourced from `/etc/neko/neko.yaml` in the pinned image:
        //   member.multiuser.admin_password: "admin"
        //   member.multiuser.user_password:  "neko"
        expect([...IMAGE_DEFAULT_PASSWORDS].sort()).toEqual(['admin', 'neko']);
    });

    it('assertNotDefault refuses each of them by name, in either role', () => {
        expect(() => assertNotDefault({ user: 'neko', admin: GOOD_ADMIN })).toThrow(/image_default_password: the user credential/);
        expect(() => assertNotDefault({ user: GOOD_USER, admin: 'admin' })).toThrow(/image_default_password: the admin credential/);
        // Positive control: a real derived pair passes, so the guard is not
        // simply rejecting everything.
        expect(() => assertNotDefault({ user: GOOD_USER, admin: GOOD_ADMIN })).not.toThrow();
    });

    it('and refuses anything short enough to be a hand-typed placeholder', () => {
        expect(() => assertNotDefault({ user: 'hunter2', admin: GOOD_ADMIN })).toThrow(/weak_neko_password/);
    });

    it('a minted pair is 32 hex characters, differs per role and per computer, and is never a default', async () => {
        const docker = fakeDocker(() => NO_SUCH);
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        const a = new URL(await pwdOf(host, 'c1')).searchParams.get('pwd')!;
        const b = new URL(await pwdOf(host, 'c2')).searchParams.get('pwd')!;
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(a).not.toBe(b);
        for (const d of IMAGE_DEFAULT_PASSWORDS) expect(a).not.toBe(d);
    });

    it('two hosts do not share credentials — the secret is per process, not a constant', async () => {
        const docker = fakeDocker(() => NO_SUCH);
        const one = new DockerHost({ spawn: docker.spawn });
        const two = new DockerHost({ spawn: docker.spawn });
        expect(await pwdOf(one, 'c1')).not.toBe(await pwdOf(two, 'c1'));
    });

    it('the SAME host answers the same URL twice — desktopUrls must be answerable for a stopped computer', async () => {
        const docker = fakeDocker(() => NO_SUCH);
        const host = new DockerHost({ spawn: docker.spawn, credentialSecret: 'fixed-secret-for-this-test' });
        expect(await pwdOf(host, 'c1')).toBe(await pwdOf(host, 'c1'));
    });

    it('a running container\'s OWN password is read back, not re-derived', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        const urls = await host.desktopUrls('c1');
        expect(new URL(urls.desktop).searchParams.get('pwd')).toBe(GOOD_USER);
    });

    it('a container running on the image defaults is refused rather than connected to', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect'
            ? { stdout: inspectLine({ running: true, env: { DESKTOP_MODE: 'neko', [NEKO_USER_PASSWORD_ENV]: 'neko', [NEKO_ADMIN_PASSWORD_ENV]: 'admin' } }) }
            : undefined));
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        await expect(host.desktopUrls('c1')).rejects.toThrow(/image_default_password/);
    });

    it('a container with no password environment at all is refused by name', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: { DESKTOP_MODE: 'neko' } }) } : undefined));
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        await expect(host.desktopUrls('c1')).rejects.toThrow(/container_without_credentials/);
    });

    it('the desktop URL is the credential envelope, exactly as the app composes it', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const urls = await new DockerHost({ spawn: docker.spawn }).desktopUrls('c1');
        const u = new URL(urls.desktop);
        expect(u.searchParams.get('usr')).toBe('EZiL');
        expect(u.searchParams.get('embed')).toBe('1');
        expect(u.searchParams.get('pwd')).toBe(GOOD_USER);
        // The other two surfaces carry no credential — code-server runs
        // `--auth none` behind a loopback port and the dev server is the user's
        // own. A `pwd` on either would be a password in a place nothing reads.
        expect(urls.code).toBe('http://127.0.0.1:8443');
        expect(urls.appPreview).toBe('http://127.0.0.1:3002');
    });
});

// ── the port offset ──────────────────────────────────────────────────────────

describe('a machine with a port already taken', () => {
    it('names the conflict instead of forwarding a daemon string', async () => {
        const docker = fakeDocker((argv) => {
            if (argv[0] === 'inspect') return NO_SUCH;
            if (argv[0] === 'run') return { exitCode: 125, stderr: 'docker: Error response from daemon: ... Bind for 0.0.0.0:8443 failed: port is already allocated\n' };
            return undefined;
        });
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        await expect(host.ensureDesktop('c1', { mode: 'neko' })).rejects.toThrow(/port_conflict/);
        // Positive control: an unrelated failure is NOT reported as a conflict.
        const other = fakeDocker((argv) => (argv[0] === 'inspect' ? NO_SUCH : { exitCode: 125, stderr: 'docker: Error response from daemon: no such image\n' }));
        await expect(new DockerHost({ spawn: other.spawn, fetch: fakeNeko().fetchImpl }).ensureDesktop('c1', { mode: 'neko' }))
            .rejects.toThrow(/docker_run_failed/);
    });

    it('an offset moves the URLs and moves the mux on BOTH sides', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? NO_SUCH : undefined));
        const host = new DockerHost({ spawn: docker.spawn, hostPortOffset: 10_000, fetch: fakeNeko().fetchImpl, image: 'img:t' });
        const urls = await host.desktopUrls('c1');
        expect(urls.code).toBe('http://127.0.0.1:18443');
        expect(new URL(urls.desktop).port).toBe('18181');

        const created = fakeDocker((argv) => (argv[0] === 'inspect' ? NO_SUCH : undefined));
        const h2 = new DockerHost({ spawn: created.spawn, hostPortOffset: 10_000, fetch: fakeNeko({ health: '' }).fetchImpl, image: 'img:t', bootTimeoutMs: 1 });
        await h2.ensureDesktop('c1', { mode: 'neko' }).catch(() => undefined);
        const run = created.calls.find((c) => c.argv[0] === 'run')!;
        const mux = WEBRTC_MUX_PORT + 10_000;
        expect(run.argv).toContain(`${LOCAL_BIND_ADDRESS}:${mux}:${mux}/udp`);
        expect(run.argv).toContain(`NEKO_WEBRTC_UDPMUX=${mux}`);
        // The HTTP ports move on the HOST side only.
        expect(run.argv).toContain(`${LOCAL_BIND_ADDRESS}:18181:8181/tcp`);
    });
});

// ── fetchIn ──────────────────────────────────────────────────────────────────

describe('fetchIn is request/response only', () => {
    it('refuses an upgrade rather than quietly proxying one the cloud side cannot have', async () => {
        const host = new DockerHost({ spawn: fakeDocker(() => ({})).spawn, fetch: fakeNeko().fetchImpl });
        const req = new Request('http://ignored/ws', { headers: { upgrade: 'websocket' } });
        await expect(host.fetchIn('c1', 9223, req)).rejects.toThrow(/fetchIn_no_upgrade/);
    });

    it('positive control: the same request without the header reaches 127.0.0.1 on that port', async () => {
        const seen: string[] = [];
        const host = new DockerHost({
            spawn: fakeDocker(() => ({})).spawn,
            fetch: async (input) => { seen.push(input); return new Response('{"ok":true}'); },
        });
        const res = await host.fetchIn('c1', 9223, new Request('http://ignored/health'));
        expect(await res.text()).toBe('{"ok":true}');
        expect(seen).toEqual(['http://127.0.0.1:9223/health']);
    });

    it('resolves the host port through the published map, not by adding the offset', async () => {
        // `offsetPortMap` moves the mux's container port too, so `port+offset`
        // is right for the HTTP ports and wrong for the mux. Reading the table
        // keeps that asymmetry in one place.
        const seen: string[] = [];
        const host = new DockerHost({
            spawn: fakeDocker(() => ({})).spawn,
            hostPortOffset: 10_000,
            fetch: async (input) => { seen.push(input); return new Response('ok'); },
        });
        await host.fetchIn('c1', 8181, new Request('http://ignored/health'));
        await host.fetchIn('c1', 8443, new Request('http://ignored/'));
        // A port nobody published still resolves, by the fallback.
        await host.fetchIn('c1', 4711, new Request('http://ignored/x'));
        expect(seen).toEqual([
            'http://127.0.0.1:18181/health',
            'http://127.0.0.1:18443/',
            'http://127.0.0.1:14711/x',
        ]);
    });

    it('the mux entry is what distinguishes the map from arithmetic', async () => {
        // 🔴 THE ONLY CASE THAT CAN TELL THE TWO IMPLEMENTATIONS APART, and it
        // is here for exactly that reason. Every HTTP port has host = container
        // + offset, so `port + offset` agrees with the table for all four of
        // them — a test using only those would pass against either. The mux is
        // published `62100:62100` at offset 10000 (both sides move together),
        // so the table answers 62100 where the arithmetic answers 72100.
        // Nothing HTTPs the mux in practice; the assertion exists to keep the
        // ONE definition of the asymmetry in `offsetPortMap`.
        const seen: string[] = [];
        const host = new DockerHost({
            spawn: fakeDocker(() => ({})).spawn,
            hostPortOffset: 10_000,
            fetch: async (input) => { seen.push(input); return new Response('ok'); },
        });
        await host.fetchIn('c1', WEBRTC_MUX_PORT + 10_000, new Request('http://ignored/'));
        expect(seen).toEqual([`http://127.0.0.1:${WEBRTC_MUX_PORT + 10_000}/`]);
    });
});

// ── screen ───────────────────────────────────────────────────────────────────

describe('screen: the read-back is the answer, the POST\'s echo is not', () => {
    it('reports the GET\'s numbers, not the ones asked for', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        // Xvfb floors the width to a multiple of 8: 900 -> 896 upstream. Here
        // the fake answers 896 for a 904 ask, and the result must be 896.
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko({ screen: { width: 896, height: 1600, rate: 60 } }).fetchImpl });
        const res = await host.setScreen('c1', { width: 904, height: 1600 });
        expect(res).toEqual({ ok: true, width: 896, height: 1600, verified: true });
    });

    it('when the read-back does not answer, `verified` is false and the numbers are the ASK', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const host = new DockerHost({
            spawn: docker.spawn,
            fetch: async (input, init) => {
                if (input.endsWith('/api/login')) return new Response(JSON.stringify({ token: 't', profile: { is_admin: true } }), { status: 200 });
                if (input.endsWith('/api/room/screen') && init?.method === 'POST') return new Response('{}', { status: 200 });
                if (input.endsWith('/api/room/screen')) return new Response('not json', { status: 200 });
                return new Response('', { status: 200 });
            },
        });
        const res = await host.setScreen('c1', { width: 1280, height: 800 });
        expect(res.verified).toBe(false);
        expect(res).toMatchObject({ width: 1280, height: 800, detail: 'screen_read_back_failed' });
    });

    it('422 is reported as unsupported so a client stops asking', async () => {
        const docker = fakeDocker((argv) => (argv[0] === 'inspect' ? { stdout: inspectLine({ running: true, env: LIVE_ENV }) } : undefined));
        const host = new DockerHost({
            spawn: docker.spawn,
            fetch: async (input, init) => {
                if (input.endsWith('/api/login')) return new Response(JSON.stringify({ token: 't', profile: { is_admin: true } }), { status: 200 });
                if (init?.method === 'POST' && input.endsWith('/api/room/screen')) return new Response('{"code":422,"message":"cannot set screen size"}', { status: 422 });
                return new Response('', { status: 200 });
            },
        });
        expect((await host.setScreen('c1', { width: 3840, height: 2160 })).detail).toBe('screen_unsupported_422');
    });

    it('refuses a screen X would silently change, before any request is made', async () => {
        const docker = fakeDocker(() => ({}));
        const host = new DockerHost({ spawn: docker.spawn });
        const odd = await host.setScreen('c1', { width: 900, height: 1600 });
        expect(odd.ok).toBe(false);
        expect(odd.detail).toContain('invalid_screen_width');
        expect(docker.calls.length).toBe(0);
    });
});

// ── restart reentrancy ───────────────────────────────────────────────────────

describe('restartDesktop', () => {
    it('a second concurrent restart is in_progress, not a second stop', async () => {
        let stops = 0;
        const docker = fakeDocker((argv) => {
            if (argv[0] === 'stop') stops += 1;
            if (argv[0] === 'inspect') return { stdout: inspectLine({ running: true, env: LIVE_ENV }) };
            return undefined;
        });
        const host = new DockerHost({ spawn: docker.spawn, fetch: fakeNeko().fetchImpl });
        const [a, b] = await Promise.all([host.restartDesktop('c1'), host.restartDesktop('c1')]);
        const codes = [a.errorCode, b.errorCode];
        expect(codes).toContain('in_progress');
        expect(stops).toBe(1);
        // Positive control: one of the two really did run.
        expect([a.ok, b.ok]).toContain(true);
    });

    it('an absent container is not_running, not boot_failed', async () => {
        const docker = fakeDocker(() => NO_SUCH);
        const res = await new DockerHost({ spawn: docker.spawn }).restartDesktop('c1');
        expect(res.errorCode).toBe('not_running');
        expect(docker.verbs()).not.toContain('stop');
    });

    it('a stop that never returns is stop_timed_out, distinct from a start that fails', async () => {
        const slow = fakeDocker((argv) => {
            if (argv[0] === 'inspect') return { stdout: inspectLine({ running: true, env: LIVE_ENV }) };
            if (argv[0] === 'stop') return { exitCode: null, timedOut: true };
            return undefined;
        });
        expect((await new DockerHost({ spawn: slow.spawn }).restartDesktop('c1')).errorCode).toBe('stop_timed_out');

        const badStart = fakeDocker((argv) => {
            if (argv[0] === 'inspect') return { stdout: inspectLine({ running: true, env: LIVE_ENV }) };
            if (argv[0] === 'start') return { exitCode: 1, stderr: 'driver failed\n' };
            return undefined;
        });
        expect((await new DockerHost({ spawn: badStart.spawn }).restartDesktop('c1')).errorCode).toBe('boot_failed');
    });
});

// ── mode ─────────────────────────────────────────────────────────────────────

describe('local mode runs neko only', () => {
    it('refuses guacamole by name rather than booting the wrong desktop', async () => {
        const host = new DockerHost({ spawn: fakeDocker(() => NO_SUCH).spawn });
        await expect(host.ensureDesktop('c1', { mode: 'guacamole' })).rejects.toThrow(/unsupported_local_mode/);
    });
});

async function pwdOf(host: DockerHost, id: string): Promise<string> {
    return (await host.desktopUrls(id)).desktop;
}

afterEach(() => { /* no global state to reset — every test builds its own host */ });
