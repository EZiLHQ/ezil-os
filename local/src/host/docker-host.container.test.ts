/**
 * `DockerHost`, against a REAL container running the REAL desktop.
 *
 * ── Why this suite exists next to a unit suite that already passes ──────────
 * `./docker-host.test.ts` proves the argv is the argv we meant. It cannot prove
 * that `start-desktop.sh` accepts it, that neko binds the mux port it was told
 * to, that the passwords this host mints are the ones actually in force, that
 * `/health` returns what the readiness oracle expects, or that a bind mount and
 * six published ports coexist. Every one of those is a fact about the image and
 * the daemon, and this row exists precisely to establish them: it is the first
 * time the product runs outside Cloudflare.
 *
 * ── Skip semantics (mirrors `worker/src/browser-sidecar.container.test.ts`) ──
 * A suite that could not run must never look like a pass. Docker absent, image
 * absent, or a host port already taken are LOUD skips naming the exact command
 * or option that fixes them. A container that boots and then misbehaves is a
 * FAILURE, never a skip.
 *
 * ── Ports ───────────────────────────────────────────────────────────────────
 * This suite runs with a `hostPortOffset`, and that is not tidiness: on the
 * development machine an unrelated long-running container (`supabase-kong`)
 * holds `0.0.0.0:8443` permanently, so the default map cannot bind. The offset
 * is picked below by actually trying to bind, so the suite is correct on a
 * machine where the defaults ARE free too.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { DockerHost, IMAGE_DEFAULT_PASSWORDS } from './docker-host.ts';
import {
    NEKO_ADMIN_PASSWORD_ENV,
    NEKO_USER_PASSWORD_ENV,
    WEBRTC_MUX_PORT,
    containerNameFor,
    localUrlFor,
    offsetPortMap,
    readAndResolveDesktopImage,
} from '../container/run-spec.ts';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const COMPUTER_ID = `t2-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const CONTAINER = containerNameFor(COMPUTER_ID);
/** Generous: a cold boot measured ~7s script-side, but a loaded machine and a 4.57GB image deserve room. A deadline is a ceiling, not an expectation. */
const BOOT_DEADLINE_MS = 180_000;

function sh(cmd: string, args: string[], timeout = 60_000) {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
}

/** Can this host port actually be bound? Catches the `0.0.0.0:<p>` case too — a wildcard listener makes the loopback bind fail, which is exactly what `docker run` will hit. */
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

/** The first offset at which every published port binds. `null` when none of the candidates work. */
async function pickOffset(): Promise<{ offset: number; busy: number[] } | { offset: null; busy: number[] }> {
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

/** Why this suite may not run. `null` means it CAN. */
async function unavailableReason(): Promise<{ reason: string } | { reason: null; image: string; offset: number }> {
    const version = sh('docker', ['version', '--format', '{{.Server.Version}}'], 20_000);
    if (version.error || version.status !== 0) {
        return { reason: `the Docker daemon is not reachable (${(version.stderr || version.error?.message || '').trim().split('\n')[0]})` };
    }
    // The image named by `deploy/images.env` — which today carries a deliberate
    // placeholder tag, so `resolveDesktopImage` lands on the local fallback and
    // says so. Either way this asks about the reference that would actually run.
    const resolved = await readAndResolveDesktopImage(`${REPO_ROOT}deploy/images.env`);
    const inspected = sh('docker', ['image', 'inspect', resolved.ref, '--format', '{{.Id}}'], 20_000);
    if (inspected.status !== 0) {
        return {
            reason: `the image \`${resolved.ref}\` (${resolved.source}${resolved.reason ? `: ${resolved.reason}` : ''}) is not present locally`
                + ` — build it with \`cd worker && docker build -t ${resolved.ref} .\``,
        };
    }
    const picked = await pickOffset();
    if (picked.offset === null) {
        return { reason: `every candidate port offset collides with something already listening on this machine (busy at the last try: ${picked.busy.join(', ')})` };
    }
    return { reason: null, image: resolved.ref, offset: picked.offset };
}

const availability = await unavailableReason();
const SKIP_REASON = availability.reason;
const IMAGE = 'image' in availability ? availability.image : '';
const OFFSET = 'offset' in availability ? availability.offset : 0;

let host: DockerHost | null = null;
let bootError: string | null = null;
let bootMs = -1;
let started = false;
/** Filled from `docker stats` once ready, so the report carries a real number. */
let memAfterReady = '(not measured)';

if (SKIP_REASON !== null) {
    console.warn(
        `\n${'='.repeat(78)}\n`
        + `SKIPPING the DockerHost container suite: ${SKIP_REASON}.\n`
        + `NOTHING about booting a real desktop has been verified by this run — not the\n`
        + `run argv against a real daemon, not the readiness oracle, not the minted\n`
        + `passwords, not the absence of the checkip call. The unit suite beside this\n`
        + `one checks argv SHAPE and decision logic, never behaviour.\n`
        + `${'='.repeat(78)}\n`,
    );
} else {
    host = new DockerHost({
        image: IMAGE,
        hostPortOffset: OFFSET,
        bootTimeoutMs: BOOT_DEADLINE_MS,
    });
    const t0 = Date.now();
    try {
        await host.ensureDesktop(COMPUTER_ID, { mode: 'neko' });
        bootMs = Date.now() - t0;
        started = true;
        const stats = sh('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', CONTAINER], 30_000);
        memAfterReady = (stats.stdout || '').trim() || '(docker stats gave nothing)';
    } catch (err) {
        // The container may exist even when the boot failed; record it so the
        // cleanup below removes it either way.
        started = sh('docker', ['inspect', '--format', '{{.Id}}', CONTAINER], 20_000).status === 0;
        bootError = err instanceof Error ? err.message : String(err);
    }
}

