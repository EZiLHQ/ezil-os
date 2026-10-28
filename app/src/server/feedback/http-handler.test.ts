import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';
import { handleFeedbackRequest, type FeedbackHandlerDeps } from './http-handler';
import type { FeedbackDb } from './ingest';
import { FEEDBACK_LIMITS } from './types';

const USER = { id: '550e8400-e29b-41d4-a716-446655440000', email: 'alice@example.com' };
const ID = '550e8400-e29b-41d4-a716-446655440001';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const VALID = { v: 1, clientRequestId: ID, category: 'bug', description: 'The button is stuck.' };
const SCREENSHOT = { contentType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' };
const URL = 'https://example.test/api/shell/feedback';

const JSON_HEADERS = { 'content-type': 'application/json' };
function request(body: unknown = VALID) { return new Request(URL, { method: 'POST', body: JSON.stringify(body), headers: JSON_HEADERS }); }
function harness(options: { hour?: number; day?: number; budget?: number; replay?: boolean; list?: boolean; owned?: boolean; fail?: boolean } = {}) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const proxy = drizzle(async (sql, params) => {
        statements.push({ sql, params });
        if (options.fail) throw new Error('postgres://secret@private-host user submitted private text');
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('count(*)')) return { rows: [[options.hour ?? 0, options.day ?? 0]] };
        if (sql.includes('sum(')) return { rows: [[options.budget ?? 0, 0]] };
        if (sql.includes('order by')) return { rows: options.list ? [[ID, NOW.toISOString(), 'bug', 'd'.repeat(200), true, 'new']] : [] };
        if (sql.startsWith('select') && sql.includes('"client_request_id"')) return { rows: options.replay ? [[ID, NOW.toISOString(), true]] : [] };
        if ((sql.startsWith('select') && sql.includes('"ezil_feedback_reports"'))
            || (sql.startsWith('delete') && sql.includes('returning'))) return { rows: options.owned ? [[ID]] : [] };
        return { rows: [] };
    }, { schema });
    const db = { select: proxy.select.bind(proxy), transaction: (cb: (tx: typeof proxy) => Promise<unknown>) => cb(proxy) } as unknown as FeedbackDb;
    const getContext = vi.fn(async () => ({ user: USER as typeof USER | null, db }));
    const deps: FeedbackHandlerDeps = { getContext, env: { EZIL_OS_FEEDBACK: '1' }, now: () => NOW };
    return { deps, statements, getContext, db };
}

