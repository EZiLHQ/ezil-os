/**
 * THE PROOF: it must not be possible to report "ready" over a blank screen.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * `desktop-frame-honesty.test.ts` next door proves the shell cannot report
 * ready over an HTTP 500 from the desktop origin. That closed a real hole and
 * stopped one layer short of the floor. A Neko origin serves its SPA shell with
 * a 200 whether or not WebRTC will ever connect, so "the origin answered" is
 * entirely compatible with a screen that never shows anything.
 *
 * Measured under WebKit: the shell declared **ready in 4.6s** while the frame's
 * video element had `videoWidth: 0`, `paused: true`, `srcObject: false`. The
 * boot panel had already come down, so what the user actually saw was a bare
 * third-party n.eko logo and spinner — no EZiL copy, no retry, no way to tell
 * whose product had failed. Half the harm was the vendor-branding leak.
 *
 * ── Why nothing that already existed could have caught it ───────────────────
 * Every signal the contract had was TRUE. The Worker registered the port; the
 * container reported the desktop process up; `probeDesktopFrame` got its 200.
 * And the browser cannot supply the missing one: the desktop iframe is
 * `8181-<sandbox>-nekodesktop.<zone>` inside the app origin, so
 * `video.videoWidth` is not hard to read, it is forbidden — an attempt throws
 * or silently yields nothing while looking exactly like a check.
 *
 * ── How this file proves the fix ────────────────────────────────────────────
 * With a REAL HTTP server standing in for the container's own Neko API, not a
 * stubbed `fetch`. `probeDesktopDisplay` logs into it and reads
 * `GET /api/sessions`, whose `state.is_watching` has exactly one writer in
 * Neko: the WebRTC peer's `OnConnectionStateChange` reaching
 * `PeerConnectionStateConnected`. A second server stands in for this app's own
 * `GET /api/shell/desktop?confirm=display` handler, the SHIPPED shell module
 * (`shell/ezil/session.js`, imported across the tree — a proof that
 * re-implements the client's parsing proves nothing about the client) is
 * pointed at it, and its answer is fed through the real `applyDisplayEvidence`.
 *
 * So the chain under test is the whole one the user's browser walks:
 *
 *   a Neko with no WebRTC peer
 *     -> probeDesktopDisplay          (server)
 *     -> the confirm route's response  (wire)
 *     -> session.confirmDisplay        (shell)
 *     -> applyDisplayEvidence          (shell)
 *     -> the state the boot panel renders
 *
 * ── BOTH DIRECTIONS, on purpose ─────────────────────────────────────────────
 * A gate that always refuses passes a one-directional test, and "always
 * refuses" is a worse bug than the one being fixed: it would hide a working
 * desktop from every user at once. So every refusal below has a control case
 * running the same code against a Neko that IS streaming, and the third
 * outcome — `unknown` — is pinned separately, because it must resolve to
 * neither.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDisplayEvidence, computeBootUiState } from '@/components/desktop/boot-phases';
import shellSession from '../../../../shell/ezil/session.js';
import { probeDesktopDisplay } from './cloudflare-guacamole-provider';

const ADMIN_PASSWORD = 'derived-admin-secret-value';
const TOKEN = 'neko-session-token';

/** A session as Neko's `SessionDataPayload` actually serialises it. */
function session(id: string, isWatching: boolean) {
    return {
        id,
        profile: { name: 'EZiL', is_admin: false, can_watch: true, can_host: true },
        state: {
            is_connected: true,
            connected_since: '2026-08-01T00:00:00Z',
            is_watching: isWatching,
            ...(isWatching ? { watching_since: '2026-08-01T00:00:01Z' } : {}),
        },
    };
}

type NekoOpts = {
    /** What `GET /api/sessions` answers with. A number is a bare status code. */
    sessions: unknown | number;
    /** Reject the login instead of issuing a token. */
    rejectLogin?: boolean;
};

/** Records every request, so credential hygiene is checkable rather than assumed. */
type Hit = { method: string; path: string; auth: string | undefined; body: string };

