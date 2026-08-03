import { describe, expect, it } from 'vitest';

import { fingerprint, normalizeDetail } from './fingerprint';

/**
 * Pins the design's worked examples (`scratchpad/telemetry-design.md` §2.3):
 * 4 positive pairs that MUST collide, 2 negative controls that MUST NOT, and
 * a leak scan over every normalised string. Fingerprints are asserted as
 * LITERALS (not just equality between pairs) so a regex edit that silently
 * re-buckets the whole fleet fails CI even if it happens to keep pairs equal
 * to each other.
 */

const EX1_A = {
    eventClass: 'api_failure' as const,
    source: 'shell' as const,
    site: 'ezil-os:apps/preview#mint',
    code: 'sandbox_start_failed',
    detail: 'preview mint failed after 21437ms: sandbox_start_failed',
};
const EX1_B = { ...EX1_A, detail: 'preview mint failed after 18902ms: sandbox_start_failed' };

const EX2_A = {
    eventClass: 'worker_exception' as const,
    source: 'worker' as const,
    site: 'sandbox.preview.desktop_ready',
    code: 'sandbox_start_failed',
    detail:
        'sandbox_start_failed: container 550e8400-e29b-41d4-a716-446655440000 exited with code 137 ' +
        'while binding http://ezil-a1b2c3d4e5f6.api-desktop.ezil.org:8080',
};
const EX2_B = {
    ...EX2_A,
    detail:
        'sandbox_start_failed: container 7c9e6679-7425-40de-944b-e07fc1f90ae7 exited with code 137 ' +
        'while binding http://ezil-99887766aabb.api-desktop.ezil.org:9223',
};

const EX3_A = {
    eventClass: 'crash' as const,
    source: 'shell' as const,
    site: 'bundle.min.js#UIWindow',
    code: 'typeerror',
    detail: "TypeError: Cannot read properties of null (reading 'focus') at bundle.min.js:41233:17",
};
const EX3_B = {
    ...EX3_A,
    detail: "TypeError: Cannot read properties of null (reading 'focus') at bundle.min.js:41233:9",
};

const EX4_A = {
    eventClass: 'boot_phase' as const,
    source: 'container' as const,
    site: 'workspace_hydration',
    code: 'workspace_fuse_unavailable',
    detail: 'fuse: device not found, mount /workspace/8f14e45f-ceea-467a-9c1f-3d6ba0d5a1e2 failed after 5901ms',
};
const EX4_B = {
    ...EX4_A,
    detail: 'fuse: device not found, mount /workspace/c0ffee11-dead-4bee-8ace-000000000001 failed after 6420ms',
};

const NEG1_A = {
    eventClass: 'api_failure' as const,
    source: 'shell' as const,
    site: 'ezil-os:apps/preview#mint',
    code: 'timeout',
    detail: 'preview mint failed after 21437ms: timeout',
};
const NEG1_B = { ...NEG1_A, code: 'sandbox_start_failed', detail: 'preview mint failed after 21437ms: sandbox_start_failed' };

const NEG2_A = {
    eventClass: 'worker_exception' as const,
    source: 'worker' as const,
    site: 'sandbox.preview.identity',
    code: 'sandbox_start_failed',
    detail: 'container exited with code 137',
};
const NEG2_B = { ...NEG2_A, detail: 'container exited with code 1' };

const PRIVACY_CASE = {
    eventClass: 'api_failure' as const,
    source: 'worker' as const,
    site: 'sandbox.preview.turn',
    code: 'unauthorized',
    detail:
        'unauthorized: bad sig t=1754006400123,v1=9f8e7d6c5b4a39281706 for authorization: ' +
        'Bearer eyJhbGciOi.J9.abc from 203.0.113.42',
};

