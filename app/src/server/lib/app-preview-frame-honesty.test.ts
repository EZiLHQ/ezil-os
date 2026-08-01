/**
 * THE SECOND PROOF: the frame-honesty contract, applied to the APP-PREVIEW and
 * CODE-SERVER bridge origins, must not invert into a false NEGATIVE.
 *
 * ── Why this file exists, and why it is separate from `desktop-frame-honesty` ─
 * `desktop-frame-honesty.test.ts` proves the contract cannot report ready over
 * an HTTP 500. That contract was written against ONE origin: the Neko desktop
 * host, whose URL carries a credential in `?pwd=` and whose document lives at
 * `/`. Wave A added two more origins behind the same `confirmFrame` call —
 * the app-preview bridge (`<APP_PREVIEW_PORT>-<sandbox>-app.<zone>`) and the
 * code-server bridge (`<CODE_PREVIEW_PORT>-<sandbox>-code.<zone>`) — and those
 * are shaped the opposite way round:
 *
 *   https://3002-<sandbox>-app.<zone>/preview-bootstrap?token=t=<ts>,v1=<hmac>
 *                                     └── the document ──┘└── the credential ─┘
 *
 * The desktop rule "drop the query, keep origin+path" is exactly right for the
 * desktop and exactly wrong here: dropping the query removes the ONLY thing
 * that makes `/preview-bootstrap` answer anything but `401`
 * (`worker/src/preview-bridge.ts` `handlePreviewBootstrap`). A working preview
 * would then be refused as "not answering", permanently, for every user, on
 * every open — a false negative that looks like caution and is just as
 * dishonest as the false positive the contract was built to stop.
 *
 * ── What is proven here, in BOTH directions ─────────────────────────────────
 * With REAL HTTP servers standing in for the Worker's bridge host, answering
 * the way `handlePreviewBootstrap` / `handlePreviewProxy` actually answer:
 *
 *   1. a healthy bridge  -> `confirmed: true`  -> the boot panel reaches `ready`
 *   2. a 500 bridge      -> `confirmed: false` -> `failed`, exactly as before
 *   3. an EXPIRED token  -> `confirmed: false` -> `failed` (401 is still an
 *      error page, and the user really would see JSON in the frame)
 *   4. the desktop URL's `?pwd=` is STILL stripped — widening for the bridge
 *      must not loosen the credential-hygiene rule it was built for.
 *
 * One direction alone is not evidence: (1) without (2) is a rubber stamp,
 * (2) without (1) is the bug this file exists to prevent.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeBootUiState } from '@/components/desktop/boot-phases';
// The SHELL's shipped module. A proof that re-implements the client proves
// nothing about the client — same reasoning as `desktop-frame-honesty.test.ts`.
import shellSession from '../../../../shell/ezil/session.js';
import {
    APP_PREVIEW_PORT,
    APP_PREVIEW_TOKEN,
    isOwnDesktopOrigin,
    probeDesktopFrame,
    type DesktopFrameProbe,
} from './cloudflare-guacamole-provider';

/** What the user's dev server actually renders, once the bridge lets it through. */
const APP_HTML = '<!doctype html><html><body><div id="root">the user\'s app</div></body></html>';

/** The body the live preview host returned on 2026-07-31. */
const PROXY_ROUTING_ERROR = 'Proxy routing error';

/** Stands in for a real minted `t=<ts>,v1=<hmac>` — opaque to everything under test. */
const GOOD_TOKEN = 't=1754006400000,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const STALE_TOKEN = 't=1700000000000,v1=0000000000000000000000000000000000000000000000000000000000000000';

/** The cookie value `handlePreviewBootstrap` mints and echoes as `?ezil_pv=`. */
const MINTED_COOKIE = 'sig.for.this.sandbox';

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

/**
 * A stand-in for `worker/src/preview-bridge.ts`'s two handlers, reproducing
 * the three behaviours this proof depends on and nothing else:
 *
 *   `/preview-bootstrap` with a good token -> 302 to `/preview/?ezil_pv=<cookie>`
 *   `/preview-bootstrap` without one       -> 401 (this is the false-negative trap)
 *   `/preview/` with `?ezil_pv=<cookie>`   -> 200, the user's app
 *   `/preview/` without it                 -> 401
 */
function makeBridge(hits: string[]): Server {
    return createServer((req, res) => {
        const raw = req.url ?? '/';
        hits.push(raw);
        const url = new URL(raw, 'http://bridge.invalid');

        if (url.pathname === '/preview-bootstrap') {
            if (url.searchParams.get('token') !== GOOD_TOKEN) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'preview_bootstrap_token_expired' }));
                return;
            }
            res.writeHead(302, { location: `/preview/?ezil_pv=${MINTED_COOKIE}` });
            res.end();
            return;
        }

        if (url.pathname.startsWith('/preview')) {
            if (url.searchParams.get('ezil_pv') !== MINTED_COOKIE) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'preview_cookie_missing_or_invalid' }));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(APP_HTML);
            return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `not_found: ${url.pathname}` }));
    });
}

