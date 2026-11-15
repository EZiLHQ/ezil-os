import { INFERENCE_VALIDATOR_SOURCE } from './contract.js';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fixture from './fixture.json';
import { parseBatch, validateInferenceTrace } from './schema';
import { handleAiTracesPost } from './http-handler';
import { retainTraces } from './store';
import { gatewayLink, queryTraces, tokenValue } from './admin';
import { TraceTable } from '../../app/admin/ai-traces/view';
const user = '30000000-0000-4000-8000-000000000001';
const other = '30000000-0000-4000-8000-000000000002';
const dialect = new PgDialect();
const trace = () => validateInferenceTrace(structuredClone(fixture))!;
const req = (body: unknown) => new Request('https://os.test/api/shell/ai-traces', { method: 'POST', body: JSON.stringify(body) });

describe('strict Carbon metadata', () => {
    it('injected validator literal exactly matches the unbundled source function', () => {
        expect(INFERENCE_VALIDATOR_SOURCE).toBe(validateInferenceTrace.toString());
    });
    it('preserves zero versus unknown, drops opaque non-UUID correlations, never invents verified edits', () => {
        expect(trace()).toEqual(fixture);
        expect(validateInferenceTrace({ ...fixture, modelAlias: 'README.md' })?.modelAlias).toBe('unknown');
        const zero = { ...fixture, usageSource: 'provider_reported', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
        expect(validateInferenceTrace(zero)?.usage).toEqual(zero.usage);
        expect(tokenValue(0)).toBe('0'); expect(tokenValue(undefined)).toBe('unknown');
        expect(validateInferenceTrace({ ...fixture, clientRequestId: 'opaque-safe-id' })?.clientRequestId).toBeNull();
    });
    it('rejects injections at every nested boundary, malformed enums, unsafe numerics and semantic claims', () => {
        for (const path of ['', 'offered', 'requested', 'results']) {
            const bad: Record<string, unknown> = structuredClone(fixture);
            const target = path ? bad[path] : bad;
            if (typeof target !== 'object' || target === null || Array.isArray(target)) throw new Error('Invalid injection fixture');
            Object.assign(target, { prompt: 'RAW' });
            expect(validateInferenceTrace(bad)).toBeNull();
        }
        for (const change of [{ userId: other }, { computerId: other }, { toolArguments: {} }, { error: 'secret' }, { verifiedFileChange: true },
            { usage: { inputTokens: 1, outputTokens: 2, signature: 'RAW' }, usageSource: 'provider_reported' },
            { compaction: { trigger: 'remote', count: 1, folded: 1, shortened: 1, path: '/x' } },
            { compaction: { trigger: 'invented', count: 1, folded: 1, shortened: 1 } },
            { modelAlias: '/home/private' }, { modelAlias: 'sk_secret_abcd' }, { finishReason: 'raw error' },
            { durationMs: Number.MAX_SAFE_INTEGER + 1 }, { attempts: -1 }, { estimatedInputTokens: 1.1 },
            { writeRequested: true }, { readHeavyWithoutVerifiedEdit: false }, { usageSource: 'provider_reported' }]) {
            expect(validateInferenceTrace({ ...fixture, ...change }), JSON.stringify(change)).toBeNull();
        }
        expect(parseBatch({ v: 1, traces: [fixture], userId: other })).toBeNull();
        expect(parseBatch({ v: 1, traces: Array(9).fill(fixture) })).toBeNull();
    });
    it('source contract keys and compaction enums match the actual sibling producer when present', () => {
        let source: string;
        try { source = readFileSync(new URL('../../../../../os-carbon-progress/extensions/ezil-models/src/inference-diagnostics.ts', import.meta.url), 'utf8'); }
        catch { return; }
        expect(source).toContain('ezil.inference.v1');
        for (const k of Object.keys(fixture)) expect(source).toContain(k);
    });
});

describe('authenticated deferred ingest and admin read', () => {
    it('unauthenticated, oversized actual bytes, hostile identity, bad JSON and database errors all fail soft', async () => {
        const db = { execute: vi.fn() }; const schedule = vi.fn();
        const deps = { getContext: async () => ({ user: { id: user }, db }), schedule };
        for (const request of [req({ v: 1, traces: [{ ...fixture, userId: other }] }), req({ v: 1, traces: [fixture], userId: other }),
            new Request('https://os.test', { method: 'POST', body: 'あ'.repeat(12000), headers: { 'content-length': '1' } }),
            new Request('https://os.test', { method: 'POST', body: '{' })]) expect((await handleAiTracesPost(request, deps)).status).toBe(202);
        await handleAiTracesPost(req({ v: 1, traces: [fixture] }), { ...deps, getContext: async () => ({ user: null, db }) });
        expect(schedule).not.toHaveBeenCalled(); expect(db.execute).not.toHaveBeenCalled();
        await handleAiTracesPost(req({ v: 1, traces: [fixture] }), deps);
        db.execute.mockRejectedValue(new Error('DO NOT LOG'));
        await expect(schedule.mock.calls[0]![0]()).resolves.toBeUndefined();
    });
    it('synthetic trace is scheduled under the authenticated user, then appears in admin query and SSR', async () => {
        const db = { execute: vi.fn().mockResolvedValue([]) }; const schedule = vi.fn();
        const response = await handleAiTracesPost(req({ v: 1, traces: [fixture] }), { getContext: async () => ({ user: { id: user }, db }), schedule });
        expect(response.headers.get('cache-control')).toBe('no-store'); expect(db.execute).not.toHaveBeenCalled();
        await schedule.mock.calls[0]![0]();
        const inserted = dialect.sqlToQuery(db.execute.mock.calls[0]![0]);
        expect(inserted.params).toContain(user); expect(inserted.params).not.toContain(other);
        expect(inserted.sql).toContain('ON CONFLICT (user_id, request_id) DO NOTHING');
        expect(inserted.sql).toContain('ezil_ai_trace_limits.used + excluded.used <=');
        expect(inserted.params).toContain(120); expect(inserted.sql).not.toMatch(/ezil_error|billing/);
        db.execute.mockResolvedValue([{ user_id: user, received_at: '2026-11-15T12:00:00Z', metadata: fixture }]);
        const result = await queryTraces(db, { email: 'founder@example.test', allowList: 'founder@example.test', userId: user, page: 999 });
        expect(result.rows).toHaveLength(1);
        const queried = dialect.sqlToQuery(db.execute.mock.calls[1]![0]);
        expect(queried.params).toContain(user); expect(queried.params).toContain(5000);
        const html = renderToStaticMarkup(createElement(TraceTable, { rows: result.rows }));
        expect(html).toContain('read-heavy'); expect(html).toContain('Verified file change: unknown'); expect(html).toContain('unknown / unknown');
        expect(html).not.toContain('stalled');
    });
    it('admin allowlist denies before SQL, invalid tenant IDs do not become all-user scans, pinned Gateway URLs only', async () => {
        const db = { execute: vi.fn() };
        for (const allowList of [undefined, '', 'other@example.test']) expect((await queryTraces(db, { email: 'founder@example.test', allowList })).available).toBe(false);
        expect((await queryTraces(db, { email: 'a', allowList: 'a', userId: 'SQL injection' })).available).toBe(false);
        expect(db.execute).not.toHaveBeenCalled();
        expect(gatewayLink(fixture.requestId, 'https://gateway.example.test')).toBe(`https://gateway.example.test/#requests?request_id=${fixture.requestId}&range=30d`);
        for (const origin of ['javascript:alert(1)', 'https://user:pass@gateway.test', 'https://gateway.test/path', 'https://gateway.test?evil', undefined]) expect(gatewayLink(fixture.requestId, origin)).toBeNull();
        expect(gatewayLink('bad-id', 'https://gateway.test')).toBeNull();
    });
    it('seven-day retention is bounded by batches and has an absent-table skip', async () => {
        const db = { execute: vi.fn().mockResolvedValue([]) };
        expect(await retainTraces(db)).toMatchObject({ skipped: true });
        db.execute.mockReset().mockResolvedValue(Array.from({ length: 1000 }, () => ({ request_id: fixture.requestId }))).mockResolvedValueOnce([{ present: true }]);
        expect(await retainTraces(db)).toMatchObject({ deleted: 10000, hitBudget: true });
        expect(db.execute).toHaveBeenCalledTimes(12);
        const queries = db.execute.mock.calls.slice(1).map(([q]) => dialect.sqlToQuery(q));
        for (const q of queries) { expect(q.sql).toContain("interval '7 days'"); expect(q.params).toContain(1000); }
    });
});