function makeNeko(opts: NekoOpts) {
    const hits: Hit[] = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const path = req.url ?? '/';
            hits.push({
                method: req.method ?? 'GET',
                path,
                auth: req.headers.authorization,
                body,
            });

            const json = (status: number, payload: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            };

            if (path === '/api/login' && req.method === 'POST') {
                const parsed = JSON.parse(body || '{}') as { password?: string };
                if (opts.rejectLogin || parsed.password !== ADMIN_PASSWORD) {
                    return json(401, { message: 'invalid password' });
                }
                return json(200, { id: 'srv', token: TOKEN, profile: { is_admin: true } });
            }
            if (path === '/api/sessions' && req.method === 'GET') {
                if (req.headers.authorization !== `Bearer ${TOKEN}`) {
                    return json(401, { message: 'unauthorized' });
                }
                if (typeof opts.sessions === 'number') {
                    res.writeHead(opts.sessions, { 'content-type': 'text/html' });
                    return res.end('<html>error</html>');
                }
                return json(200, opts.sessions);
            }
            if (path === '/api/logout' && req.method === 'POST') return json(200, {});
            // Neko's SPA shell — a 200 for anything else, which is exactly why
            // `probeDesktopFrame` cannot tell a streaming desktop from a dead one.
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><html><body><div id="neko"></div></body></html>');
        });
    });
    return { server, hits };
}

function listen(server: Server): Promise<string> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

