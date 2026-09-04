/**
 * The shell contract, exercised over a real HTTP listener.
 *
 * 🔴 EVERY ASSERTED FIELD IS ONE A NAMED LINE OF `shell/` OR OF AN APP ROUTE
 * ACTUALLY READS, AND THE CITATION IS IN THE TEST. A contract test that
 * asserted this server's own output against this server's own idea of the shape
 * would pass forever and prove nothing; what makes it a contract is that the
 * expectations come from the OTHER side. Where the value can be imported from
 * the app it is imported (`SHELL_API_ROUTES`, `SHELL_APPS`,
 * `serializeBootPayload`); where it cannot — a field read inside a jQuery
 * bundle — the reading line is quoted in a comment above the assertion.
 *
 * The server runs on an EPHEMERAL port with a `FakeSandboxHost`, so nothing
 * here starts a container and nothing here needs Docker. What that buys is the
 * only thing it can buy: proof that a given host answer becomes the response
 * the shell expects. It is not evidence about the Docker adapter (row T2) and
 * must never be reported as any.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SHELL_APPS, SHELL_API_ROUTES as APP_SHELL_API_ROUTES } from '../../../app/src/server/shell/boot-payload.ts';
import { OS_ASSET_PATHS } from '../boot/os-document.ts';
import { loadConfig, SHELL_ASSET_FILES, type LocalConfig } from '../config.ts';
import { localUrlFor } from '../container/run-spec.ts';
import { SHELL_API_ROUTES } from '../contract/shell-api.ts';
import { FakeSandboxHost, healthyFakeState, type FakeHostState } from './fake-host.ts';
import {
    LOCAL_FOCUSABLE_APPS,
    isOwnDesktopOrigin,
    probeDesktopOrigin,
    shellRoutes,
    type FrameProbe,
} from './routes.ts';
import { startLocalServer, type LocalServer } from './server.ts';

// ── Harness ──────────────────────────────────────────────────────────────────

let tmp: string;
let config: LocalConfig;
let server: LocalServer;
let host: FakeSandboxHost;
let state: FakeHostState;
let telemetry: unknown[];
let frameVerdict: FrameProbe;

const base = () => server.url;
const computerId = () => server.computer.id();

async function get(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${base()}${path}`, init);
}

async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ezil-t1-'));
    config = await loadConfig({
        EZIL_LOCAL_PORT: '0',
        EZIL_LOCAL_WORKSPACE: join(tmp, 'workspace'),
        EZIL_LOCAL_STATE_DIR: join(tmp, 'state'),
    });
    state = healthyFakeState();
    host = new FakeSandboxHost(state);
    telemetry = [];
    frameVerdict = { alive: true, reason: 'ok', status: 200 };
    server = await startLocalServer({
        config,
        host,
        probeFrame: () => Promise.resolve(frameVerdict),
        telemetrySink: async (record) => {
            telemetry.push(record);
        },
    });
});

afterAll(async () => {
    await server.stop();
    await rm(tmp, { recursive: true, force: true });
});

/** Restore the healthy state between the tests that break it, so one broken case cannot leak into the next. */
function reset(): void {
    Object.assign(state, healthyFakeState());
    frameVerdict = { alive: true, reason: 'ok', status: 200 };
}

// ── The route table ──────────────────────────────────────────────────────────

describe('the published endpoint map and the served paths are the same nine', () => {
    it('the local mirror carries exactly the app\'s nine keys and paths', () => {
        // Imported from `app/src/server/shell/boot-payload.ts` at RUNTIME — its
        // only import is `import type { Computer }`, which Bun erases, so
        // nothing of Next.js is loaded. Same technique as
        // `../contract/shell-api.test.ts`.
        expect(Object.keys(SHELL_API_ROUTES).sort()).toEqual(Object.keys(APP_SHELL_API_ROUTES).sort());
        for (const key of Object.keys(APP_SHELL_API_ROUTES) as (keyof typeof APP_SHELL_API_ROUTES)[]) {
            expect(SHELL_API_ROUTES[key]).toBe(APP_SHELL_API_ROUTES[key]);
        }
    });

    it('every published key is a path this host actually serves', () => {
        // `../contract/shell-api.ts`: "a key here is a SWITCH, not
        // documentation... the local host must publish a key only while it
        // actually serves that path. Publishing one it does not serve is a
        // control that 404s."
        const served = Object.keys(shellRoutes()).sort();
        expect(served).toEqual(Object.values(SHELL_API_ROUTES).sort());
    });

    it('the boot payload publishes all nine to the browser', async () => {
        const res = await post(SHELL_API_ROUTES.session, {});
        const body = (await res.json()) as { desktopState: { endpoints: Record<string, string> } };
        expect(Object.entries(body.desktopState.endpoints).sort()).toEqual(
            Object.entries(APP_SHELL_API_ROUTES).sort(),
        );
    });
});

// ── /os and the three bundle files ───────────────────────────────────────────

