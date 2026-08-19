/**
 * THE PROOF: a boot that settles a second late must not be reported as a
 * failure.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * 38% of desktop launches were failing with `desktop_unreachable`. In all ten
 * observed production failures the Worker had SUCCEEDED — it returned `ok` with
 * a `guacamoleUrl`, `ensureDesktop` had passed `desktop_ready_wait`, and the
 * port was exposed. What failed was the app server's own pre-handoff HTTP probe
 * of the public preview origin: ONE `GET`, six-second timeout, no retry.
 *
 * The edge answers fast and wrong during a normal boot transition —
 * `proxyToSandbox` returns `404 INVALID_TOKEN`, `410 STALE_PREVIEW_URL` and
 * `500 Container suddenly disconnected` in well under a second while the
 * container is still settling. All are `>= 400`, so the probe returned
 * `alive:false` immediately. A 27.9s success and a 33s failure were the same
 * boot; the probe merely asked at the wrong moment.
 *
 * The discriminator that made this a diagnosis rather than a theory:
 * `codePreviewUrl` has NO frame probe at all, and in every one of those
 * failures the code app minted successfully on the same sandbox in the same
 * seconds. The launch with a probe failed; the launch without one succeeded.
 *
 * ── How this file proves the fix ────────────────────────────────────────────
 * With a REAL HTTP server, like its sibling `desktop-frame-honesty.test.ts` and
 * for the same reason: a stubbed `fetch` would prove the retry loop calls
 * itself, not that it recovers a boot. The server here answers with the exact
 * statuses `proxyToSandbox` emits for the first N requests and then starts
 * serving, and the test asserts that the SAME url is a failure under
 * `probeDesktopFrame` and a success under `confirmDesktopFrame`.
 *
 * 🔴 The honesty contract is NOT weakened. The last section asserts that an
 * origin which never serves is still reported as dead, that a deterministic
 * failure is not retried at all, and that the loop cannot outrun its budget.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
    DESKTOP_FRAME_CONFIRM_BUDGET_MS,
    DESKTOP_FRAME_CONFIRM_GAP_MS,
    confirmDesktopFrame,
    probeDesktopFrame,
} from './cloudflare-guacamole-provider';

let running: Server | null = null;

afterEach(async () => {
    if (running) await new Promise<void>((r) => running!.close(() => r()));
    running = null;
});

/**
 * A server that answers `statuses[n]` to its n-th request and 200 for every
 * request after the list runs out — i.e. a container that is settling.
 */
