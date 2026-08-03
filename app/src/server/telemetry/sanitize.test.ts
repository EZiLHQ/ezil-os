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

    it('classifyError derives a stable low-cardinality code', () => {
        expect(classifyError('sandbox_start_failed: boom')).toBe('sandbox_start_failed');
        expect(classifyError('timed out waiting for X')).toBe('timeout');
        expect(classifyError(new Error('fuse: device not found'))).toBe('workspace_fuse_unavailable');
        expect(classifyError('')).toBe('unexpected_error');
    });
});