describe('GET /os', () => {
    it('serves an HTML document with the payload, the stylesheet and both scripts', async () => {
        const res = await get('/os');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        // The payload is per-boot and carries `isNew`. Never cached.
        expect(res.headers.get('cache-control')).toContain('no-store');

        const html = await res.text();
        expect(html).toContain('window.__EZIL_BOOT__=');
        expect(html).toContain(`<link rel="stylesheet" href="${OS_ASSET_PATHS.css}">`);
        // ORDER: `app/src/app/os/page.tsx` — "the payload must exist before the
        // bundle runs, and the icons before the bundle that draws them".
        expect(html.indexOf('window.__EZIL_BOOT__=')).toBeLessThan(html.indexOf(OS_ASSET_PATHS.icons));
        expect(html.indexOf(OS_ASSET_PATHS.icons)).toBeLessThan(html.indexOf(OS_ASSET_PATHS.bundle));
        // `defer`, never `async` — page.tsx: "`async` would let the bundle run
        // before its icons".
        expect(html).toContain(`<script src="${OS_ASSET_PATHS.icons}" defer></script>`);
        expect(html).toContain(`<script src="${OS_ASSET_PATHS.bundle}" defer></script>`);
        expect(html).not.toContain('async');
    });

    it('renders the mount point the shell adopts', async () => {
        const html = await (await get('/os')).text();
        // `shell/ezil/boot.js:635` — `document.getElementById('ezil-os-root')`.
        expect(html).toContain('id="ezil-os-root"');
        // `boot.js:628` `mount_desktop_root()` REUSES an existing `.desktop`,
        // so this node is the wallpaper painted before any script runs.
        expect(html).toContain('class="desktop ezil-desktop"');
    });

    it('does NOT carry data-awaits-hydration', async () => {
        const html = await (await get('/os')).text();
        // 🔴 THE NEGATIVE. `shell/ezil/boot.js:931` `awaits_hydration()` returns
        // true only for the exact string "react", and `when_hydrated` then waits
        // for an `ezil:hydrated` event up to HYDRATION_CAP_MS (3s). This document
        // is not a React document and will never dispatch that event, so copying
        // the attribute across from `app/src/app/os/page.tsx` would add a 3s
        // stall to every single local boot.
        expect(html).not.toContain('data-awaits-hydration');
        // POSITIVE CONTROL for the negative above: the attribute the shell DOES
        // key on is spelled exactly this way in the hosted document, so the
        // grep above is looking for a real string and not a typo that can never
        // match. Read from the hosted page's own source.
        const hosted = await readFile(
            join(config.parentRoot, 'app', 'src', 'app', 'os', 'page.tsx'),
            'utf8',
        );
        expect(hosted).toContain('data-awaits-hydration="react"');
    });

    it('carries the viewport meta the mobile keyboard depends on', async () => {
        const html = await (await get('/os')).text();
        // `app/src/app/layout.tsx`'s `viewport` export: without
        // `interactive-widget`, Android resized the visual viewport and the
        // desktop the user was typing into slid off the screen.
        expect(html).toContain('interactive-widget=overlays-content');
    });
});

describe('the three bundle files', () => {
    it('are served by path from app/public/os with the right content types', async () => {
        expect(config.shellAssetsDir).toBe(join(config.parentRoot, 'app', 'public', 'os'));
        const expected: Record<string, string> = {
            [OS_ASSET_PATHS.bundle]: 'text/javascript; charset=utf-8',
            [OS_ASSET_PATHS.css]: 'text/css; charset=utf-8',
            [OS_ASSET_PATHS.icons]: 'text/javascript; charset=utf-8',
        };
        for (const [path, type] of Object.entries(expected)) {
            const res = await get(path);
            expect(`${path} -> ${res.status}`).toBe(`${path} -> 200`);
            expect(res.headers.get('content-type')).toBe(type);
            expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
        }
    });

    it('the cache validator is derived from the file\'s own mtime and size', async () => {
        const res = await get(OS_ASSET_PATHS.icons);
        const etag = res.headers.get('etag');
        expect(etag).toMatch(/^W\/"\d+-\d+"$/);
        expect(res.headers.get('cache-control')).toBe('no-cache');

        // MUTATION-STYLE PROOF, without editing the file on disk: the tag is
        // recomputed from a stat, so a different mtime is a different tag.
        const { assetETag } = await import('../boot/assets.ts');
        const same = { path: 'x', sizeBytes: 10, mtimeMs: 1000 };
        expect(assetETag(same)).toBe(assetETag({ ...same }));
        expect(assetETag({ ...same, mtimeMs: 1001 })).not.toBe(assetETag(same));
        expect(assetETag({ ...same, sizeBytes: 11 })).not.toBe(assetETag(same));
    });

    it('a matching If-None-Match gets a 304 with no body', async () => {
        const first = await get(OS_ASSET_PATHS.css);
        const etag = first.headers.get('etag') ?? '';
        expect(etag).not.toBe('');
        const second = await get(OS_ASSET_PATHS.css, { headers: { 'if-none-match': etag } });
        expect(second.status).toBe(304);
        expect((await second.arrayBuffer()).byteLength).toBe(0);
        // POSITIVE CONTROL: a stale validator gets the bytes back, so the 304
        // above is the validator matching and not the route always 304ing.
        const stale = await get(OS_ASSET_PATHS.css, { headers: { 'if-none-match': 'W/"0-0"' } });
        expect(stale.status).toBe(200);
    });

    it('the three served paths are exactly the three files the document loads', () => {
        expect([...SHELL_ASSET_FILES].map((f) => `/os/${f}`).sort()).toEqual(
            Object.values(OS_ASSET_PATHS).sort(),
        );
    });
});

// ── session ──────────────────────────────────────────────────────────────────

