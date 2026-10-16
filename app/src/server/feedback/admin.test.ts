import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FeedbackAdminPage from '@/app/admin/feedback/page';
import { GET } from '@/app/api/admin/feedback/screenshot/route';

import { isFeedbackAdmin } from './admin';

const entrypoints = vi.hoisted(() => ({
    getUser: vi.fn(),
    execute: vi.fn(),
    env: { FEEDBACK_ADMIN_EMAILS: 'owner@ezil.work' as string | undefined },
}));

vi.mock('@/env', () => ({ env: entrypoints.env }));
vi.mock('@/server/db', () => ({ db: { execute: entrypoints.execute } }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: entrypoints.getUser } }) }));
vi.mock('next/navigation', () => ({
    notFound: () => { throw new Error('NOT_FOUND'); },
    redirect: (location: string) => { throw new Error(`REDIRECT ${location}`); },
}));

describe('feedback admin allow-list: fail closed', () => {
    it.each([
        ['owner@ezil.work', undefined, false],
        ['owner@ezil.work', '', false],
        ['owner@ezil.work', ' , , ', false],
        [undefined, 'owner@ezil.work', false],
        [null, 'owner@ezil.work', false],
        ['', 'owner@ezil.work', false],
        ['   ', ' , ', false],
        ['Owner@EZIL.work', 'owner@ezil.work', true],
        [' owner@ezil.work ', 'a@ezil.work, OWNER@ezil.work ,b@ezil.work', true],
        ['stranger@ezil.work', 'owner@ezil.work', false],
        ['owner@ezil.work.evil', 'owner@ezil.work', false],
        ['owner@ezil.work', '*@ezil.work', false],
    ])('email %s, allow-list %s → %s', (email, allowList, expected) => {
        expect(isFeedbackAdmin(email, allowList)).toBe(expected);
    });
});

describe('feedback Next.js entry points use current auth and the feedback allow-list', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'owner@ezil.work' };
    const request = () => new Request(`https://example.test/api/admin/feedback/screenshot?id=${id}`);

    beforeEach(() => {
        vi.clearAllMocks();
        entrypoints.env.FEEDBACK_ADMIN_EMAILS = 'owner@ezil.work';
        entrypoints.getUser.mockResolvedValue({ data: { user } });
        entrypoints.execute.mockResolvedValue([]);
    });

    it.each(['signed-out', 'not-admin', 'unconfigured'] as const)('404s page and screenshot for %s without touching the DB', async (denial) => {
        if (denial === 'unconfigured') entrypoints.env.FEEDBACK_ADMIN_EMAILS = undefined;
        else entrypoints.getUser.mockResolvedValue({ data: { user: denial === 'signed-out' ? null : { ...user, email: 'stranger@ezil.work' } } });
        await expect(FeedbackAdminPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NOT_FOUND');
        expect((await GET(request())).status).toBe(404);
        expect(entrypoints.execute).not.toHaveBeenCalled();
    });

    it('the screenshot route awaits the real audit adapter before selecting bytes', async () => {
        const png = new Uint8Array([137, 80, 78, 71]);
        entrypoints.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ bytes: png, contentType: 'image/png' }]);
        const response = await GET(request());
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
        const statements = entrypoints.execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q));
        expect(statements[0]!.sql).toMatch(/INSERT INTO ezil_feedback_access_log/);
        expect(statements[0]!.params.slice(1, 4)).toEqual([id, user.id, 'view_screenshot']);
        expect(statements[1]!.sql).toMatch(/SELECT bytes/);
    });

    it('the screenshot route withholds bytes when the actual audit insert fails', async () => {
        entrypoints.execute.mockRejectedValueOnce(new Error('audit unavailable'));
        const response = await GET(request());
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('');
        expect(entrypoints.execute).toHaveBeenCalledTimes(1);
    });

    it('the detail page withholds content when the audit insert fails', async () => {
        entrypoints.execute.mockRejectedValueOnce(new Error('audit unavailable'));
        await expect(FeedbackAdminPage({ searchParams: Promise.resolve({ id }) })).rejects.toThrow('audit unavailable');
        expect(entrypoints.execute).toHaveBeenCalledTimes(1);
    });

    it('rechecks the admin gate when a previously rendered delete action is submitted', async () => {
        entrypoints.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{
            id, createdAt: new Date(), category: 'bug', description: 'Private report',
            status: 'new', computerId: null, diagnostics: null, hasScreenshot: false,
        }]);
        const page = await FeedbackAdminPage({ searchParams: Promise.resolve({ id }) });
        const action = findFormAction(page);
        expect(action).toBeTypeOf('function');
        entrypoints.execute.mockClear();
        entrypoints.getUser.mockResolvedValue({ data: { user: null } });
        const form = new FormData();
        form.set('id', id);
        await expect(action!(form)).rejects.toThrow('NOT_FOUND');
        expect(entrypoints.execute).not.toHaveBeenCalled();
    });
});

/** Find the actual server action in the rendered element tree, without a browser. */
function findFormAction(node: unknown): ((form: FormData) => Promise<void>) | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
        for (const child of node) {
            const action = findFormAction(child);
            if (action) return action;
        }
        return undefined;
    }
    const element = node as { type?: unknown; props?: { action?: (form: FormData) => Promise<void>; children?: unknown } };
    return element.type === 'form' ? element.props?.action : findFormAction(element.props?.children);
}