/** Give the unawaited best-effort logout a beat to land before asserting on it. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('probeDesktopDisplay — only a connected WebRTC peer counts as pixels', () => {
    it('🔴 reports `live` when a session is watching', async () => {
        const { server, hits } = makeNeko({ sessions: [session('a', true)] });
        const url = await listen(server);
        try {
            expect(await probeDesktopDisplay(`${url}/?usr=EZiL&pwd=secret&embed=1`, ADMIN_PASSWORD)).toEqual({
                display: 'live',
                sessions: 1,
                watching: 1,
            });
            await settle();
            // Hygiene: the admin credential travels in a POST body and NEVER in
            // a URL, which is the kind of string that ends up in a log line.
            expect(hits.map((h) => `${h.method} ${h.path}`)).toEqual([
                'POST /api/login',
                'GET /api/sessions',
                'POST /api/logout',
            ]);
            expect(hits.map((h) => h.path).join('')).not.toContain(ADMIN_PASSWORD);
            // And the phantom-session hygiene `enableImplicitHosting` established.
            expect(hits.some((h) => h.path === '/api/logout')).toBe(true);
        } finally {
            await close(server);
        }
    });

    it('🔴 reports `blank` when sessions exist but none is watching', async () => {
        // The measured failure: the page loaded, the websocket connected, and
        // the WebRTC peer never reached `connected`.
        const { server } = makeNeko({ sessions: [session('a', false)] });
        const url = await listen(server);
        try {
            expect(await probeDesktopDisplay(`${url}/`, ADMIN_PASSWORD)).toEqual({
                display: 'blank',
                sessions: 1,
            });
        } finally {
            await close(server);
        }
    });

    it('reports `blank` for an empty session list — no sessions means no viewer', async () => {
        const { server } = makeNeko({ sessions: [] });
        const url = await listen(server);
        try {
            expect(await probeDesktopDisplay(`${url}/`, ADMIN_PASSWORD)).toEqual({
                display: 'blank',
                sessions: 0,
            });
        } finally {
            await close(server);
        }
    });

    it('one watcher among several idle sessions is still `live`', async () => {
        const { server } = makeNeko({
            sessions: [session('a', false), session('b', true), session('c', false)],
        });
        const url = await listen(server);
        try {
            expect(await probeDesktopDisplay(`${url}/`, ADMIN_PASSWORD)).toEqual({
                display: 'live',
                sessions: 3,
                watching: 1,
            });
        } finally {
            await close(server);
        }
    });

    it('🔴 a refused login is `unknown`, NOT `blank` — we learned nothing about the screen', async () => {
        const { server } = makeNeko({ sessions: [session('a', true)], rejectLogin: true });
        const url = await listen(server);
        try {
            expect(await probeDesktopDisplay(`${url}/`, ADMIN_PASSWORD)).toEqual({
                display: 'unknown',
                reason: 'login_failed',
                status: 401,
            });
        } finally {
            await close(server);
        }
    });

    it('🔴 the wrong credential is `unknown` too — our mistake is not the user`s failure', async () => {
        const { server } = makeNeko({ sessions: [session('a', true)] });
        const url = await listen(server);
        try {
            const probe = await probeDesktopDisplay(`${url}/`, 'not-the-admin-password');
            expect(probe.display).toBe('unknown');
        } finally {
            await close(server);
        }
    });

    it('🔴 a 500 from /api/sessions is `unknown`', async () => {
        const { server } = makeNeko({ sessions: 500 });
        const url = await listen(server);
        try {
            expect(await probeDesktopDisplay(`${url}/`, ADMIN_PASSWORD)).toEqual({
                display: 'unknown',
                reason: 'http_error',
                status: 500,
            });
        } finally {
            await close(server);
        }
    });

    it('🔴 A SHAPE WE DO NOT RECOGNISE IS `unknown`, never `blank`', async () => {
        // This is the case that decides whether a future Neko bump degrades
        // gracefully or takes the product down. A renamed field must make every
        // desktop UNVERIFIED (shown, with a caveat) — never make every desktop
        // FAILED. Both halves are asserted: a wrong container type, and the
        // right container with the field renamed.
        for (const body of [
            { sessions: [] },
            'not json at all, but served as json',
            [{ id: 'a', state: { isWatching: true } }],
            [{ id: 'a', state: {} }],
            [{ id: 'a' }],
            [session('a', true), { id: 'b', state: { is_watching: 'yes' } }],
            [null],
        ]) {
            const { server } = makeNeko({ sessions: body });
            const url = await listen(server);
            try {
                const probe = await probeDesktopDisplay(`${url}/`, ADMIN_PASSWORD);
                expect(probe).toEqual({ display: 'unknown', reason: 'unrecognised' });
            } finally {
                await close(server);
            }
        }
    });

    it('a host that does not answer at all is `unknown`', async () => {
        // Port 1 on loopback: nothing listens, so this is a genuine transport
        // failure rather than a synthesized one.
        expect(await probeDesktopDisplay('http://127.0.0.1:1/', ADMIN_PASSWORD, 2_000)).toEqual({
            display: 'unknown',
            reason: 'unreachable',
        });
    });

    it('a URL we cannot probe is `unknown`', async () => {
        for (const bad of ['', 'not a url', 'file:///etc/passwd', 'ws://host/']) {
            expect(await probeDesktopDisplay(bad, ADMIN_PASSWORD)).toEqual({
                display: 'unknown',
                reason: 'bad_url',
            });
        }
    });

    it('never throws, whatever it is handed', async () => {
        for (const bad of [undefined, null, 42, {}]) {
            await expect(
                probeDesktopDisplay(bad as unknown as string, ADMIN_PASSWORD, 1_500),
            ).resolves.toHaveProperty('display', 'unknown');
        }
    });
});

/**
 * The end-to-end chain, three times: once for each verdict.
 *
 * Only authentication is faked. `probeDesktopDisplay`, the wire shape, the
 * shipped `session.confirmDisplay`, `computeBootUiState` and
 * `applyDisplayEvidence` are all the real ones.
 */