describe('the app-preview bridge: a HEALTHY frame must confirm, and a broken one must not', () => {
    let bridge: Server;
    let bridgeUrl: string;
    let broken: Server;
    let brokenUrl: string;
    let desktop: Server;
    let desktopUrl: string;
    const bridgeHits: string[] = [];
    const desktopHits: string[] = [];

    beforeAll(async () => {
        bridge = makeBridge(bridgeHits);
        bridgeUrl = await listen(bridge);

        broken = createServer((_req, res) => {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(PROXY_ROUTING_ERROR);
        });
        brokenUrl = await listen(broken);

        // The Neko desktop origin, unchanged: its document is at `/` and its
        // credential is in the query.
        desktop = createServer((req, res) => {
            desktopHits.push(req.url ?? '');
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><html><body><div id="neko"></div></body></html>');
        });
        desktopUrl = await listen(desktop);
    });

    afterAll(async () => {
        await close(bridge);
        await close(broken);
        await close(desktop);
    });

    // ── DIRECTION 1: healthy confirms ────────────────────────────────────────

    it('🔴 DIRECTION 1 — a healthy bridge, probed at its real bootstrap URL, is alive', async () => {
        bridgeHits.length = 0;
        const probe = await probeDesktopFrame(`${bridgeUrl}/preview-bootstrap?token=${GOOD_TOKEN}`);
        expect(probe).toEqual({ alive: true, status: 200 });

        // Real traffic, and the WHOLE flow: the bootstrap answered, the probe
        // followed the redirect, and the proxied app answered 200. A probe
        // that stopped at the 302 would show only one hit here.
        expect(bridgeHits).toEqual([
            `/preview-bootstrap?token=${GOOD_TOKEN}`,
            `/preview/?ezil_pv=${MINTED_COOKIE}`,
        ]);
    });

    it('🔴 DIRECTION 1, whole chain — the shell renders `ready` over a healthy preview', async () => {
        const state = await driveShellChain(`${bridgeUrl}/preview-bootstrap?token=${GOOD_TOKEN}`);
        expect(state.confirmed).toBe(true);
        expect(state.ui).toEqual({ kind: 'ready' });
    });

    // ── DIRECTION 2: broken is still refused ─────────────────────────────────

    it('🔴 DIRECTION 2 — a bridge returning 500 is NOT alive, token or no token', async () => {
        expect(await probeDesktopFrame(`${brokenUrl}/preview-bootstrap?token=${GOOD_TOKEN}`)).toEqual({
            alive: false,
            reason: 'http_error',
            status: 500,
        });
    });

    it('🔴 DIRECTION 2, whole chain — the shell renders `failed` over a 500 preview', async () => {
        const state = await driveShellChain(`${brokenUrl}/preview-bootstrap?token=${GOOD_TOKEN}`);
        expect(state.confirmed).toBe(false);
        expect(state.ui).toEqual({ kind: 'failed', reason: 'desktop_unreachable' });
    });

    it('an EXPIRED bootstrap token is refused — 401 is an error page the user would really see', async () => {
        const probe = await probeDesktopFrame(`${bridgeUrl}/preview-bootstrap?token=${STALE_TOKEN}`);
        expect(probe).toEqual({ alive: false, reason: 'http_error', status: 401 });
        const state = await driveShellChain(`${bridgeUrl}/preview-bootstrap?token=${STALE_TOKEN}`);
        expect(state.ui).toEqual({ kind: 'failed', reason: 'desktop_unreachable' });
    });

    it('a bridge host that does not answer at all is not a confirmation either', async () => {
        const probe = await probeDesktopFrame('http://127.0.0.1:1/preview-bootstrap?token=x', 2_000);
        expect(probe.alive).toBe(false);
    });

    // ── the hygiene rule the widening must NOT loosen ────────────────────────

    it('the DESKTOP url still has its query stripped — `?pwd=` never reaches the wire', async () => {
        desktopHits.length = 0;
        await probeDesktopFrame(`${desktopUrl}/?usr=EZiL&pwd=deadbeefdeadbeefdeadbeefdeadbeef&embed=1`);
        expect(desktopHits).toEqual(['/']);
        expect(desktopHits.join('')).not.toContain('pwd');
    });

    it('only `/preview-bootstrap` keeps its query — any other path on the bridge is still stripped', async () => {
        bridgeHits.length = 0;
        // `/preview/` carries the cookie fallback, which is a credential too.
        // Nothing composes such a URL for the frame, and if anything ever does
        // it must not smuggle the value through the probe.
        await probeDesktopFrame(`${bridgeUrl}/preview/?ezil_pv=${MINTED_COOKIE}`);
        expect(bridgeHits).toEqual(['/preview/']);
    });

    /**
     * The real chain the browser walks, with only authentication faked:
     * a stand-in for `GET /api/shell/desktop?confirm=frame` that runs the REAL
     * `probeDesktopFrame`, driven by the SHIPPED `shell/ezil/session.js`, whose
     * answer is fed to the REAL `computeBootUiState`.
     */
    async function driveShellChain(frameUrl: string) {
        const app = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://internal');
            void (async () => {
                const probe: DesktopFrameProbe = await probeDesktopFrame(url.searchParams.get('frameUrl') ?? '');
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify(
                        probe.alive
                            ? { ok: true, confirmed: true, status: probe.status }
                            : { ok: true, confirmed: false, reason: probe.reason, status: probe.status },
                    ),
                );
            })();
        });
        const appUrl = await listen(app);
        try {
            (globalThis as unknown as { window: unknown }).window = {
                __EZIL_BOOT__: {
                    user: { id: '00000000-0000-4000-8000-000000000001' },
                    desktopState: { endpoints: { desktop: `${appUrl}/api/shell/desktop` } },
                },
            };
            const confirmed = await shellSession.confirmFrame(
                '00000000-0000-4000-8000-000000000002',
                frameUrl,
            );
            return {
                confirmed,
                ui: computeBootUiState({ requestStatus: 'success', elapsedMs: 0, frameConfirmed: confirmed }),
            };
        } finally {
            delete (globalThis as unknown as { window?: unknown }).window;
            await close(app);
        }
    }
});

