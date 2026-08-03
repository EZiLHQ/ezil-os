import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyError, safeUserHash, sanitizeErrorMessage } from './sanitize';

/**
 * `sanitize.ts` is a deliberate logic-identical DUPLICATE of three functions
 * from `worker/src/observability.ts` (see that file's doc comment for why
 * duplication rather than a shared import). "Identical" is meaningless
 * unless something actually checks it — this file extracts each function's
 * source text from both locations and diffs them (modulo indentation style,
 * since the two repos use different widths — see `dedent` below), so an
 * edit to one without the other fails CI rather than silently re-bucketing
 * every fingerprint that flows through the two producers.
 */

const WORKER_OBSERVABILITY_PATH = path.resolve(__dirname, '../../../../worker/src/observability.ts');
const APP_SANITIZE_PATH = path.resolve(__dirname, './sanitize.ts');

/** Extract a named function's full source (signature through its matching
 * closing brace) via a simple brace-depth scan — good enough for these three
 * top-level `export function` declarations, which contain no template
 * literals with braces. */
function extractFunction(source: string, name: string): string {
    const start = source.indexOf(`export function ${name}(`);
    if (start === -1) throw new Error(`function ${name} not found`);
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces for ${name}`);
}

/** Strip per-line leading/trailing whitespace before comparing. The worker
 * repo is 2-space indented and this app repo is 4-space indented (each
 * project's own established convention — see `computers.ts` vs
 * `observability.ts`), so a raw byte comparison would fail on indentation
 * alone despite the logic being identical. Stripping indentation still
 * catches everything that matters: a changed regex, a changed branch, a
 * changed literal, a reordered check, an added/removed line. */
function dedent(source: string): string {
    return source
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
}

describe('sanitize.ts stays byte-identical to worker/src/observability.ts', () => {
    const workerSource = readFileSync(WORKER_OBSERVABILITY_PATH, 'utf8');
    const appSource = readFileSync(APP_SANITIZE_PATH, 'utf8');

    for (const fn of ['safeUserHash', 'sanitizeErrorMessage', 'classifyError'] as const) {
        it(`${fn} is identical (modulo indentation style) in both files`, () => {
            expect(dedent(extractFunction(appSource, fn))).toBe(dedent(extractFunction(workerSource, fn)));
        });
    }
});

describe('sanitize.ts functions behave as expected (smoke coverage for the parity above)', () => {
    it('safeUserHash: empty/undefined -> u_anon, stable, no raw id leaks', () => {
        expect(safeUserHash(undefined)).toBe('u_anon');
        expect(safeUserHash('')).toBe('u_anon');
        expect(safeUserHash('  ')).toBe('u_anon');
        const h1 = safeUserHash('user-123');
        const h2 = safeUserHash('user-123');
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^u_[0-9a-f]{8}$/);
        expect(h1).not.toContain('user-123');
    });

    it('sanitizeErrorMessage redacts secrets and truncates', () => {
        const out = sanitizeErrorMessage(
            'unauthorized: bad sig t=1754006400123,v1=9f8e7d6c5b4a39281706 for ' +
                'authorization: Bearer eyJhbGciOi.J9.abc from 203.0.113.42',
        );
        expect(out).not.toMatch(/v1=[0-9a-f]{8,}/);
        expect(out).not.toMatch(/bearer\s+ey/i);
        expect(out).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
        expect(out.length).toBeLessThanOrEqual(200);
    });

    /**
     * 🔴 The reason this file's parity check exists at all. `ezil_error_events.detail`
     * is written from `sanitizeErrorMessage`'s output — NOT from
     * `normalizeDetail`'s — so a path rule that lives only in `normalizeDetail`
     * (N9) leaves absolute paths in the stored column while making a fingerprint
     * look clean. `docs/telemetry.md` promises the opposite. These cases are
     * written so that deleting either path `.replace(...)` from `sanitize.ts`
     * turns them red, not just the parity test.
     */
    describe('sanitizeErrorMessage strips absolute paths from what actually gets STORED', () => {
        /**
         * The exact string measured end-to-end through the shipped chain
         * (`shell/ezil/telemetry.js` -> `handleTelemetryPost` -> `parseTelemetryBatch`
         * -> `ingestBatch` -> Postgres) before this rule existed. It landed in
         * `detail` verbatim, username and project name included.
         */
        const MEASURED =
            'restart rejected for <url> after 20001ms for u_b6b2f6a3 at ' +
            '/home/user1/workspace/proj-1 (cid_abc1, computer <uuid>, port :8444)';

        it('the exact measured leak: no username, no project name, no slash-path left', () => {
            const out = sanitizeErrorMessage(MEASURED);
            expect(out).not.toContain('user1');
            expect(out).not.toContain('proj-1');
            expect(out).not.toContain('/home');
            expect(out).not.toMatch(/(?:^|\s)~?\/[\w.@%+~-]/);
            expect(out).toContain('<path>');
        });

        it('the same string keeps everything that makes it actionable', () => {
            const out = sanitizeErrorMessage(MEASURED);
            // Over-redaction is its own failure mode: a record with no port, no
            // duration and no correlation id cannot be acted on.
            expect(out).toContain('port :8444');
            expect(out).toContain('20001ms');
            expect(out).toContain('cid_abc1');
            expect(out).toContain('u_b6b2f6a3');
            expect(out).toContain('restart rejected');
            expect(out).toBe(
                'restart rejected for <url> after 20001ms for u_b6b2f6a3 at <path> ' +
                    '(cid_abc1, computer <uuid>, port :8444)',
            );
        });

        it.each([
            ['/home/user1/workspace/proj-1 is not empty', ['user1', 'proj-1']],
            ['mount_failed_after_4_attempts: s3fs could not mount /workspace/alice/startup', ['alice', 'startup']],
            ["seed_check_failed: ENOENT, open '/home/bob/workspace/my app/.env'", ['bob', 'my app', '.env']],
            ['EACCES /home/u/workspace/proj 1/node_modules/.bin/next', ['proj 1', 'node_modules']],
            ['failed at ~/workspace/proj-1/src/index.ts', ['proj-1', 'index.ts']],
            ['error in "/home/user1/workspace/p/a.js"', ['user1', 'a.js']],
            ['C:\\Users\\user1\\workspace\\proj-1 not found', ['user1', 'proj-1']],
            ['C:\\Program Files\\EZiL\\proj-1\\x.txt missing', ['Program Files', 'proj-1', 'x.txt']],
            // A URL is a path carrier too — the workspace path rides in its
            // pathname, where the POSIX rule deliberately will not follow it.
            ['fetch https://8444-guac-x.workers.dev/home/user1/workspace/proj-1/i.html failed', ['user1', 'proj-1']],
        ])('%s leaks nothing', (input, forbidden) => {
            const out = sanitizeErrorMessage(input);
            for (const f of forbidden) expect(out).not.toContain(f);
        });

        it.each([
            ['http 500 on :8444 read/write conflict, ratio 1/2', 'http 500 on :8444 read/write conflict, ratio 1/2'],
            ['expected 200 / got 500', 'expected 200 / got 500'],
            ['openWindow@UIWindow.js:12:34', 'openWindow@UIWindow.js:12:34'],
            ['08/01/2026 boot failed', '08/01/2026 boot failed'],
            ['and/or both flags set', 'and/or both flags set'],
            ['stop_timed_out: exit 137 after 20001ms', 'stop_timed_out: exit 137 after 20001ms'],
            ["Cannot read properties of undefined (reading 'foo')", "Cannot read properties of undefined (reading 'foo')"],
            ['workspace_fuse_unavailable: fuse: device not found', 'workspace_fuse_unavailable: fuse: device not found'],
        ])('%s is left completely alone', (input, expected) => {
            expect(sanitizeErrorMessage(input)).toBe(expected);
        });

        it('a QUOTED path is eaten whole, spaces and all — quotes delimit it', () => {
            expect(sanitizeErrorMessage("could not open '/home/bob/workspace/my secret project'")).toBe(
                "could not open '<path>'",
            );
            expect(sanitizeErrorMessage('EACCES "/home/u/workspace/my app/.env" at boot')).toBe(
                'EACCES "<path>" at boot',
            );
        });

        /**
         * 🔴 PINS THE ONE RESIDUAL, so it cannot quietly get worse and cannot be
         * forgotten when someone next reads `docs/telemetry.md`. An UNQUOTED path
         * whose LAST segment contains a space is undecidable — `/home/u/w/my
         * project failed` could be a directory called `my project` or a directory
         * called `my` followed by prose. The rule stops at the space, so the tail
         * words survive. Absorbing them instead would eat the diagnosis, which is
         * the failure mode the other half of this suite guards against. The doc
         * says this plainly rather than promising absolutely; if this test ever
         * changes, that paragraph has to change with it.
         */
        it('DOCUMENTED RESIDUAL: an unquoted path with a space in its last segment truncates there', () => {
            const out = sanitizeErrorMessage('mount failed at /home/user1/workspace/my secret project');
            expect(out).toBe('mount failed at <path> secret project');
            // The username and every interior segment are still gone — the
            // residual is bounded to the trailing words of the final segment.
            expect(out).not.toContain('user1');
            expect(out).not.toContain('/home');
        });

        it('is idempotent — the worker sanitizes at the source and again on the way out', () => {
            for (const s of [MEASURED, '/home/u/w/p failed', 'C:\\a\\b broke', 'plain message']) {
                expect(sanitizeErrorMessage(sanitizeErrorMessage(s))).toBe(sanitizeErrorMessage(s));
            }
        });

        it('does not blow up on pathological input (no catastrophic backtracking)', () => {
            for (const bomb of ['/' + 'a/'.repeat(3000), '/a' + ' a'.repeat(2000), 'C:\\' + 'a\\'.repeat(600) + ' x']) {
                const t0 = Date.now();
                sanitizeErrorMessage(bomb);
                expect(Date.now() - t0).toBeLessThan(1000);
            }
        });
    });

    it('classifyError derives a stable low-cardinality code', () => {
        expect(classifyError('sandbox_start_failed: boom')).toBe('sandbox_start_failed');
        expect(classifyError('timed out waiting for X')).toBe('timeout');
        expect(classifyError(new Error('fuse: device not found'))).toBe('workspace_fuse_unavailable');
        expect(classifyError('')).toBe('unexpected_error');
    });
});