describe('🔴 THE PROOF — the whole shell chain over a real Neko', () => {
    let app: Server;
    let appUrl: string;

    beforeAll(async () => {
        app = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://internal');
            void (async () => {
                const frameUrl = url.searchParams.get('frameUrl') ?? '';
                const probe = await probeDesktopDisplay(frameUrl, ADMIN_PASSWORD);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...probe }));
            })();
        });
        appUrl = await listen(app);
        (globalThis as unknown as { window: unknown }).window = {
            __EZIL_BOOT__: {
                user: { id: '00000000-0000-4000-8000-000000000001' },
                desktopState: { endpoints: { desktop: `${appUrl}/api/shell/desktop` } },
            },
        };
    });

    afterAll(async () => {
        delete (globalThis as unknown as { window?: unknown }).window;
        await close(app);
    });

    /** The first gate's verdict, run for real — `settle_display` composes it the same way. */
    const frameState = () =>
        computeBootUiState({ requestStatus: 'success', elapsedMs: 0, frameConfirmed: true });

    async function drive(neko: NekoOpts) {
        const { server } = makeNeko(neko);
        const url = await listen(server);
        try {
            const display = await shellSession.confirmDisplay(
                '00000000-0000-4000-8000-000000000002',
                `${url}/?usr=EZiL&pwd=secret&embed=1`,
            );
            return { display, ui: applyDisplayEvidence(frameState(), display) };
        } finally {
            await close(server);
        }
    }

    it('🔴 a reachable Neko with NO WebRTC peer does not reach ready', async () => {
        // Every older signal in the contract is satisfied here: this host
        // answers 200 on `/`, so `probeDesktopFrame` confirms it and
        // `computeBootUiState` says `ready`. The control below shows the same
        // code reaching `ready` when a peer IS connected, so this is a real
        // discrimination and not a blanket refusal.
        expect(frameState()).toEqual({ kind: 'ready' });

        const { display, ui } = await drive({ sessions: [session('a', false)] });
        expect(display).toBe('blank');
        expect(ui.kind).not.toBe('ready');
        expect(ui).toEqual({ kind: 'failed', reason: 'display_not_streaming' });
    });

    it('🔴 the control: a Neko with a connected peer DOES reach ready', async () => {
        const { display, ui } = await drive({ sessions: [session('a', true)] });
        expect(display).toBe('live');
        expect(ui).toEqual({ kind: 'ready' });
    });

    it('🔴 a Neko we cannot read is neither — the desktop is shown, unverified', async () => {
        const { display, ui } = await drive({ sessions: [{ id: 'a', state: { isWatching: true } }] });
        expect(display).toBe('unknown');
        expect(ui.kind).not.toBe('ready');
        expect(ui.kind).not.toBe('failed');
        expect(ui).toEqual({ kind: 'ready_unverified' });
    });

    it('a confirm route that does not answer at all is `unknown`, not `blank`', async () => {
        // Our own plumbing failing says nothing about the user's screen, so it
        // must not be able to produce a failure panel.
        (globalThis as unknown as { window: { __EZIL_BOOT__: unknown } }).window = {
            __EZIL_BOOT__: {
                user: { id: '00000000-0000-4000-8000-000000000001' },
                desktopState: { endpoints: { desktop: 'http://127.0.0.1:1/api/shell/desktop' } },
            },
        };
        try {
            const display = await shellSession.confirmDisplay(
                '00000000-0000-4000-8000-000000000002',
                'https://8181-guac-a-b-nekodesktop.example.invalid/',
            );
            expect(display).toBe('unknown');
            expect(applyDisplayEvidence(frameState(), display)).toEqual({ kind: 'ready_unverified' });
        } finally {
            (globalThis as unknown as { window: { __EZIL_BOOT__: unknown } }).window = {
                __EZIL_BOOT__: {
                    user: { id: '00000000-0000-4000-8000-000000000001' },
                    desktopState: { endpoints: { desktop: `${appUrl}/api/shell/desktop` } },
                },
            };
        }
    });

    it('a confirm route answering a shape the shell does not know is `unknown`', async () => {
        const rogue = createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            // Every one of these is a plausible near-miss for "yes".
            res.end(JSON.stringify({ ok: true, display: 'LIVE', watching: 1, live: true }));
        });
        const rogueUrl = await listen(rogue);
        const saved = (globalThis as unknown as { window: unknown }).window;
        (globalThis as unknown as { window: unknown }).window = {
            __EZIL_BOOT__: {
                user: { id: '00000000-0000-4000-8000-000000000001' },
                desktopState: { endpoints: { desktop: `${rogueUrl}/api/shell/desktop` } },
            },
        };
        try {
            const display = await shellSession.confirmDisplay(
                '00000000-0000-4000-8000-000000000002',
                'https://8181-guac-a-b-nekodesktop.example.invalid/',
            );
            expect(display).toBe('unknown');
        } finally {
            (globalThis as unknown as { window: unknown }).window = saved;
            await close(rogue);
        }
    });
});