async function settlingOrigin(statuses: number[]): Promise<{ url: string; hits: () => number }> {
    let n = 0;
    const server = createServer((_req, res) => {
        const status = n < statuses.length ? statuses[n]! : 200;
        n++;
        if (status >= 400) {
            // The literal bodies `proxyToSandbox` returns during a transition.
            res.writeHead(status, { 'content-type': 'text/plain' });
            res.end(status === 404 ? 'INVALID_TOKEN' : status === 410 ? 'STALE_PREVIEW_URL' : 'Container suddenly disconnected');
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>neko</body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    running = server;
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/`, hits: () => n };
}

describe('the single probe was a coin flip', () => {
    it('🔴 a settling origin is reported DEAD by the single probe — the shipped defect', async () => {
        const { url } = await settlingOrigin([404]);
        const probe = await probeDesktopFrame(url);
        expect(probe.alive).toBe(false);
        expect(probe.status).toBe(404);
    });

    it('🔴 …and ALIVE by the re-probe, which is the same boot asked twice', async () => {
        const { url, hits } = await settlingOrigin([404]);
        const confirmed = await confirmDesktopFrame(url, 10_000, 20);
        expect(confirmed.alive).toBe(true);
        expect(confirmed.attempts).toBe(2);
        expect(hits()).toBe(2);
    });

    it.each([[404], [410], [500]])(
        'recovers from the %i `proxyToSandbox` emits during a transition',
        async (status) => {
            const { url } = await settlingOrigin([status, status]);
            const confirmed = await confirmDesktopFrame(url, 10_000, 20);
            expect(`${status} -> alive=${confirmed.alive} attempts=${confirmed.attempts}`).toBe(
                `${status} -> alive=true attempts=3`,
            );
        },
    );

    it('recovers from a mixed sequence, which is what a real transition looks like', async () => {
        const { url } = await settlingOrigin([500, 404, 410, 404]);
        const confirmed = await confirmDesktopFrame(url, 10_000, 20);
        expect(confirmed.alive).toBe(true);
        expect(confirmed.attempts).toBe(5);
    });
});

describe('it costs nothing on a healthy boot', () => {
    it('🔴 a healthy origin is confirmed on the FIRST attempt, with no sleep', async () => {
        const { url, hits } = await settlingOrigin([]);
        const started = Date.now();
        const confirmed = await confirmDesktopFrame(url);
        expect(confirmed.alive).toBe(true);
        expect(confirmed.attempts).toBe(1);
        expect(hits()).toBe(1);
        // The gap is 1.5s; a loop that slept before checking `alive` would show
        // it here. Generous ceiling so this cannot flake on a loaded machine.
        expect(`under a gap: ${Date.now() - started < DESKTOP_FRAME_CONFIRM_GAP_MS}`).toBe('under a gap: true');
    });
});

describe('the honesty contract is not weakened', () => {
    it('🔴 an origin that NEVER serves is still reported dead', async () => {
        const { url } = await settlingOrigin(Array<number>(50).fill(500));
        const confirmed = await confirmDesktopFrame(url, 300, 20);
        expect(confirmed.alive).toBe(false);
        if (confirmed.alive) return; // narrows the discriminated union; unreachable given the line above
        expect(confirmed.reason).toBe('http_error');
        expect(confirmed.status).toBe(500);
    });

    it('🔴 a DETERMINISTIC failure is never retried — one attempt, no budget spent', async () => {
        // A bad URL answers the same however many times it is asked. Retrying
        // it would burn the whole budget to learn nothing, on the critical path.
        const started = Date.now();
        const confirmed = await confirmDesktopFrame('not-a-url', 5_000, 500);
        expect(confirmed.alive).toBe(false);
        if (confirmed.alive) return; // narrows the discriminated union; unreachable given the line above
        expect(confirmed.reason).toBe('bad_url');
        expect(confirmed.attempts).toBe(1);
        expect(`fast: ${Date.now() - started < 400}`).toBe('fast: true');
    });

    it('🔴 cannot outrun its own budget', async () => {
        const { url } = await settlingOrigin(Array<number>(200).fill(500));
        const started = Date.now();
        const confirmed = await confirmDesktopFrame(url, 400, 50);
        const elapsed = Date.now() - started;
        expect(confirmed.alive).toBe(false);
        if (confirmed.alive) return; // narrows the discriminated union; unreachable given the line above
        // A loop that slept AFTER the last attempt, or that let a full
        // per-probe timeout run past the deadline, would overshoot here.
        expect(`elapsed ${elapsed} within budget+slack: ${elapsed < 400 + 500}`).toBe(
            `elapsed ${elapsed} within budget+slack: true`,
        );
        expect(confirmed.elapsedMs).toBeGreaterThan(0);
    });

    it('reports how hard it tried, so the next failure is a diagnosis not an investigation', async () => {
        // 🔴 DE-FLAKED BY INTEGRATION, 2026-08-19 — and note WHICH knob moved.
        // This was `settlingOrigin(Array(50).fill(410))` with a 300 ms budget,
        // and it was LOAD-flaky rather than wrong: measured ~1-in-3 red inside
        // the full 649-test vitest run, 6/6 green when this file ran alone. With
        // a 300 ms whole budget, one slow loopback round trip on a busy machine
        // eats it, the per-attempt timeout clamps to `Math.max(1, remaining)`,
        // the probe aborts, and the reason comes back `unreachable` — a fact
        // about the CPU, not about the origin.
        //
        // Raising the BUDGET alone is wrong and was tried first: `settlingOrigin`
        // serves 200 once the array runs out, so a bigger budget walks past all
        // 50 statuses and the origin CONFIRMS. The 300 ms was load-bearing
        // against the array length, which is exactly the coupling that made this
        // brittle. So the ORIGIN becomes permanently 410 instead, and the budget
        // is then free to be generous. The three assertions below are all about
        // the origin — it tried more than once, it saw the 410, it kept the
        // status — and none is about speed; the budget's own tightness is the
        // separate `cannot outrun its own budget` case above.
        const { url } = await settlingOrigin(Array<number>(10_000).fill(410));
        const confirmed = await confirmDesktopFrame(url, 1_000, 20);
        if (confirmed.alive) throw new Error("an origin that only 410s must never confirm");
        expect(confirmed.attempts).toBeGreaterThan(1);
        expect(confirmed.elapsedMs).toBeGreaterThan(0);
        expect(confirmed.reason).toBe('http_error');
        expect(confirmed.status).toBe(410);
    });

    it('the shipped budget stays inside the route and shell budgets that contain it', () => {
        // `maxDuration = 300s` on the route, `DESKTOP_BOOT_TIMEOUT_MS = 215s`
        // in the shell, and a ~180s Worker wait already inside this request.
        // The re-probe is only allowed to be the small remainder.
        expect(DESKTOP_FRAME_CONFIRM_BUDGET_MS).toBeLessThanOrEqual(30_000);
        expect(DESKTOP_FRAME_CONFIRM_GAP_MS).toBeLessThan(DESKTOP_FRAME_CONFIRM_BUDGET_MS);
    });
});
