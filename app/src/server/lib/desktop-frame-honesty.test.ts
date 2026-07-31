/**
 * THE PROOF: it must not be possible to report "ready" over an HTTP 500.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * On 2026-07-31 the container preview host started returning
 * `HTTP 500 "Proxy routing error"`. Both of this app's surfaces reported
 * success over it: the shell set `data-kind="ready"` and hid its boot panel on
 * the iframe's `load` event, and `/computer/[id]` showed a green "Live" pill.
 * The honesty contract covered the boot; it did not cover the frame that landed
 * after it.
 *
 * ── Why nothing that already existed could have caught it ───────────────────
 * The iframe `load` event fires for a 500 error page exactly as it does for a
 * working desktop, and cross-origin script can read neither the status code nor
 * the document. The Worker's `guacamoleRunning` is derived from
 * `sandbox.getExposedPorts()`, which reads Durable Object storage and never
 * crosses the edge — a registered port behind a broken edge route reports
 * healthy indefinitely, which is exactly what was observed alongside the 500.
 *
 * ── How this file proves the fix ────────────────────────────────────────────
 * With a REAL HTTP server, not a stubbed `fetch`. One server answers 500 with
 * the observed body; another stands in for this app's own
 * `GET /api/shell/desktop?confirm=frame` handler and calls the real
 * `probeDesktopFrame`. The shell's own `session.js` — the shipped module, not a
 * copy — is pointed at it, and its answer is fed through the real
 * `computeBootUiState`.
 *
 * So the chain under test is the whole one the user's browser walks:
 *
 *   a URL that 500s
 *     -> probeDesktopFrame            (server)
 *     -> the confirm route's response  (wire)
 *     -> session.confirmFrame          (shell)
 *     -> computeBootUiState            (shell)
 *     -> the state the boot panel renders
 *
 * and the assertion at the end of it is that the state is NOT `ready`.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeBootUiState } from '@/components/desktop/boot-phases';
// The SHELL's shipped module, imported across the tree on purpose: a proof that
// re-implements the client's parsing proves nothing about the client.
import shellSession from '../../../../shell/ezil/session.js';
import {
    isOwnDesktopOrigin,
    probeDesktopFrame,
    type DesktopFrameProbe,
} from './cloudflare-guacamole-provider';

/** The body the live preview host actually returned. */
const PROXY_ROUTING_ERROR = 'Proxy routing error';

/** A minimal Neko-shaped 200, for the control case. */
const DESKTOP_HTML = '<!doctype html><html><body><div id="neko"></div></body></html>';

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

describe('a desktop host that returns 500 cannot be reported ready', () => {
    let broken: Server;
    let brokenUrl: string;
    let working: Server;
    let workingUrl: string;
    /** Every path the broken host was asked for — proof the probe is real traffic. */
    const brokenHits: string[] = [];

    beforeAll(async () => {
        broken = createServer((req, res) => {
            brokenHits.push(req.url ?? '');
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(PROXY_ROUTING_ERROR);
        });
        brokenUrl = await listen(broken);

        working = createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(DESKTOP_HTML);
        });
        workingUrl = await listen(working);
    });

    afterAll(async () => {
        await close(broken);
        await close(working);
    });

    it('probeDesktopFrame reports the 500 as not alive, with the status it saw', async () => {
        const probe = await probeDesktopFrame(`${brokenUrl}/`);
        expect(probe).toEqual({ alive: false, reason: 'http_error', status: 500 });
        // Real traffic, not a stub: the server recorded the request.
        expect(brokenHits.length).toBeGreaterThan(0);
    });

    it('and reports a host that actually answers as alive — the check is not just "always no"', async () => {
        expect(await probeDesktopFrame(`${workingUrl}/`)).toEqual({ alive: true, status: 200 });
    });

    it('never puts the desktop credential in the probe URL', async () => {
        brokenHits.length = 0;
        // What `composeBrowserDesktopUrl` produces: the per-sandbox Neko
        // credential rides in the query string.
        await probeDesktopFrame(`${brokenUrl}/?usr=EZiL&pwd=deadbeefdeadbeefdeadbeefdeadbeef&embed=1`);
        expect(brokenHits).toEqual(['/']);
        expect(brokenHits.join('')).not.toContain('pwd');
    });

    it('🔴 THE PROOF — the whole shell chain, over a real 500, does not claim ready', async () => {
        // A stand-in for this app's own confirm route. It runs the REAL
        // `probeDesktopFrame` and answers in the real wire shape, so the only
        // thing being faked here is authentication.
        const app = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://internal');
            void (async () => {
                const frameUrl = url.searchParams.get('frameUrl') ?? '';
                const probe: DesktopFrameProbe = await probeDesktopFrame(frameUrl);
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
            // Point the SHIPPED shell module at it, the way the page does: the
            // endpoint map comes off `window.__EZIL_BOOT__`.
            (globalThis as unknown as { window: unknown }).window = {
                __EZIL_BOOT__: {
                    user: { id: '00000000-0000-4000-8000-000000000001' },
                    desktopState: { endpoints: { desktop: `${appUrl}/api/shell/desktop` } },
                },
            };

            const confirmed = await shellSession.confirmFrame(
                '00000000-0000-4000-8000-000000000002',
                `${brokenUrl}/?usr=EZiL&pwd=secret&embed=1`,
            );

            // The shell's own answer about the frame.
            expect(confirmed).toBe(false);

            // And what the boot panel renders from it. THIS is the assertion the
            // whole change exists for.
            const state = computeBootUiState({
                requestStatus: 'success',
                elapsedMs: 0,
                frameConfirmed: confirmed,
            });
            expect(state.kind).not.toBe('ready');
            expect(state).toEqual({ kind: 'failed', reason: 'desktop_unreachable' });

            // The control case, same chain, same code, a host that answers:
            // `ready` is still reachable, so this is a real discrimination and
            // not a blanket refusal.
            const okConfirmed = await shellSession.confirmFrame(
                '00000000-0000-4000-8000-000000000002',
                `${workingUrl}/`,
            );
            expect(okConfirmed).toBe(true);
            expect(
                computeBootUiState({ requestStatus: 'success', elapsedMs: 0, frameConfirmed: okConfirmed }),
            ).toEqual({ kind: 'ready' });
        } finally {
            delete (globalThis as unknown as { window?: unknown }).window;
            await close(app);
        }
    });

    it('a host that does not answer at all is also not a confirmation', async () => {
        // Port 1 on loopback: nothing listens, so this is a genuine transport
        // failure rather than a synthesized one.
        const probe = await probeDesktopFrame('http://127.0.0.1:1/', 2_000);
        expect(probe.alive).toBe(false);
        expect(
            computeBootUiState({ requestStatus: 'success', elapsedMs: 0, frameConfirmed: probe.alive }),
        ).toEqual({ kind: 'failed', reason: 'desktop_unreachable' });
    });
});

