import { describe, expect, it } from 'vitest';
import fixtures from './app-failures.fixtures.json';
import { sanitizeDiagnostics } from './redact';
import {
    APP_FAILURE_CODES, appFailureRecordSchema, diagnosticsSchema, feedbackSubmitSchema, type FeedbackDiagnostics,
} from './types';

const wireRecord = (failure: unknown) => ({ ...(failure as Record<string, unknown>), app: 'code', ageMs: 1000 });
const base = wireRecord(fixtures.valid.find(fixture => fixture.name === 'network failed')!.failure);
const neighbors = fixtures.valid.slice(0, 2).map(fixture => wireRecord(fixture.failure));
const rawDiagnostics = (appFailures: unknown): FeedbackDiagnostics => ({ appFailures }) as FeedbackDiagnostics;
// A cancellation needs its source and the cancelled outcome; every other category forbids both.
const inCategory = (category: string) => category === 'cancellation'
    ? { ...base, category, outcome: 'cancelled', cancellationSource: 'caller' } : { ...base, category };
const requestIdFields = ['clientRequestId', 'gatewayRequestId', 'vscodeRequestId', 'retryOfClientRequestId'] as const;

describe('app failure v1 golden fixtures', () => {
    it.each(fixtures.valid)('accepts and preserves $name', ({ failure }) => {
        const record = Object.freeze(wireRecord(failure));
        const diagnostics = { appFailures: [record] };
        expect(appFailureRecordSchema.parse(record)).toEqual(record);
        expect(diagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
        expect(feedbackSubmitSchema.safeParse({
            v: 1, clientRequestId: 'f0000000-0000-4000-8000-000000000001', category: 'bug',
            description: 'App request failed', diagnostics,
        }).success).toBe(true);
        const sanitized = sanitizeDiagnostics(rawDiagnostics([record]));
        expect(sanitized).toEqual(diagnostics);
        expect(sanitized?.appFailures?.[0]).not.toBe(record);
    });

    it.each(fixtures.rejected)('rejects and drops $name without affecting neighbors', ({ failure }) => {
        const record = Object.freeze(wireRecord(failure));
        expect(appFailureRecordSchema.safeParse(record).success).toBe(false);
        // The wire stays lenient so one bad entry never rejects the whole report.
        const report = { v: 1, clientRequestId: 'f0000000-0000-4000-8000-000000000002', category: 'bug',
            description: 'Kept with a malformed app failure', diagnostics: { appFailures: [record] } };
        expect(feedbackSubmitSchema.parse(report).description).toBe(report.description);
        expect(sanitizeDiagnostics(rawDiagnostics([neighbors[0], record, neighbors[1]])))
            .toEqual({ appFailures: neighbors });
    });
});

describe('app failure wire strictness and bounds', () => {
    it('allows omission and empty arrays, but rejects eleven entries and unknown keys at either level', () => {
        expect(diagnosticsSchema.parse({})).toEqual({});
        expect(diagnosticsSchema.parse({ appFailures: [] })).toEqual({ appFailures: [] });
        expect(diagnosticsSchema.safeParse({ appFailures: Array(10).fill(base) }).success).toBe(true);
        for (const diagnostics of [
            { appFailures: Array(11).fill(base) },
            { appFailures: [base], unknown: true },
        ]) expect(diagnosticsSchema.safeParse(diagnostics).success).toBe(false);
        // An extra key on one entry passes the bounded wire array and is dropped by the sanitizer.
        expect(diagnosticsSchema.safeParse({ appFailures: [{ ...base, extra: 'private' }] }).success).toBe(true);
        expect(sanitizeDiagnostics(rawDiagnostics([{ ...base, extra: 'private' }, base]))?.appFailures).toEqual([base]);
    });

    it('requires every mandatory field', () => {
        for (const field of ['eventId', 'source', 'operation', 'category', 'code', 'stage', 'outcome', 'app', 'ageMs']) {
            const incomplete: Record<string, unknown> = { ...base };
            delete incomplete[field];
            expect(appFailureRecordSchema.safeParse(incomplete).success, field).toBe(false);
        }
    });

    it('accepts every category code only in its category, with unexpected_error valid in all', () => {
        for (const [category, codes] of Object.entries(APP_FAILURE_CODES)) {
            expect(appFailureRecordSchema.safeParse({ ...inCategory(category), code: 'unexpected_error' }).success).toBe(true);
            for (const [codeCategory, categoryCodes] of Object.entries(APP_FAILURE_CODES)) {
                for (const code of categoryCodes) {
                    expect(appFailureRecordSchema.safeParse({ ...inCategory(category), code }).success, `${category}/${code}`)
                        .toBe(category === codeCategory);
                }
            }
            expect(codes.length).toBeGreaterThan(0);
        }
        expect(appFailureRecordSchema.safeParse({ ...base, code: 'unknown_error' }).success).toBe(false);
        expect(appFailureRecordSchema.safeParse({ ...base, category: 'unknown', code: 'unexpected_error' }).success).toBe(false);
    });

    it.each([
        ['source', ['ezil_chat', 'code_app']],
        ['operation', ['chat_request', 'app_start']],
        ['stage', ['startup', 'admission', 'request', 'headers', 'stream']],
        ['outcome', ['failed', 'retrying', 'recovered']],
        ['app', ['code']],
    ] as const)('keeps %s a closed enum', (field, values) => {
        for (const value of values) expect(appFailureRecordSchema.safeParse({ ...base, [field]: value }).success).toBe(true);
        for (const value of ['', 'unknown', values[0].toUpperCase(), null, 1]) {
            expect(appFailureRecordSchema.safeParse({ ...base, [field]: value }).success).toBe(false);
        }
    });

    it('keeps cancellation neutral: source required, cancelled outcome only for it', () => {
        const cancel = inCategory('cancellation');
        for (const source of ['caller', 'user_stop', 'unknown']) {
            expect(appFailureRecordSchema.safeParse({ ...cancel, code: 'request_cancelled', cancellationSource: source }).success).toBe(true);
        }
        const sourceless: Record<string, unknown> = { ...cancel, code: 'request_cancelled' };
        delete sourceless.cancellationSource;
        for (const invalid of [
            sourceless,
            { ...cancel, code: 'request_cancelled', cancellationSource: 'user' },
            { ...cancel, code: 'request_cancelled', outcome: 'failed' },
            { ...base, cancellationSource: 'caller' },
            { ...base, outcome: 'cancelled' },
        ]) {
            expect(appFailureRecordSchema.safeParse(invalid).success).toBe(false);
            expect(sanitizeDiagnostics(rawDiagnostics([invalid, base]))?.appFailures).toEqual([base]);
        }
    });

    it.each(['eof', 'malformed_event', 'missing_terminal'])('accepts streamReason %s only in the stream stage', streamReason => {
        for (const stage of ['startup', 'admission', 'request', 'headers', 'stream']) {
            expect(appFailureRecordSchema.safeParse({ ...base, stage, streamReason }).success).toBe(stage === 'stream');
        }
        expect(appFailureRecordSchema.safeParse({ ...base, stage: 'stream', streamReason: 'unknown' }).success).toBe(false);
    });

    it.each(['eventId', ...requestIdFields])('requires a lowercase UUID for %s without repair', field => {
        const id = 'abcdef01-2345-4678-9abc-def012345678';
        expect(appFailureRecordSchema.safeParse({ ...base, [field]: id }).success).toBe(true);
        for (const value of [id.toUpperCase(), ` ${id}`, `${id} `, `${id}\n`, `${id}\r`, id.replaceAll('-', ''), 'not-a-uuid', null]) {
            const invalid = { ...base, [field]: value };
            expect(appFailureRecordSchema.safeParse(invalid).success).toBe(false);
            expect(sanitizeDiagnostics(rawDiagnostics([invalid, base]))?.appFailures).toEqual([base]);
        }
    });

    it.each([
        ['attempt', 1, 64], ['durationMs', 0, 3_600_000], ['httpStatus', 100, 599], ['ageMs', 0, 1_800_000],
    ] as const)('bounds %s to integers %i..%i', (field, min, max) => {
        for (const value of [min, max]) expect(appFailureRecordSchema.safeParse({ ...base, [field]: value }).success).toBe(true);
        for (const value of [min - 1, max + 1, min + 0.5, String(min), null]) {
            const invalid = { ...base, [field]: value };
            expect(appFailureRecordSchema.safeParse(invalid).success).toBe(false);
            expect(sanitizeDiagnostics(rawDiagnostics([base, invalid]))?.appFailures).toEqual([base]);
        }
    });

    it('allows only a boolean retryable, preserving false', () => {
        for (const retryable of [true, false]) {
            const record = { ...base, retryable };
            expect(appFailureRecordSchema.safeParse(record).success).toBe(true);
            expect(sanitizeDiagnostics(rawDiagnostics([record]))?.appFailures).toEqual([record]);
        }
        for (const retryable of [0, 1, 'false', null]) {
            expect(appFailureRecordSchema.safeParse({ ...base, retryable }).success).toBe(false);
        }
    });

    it('accepts only namespaced catalog model keys: no URL, credential, path, token segment or random run', () => {
        for (const modelKey of ['anthropic/claude-sonnet-4-5-20250929', 'anthropic.claude-sonnet-5-5-v1:0', 'openai/gpt-6', 'google/gemini-2.5-flash', 'gpt-6', 'claude-sonnet-5-5', 'gemini-3.8-flash', 'qwen.qwen3-coder-next', 'us.moonshotai.kimi-k3', 'ezil-code', 'ezil-fast']) {
            expect(appFailureRecordSchema.safeParse({ ...base, modelKey }).success).toBe(true);
        }
        for (const modelKey of ['', 'a'.repeat(65), 'Model', '/path', '.model', 'two words', 'model?key', 'model\n', 'model\r',
            'https://gateway.example.test/v1', 'http://host/model', 'wss://host/model', null,
            '1', 'catalog:model_1.2/variant-3', 'us.sb_secret_ab-cd', 'claude-secret-1', 'ezil-session-1', 'claude.sk_live-1', 'us.project/file-1', 'project/file-1', 'sb_secret_abcd-efgh-ijkl-mnop', 'openai/sb_secret_abcd-efgh', 'anthropic/claude-api-key-1', 'anthropic/sk-proj-1', 'ezil/session-1', 'a', 'a'.repeat(64), 'sk-proj-' + 'a'.repeat(32), 'ghp_' + 'z'.repeat(24), 'xoxb-1-2', 'etc/passwd', 'etc/ssh-host-key', 'home/id-rsa-2', 'home/user/key', 'a/b/c-1', 'bearer-1']) {
            const invalid = { ...base, modelKey };
            expect(appFailureRecordSchema.safeParse(invalid).success).toBe(false);
            expect(sanitizeDiagnostics(rawDiagnostics([invalid, base]))?.appFailures).toEqual([base]);
        }
    });
});

describe('app failure sanitization', () => {
    it.each(requestIdFields)('drops the whole entry when %s equals an excluded identity, compared lowercase', field => {
        const identity = 'abcdef01-2345-4678-9abc-def012345678';
        const excluded = { ...base, [field]: identity };
        const diagnostics = rawDiagnostics([neighbors[0], excluded, neighbors[1]]);
        for (const excludeIds of [[identity], [null, undefined, identity.toUpperCase()]]) {
            expect(sanitizeDiagnostics(diagnostics, { excludeIds })).toEqual({ appFailures: neighbors });
        }
        expect(sanitizeDiagnostics(diagnostics, { excludeIds: ['f0000000-0000-4000-8000-000000000001'] })).toEqual(diagnostics);
    });

    it('drops a gatewayRequestId equal to the reporter computer id', () => {
        const computerId = 'f0000000-0000-4000-8000-000000000001';
        const diagnostics = rawDiagnostics([{ ...base, gatewayRequestId: computerId }, base]);
        expect(sanitizeDiagnostics(diagnostics, { excludeIds: [computerId] })).toEqual({ appFailures: [base] });
    });

    it('retains the newest ten valid records after dropping invalid entries, without mutating input', () => {
        const valid = fixtures.valid.map(({ failure }, index) => Object.freeze({ ...wireRecord(failure), ageMs: (fixtures.valid.length - index) * 1000 }));
        const invalid = fixtures.rejected.map(({ failure }) => wireRecord(failure));
        const records = Object.freeze([...valid, ...invalid]);
        const diagnostics = Object.freeze(rawDiagnostics(records));
        expect(sanitizeDiagnostics(diagnostics)).toEqual({ appFailures: valid.slice(-10) });
        expect(records).toEqual([...valid, ...invalid]);
    });

    it('does not let excluded entries displace valid records at the retention limit', () => {
        const computerId = 'f0000000-0000-4000-8000-000000000001';
        const valid = fixtures.valid.slice(-10).map(({ failure }) => wireRecord(failure));
        expect(sanitizeDiagnostics(rawDiagnostics([...valid, { ...base, gatewayRequestId: computerId }]), { excludeIds: [computerId] }))
            .toEqual({ appFailures: valid });
    });

    it('drops malformed records individually and ignores a non-array container', () => {
        expect(sanitizeDiagnostics(rawDiagnostics([null, false, 'failure', [], {}, base]))).toEqual({ appFailures: [base] });
        for (const appFailures of [null, false, 'failure', {}]) {
            expect(diagnosticsSchema.safeParse({ appFailures }).success).toBe(false);
            expect(sanitizeDiagnostics(rawDiagnostics(appFailures))).toEqual({});
        }
        expect(sanitizeDiagnostics({})).toEqual({});
        expect(sanitizeDiagnostics({ appFailures: [] })).toEqual({ appFailures: [] });
    });
});