describe('fingerprint(): positive pairs collide, pinned as literals', () => {
    it('EX1 — shell preview mint, different durations', () => {
        expect(fingerprint(EX1_A)).toBe('fp_b4ae95542373297f');
        expect(fingerprint(EX1_B)).toBe('fp_b4ae95542373297f');
    });

    it('EX2 — worker exception, different sandbox ids/ports, same exit code kept', () => {
        expect(fingerprint(EX2_A)).toBe('fp_9d46755b6efce66b');
        expect(fingerprint(EX2_B)).toBe('fp_9d46755b6efce66b');
    });

    it('EX3 — shell crash, different stack column', () => {
        expect(fingerprint(EX3_A)).toBe('fp_26c1ab9711e709b9');
        expect(fingerprint(EX3_B)).toBe('fp_26c1ab9711e709b9');
    });

    /**
     * The pinned literal moved from `fp_0152c25775351c84` to
     * `fp_b4a68646617f9fe2` when `sanitizeErrorMessage` gained its own path
     * rule. Before, `/workspace/<uuid>` reached `normalizeDetail` intact and
     * was rewritten by N3 (uuid) and then N9 (path); now the sanitiser — which
     * runs first, and which is what actually writes `ezil_error_events.detail`
     * — has already collapsed the whole thing to `<path>`. Both sides still
     * normalise to `fuse: device not found, mount <path> failed after <dur>`,
     * so THE PROPERTY THE PIN EXISTS FOR IS UNCHANGED: two containers with
     * different workspace paths and different durations remain one fingerprint.
     *
     * Re-pinning was safe to do exactly once: `app/drizzle/0001_telemetry.sql`
     * is still un-applied, so no stored fingerprint anywhere needs rehashing.
     * It will not be safe the next time.
     */
    it('EX4 — container boot phase, different workspace paths', () => {
        expect(fingerprint(EX4_A)).toBe('fp_b4a68646617f9fe2');
        expect(fingerprint(EX4_B)).toBe('fp_b4a68646617f9fe2');
    });
});

describe('fingerprint(): negative controls never collide', () => {
    it('NEG1 — timeout vs sandbox_start_failed at the same site', () => {
        expect(fingerprint(NEG1_A)).not.toBe(fingerprint(NEG1_B));
        expect(fingerprint(NEG1_A)).toBe('fp_22a4070ae2c1aff7');
        expect(fingerprint(NEG1_B)).toBe('fp_b4ae95542373297f');
    });

    it('NEG2 — exit code 137 (OOM) vs 1 (generic) must stay distinct', () => {
        expect(fingerprint(NEG2_A)).not.toBe(fingerprint(NEG2_B));
        expect(fingerprint(NEG2_A)).toBe('fp_a34392e3c52e32f3');
        expect(fingerprint(NEG2_B)).toBe('fp_80f2a1e532ae0dac');
    });
});

describe('normalizeDetail(): privacy — no secret material reaches the hash input', () => {
    const LEAKS = [/v1=[0-9a-f]{8,}/i, /bearer\s+ey/i, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, /@[\w.]+\.[a-z]{2,}/i];

    it('redacts an HMAC signature, a bearer token and an ICE-candidate IP', () => {
        const normalised = normalizeDetail(PRIVACY_CASE.detail);
        for (const re of LEAKS) expect(normalised).not.toMatch(re);
        expect(normalised).toBe('unauthorized: bad sig [redacted-token] for authorization=[redacted]');
    });

    it('runs the leak scan over every normalised string in the pair corpus', () => {
        const corpus = [EX1_A, EX1_B, EX2_A, EX2_B, EX3_A, EX3_B, EX4_A, EX4_B, NEG1_A, NEG1_B, NEG2_A, NEG2_B];
        for (const c of corpus) {
            const n = normalizeDetail(c.detail);
            for (const re of LEAKS) expect(n).not.toMatch(re);
        }
    });

    it('normalizeDetail("") -> ""', () => {
        expect(normalizeDetail('')).toBe('');
        expect(normalizeDetail(undefined)).toBe('');
    });
});

describe('fingerprint(): both-directions proof — the delimiter matters', () => {
    it('a \\x1f-joined field split cannot be reproduced by concatenation alone', () => {
        // site='a', code='bc'  vs  site='ab', code='c' must NOT collide, proving
        // fields are delimited rather than naively concatenated.
        const f1 = fingerprint({ eventClass: 'crash', source: 'shell', site: 'a', code: 'bc' });
        const f2 = fingerprint({ eventClass: 'crash', source: 'shell', site: 'ab', code: 'c' });
        expect(f1).not.toBe(f2);
    });
});
