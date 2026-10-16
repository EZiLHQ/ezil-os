import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import {
    deleteFeedbackReport, feedbackAdminQueries, handleFeedbackScreenshot, loadFeedbackList, loadFeedbackReport,
} from './admin-queries';
import type { FeedbackDb } from './access-log';

const id = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const admin = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const screenshot = new Uint8Array([137, 80, 78, 71]);
const request = (value: string = id) => new Request(`https://example.test/api/admin/feedback/screenshot?id=${encodeURIComponent(value)}`);

function deps() {
    return {
        user: { id: admin, email: 'owner@ezil.work' },
        allowList: 'owner@ezil.work',
        recordAccess: vi.fn().mockResolvedValue(undefined),
        listReportIds: vi.fn().mockResolvedValue([id, secondId]),
        listReports: vi.fn().mockResolvedValue([{ id, descriptionPreview: 'Private preview' }]),
        findReport: vi.fn().mockResolvedValue({ id, description: 'Private report' }),
        findScreenshot: vi.fn().mockResolvedValue({ bytes: screenshot, contentType: 'image/png' }),
        deleteReport: vi.fn().mockResolvedValue(undefined),
    };
}

describe('admin handlers: gate, validation, and audit before content', () => {
    it.each([
        { user: null },
        { user: { id: admin, email: 'stranger@ezil.work' } },
        { allowList: undefined },
        { allowList: ' , ' },
    ])('denies all handlers before any DB operation: %j', async (override) => {
        const d = { ...deps(), ...override };
        expect(await loadFeedbackList(d)).toBeNull();
        expect(await loadFeedbackReport(id, d)).toBeNull();
        expect(await deleteFeedbackReport(id, d)).toBe(false);
        expect((await handleFeedbackScreenshot(request(), d)).status).toBe(404);
        for (const fn of [d.recordAccess, d.listReportIds, d.listReports, d.findReport, d.findScreenshot, d.deleteReport]) {
            expect(fn).not.toHaveBeenCalled();
        }
    });

    it.each(['', 'not-a-uuid', `${id}.png`, "' OR true --"])('refuses invalid report ids: %s', async (badId) => {
        const d = deps();
        expect(await loadFeedbackReport(badId, d)).toBeNull();
        expect(await deleteFeedbackReport(badId, d)).toBe(false);
        const res = await handleFeedbackScreenshot(request(badId), d);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('');
        expect(d.recordAccess).not.toHaveBeenCalled();
        expect(d.findReport).not.toHaveBeenCalled();
        expect(d.findScreenshot).not.toHaveBeenCalled();
        expect(d.deleteReport).not.toHaveBeenCalled();
    });

    it('rejects absent and array ids', async () => {
        const d = deps();
        expect(await loadFeedbackReport([id], d)).toBeNull();
        expect(await deleteFeedbackReport(null, d)).toBe(false);
        expect((await handleFeedbackScreenshot(new Request('https://example.test/api/admin/feedback/screenshot'), d)).status).toBe(404);
        expect(d.recordAccess).not.toHaveBeenCalled();
    });

    it.each(['detail', 'screenshot', 'delete', 'list'] as const)('%s waits for the audit to finish before fetching content or deleting', async (handler) => {
        const d = deps();
        const order: string[] = [];
        let release!: () => void;
        d.recordAccess.mockImplementationOnce(() => new Promise<void>((resolve) => { release = () => { order.push('audit'); resolve(); }; }));
        const operation = handler === 'detail' ? d.findReport : handler === 'screenshot' ? d.findScreenshot : handler === 'delete' ? d.deleteReport : d.listReports;
        operation.mockImplementation(async () => { order.push('content'); return null; });
        const pending = handler === 'detail' ? loadFeedbackReport(id, d)
            : handler === 'screenshot' ? handleFeedbackScreenshot(request(), d)
            : handler === 'delete' ? deleteFeedbackReport(id, d) : loadFeedbackList(d);
        // List discovery is asynchronous and contains ids only.
        await Promise.resolve();
        expect(operation).not.toHaveBeenCalled();
        release();
        await pending;
        expect(order).toEqual(['audit', 'content']);
        expect(d.recordAccess).toHaveBeenCalledWith({ reportId: id, adminUserId: admin, action: handler === 'screenshot' ? 'view_screenshot' : handler === 'delete' ? 'delete' : 'view_report' });
    });

    it('withholds detail and list content, and prevents deletion, when logging throws', async () => {
        const d = deps();
        d.recordAccess.mockRejectedValue(new Error('audit unavailable'));
        await expect(loadFeedbackReport(id, d)).rejects.toThrow('audit unavailable');
        await expect(loadFeedbackList(d)).rejects.toThrow('audit unavailable');
        await expect(deleteFeedbackReport(id, d)).rejects.toThrow('audit unavailable');
        expect(d.findReport).not.toHaveBeenCalled();
        expect(d.listReports).not.toHaveBeenCalled();
        expect(d.deleteReport).not.toHaveBeenCalled();
    });

    it('logs every list row before reading any preview, including when a later audit write fails', async () => {
        const d = deps();
        await loadFeedbackList(d);
        expect(d.recordAccess.mock.calls.map(([entry]) => entry.reportId)).toEqual([id, secondId]);
        expect(d.listReports).toHaveBeenCalledWith([id, secondId]);
        d.listReports.mockClear();
        d.recordAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second audit failed'));
        await expect(loadFeedbackList(d)).rejects.toThrow('second audit failed');
        expect(d.listReports).not.toHaveBeenCalled();
    });

    it('returns the detail only after a successful audit, or null for a missing report', async () => {
        const d = deps();
        expect(await loadFeedbackReport(id, d)).toEqual({ id, description: 'Private report' });
        d.findReport.mockResolvedValue(null);
        expect(await loadFeedbackReport(id, d)).toBeNull();
    });

    it('returns an empty 500, with no screenshot read, on an audit failure', async () => {
        const d = deps();
        d.recordAccess.mockRejectedValue(new Error('private DB error'));
        const res = await handleFeedbackScreenshot(request(), d);
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(d.findScreenshot).not.toHaveBeenCalled();
    });

    it.each(['image/png', 'image/jpeg', 'image/webp'])('streams stored bytes as %s with all security headers', async (contentType) => {
        const d = deps();
        d.findScreenshot.mockResolvedValue({ bytes: screenshot, contentType });
        const res = await handleFeedbackScreenshot(request(), d);
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(screenshot);
        expect(res.headers.get('content-type')).toBe(contentType);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('content-disposition')).toBe('inline');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    });

    it('returns empty 404 for missing screenshots and empty 500 for failed reads', async () => {
        const d = deps();
        d.findScreenshot.mockResolvedValue(null);
        let res = await handleFeedbackScreenshot(request(), d);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('');
        d.findScreenshot.mockRejectedValue(new Error('read failed'));
        res = await handleFeedbackScreenshot(request(), d);
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('');
    });
});