// 🔴 ALWAYS, EVEN ON FAILURE. A suite that leaves a desktop running leaves six
// published ports and a browser process behind on the developer's machine.
afterAll(() => {
    if (started || SKIP_REASON === null) sh('docker', ['rm', '--force', CONTAINER], 60_000);
});

describe.skipIf(SKIP_REASON !== null)('a real desktop, booted by DockerHost', () => {
    it('booted at all (every assertion below depends on this one)', () => {
        expect(bootError).toBeNull();
        expect(host).not.toBeNull();
        console.log(
            `\n[T2 measured] image=${IMAGE} offset=${OFFSET}`
            + `\n[T2 measured] cold boot (docker run -> authenticated neko login): ${(bootMs / 1000).toFixed(1)}s`
            + `\n[T2 measured] container memory after ready: ${memAfterReady}\n`,
        );
        expect(bootMs).toBeGreaterThan(0);
        expect(bootMs).toBeLessThan(BOOT_DEADLINE_MS);
    });

    it('reports ready — and `ready` means neko accepted THIS boot\'s credential, not that a port answered', async () => {
        expect(host!.bootPhase(COMPUTER_ID)).toBe('ready');
        const status = await host!.status(COMPUTER_ID);
        expect(status).toMatchObject({ ok: true, containerState: 'running', desktopReady: true, mode: 'neko' });
    });

    it('neko\'s own /health answers with the body the oracle requires', async () => {
        const res = await host!.fetchIn(COMPUTER_ID, 8181, new Request('http://x/health'));
        expect(res.status).toBe(200);
        // 🔴 THE BODY. A 200 alone is what §16b says is not evidence.
        expect((await res.text()).trim()).toBe('true');
    });

    it('the desktop URL logs in, and the image\'s own passwords do NOT', async () => {
        const urls = await host!.desktopUrls(COMPUTER_ID);
        const pwd = new URL(urls.desktop).searchParams.get('pwd');
        expect(pwd).toMatch(/^[0-9a-f]{32}$/);
        const origin = localUrlFor('desktop', OFFSET);

        const good = await fetch(`${origin}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'ezil-os-container-test', password: pwd }),
        });
        expect(good.status).toBe(200);
        const body = (await good.json()) as { token?: string };
        expect(typeof body.token).toBe('string');
        await fetch(`${origin}/api/logout`, { method: 'POST', headers: { Authorization: `Bearer ${body.token}` } });

        // 🔴 THE NEGATIVE, WITH THE POSITIVE ABOVE AS ITS CONTROL. The image
        // ships /etc/neko/neko.yaml with admin_password "admin" and
        // user_password "neko". If either still worked, this desktop would be
        // published on a bound loopback port with a password in a public repo.
        for (const literal of IMAGE_DEFAULT_PASSWORDS) {
            const bad = await fetch(`${origin}/api/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: 'ezil-os-container-test', password: literal }),
            });
            expect(bad.status).toBe(401);
        }
    });

    it('the legacy V2 websocket path rejects the image defaults too', async () => {
        // The V3 REST check above is not the whole surface: the pinned neko
        // build has `--legacy` on by default and the browser client uses
        // `/ws?password=`. `worker/src/hmac.ts` warns that V2 keys can take
        // precedence, so the V2 door is checked with the same literals.
        const origin = localUrlFor('desktop', OFFSET).replace('http://', 'ws://');
        const pwd = new URL((await host!.desktopUrls(COMPUTER_ID)).desktop).searchParams.get('pwd')!;
        expect(await firstWsEvent(`${origin}/ws?password=${encodeURIComponent(pwd)}`)).toContain('member/list');
        for (const literal of IMAGE_DEFAULT_PASSWORDS) {
            expect(await firstWsEvent(`${origin}/ws?password=${literal}`)).toContain('Unauthorized');
        }
    }, 60_000);

    it('code-server answers on its own port with --auth none', async () => {
        const res = await fetch(localUrlFor('code', OFFSET), { redirect: 'manual' });
        // Measured: `GET /` is a 302 to `/?folder=/home/neko/project`.
        expect([200, 302]).toContain(res.status);
        if (res.status === 302) expect(res.headers.get('location') ?? '').toContain('folder=');
    });

    it('the browser sidecar answers on 9223, reached the way the cloud reaches it', async () => {
        const res = await host!.fetchIn(COMPUTER_ID, 9223, new Request('http://x/health'));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok?: boolean; chromeConnected?: boolean };
        expect(body.ok).toBe(true);
        expect(body.chromeConnected).toBe(true);
    });

    it('exec round-trips a command as an array', async () => {
        const res = await host!.exec(COMPUTER_ID, ['bash', '-c', 'echo ok']);
        expect(res.exitCode).toBe(0);
        expect(res.stdout.trim()).toBe('ok');
        expect(res.timedOut).toBe(false);
    });

    it('exec enforces a timeout host-side, since docker exec has no flag for one', async () => {
        const res = await host!.exec(COMPUTER_ID, ['sleep', '30'], { timeoutMs: 2_000 });
        expect(res.timedOut).toBe(true);
        expect(res.exitCode).toBeNull();
    }, 30_000);

    it('NO OUTBOUND IP-RETRIEVAL CALL — and the positive control is in the same log', async () => {
        const raw = await host!.exec(COMPUTER_ID, ['cat', '/tmp/neko.log'], { timeoutMs: 30_000 });
        expect(raw.exitCode).toBe(0);
        // 🔴 STRIP ANSI FIRST. neko colourises its own structured log, so the
        // bytes are `udpmux=\x1b[0m62100`, not `udpmux=62100`. The first version
        // of this test asserted on the raw text and went red against a log that
        // said exactly the right thing — a substring assertion over colourised
        // output is a test of the terminal, not of the program.
        const log = { ...raw, stdout: stripAnsi(raw.stdout) };
        // 🔴 The positive control FIRST, so "no checkip" is a fact about the
        // absence of checkip and not about an empty file or a wrong path.
        // Measured line: `webrtc starting epr=0-0 icelite=true ...
        // nat1to1=127.0.0.1 tcpmux=52100 udpmux=52100`.
        const mux = WEBRTC_MUX_PORT + OFFSET;
        expect(log.stdout).toContain('webrtc starting');
        expect(log.stdout).toContain('nat1to1=');
        expect(log.stdout).toContain('127.0.0.1');
        expect(log.stdout).toContain(`udpmux=${mux}`);
        expect(log.stdout).toContain(`tcpmux=${mux}`);
        expect(log.stdout).toContain('icelite=true');
        // The negative: `--webrtc.ip_retrieval_url` defaults to
        // `https://checkip.amazonaws.com` and is fetched whenever nat1to1 is
        // ABSENT. It is present, so nothing must have called out.
        for (const needle of ['checkip', 'ip_retrieval', 'amazonaws']) {
            expect(log.stdout.toLowerCase()).not.toContain(needle);
        }
        console.log(`\n[T2 measured] neko WebRTC line: ${(log.stdout.split('\n').find((l) => l.includes('webrtc starting')) ?? '').trim()}\n`);
    });

    it('the mux port is bound on the HOST, on both transports', async () => {
        const mux = WEBRTC_MUX_PORT + OFFSET;
        // If these were free, nothing is published and the browser would have
        // no media path at all — the failure an HTTP probe cannot see.
        expect(await udpFree(mux)).toBe(false);
        expect(tcpFree(mux)).toBe(false);
        const ss = sh('ss', ['-lun'], 20_000);
        if (ss.status === 0) {
            expect(ss.stdout).toContain(`127.0.0.1:${mux}`);
            console.log(`\n[T2 measured] host UDP mux: ${(ss.stdout.split('\n').find((l) => l.includes(`:${mux}`)) ?? '').trim()}\n`);
        }
    });

    it('the container carries this host\'s minted credentials, not the image\'s', () => {
        const env = sh('docker', ['inspect', '--format', '{{json .Config.Env}}', CONTAINER], 20_000);
        expect(env.status).toBe(0);
        const entries = JSON.parse(env.stdout.trim()) as string[];
        const read = (key: string) => entries.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1);
        for (const key of [NEKO_USER_PASSWORD_ENV, NEKO_ADMIN_PASSWORD_ENV]) {
            const value = read(key);
            expect(value).toMatch(/^[0-9a-f]{32}$/);
            for (const literal of IMAGE_DEFAULT_PASSWORDS) expect(value).not.toBe(literal);
        }
        expect(read('DESKTOP_MODE')).toBe('neko');
        expect(read('NEKO_WEBRTC_NAT1TO1')).toBe('127.0.0.1');
        expect(read('NEKO_WEBRTC_UDPMUX')).toBe(String(WEBRTC_MUX_PORT + OFFSET));
    });

    it('readScreen reads X back, and setScreen reports the read-back', async () => {
        const before = await host!.readScreen(COMPUTER_ID);
        expect(before).toMatchObject({ ok: true, verified: true, width: 1920, height: 1080 });
        const set = await host!.setScreen(COMPUTER_ID, { width: 1280, height: 800 });
        expect(set).toMatchObject({ ok: true, verified: true, width: 1280, height: 800 });
        const after = await host!.readScreen(COMPUTER_ID);
        expect(after.width).toBe(1280);
        // Put it back so a later assertion is not surprised by it.
        await host!.setScreen(COMPUTER_ID, { width: 1920, height: 1080 });
    }, 60_000);

    it('ensureDesktop is idempotent: a second call starts nothing and returns the same URLs', async () => {
        const first = await host!.desktopUrls(COMPUTER_ID);
        const t0 = Date.now();
        const again = await host!.ensureDesktop(COMPUTER_ID, { mode: 'neko' });
        const elapsed = Date.now() - t0;
        expect(again).toEqual(first);
        // A reuse is a probe, not a boot. Measured cold boot is seconds; this
        // must be well under it.
        expect(elapsed).toBeLessThan(15_000);
        console.log(`\n[T2 measured] warm ensureDesktop (reuse): ${elapsed}ms\n`);
    }, 60_000);

    it('restartDesktop keeps the container and comes back ready', async () => {
        const before = sh('docker', ['inspect', '--format', '{{.Id}}', CONTAINER], 20_000).stdout.trim();
        const t0 = Date.now();
        const res = await host!.restartDesktop(COMPUTER_ID);
        const elapsed = Date.now() - t0;
        expect(res.ok).toBe(true);
        const after = sh('docker', ['inspect', '--format', '{{.Id}}', CONTAINER], 20_000).stdout.trim();
        // 🔴 THE SAME CONTAINER. `restartDesktop` is not terminate+ensure; the
        // user's files have to survive it.
        expect(after).toBe(before);
        expect((await host!.status(COMPUTER_ID)).desktopReady).toBe(true);
        console.log(`\n[T2 measured] restartDesktop (stop + start + ready): ${(elapsed / 1000).toFixed(1)}s\n`);
        // 120s rather than Bun's 5s default: a real restart is a real stop, a
        // real start and a real boot. Measured 9.0s on this machine; the first
        // run of this suite failed here purely because the default per-test
        // deadline is shorter than the thing being measured.
    }, 120_000);

    it('terminate removes it, and a second status reports absent', async () => {
        const res = await host!.terminate(COMPUTER_ID);
        expect(res).toEqual({ ok: true, terminated: true });
        const status = await host!.status(COMPUTER_ID);
        expect(status).toEqual({ ok: true, computerId: COMPUTER_ID, containerState: 'absent', desktopReady: false, mode: null });
        // Terminating an already-absent computer is not a failure.
        expect(await host!.terminate(COMPUTER_ID)).toMatchObject({ ok: true, terminated: false });
        started = false;
    }, 60_000);
});

/** neko colourises its own log; a substring assertion has to see the bytes it means. */
function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** The first frame neko sends after the legacy websocket handshake. The handshake itself is always a 101 — auth is answered in-band, which is why a curl status code proves nothing here. */
function firstWsEvent(url: string): Promise<string> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        let done = false;
        const finish = (text: string) => {
            if (done) return;
            done = true;
            try { ws.close(); } catch { /* ignore */ }
            resolve(text);
        };
        ws.onmessage = (e) => finish(String(e.data).slice(0, 400));
        ws.onclose = (e) => finish(`CLOSED ${e.code} ${e.reason}`);
        ws.onerror = () => finish('ERROR');
        setTimeout(() => finish('TIMEOUT'), 15_000);
    });
}