/**
 * The SSRF pin, for the two origins Wave A added.
 *
 * T4's report predicted these would be refused ("`isOwnDesktopOrigin` … is
 * scoped to the DESKTOP origin today … a healthy preview will be refused as
 * unconfirmed forever"). That prediction is WRONG — the pin is deliberately
 * port- and token-agnostic, so it already accepts them. These tests exist so
 * that stays true: a future "tightening" that pins the port would silently
 * reproduce exactly the failure T4 predicted, and it must fail here loudly
 * instead.
 */
describe('isOwnDesktopOrigin — the bridge origins are inside the pin, and foreign ones are not', () => {
    const SANDBOX = 'guac-abc123def456-789xyz012345';
    const WORKER_HOST = 'os.ezil.org';

    it('accepts the app-preview origin, composed exactly as the provider composes it', () => {
        const host = `${APP_PREVIEW_PORT}-${SANDBOX}-${APP_PREVIEW_TOKEN}.ezil.org`;
        expect(isOwnDesktopOrigin(WORKER_HOST, SANDBOX, `https://${host}/preview-bootstrap?token=t=1,v1=a`)).toBe(
            true,
        );
    });

    it('accepts the code-server origin (worker/src/desktop-mode.ts CODE_PREVIEW_PORT/TOKEN)', () => {
        expect(
            isOwnDesktopOrigin(WORKER_HOST, SANDBOX, `https://8443-${SANDBOX}-code.ezil.org/preview-bootstrap?token=t=1,v1=a`),
        ).toBe(true);
    });

    it('accepts them on the un-collapsed Worker host too', () => {
        expect(
            isOwnDesktopOrigin(WORKER_HOST, SANDBOX, `https://3002-${SANDBOX}-app.os.ezil.org/preview-bootstrap`),
        ).toBe(true);
    });

    it('still refuses another user’s app-preview host on our own zone', () => {
        expect(
            isOwnDesktopOrigin(WORKER_HOST, SANDBOX, 'https://3002-guac-someoneelse-0000-app.ezil.org/preview-bootstrap'),
        ).toBe(false);
    });

    it('still refuses our own app-preview label parked on somebody else’s domain', () => {
        expect(isOwnDesktopOrigin(WORKER_HOST, SANDBOX, `https://3002-${SANDBOX}-app.evil.com/preview-bootstrap`)).toBe(
            false,
        );
    });

    it('the widening is not a loosening — the classic SSRF targets are still refused', () => {
        for (const target of [
            'http://169.254.169.254/preview-bootstrap?token=x',
            'http://localhost:8787/preview-bootstrap?token=x',
            'http://127.0.0.1/preview-bootstrap',
            'file:///etc/passwd',
        ]) {
            expect(isOwnDesktopOrigin(WORKER_HOST, SANDBOX, target)).toBe(false);
        }
    });
});