function queryDb(rows: unknown[] = []) {
    const statements: ReturnType<PgDialect['sqlToQuery']>[] = [];
    const db: FeedbackDb = { execute: async (q) => { statements.push(new PgDialect().sqlToQuery(q)); return { rows }; } };
    return { queries: feedbackAdminQueries(db), statements };
}

describe('admin SQL scope and projection', () => {
    it('discovers newest ids with a fixed cap and fetches only audited summaries, never bytes', async () => {
        const { queries, statements } = queryDb([{ id }]);
        expect(await queries.listReportIds()).toEqual([id]);
        await queries.listReports([id, secondId]);
        expect(statements[0]!.sql).toMatch(/SELECT id FROM ezil_feedback_reports ORDER BY created_at DESC, id DESC LIMIT/);
        expect(statements[0]!.params).toEqual([50]);
        expect(statements[1]!.params).toEqual([140, id, secondId]);
        expect(statements[1]!.sql).toMatch(/WHERE r.id IN \(/);
        expect(statements[1]!.sql).toMatch(/left\(r.computer_id::text, 8\)/);
        expect(statements[1]!.sql).toMatch(/EXISTS \(SELECT 1 FROM ezil_feedback_attachments/);
        for (const { sql } of statements) {
            expect(sql).not.toMatch(/\bbytes\b|SELECT\s+\*|user_id/i);
        }
    });

    it('an empty id set does not fall back to an unscoped content query', async () => {
        const { queries, statements } = queryDb();
        expect(await queries.listReports([])).toEqual([]);
        expect(statements).toHaveLength(0);
    });

    it('details and screenshots parameterize report ids, with bytes only in the screenshot projection', async () => {
        const { queries, statements } = queryDb();
        expect(await queries.findReport(id)).toBeNull();
        expect(await queries.findScreenshot(id)).toBeNull();
        expect(statements[0]!.sql).not.toMatch(/\bbytes\b|SELECT\s+\*/i);
        expect(statements[1]!.sql).toMatch(/SELECT bytes, content_type/);
        for (const statement of statements) expect(statement.params).toEqual([id]);
    });

    it('deletes attachments before reports in one dependent statement, retaining audit history', async () => {
        const { queries, statements } = queryDb();
        await queries.deleteReport(id);
        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql).toMatch(/WITH deleted_attachments AS \(\s*DELETE FROM ezil_feedback_attachments[\s\S]+DELETE FROM ezil_feedback_reports/);
        expect(statements[0]!.sql).toMatch(/SELECT count\(\*\) FROM deleted_attachments/);
        expect(statements[0]!.sql).not.toContain('ezil_feedback_access_log');
        expect(statements[0]!.params).toEqual([id, id]);
    });
});