describe('feedback HTTP boundary', () => {
    it.each(['POST', 'GET', 'DELETE'])('requires auth for %s', async (method) => {
        const h = harness(); h.getContext.mockResolvedValue({ user: null, db: h.db });
        const response = await handleFeedbackRequest(new Request(URL, { method }), h.deps);
        expect(response.status).toBe(401); expect(h.statements).toEqual([]);
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it.each(['POST', 'GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'])('is 404 with feature off for %s, without touching auth or DB', async (method) => {
        const h = harness(); h.deps.env = {};
        const response = await handleFeedbackRequest(new Request(URL, { method }), h.deps);
        expect(response.status).toBe(404); expect(h.getContext).not.toHaveBeenCalled(); expect(h.statements).toEqual([]);
    });

    it.each(['POST', 'GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'])('is 404 outside the pilot for %s', async (method) => {
        const h = harness(); h.deps.env.FEEDBACK_PILOT_EMAILS = 'someone-else@example.com';
        expect((await handleFeedbackRequest(new Request(URL, { method }), h.deps)).status).toBe(404);
        expect(h.statements).toEqual([]);
    });

    it('honors a matching pilot email', async () => {
        const h = harness(); h.deps.env.FEEDBACK_PILOT_EMAILS = ' ALICE@EXAMPLE.COM ';
        expect((await handleFeedbackRequest(request(), h.deps)).status).toBe(201);
    });

    it.each([
        { ...VALID, userId: USER.id }, { ...VALID, clientRequestId: 'bad-uuid' }, { ...VALID, computerId: 'bad-uuid' },
        { ...VALID, description: 'x'.repeat(4001) }, { ...VALID, description: '  ' },
        { ...VALID, diagnostics: { cookie: 'never collect' } },
        { ...VALID, diagnostics: { browser: { family: 'Chrome', major: 130, email: 'private@example.com' } } },
        { ...VALID, screenshot: { ...SCREENSHOT, width: 1 } },
    ])('returns fixed strict 400 for invalid payload %#', async (body) => {
        const h = harness(); h.deps.env.EZIL_OS_FEEDBACK_SCREENSHOTS = '1';
        const response = await handleFeedbackRequest(request(body), h.deps);
        expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_request' }); expect(h.statements).toEqual([]);
    });

    it.each(['{not-json', '', 'null', '[]'])('rejects malformed or non-object JSON: %j', async (body) => {
        const h = harness();
        expect((await handleFeedbackRequest(new Request(URL, { method: 'POST', body, headers: JSON_HEADERS }), h.deps)).status).toBe(400);
        expect(h.statements).toEqual([]);
    });

    it.each([false, true])('enforces actual body bytes with screenshot flag %s despite false Content-Length', async (screenshots) => {
        const h = harness(); if (screenshots) h.deps.env.EZIL_OS_FEEDBACK_SCREENSHOTS = '1';
        const limit = screenshots ? FEEDBACK_LIMITS.bodyBytesWithScreenshot : FEEDBACK_LIMITS.bodyBytesNoScreenshot;
        const response = await handleFeedbackRequest(new Request(URL, { method: 'POST', body: 'x'.repeat(limit + 1), headers: { ...JSON_HEADERS, 'content-length': '10' } }), h.deps);
        expect(response.status).toBe(413); expect(h.statements).toEqual([]);
    });

    it('counts multibyte UTF-8 and cancels the over-limit stream', async () => {
        const h = harness(); const cancel = vi.fn(); let chunk = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) { chunk++; controller.enqueue(new TextEncoder().encode('🙂'.repeat(4097))); }, cancel,
        });
        const req = new Request(URL, { method: 'POST', body, headers: JSON_HEADERS, duplex: 'half' } as RequestInit);
        expect((await handleFeedbackRequest(req, h.deps)).status).toBe(413);
        expect(cancel).toHaveBeenCalled(); expect(chunk).toBeLessThanOrEqual(3); expect(h.statements).toEqual([]);
    });

    it('accepts a body exactly at its byte cap', async () => {
        const h = harness(); const raw = JSON.stringify(VALID);
        const body = raw + ' '.repeat(FEEDBACK_LIMITS.bodyBytesNoScreenshot - Buffer.byteLength(raw));
        expect((await handleFeedbackRequest(new Request(URL, { method: 'POST', body, headers: JSON_HEADERS }), h.deps)).status).toBe(201);
    });

    it('rejects malformed UTF-8 rather than storing replacement characters', async () => {
        const h = harness();
        const body = Buffer.concat([Buffer.from(JSON.stringify(VALID).slice(0, -2)), Buffer.from([0xff]), Buffer.from('"}')]);
        expect((await handleFeedbackRequest(new Request(URL, { method: 'POST', body, headers: JSON_HEADERS }), h.deps)).status).toBe(400);
        expect(h.statements).toEqual([]);
    });

    it.each([undefined, 'text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'application/json-patch+json'])(
        'refuses a POST whose content-type is %s with 415, before reading the body or touching the DB', async (type) => {
            const h = harness();
            const req = new Request(URL, { method: 'POST', body: JSON.stringify(VALID) });
            if (type === undefined) req.headers.delete('content-type'); else req.headers.set('content-type', type);
            const response = await handleFeedbackRequest(req, h.deps);
            expect(response.status).toBe(415); expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
            expect(response.headers.get('cache-control')).toContain('no-store');
            expect(req.bodyUsed).toBe(false); expect(h.statements).toEqual([]);
        });

    it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON;charset=UTF-8', ' application/json '])('accepts content-type %j', async (type) => {
        const h = harness();
        const response = await handleFeedbackRequest(new Request(URL, { method: 'POST', body: JSON.stringify(VALID), headers: { 'content-type': type } }), h.deps);
        expect(response.status).toBe(201);
    });

    it('a wrong content-type is still 404 with the feature off and 401 without a session', async () => {
        const off = harness(); off.deps.env = {};
        const text = () => new Request(URL, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
        expect((await handleFeedbackRequest(text(), off.deps)).status).toBe(404);
        const anon = harness(); anon.getContext.mockResolvedValue({ user: null, db: anon.db });
        expect((await handleFeedbackRequest(text(), anon.deps)).status).toBe(401);
    });

    it('stamps the deployed commit from deps on the inserted report, never from the body', async () => {
        const h = harness(); h.deps.deploySha = '46698745a1b2c3d4e5f60718293a4b5c6d7e8f90';
        expect((await handleFeedbackRequest(request(), h.deps)).status).toBe(201);
        const insert = h.statements.find((s) => s.sql.startsWith('insert into "ezil_feedback_reports"'))!;
        expect(insert.sql).toContain('"deploy_sha"');
        expect(insert.params).toContain('46698745a1b2c3d4e5f60718293a4b5c6d7e8f90');
        const forged = harness();
        expect((await handleFeedbackRequest(request({ ...VALID, deploySha: 'abc1234' }), forged.deps)).status).toBe(400);
    });

    it.each([{ hour: 10 }, { day: 30 }])('returns 429 at the DB rate limit %j', async (options) => {
        const h = harness(options); const response = await handleFeedbackRequest(request(), h.deps);
        expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: 'rate_limited' });
        expect(h.statements.some((s) => s.sql.startsWith('insert'))).toBe(false);
    });

    it('returns the exact original FeedbackCreated for an idempotent replay', async () => {
        const h = harness({ replay: true, hour: 10 }); const response = await handleFeedbackRequest(request(), h.deps);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: ID, createdAt: NOW.toISOString(), screenshotAccepted: true });
        expect(h.statements.some((s) => s.sql.startsWith('insert') || s.sql.includes('count(*)'))).toBe(false);
    });

    it('returns 201 only after the report is written', async () => {
        const h = harness(); const response = await handleFeedbackRequest(request(), h.deps);
        expect(response.status).toBe(201); expect(await response.json()).toEqual({ id: expect.any(String), createdAt: NOW.toISOString(), screenshotAccepted: false });
        expect(h.statements.some((s) => s.sql.startsWith('insert'))).toBe(true);
    });

    it('accepts an explicit null screenshot when screenshots are off (the shell always sends the key)', async () => {
        const h = harness(); const response = await handleFeedbackRequest(request({ ...VALID, screenshot: null }), h.deps);
        expect(response.status).toBe(201);
    });

    it.each([SCREENSHOT])('rejects a screenshot when screenshots are off', async (screenshot) => {
        const h = harness(); const response = await handleFeedbackRequest(request({ ...VALID, screenshot }), h.deps);
        expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_request' }); expect(h.statements).toEqual([]);
    });

    it.each([
        [{ ...SCREENSHOT, contentType: 'image/jpeg' }, 400],
        [{ ...SCREENSHOT, dataBase64: Buffer.alloc(FEEDBACK_LIMITS.imageBytesMax + 1).toString('base64') }, 413],
        [{ ...SCREENSHOT, dataBase64: (() => { const bytes = Buffer.from(SCREENSHOT.dataBase64, 'base64'); bytes.writeUInt32BE(4097, 16); return bytes.toString('base64'); })() }, 400],
    ])('rejects invalid screenshot %#', async (screenshot, status) => {
        const h = harness(); h.deps.env.EZIL_OS_FEEDBACK_SCREENSHOTS = '1';
        const response = await handleFeedbackRequest(request({ ...VALID, screenshot }), h.deps);
        expect(response.status).toBe(status); expect(h.statements).toEqual([]);
    });

    it('stores the report with screenshotAccepted false when attachment budget is exhausted', async () => {
        const h = harness({ budget: FEEDBACK_LIMITS.globalAttachmentBytesPerDay }); h.deps.env.EZIL_OS_FEEDBACK_SCREENSHOTS = '1';
        const response = await handleFeedbackRequest(request({ ...VALID, screenshot: SCREENSHOT }), h.deps);
        expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ screenshotAccepted: false });
        const inserts = h.statements.filter((s) => s.sql.startsWith('insert'));
        expect(inserts).toHaveLength(1); expect(inserts[0]!.sql).toContain('ezil_feedback_reports');
    });

    it('GET returns only scoped summaries with bounded previews', async () => {
        const h = harness({ list: true }); const response = await handleFeedbackRequest(new Request(URL), h.deps);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ reports: [{ id: ID, createdAt: NOW.toISOString(), category: 'bug', descriptionPreview: 'd'.repeat(140), hasScreenshot: true, status: 'new' }] });
        expect(h.statements[0]!.params).toEqual([USER.id, 50]);
        expect(h.statements[0]!.sql).toContain('where "ezil_feedback_reports"."user_id" = $1');
    });

    it.each(['', '?id=not-a-uuid'])('DELETE validates id %s before querying', async (query) => {
        const h = harness(); expect((await handleFeedbackRequest(new Request(URL + query, { method: 'DELETE' }), h.deps)).status).toBe(400);
        expect(h.statements).toEqual([]);
    });

    it('DELETE gives 404 for another user or a missing report', async () => {
        const h = harness(); const response = await handleFeedbackRequest(new Request(`${URL}?id=${ID}`, { method: 'DELETE' }), h.deps);
        expect(response.status).toBe(404); expect(h.statements.some((s) => s.sql.startsWith('delete'))).toBe(false);
        expect(h.statements[1]!.params.slice(0, 2)).toEqual([ID, USER.id]);
    });

    it('DELETE returns an empty 204 after both scoped deletes', async () => {
        const h = harness({ owned: true }); const response = await handleFeedbackRequest(new Request(`${URL}?id=${ID}`, { method: 'DELETE' }), h.deps);
        expect(response.status).toBe(204); expect(await response.text()).toBe('');
        expect(h.statements.filter((s) => s.sql.startsWith('delete'))).toHaveLength(2);
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('returns a generic uncached error for DB failures', async () => {
        const h = harness({ fail: true }); const response = await handleFeedbackRequest(request(), h.deps);
        expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'internal_error' });
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('returns a generic error for auth failures', async () => {
        const h = harness(); h.getContext.mockRejectedValue(new Error('private credentials'));
        const response = await handleFeedbackRequest(request(), h.deps);
        expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'internal_error' });
    });

    it('returns 405 for unsupported methods when enabled', async () => {
        const h = harness(); expect((await handleFeedbackRequest(new Request(URL, { method: 'PATCH' }), h.deps)).status).toBe(405);
        expect(h.statements).toEqual([]);
    });
});