describe('/api/shell/session', () => {
    it('GET answers the read-only session payload', async () => {
        const res = await get(SHELL_API_ROUTES.session);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toContain('no-store');
        const body = (await res.json()) as {
            user: { id: string; email: string | null };
            computer: { id: string; name: string; slot: number; isNew: boolean } | null;
            apps: unknown[];
            desktopState: { configured: boolean; hasHmacSecret: boolean; status: string };
        };
        // `shell/ezil/session.js:133` — the ONE field every consumer
        // dereferences; a payload without a string `user.id` is rejected as
        // malformed and the desktop is never drawn.
        expect(typeof body.user.id).toBe('string');
        expect(body.user.email).toBeNull();
        expect(body.computer?.id).toBe(computerId());
        // The hosted GET passes `isNew: false` unconditionally
        // (`app/src/app/api/shell/session/route.ts:61`): reading a session never
        // created anything.
        expect(body.computer?.isNew).toBe(false);
        expect(body.apps).toEqual([...SHELL_APPS]);
        // `shell/ezil/apps/desktop-window.js:1106` renders the "not configured"
        // panel and stops unless this is exactly `true`.
        expect(body.desktopState.configured).toBe(true);
        // Local mode signs nothing. Zero readers in `shell/` — grepped.
        expect(body.desktopState.hasHmacSecret).toBe(false);
        // `boot-payload.ts`: "ALWAYS 'idle' at boot. The page never asks the
        // container anything."
        expect(body.desktopState.status).toBe('idle');
    });

    it('POST answers the full boot payload and moves lastOpenedAt', async () => {
        const res = await post(SHELL_API_ROUTES.session, {});
        expect(res.status).toBe(200);
        const body = (await res.json()) as { computer: { id: string; lastOpenedAt: string | null } };
        expect(body.computer.id).toBe(computerId());

        const after = (await (await get(SHELL_API_ROUTES.session)).json()) as {
            computer: { lastOpenedAt: string | null };
        };
        // Written by `markOpened()` on the POST path only, and a real ISO 8601
        // instant rather than "some truthy string".
        expect(typeof after.computer.lastOpenedAt).toBe('string');
        expect(Number.isFinite(Date.parse(after.computer.lastOpenedAt ?? ''))).toBe(true);
    });

    it('on a FRESH host: lastOpenedAt is null and isNew is true exactly once', async () => {
        // A second server, on its own ephemeral port and its own temp
        // workspace, so this is the real first-boot state rather than whatever
        // the shared harness has already done. Order-independent by
        // construction.
        const dir = await mkdtemp(join(tmpdir(), 'ezil-t1-fresh-'));
        const freshConfig = await loadConfig({
            EZIL_LOCAL_PORT: '0',
            EZIL_LOCAL_WORKSPACE: join(dir, 'workspace'),
            EZIL_LOCAL_STATE_DIR: join(dir, 'state'),
        });
        const fresh = await startLocalServer({
            config: freshConfig,
            host: new FakeSandboxHost(),
            probeFrame: () => Promise.resolve({ alive: true, reason: 'ok', status: 200 }),
            telemetrySink: async () => {},
        });
        try {
            const read = (await (await fetch(`${fresh.url}${SHELL_API_ROUTES.session}`)).json()) as {
                computer: { lastOpenedAt: string | null; isNew: boolean };
            };
            // Nothing has opened the desktop, and this host does not persist
            // across restarts. `null` is the honest answer; the hosted field is
            // "ISO 8601, or null if never opened".
            expect(read.computer.lastOpenedAt).toBeNull();
            // A READ never created anything, so it never claims to have — the
            // hosted GET passes `isNew: false` outright
            // (`app/src/app/api/shell/session/route.ts:61`).
            expect(read.computer.isNew).toBe(false);
            // 🔴 AND THE READ ABOVE MUST NOT HAVE SPENT THE LATCH. `isNew` is
            // "True only when THIS boot created the row" (`boot-payload.ts`),
            // this process DID create the workspace directory, and a status
            // poll arriving first must not be what makes the shell forget.
            // Caught by this assertion during development: the GET path shared
            // the consuming accessor and burned it.
            const created = (await (await fetch(`${fresh.url}${SHELL_API_ROUTES.session}`, { method: 'POST' })).json()) as {
                computer: { isNew: boolean };
            };
            expect(created.computer.isNew).toBe(true);
            // ...and every get-or-create after it does not.
            // `getOrCreateDefault` returns `created: true` once; a second
            // payload claiming the workspace is one second old would be the
            // same lie the field exists to prevent.
            const again = (await (await fetch(`${fresh.url}${SHELL_API_ROUTES.session}`, { method: 'POST' })).json()) as {
                computer: { isNew: boolean };
            };
            expect(again.computer.isNew).toBe(false);
        } finally {
            await fresh.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('a workspace that already existed is not new', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ezil-t1-existing-'));
        const ws = join(dir, 'workspace');
        await mkdir(ws, { recursive: true });
        const cfg = await loadConfig({
            EZIL_LOCAL_PORT: '0',
            EZIL_LOCAL_WORKSPACE: ws,
            EZIL_LOCAL_STATE_DIR: join(dir, 'state'),
        });
        const s = await startLocalServer({
            config: cfg,
            host: new FakeSandboxHost(),
            telemetrySink: async () => {},
        });
        try {
            const body = (await (await fetch(`${s.url}${SHELL_API_ROUTES.session}`, { method: 'POST' })).json()) as {
                computer: { isNew: boolean };
            };
            // The POSITIVE CONTROL for the case above: `mkdir(recursive)`
            // returns `undefined` when it created nothing, and that is the
            // whole `isNew` question asked of the filesystem.
            expect(body.computer.isNew).toBe(false);
        } finally {
            await s.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('the apps list matches the app\'s own SHELL_APPS exactly', async () => {
        // Imported, not retyped: `boot-payload.ts`'s SHELL_APPS is the SERVER's
        // declaration of what it can launch, and two copies is how they drift.
        const body = (await (await post(SHELL_API_ROUTES.session, {})).json()) as { apps: unknown[] };
        expect(body.apps).toEqual([...SHELL_APPS]);
    });
});

// ── desktop ──────────────────────────────────────────────────────────────────

describe('GET /api/shell/desktop — the cheap poll', () => {
    it('reports guacamoleRunning from the host\'s desktopReady', async () => {
        reset();
        const res = await get(`${SHELL_API_ROUTES.desktop}?computerId=${computerId()}`);
        expect(res.status).toBe(200);
        // `shell/ezil/session.js:695` — `res.data?.ok === true ?
        // res.data.guacamoleRunning : undefined`.
        const body = (await res.json()) as { ok: boolean; guacamoleRunning?: boolean };
        expect(body.ok).toBe(true);
        expect(body.guacamoleRunning).toBe(true);
    });

    it('🔴 a RUNNING container with a DEAD desktop is not running', async () => {
        reset();
        state.containerState = 'running';
        state.desktopReady = false;
        const body = (await (await get(`${SHELL_API_ROUTES.desktop}?computerId=${computerId()}`)).json()) as {
            ok: boolean;
            guacamoleRunning?: boolean;
            containerState: string;
        };
        // `docker run --publish` binds every port at container-create time, so
        // a port-derived or containerState-derived answer would say `true`
        // here. `sandbox-host.ts`: "a running container whose desktop died is
        // `running` + `false`, and reporting it as ready is the exact failure
        // `docs/PLATFORM-NOTES.md` §16 describes".
        expect(body.ok).toBe(true);
        expect(body.containerState).toBe('running');
        expect(body.guacamoleRunning).toBe(false);
        reset();
    });

    it('a host that could not answer omits guacamoleRunning rather than saying false', async () => {
        reset();
        state.ok = false;
        state.error = 'daemon_unreachable';
        const body = (await (await get(`${SHELL_API_ROUTES.desktop}?computerId=${computerId()}`)).json()) as
            Record<string, unknown>;
        expect(body['ok']).toBe(false);
        expect(body['error']).toBe('daemon_unreachable');
        // `session.js:697`'s comment: "`undefined` must NOT be read as `false`
        // — that would fabricate a negative signal we do not have." A `false`
        // on the wire here is exactly that fabrication.
        expect('guacamoleRunning' in body).toBe(false);
        reset();
    });

    it('does not wake anything: the poll only ever calls status()', async () => {
        reset();
        host.calls.length = 0;
        await get(`${SHELL_API_ROUTES.desktop}?computerId=${computerId()}`);
        // `SandboxHost.status`: "MUST NOT WAKE OR START ANYTHING. This is the
        // cheap poll the shell runs on a timer."
        expect(host.calls).toEqual([`status:${computerId()}`]);
    });

    it('confirm=frame reports the probe verdict', async () => {
        reset();
        const url = `${SHELL_API_ROUTES.desktop}?computerId=${computerId()}&confirm=frame&frameUrl=${encodeURIComponent(localUrlFor('desktop'))}`;
        // `session.js:625` — `res.data?.ok !== true` -> undefined, then
        // `res.data.confirmed === true`.
        const okBody = (await (await get(url)).json()) as { ok: boolean; confirmed: boolean };
        expect(okBody.ok).toBe(true);
        expect(okBody.confirmed).toBe(true);

        frameVerdict = { alive: false, reason: 'http_error', status: 500 };
        const badBody = (await (await get(url)).json()) as { ok: boolean; confirmed: boolean; status: number };
        expect(badBody.ok).toBe(true);
        expect(badBody.confirmed).toBe(false);
        expect(badBody.status).toBe(500);
        reset();
    });

    it('confirm=display answers unknown, well-formed', async () => {
        reset();
        const url = `${SHELL_API_ROUTES.desktop}?computerId=${computerId()}&confirm=display&frameUrl=x`;
        const body = (await (await get(url)).json()) as { ok: boolean; display: string };
        // `docs/PLATFORM-NOTES.md` §16b: the only thing that knows whether a
        // WebRTC peer is connected is neko's own `GET /api/sessions`, behind an
        // authenticated login. `SandboxHost` exposes no credential, so this
        // host CANNOT observe it — and §16b is explicit that a non-answer must
        // be `unknown` rather than `blank`, because collapsing it would show a
        // failure panel over every desktop that is streaming perfectly.
        //
        // Well-formed on purpose: `session.js:669`'s `confirmDisplay` also
        // returns 'unknown' for `ok !== true` or a missing field, so answering
        // `{ok:true, display:'unknown'}` is what proves this is the INTENDED
        // branch and not an accidental one.
        expect(body.ok).toBe(true);
        expect(body.display).toBe('unknown');
    });
});

describe('POST /api/shell/desktop — the cold boot', () => {
    it('returns the fields the shell reads on success', async () => {
        reset();
        const res = await post(SHELL_API_ROUTES.desktop, { computerId: computerId() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            ok: boolean;
            guacamoleUrl: string;
            frame: { confirmed: boolean };
            screen?: unknown;
        };
        expect(body.ok).toBe(true);
        // `session.js:479` — a non-empty string, else a `contract_violation`
        // telemetry event and `errorCode: unknown`.
        expect(typeof body.guacamoleUrl).toBe('string');
        expect(body.guacamoleUrl.length).toBeGreaterThan(0);
        expect(body.guacamoleUrl.startsWith(localUrlFor('desktop'))).toBe(true);
        // `session.js:492` — strict `=== true`, never defaulted.
        expect(body.frame.confirmed).toBe(true);
        // No screen was asked for, so the read-back is skipped entirely.
        expect(host.calls.some((c) => c.startsWith('readScreen:'))).toBe(false);
    });

    it('🔴 never says ready when SandboxHost.status does not', async () => {
        reset();
        state.desktopReady = false;
        const body = (await (await post(SHELL_API_ROUTES.desktop, { computerId: computerId() })).json()) as {
            ok: boolean;
            errorCode: string;
            error: string;
        };
        expect(body.ok).toBe(false);
        // `desktop_unreachable` is a code
        // `app/src/components/desktop/boot-phases.shell.js`'s `classifyFailure`
        // maps to its own honest copy and its own Retry button.
        expect(body.errorCode).toBe('desktop_unreachable');
        expect(body.error).toContain('host_status_not_ready');
        reset();
    });

    it('a frame that does not confirm is a failure with the observation attached', async () => {
        reset();
        frameVerdict = { alive: false, reason: 'http_error', status: 404 };
        const body = (await (await post(SHELL_API_ROUTES.desktop, { computerId: computerId() })).json()) as {
            ok: boolean;
            errorCode: string;
            error: string;
            frameReason: string;
            frameStatus: number;
        };
        expect(body.ok).toBe(false);
        expect(body.errorCode).toBe('desktop_unreachable');
        // The three fields the hosted answer added after "ten production
        // failures were indistinguishable from each other".
        expect(body.error).toBe('desktop_frame_http_error_404');
        expect(body.frameReason).toBe('http_error');
        expect(body.frameStatus).toBe(404);
        reset();
    });

    it('a host that refuses to start reports sandbox_start_failed, not a throw', async () => {
        reset();
        state.ensureThrows = 'image_not_present';
        const res = await post(SHELL_API_ROUTES.desktop, { computerId: computerId() });
        // A VALUE on a 200: `withWakeAndOneRetry` re-issues thrown/5xx answers,
        // and a deterministic failure re-asked is the same answer twice.
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; errorCode: string; error: string };
        expect(body.ok).toBe(false);
        expect(body.errorCode).toBe('sandbox_start_failed');
        expect(body.error).toBe('image_not_present');
        reset();
    });

    it('a requested screen is fitted, passed to the host, and READ BACK', async () => {
        reset();
        // 900 is not a multiple of 8 (Xvfb floors it to 896 and reports
        // success), so this exercises the fit AND the read-back.
        const body = (await (await post(SHELL_API_ROUTES.desktop, {
            computerId: computerId(),
            screen: { width: 900, height: 1600 },
        })).json()) as { ok: boolean; screen: { width: number; height: number; source: string } };
        expect(body.ok).toBe(true);
        expect(body.screen.width % 8).toBe(0);
        expect(body.screen.height % 2).toBe(0);
        expect(host.calls.some((c) => c.startsWith('readScreen:'))).toBe(true);
        // The ask was 900x1600 and the applied size is not, so the honest word
        // is `snapped`, never `requested`.
        expect(body.screen.source).toBe('snapped');
        reset();
    });

    it('an unverified read-back downgrades requested to snapped', async () => {
        reset();
        state.screen = { width: 1280, height: 720, verified: false };
        const body = (await (await post(SHELL_API_ROUTES.desktop, {
            computerId: computerId(),
            screen: { width: 1280, height: 720 },
        })).json()) as { screen: { source: string } };
        // `ScreenResult`: "`verified: false` MEANS THE NUMBERS ARE THE ASK, NOT
        // THE ANSWER." "We set it and could not check" is not "you got what you
        // asked for".
        expect(body.screen.source).toBe('snapped');
        reset();
    });

    it('carries no expiresAt: there is no token and no TTL', async () => {
        reset();
        const body = (await (await post(SHELL_API_ROUTES.desktop, { computerId: computerId() })).json()) as
            Record<string, unknown>;
        expect('expiresAt' in body).toBe(false);
    });
});

// ── preview-url / code-preview-url ───────────────────────────────────────────

describe('the two window-minting routes', () => {
    it('answer the loopback origins the shell navigates to', async () => {
        reset();
        const app = (await (await post(SHELL_API_ROUTES.previewUrl, { computerId: computerId() })).json()) as {
            ok: boolean;
            appPreviewUrl: string;
        };
        // `session.js:552` — `typeof data.appPreviewUrl !== 'string' || === ''`
        // is a `contract_violation`.
        expect(app.ok).toBe(true);
        expect(app.appPreviewUrl).toBe(localUrlFor('appPreview'));

        const code = (await (await post(SHELL_API_ROUTES.codePreviewUrl, { computerId: computerId() })).json()) as {
            ok: boolean;
            codePreviewUrl: string;
        };
        // `apps/code.js:194` — same rule for `codePreviewUrl`.
        expect(code.ok).toBe(true);
        expect(code.codePreviewUrl).toBe(localUrlFor('code'));
    });

    it('refuse when there is no container, rather than handing over a dead port', async () => {
        reset();
        state.containerState = 'absent';
        const app = (await (await post(SHELL_API_ROUTES.previewUrl, { computerId: computerId() })).json()) as {
            ok: boolean;
            errorCode: string;
        };
        expect(app.ok).toBe(false);
        expect(app.errorCode).toBe('app_preview_unavailable');
        const code = (await (await post(SHELL_API_ROUTES.codePreviewUrl, { computerId: computerId() })).json()) as {
            ok: boolean;
            errorCode: string;
        };
        expect(code.ok).toBe(false);
        expect(code.errorCode).toBe('code_preview_unavailable');
        reset();
    });
});

// ── focus ────────────────────────────────────────────────────────────────────

describe('/api/shell/focus', () => {
    it('accepts exactly the app layer\'s narrowed enum', async () => {
        // 🔴 PINNED TO THE APP'S SOURCE TEXT, not to a copy of the list. The
        // technique `../container/run-spec.test.ts` already uses for its own
        // cross-package twin: read the upstream declaration and compare.
        const provider = await readFile(
            join(config.parentRoot, 'app', 'src', 'server', 'lib', 'cloudflare-guacamole-provider.ts'),
            'utf8',
        );
        const match = /export const FOCUSABLE_APPS = \[([^\]]*)\] as const;/.exec(provider);
        expect(match).not.toBeNull();
        const upstream = (match?.[1] ?? '')
            .split(',')
            .map((s) => s.trim().replace(/^'|'$/g, ''))
            .filter((s) => s !== '');
        expect(upstream).toEqual([...LOCAL_FOCUSABLE_APPS] as string[]);
    });

    it('returns { ok, app, correlationId } for an accepted app', async () => {
        reset();
        const res = await post(SHELL_API_ROUTES.focus, { computerId: computerId(), app: 'chromium' });
        expect(res.status).toBe(200);
        // `session.js:614` — `res.data?.ok === true` and nothing else.
        const body = (await res.json()) as { ok: boolean; app: string; correlationId: string };
        expect(body.ok).toBe(true);
        expect(body.app).toBe('chromium');
        expect(typeof body.correlationId).toBe('string');
    });

    it('a refused focus is ok:false on a 200, not an exception', async () => {
        reset();
        state.focusOk = false;
        const res = await post(SHELL_API_ROUTES.focus, { computerId: computerId(), app: 'chromium' });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
        reset();
    });

    it('rejects an app outside the narrowed enum with a 400', async () => {
        reset();
        // `vscode` is legal in the PRIMITIVE enum (`run-spec.ts`'s FOCUS_APPS)
        // and refused here, because it has no X window in today's image and the
        // switch would always fail.
        const res = await post(SHELL_API_ROUTES.focus, { computerId: computerId(), app: 'vscode' });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('BAD_REQUEST');
    });
});

// ── telemetry ────────────────────────────────────────────────────────────────

describe('/api/shell/telemetry', () => {
    it('always answers 202 with no body', async () => {
        reset();
        const res = await post(SHELL_API_ROUTES.telemetry, {
            schemaVersion: 1,
            events: [{ eventClass: 'window_error', site: 'x', code: 'y' }],
        });
        // The hosted route: "ALWAYS 202, whatever happens... The client has
        // nothing to branch on."
        expect(res.status).toBe(202);
        expect((await res.arrayBuffer()).byteLength).toBe(0);
        expect(res.headers.get('cache-control')).toContain('no-store');
    });

    it('writes the batch to the local sink and never anywhere else', async () => {
        reset();
        telemetry.length = 0;
        await post(SHELL_API_ROUTES.telemetry, { schemaVersion: 1, events: [{ code: 'a' }, { code: 'b' }] });
        expect(telemetry.length).toBe(1);
        const record = telemetry[0] as { events: unknown[]; schemaVersion: number };
        expect(record.events.length).toBe(2);
        expect(record.schemaVersion).toBe(1);
    });

    it('a malformed body is still a 202 and writes nothing', async () => {
        reset();
        telemetry.length = 0;
        const res = await fetch(`${base()}${SHELL_API_ROUTES.telemetry}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'not json at all',
        });
        expect(res.status).toBe(202);
        expect(telemetry.length).toBe(0);
    });

    it('caps a batch at the upstream MAX_EVENTS_PER_BATCH', async () => {
        reset();
        telemetry.length = 0;
        await post(SHELL_API_ROUTES.telemetry, {
            schemaVersion: 1,
            events: Array.from({ length: 120 }, (_, i) => ({ code: `e${i}` })),
        });
        // `TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH` = 50
        // (`app/src/server/telemetry/types.ts:114`).
        expect((telemetry[0] as { events: unknown[] }).events.length).toBe(50);
    });
});

// ── restart ──────────────────────────────────────────────────────────────────

describe('/api/shell/restart', () => {
    it('a successful restart is ok:true', async () => {
        reset();
        const body = (await (await post(SHELL_API_ROUTES.restart, { computerId: computerId() })).json()) as {
            ok: boolean;
        };
        // `session.js:758` — `data.ok !== true` is a failure with
        // `data.errorCode`; `{ok:true}` is the only success.
        expect(body.ok).toBe(true);
    });

    it('maps every RestartErrorCode onto a code troubleshoot.js renders', async () => {
        reset();
        const troubleshoot = await readFile(
            join(config.parentRoot, 'shell', 'ezil', 'ui', 'Settings', 'tabs', 'troubleshoot.js'),
            'utf8',
        );
        const cases: Array<[string, string]> = [
            ['stop_timed_out', 'stop_timed_out'],
            ['boot_failed', 'boot_failed'],
            ['in_progress', 'restart_in_progress'],
            ['not_running', 'bad_request'],
            ['runtime_error', 'fetch_failed'],
        ];
        for (const [hostCode, wireCode] of cases) {
            state.restart = { ok: false, errorCode: hostCode as never, detail: '/home/someone/secret/path' };
            const body = (await (await post(SHELL_API_ROUTES.restart, { computerId: computerId() })).json()) as {
                ok: boolean;
                errorCode: string;
            };
            expect(`${hostCode} -> ${body.errorCode}`).toBe(`${hostCode} -> ${wireCode}`);
            // Every emitted code has real copy in `reasonCopy()`, so none of
            // them falls through to "Something went wrong."
            expect(troubleshoot).toContain(`case '${wireCode}':`);
            // 🔴 The adapter's free-text detail never reaches the DOM: it can
            // carry a filesystem path, and this value is RENDERED.
            expect(JSON.stringify(body)).not.toContain('/home/someone/secret/path');
        }
        reset();
    });
});

// ── activity ─────────────────────────────────────────────────────────────────

describe('/api/shell/activity', () => {
    it('records presence and never touches the container', async () => {
        reset();
        host.calls.length = 0;
        const res = await post(SHELL_API_ROUTES.activity, { computerId: computerId(), lastInputAgoMs: 1500 });
        expect(res.status).toBe(200);
        // `session.js:820` — `res.data?.ok === true`.
        expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
        // The hosted comment: the heartbeat that exists so an idle container
        // can sleep must not itself be what keeps waking it up.
        expect(host.calls).toEqual([]);
        expect(server.computer.presenceAt()).not.toBeNull();
    });

    it('rejects a non-finite or negative lastInputAgoMs with a 400', async () => {
        reset();
        for (const bad of [-1, 'soon', null]) {
            const res = await post(SHELL_API_ROUTES.activity, { computerId: computerId(), lastInputAgoMs: bad });
            expect(`${String(bad)} -> ${res.status}`).toBe(`${String(bad)} -> 400`);
        }
        // POSITIVE CONTROL: 0 is legal (`z.number().finite().nonnegative()`).
        const ok = await post(SHELL_API_ROUTES.activity, { computerId: computerId(), lastInputAgoMs: 0 });
        expect(ok.status).toBe(200);
    });
});

// ── screen ───────────────────────────────────────────────────────────────────

describe('/api/shell/screen', () => {
    it('GET observes without changing anything', async () => {
        reset();
        host.calls.length = 0;
        const body = (await (await get(`${SHELL_API_ROUTES.screen}?computerId=${computerId()}`)).json()) as {
            ok: boolean;
            width: number;
            height: number;
            source: string;
        };
        // `session.js:990` — integers, else `UPSTREAM`; `data.source ??
        // 'observed'`.
        expect(body.ok).toBe(true);
        expect(Number.isInteger(body.width)).toBe(true);
        expect(body.source).toBe('observed');
        expect(host.calls.some((c) => c.startsWith('setScreen:'))).toBe(false);
    });

    it('GET reports a read-back it could not verify as a failure, not as observed', async () => {
        reset();
        state.screen = { width: 1920, height: 1080, verified: false };
        const body = (await (await get(`${SHELL_API_ROUTES.screen}?computerId=${computerId()}`)).json()) as {
            ok: boolean;
            error: { code: string; message: string };
        };
        expect(body.ok).toBe(false);
        expect(body.error.message).toBe('screen_not_verified');
        reset();
    });

    it('POST fits the ask and reports the read-back', async () => {
        reset();
        const body = (await (await post(SHELL_API_ROUTES.screen, {
            computerId: computerId(),
            width: 1280,
            height: 720,
        })).json()) as { ok: boolean; width: number; height: number; source: string };
        expect(body.ok).toBe(true);
        expect(body.width).toBe(1280);
        expect(body.height).toBe(720);
        // Exactly the two values the live-resize contract allows.
        expect(['requested', 'snapped']).toContain(body.source);
        expect(body.source).toBe('requested');
        reset();
    });

    it('POST snaps a misaligned ask rather than passing it to X', async () => {
        reset();
        const body = (await (await post(SHELL_API_ROUTES.screen, {
            computerId: computerId(),
            width: 900,
            height: 1601,
        })).json()) as { ok: boolean; width: number; height: number; source: string };
        expect(body.ok).toBe(true);
        // `assertUsableScreen` in `../container/run-spec.ts` THROWS on a width
        // that is not a multiple of 8 or an odd height. Fitting here is what
        // keeps that from ever being reachable.
        expect(body.width % 8).toBe(0);
        expect(body.height % 2).toBe(0);
        expect(body.source).toBe('snapped');
        reset();
    });

    it('POST refuses an unusable measurement as a VALUE, not a 404', async () => {
        reset();
        for (const bad of [{ width: 0, height: 720 }, { width: 1280, height: 1.5 }, { width: 'x', height: 720 }]) {
            const res = await post(SHELL_API_ROUTES.screen, { computerId: computerId(), ...bad });
            // 🔴 NOT 404/405: `session.js:1013` treats those as UNSUPPORTED and
            // DISARMS the resize path permanently. A bad measurement must stay
            // retryable after the next drag.
            expect(res.status).toBe(200);
            const body = (await res.json()) as { ok: boolean; error: { code: string } };
            expect(body.ok).toBe(false);
            expect(body.error.code).toBe('BAD_REQUEST');
        }
    });
});

// ── The gate, methods and unknown routes ─────────────────────────────────────

describe('boundary behaviour', () => {
    it('every computerId-bearing route rejects a foreign id with 404', async () => {
        reset();
        const foreign = 'local-0000000000000000';
        expect(foreign).not.toBe(computerId());
        const responses = await Promise.all([
            get(`${SHELL_API_ROUTES.desktop}?computerId=${foreign}`),
            post(SHELL_API_ROUTES.desktop, { computerId: foreign }),
            post(SHELL_API_ROUTES.previewUrl, { computerId: foreign }),
            post(SHELL_API_ROUTES.codePreviewUrl, { computerId: foreign }),
            post(SHELL_API_ROUTES.focus, { computerId: foreign, app: 'chromium' }),
            post(SHELL_API_ROUTES.restart, { computerId: foreign }),
            post(SHELL_API_ROUTES.activity, { computerId: foreign, lastInputAgoMs: 1 }),
            get(`${SHELL_API_ROUTES.screen}?computerId=${foreign}`),
            post(SHELL_API_ROUTES.screen, { computerId: foreign, width: 1280, height: 720 }),
        ]);
        for (const res of responses) expect(res.status).toBe(404);
        // The hosted `assertOwnedComputer` surfaces as tRPC NOT_FOUND -> 404,
        // so the shell's branches are unchanged.
        const body = (await responses[0]!.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
        // POSITIVE CONTROL: the same requests with the real id are not 404.
        const good = await get(`${SHELL_API_ROUTES.desktop}?computerId=${computerId()}`);
        expect(good.status).toBe(200);
    });

    it('an unknown path is a 404 with a JSON error body', async () => {
        const res = await get('/api/shell/nope');
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });

    it('a wrong method on a known path is a 405, not a 404', async () => {
        // `session.js#getScreen` treats 404 AND 405 as UNSUPPORTED, so either is
        // survivable — but a POST-only route answering 404 to a GET would be
        // indistinguishable from the route not existing.
        const res = await get(SHELL_API_ROUTES.focus);
        expect(res.status).toBe(405);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('METHOD_NOT_SUPPORTED');
    });

    it('/ redirects to /os with a real 302, which the browser follows as a document load', async () => {
        const res = await fetch(`${base()}/`, { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(`${base()}/os`);
    });

    it('a body over the cap is refused before it is parsed', async () => {
        const res = await fetch(`${base()}${SHELL_API_ROUTES.focus}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ computerId: computerId(), app: 'chromium', pad: 'x'.repeat(70_000) }),
        });
        expect(res.status).toBe(413);
    });
});

// ── The frame probe's origin pin ─────────────────────────────────────────────

describe('the frame probe only ever fetches our own desktop origin', () => {
    it('accepts the desktop origin and nothing else', () => {
        // 🔴 `frameUrl` ARRIVES FROM THE BROWSER. Without this pin the local
        // host is an SSRF gadget: any page the user has open can aim a
        // no-preflight cross-origin GET at `/api/shell/desktop?confirm=frame`
        // and have this process fetch an arbitrary address on the user's LAN,
        // then read the verdict back. The hosted route pins the same value
        // inside the procedure (`isOwnDesktopOrigin`).
        expect(isOwnDesktopOrigin(localUrlFor('desktop'))).toBe(true);
        expect(isOwnDesktopOrigin(`${localUrlFor('desktop')}/?usr=EZiL&embed=1`)).toBe(true);
        for (const foreign of [
            localUrlFor('code'),          // a different port on the same host
            'http://192.168.1.9:8181/',   // the LAN
            'http://169.254.169.254/',    // a cloud metadata service
            'file:///etc/passwd',
            'not a url',
            '',
        ]) {
            expect(`${foreign} -> ${String(isOwnDesktopOrigin(foreign))}`).toBe(`${foreign} -> false`);
        }
    });

    it('refuses a foreign origin WITHOUT making the request', async () => {
        // A port nothing is listening on: if the probe fetched it we would get
        // `unreachable` after a connect attempt. `foreign_origin` is only
        // reachable from the pin, before any socket is opened.
        const verdict = await probeDesktopOrigin('http://127.0.0.1:1/');
        expect(verdict.reason).toBe('foreign_origin');
        expect(verdict.alive).toBe(false);
    });

    it('POSITIVE CONTROL: the probe really does make a request for its own origin', async () => {
        // Without this, `foreign_origin` above could just as well be a probe
        // that never does anything at all.
        const verdict = await probeDesktopOrigin(localUrlFor('desktop'));
        // Nothing is serving the desktop port in this suite, so the honest
        // answer is a failed connection — NOT `foreign_origin`, and never
        // `alive`.
        expect(verdict.reason).not.toBe('foreign_origin');
        expect(verdict.alive).toBe(false);
    });
});
