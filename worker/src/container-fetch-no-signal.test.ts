/**
 * `containerFetch` must never be handed an `AbortSignal`.
 *
 * ── The defect this exists to prevent ───────────────────────────────────────
 * `Sandbox.containerFetch()` is a Durable Object RPC. Its `RequestInit` is
 * serialized across the isolate boundary, and an `AbortSignal` is not
 * serializable unless the `enable_request_signal` compatibility flag is set.
 * Passing one throws — synchronously, before any request is made:
 *
 *     AbortSignal serialization is not enabled.
 *
 * Shipped 2026-08-19 on all three container calls in `handleScreen`. Live
 * telemetry recorded **20 of 20 live resizes failing** with
 * `screen_upstream_exception`, every one of them that message, within minutes
 * of the deploy. The desktop stayed at whatever shape it booted at, so a warm
 * container served the previous session's aspect ratio and the picture was
 * letterboxed into the window — the exact symptom the resize feature had been
 * written to fix.
 *
 * ── Why this is a SOURCE test and not a behavioural one ─────────────────────
 * The constraint lives in the RPC boundary, not in our code. There is no
 * container, no `wrangler dev` stub and no unit fake that reproduces it: a
 * plain `fetch()` at a real container in a docker test accepts a signal
 * happily, which is precisely why every local run passed and why this reached
 * production. Reproducing it needs a deployed Worker talking to a real
 * Durable Object.
 *
 * So this asserts the one thing that is checkable without that: the argument is
 * not written at the call site. That is a narrow claim and it is stated
 * narrowly — it cannot catch a signal reaching `containerFetch` through a
 * variable or a spread. It catches the literal shape that actually shipped.
 *
 * ── If you need a deadline ──────────────────────────────────────────────────
 * Use `withDeadline()` in `index.ts`, which races the RPC against a timer and
 * rejects with an `Error` named `TimeoutError` so the existing `catch`
 * classification is unchanged.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_SRC = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');

/**
 * Every `sandbox.containerFetch(` / `.containerFetch(` call site, with the text
 * that follows it up to the closing of its argument list — approximated by the
 * next `\n    );` / `\n  );`-style terminator, which is enough to cover the
 * `RequestInit` object literal that is the only place a signal has ever been
 * written.
 */
function containerFetchCallSites(src: string): string[] {
    const sites: string[] = [];
    const needle = '.containerFetch(';
    let from = 0;
    for (;;) {
        const at = src.indexOf(needle, from);
        if (at === -1) break;
        from = at + needle.length;
        // A doc comment mentioning the name is not a call site.
        const lineStart = src.lastIndexOf('\n', at) + 1;
        const line = src.slice(lineStart, at);
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        sites.push(src.slice(at, at + 900));
    }
    return sites;
}

describe('containerFetch must not be given an AbortSignal', () => {
    it('finds the call sites at all — a zero-site pass would be a false green', () => {
        const sites = containerFetchCallSites(INDEX_SRC);
        // Three today: neko login, neko screen set, neko screen read-back.
        // If this ever drops to zero the scanner has broken, not the code.
        expect(sites.length).toBeGreaterThanOrEqual(3);
    });

    it('no call site passes `signal`', () => {
        const offenders = containerFetchCallSites(INDEX_SRC)
            .filter((site) => /(^|[\s,{])signal\s*[,:}]/.test(site))
            .map((site) => site.slice(0, 200));

        expect(offenders).toEqual([]);
    });

    it('`AbortSignal.timeout` is not constructed anywhere in the screen handler', () => {
        const start = INDEX_SRC.indexOf('async function handleScreen(');
        expect(start).toBeGreaterThan(-1);
        const body = INDEX_SRC.slice(start, start + 6_000);
        // CONSTRUCTION, not the word: the handler deliberately *mentions*
        // `AbortSignal` in a comment explaining why it must not use one, and a
        // test that went red on its own rationale would be promptly deleted.
        expect(body.includes('AbortSignal.timeout(')).toBe(false);
        expect(body.includes('new AbortController')).toBe(false);
    });

    it('the replacement deadline helper is present and rejects as a TimeoutError', () => {
        // The `catch` in `handleScreen` maps `err.name === 'TimeoutError'` to
        // `screen_timeout`/504. A helper that rejected with a plain Error would
        // silently reclassify every timeout as `screen_upstream_exception`/502.
        expect(INDEX_SRC.includes('async function withDeadline<T>')).toBe(true);
        expect(INDEX_SRC.includes("err.name = 'TimeoutError';")).toBe(true);
    });
});