/**
 * `confirmFrame` fetches a URL the BROWSER named. Without a pin that is a
 * server-side request forgery primitive pointed at anything the app server can
 * reach — which, on a serverless host, includes the metadata endpoint.
 */
describe('isOwnDesktopOrigin — the confirm route only ever probes our own desktop', () => {
    const SANDBOX = 'guac-abc123def456-789xyz012345';
    const WORKER_HOST = 'os.ezil.org';
    const REAL = `https://8181-${SANDBOX}-nekodesktop.ezil.org/`;

    it('accepts the real preview URL shape, on the zone root the Worker collapses to', () => {
        expect(isOwnDesktopOrigin(WORKER_HOST, SANDBOX, REAL)).toBe(true);
    });

    it('accepts it on the un-collapsed Worker host too', () => {
        expect(
            isOwnDesktopOrigin(WORKER_HOST, SANDBOX, `https://8181-${SANDBOX}-nekodesktop.os.ezil.org/`),
        ).toBe(true);
    });

    it('is port- and token-agnostic, so a Worker-side portFor() change is not a drift trap', () => {
        expect(isOwnDesktopOrigin(WORKER_HOST, SANDBOX, `https://8080-${SANDBOX}-desktop.ezil.org/`)).toBe(
            true,
        );
    });

    it('refuses another user’s sandbox on our own zone', () => {
        expect(
            isOwnDesktopOrigin(WORKER_HOST, SANDBOX, 'https://8181-guac-someoneelse-0000-nekodesktop.ezil.org/'),
        ).toBe(false);
    });

    it('refuses our own sandbox label parked on somebody else’s domain', () => {
        expect(isOwnDesktopOrigin(WORKER_HOST, SANDBOX, `https://8181-${SANDBOX}-nekodesktop.evil.com/`)).toBe(
            false,
        );
    });

    it('refuses a bare-TLD suffix match — the reason this is not `endsWith`', () => {
        expect(isOwnDesktopOrigin(WORKER_HOST, SANDBOX, `https://8181-${SANDBOX}-nekodesktop.org/`)).toBe(
            false,
        );
    });

    it('refuses the classic SSRF targets outright', () => {
        for (const target of [
            'http://169.254.169.254/latest/meta-data/',
            'http://localhost:8787/sandbox/preview',
            'http://127.0.0.1/',
            'file:///etc/passwd',
            'not a url at all',
        ]) {
            expect(isOwnDesktopOrigin(WORKER_HOST, SANDBOX, target)).toBe(false);
        }
    });

    it('refuses everything when the config it pins against is missing', () => {
        expect(isOwnDesktopOrigin('', SANDBOX, REAL)).toBe(false);
        expect(isOwnDesktopOrigin(WORKER_HOST, '', REAL)).toBe(false);
    });
});