describe('route/proxy wiring', () => {
    it('the feedback route is covered by the actual exported proxy matcher, not its image exclusion', () => {
        // Read only the exported constant to avoid loading Supabase/env in a
        // unit test; JSON decodes the literal's escaped regex (proxy.ts:28).
        const source = readFileSync(new globalThis.URL('../../proxy.ts', import.meta.url), 'utf8');
        const matcher = source.slice(source.indexOf('export const config')).match(/^\s*'(\/[^'\n]+)'/m)?.[1];
        expect(matcher).toBeDefined();
        const pattern = new RegExp(`^${JSON.parse(`"${matcher}"`)}$`);
        expect('/api/shell/feedback').toMatch(pattern);
        for (const extension of ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp']) expect(`/api/shell/feedback.${extension}`).not.toMatch(pattern);
    });

    it('wires auth through shell-http and explicitly gates every Next route method', () => {
        const source = readFileSync(new globalThis.URL('../../app/api/shell/feedback/route.ts', import.meta.url), 'utf8');
        expect(source).toContain("headers.set('x-trpc-source', 'shell-http')");
        expect(source).toContain('createTRPCContext({ headers })');
        expect(source).toContain('handleFeedbackRequest(req,');
        for (const method of ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD']) expect(source).toContain(`export const ${method} = handle`);
    });
});
