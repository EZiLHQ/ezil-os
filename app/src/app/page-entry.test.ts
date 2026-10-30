import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ user: null as { id: string } | null, enabled: false }));
const redirect = vi.hoisted(() => vi.fn((destination: string): never => { throw new Error(`redirect:${destination}`); }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock('@/server/billing/config', async importOriginal => {
    const actual = await importOriginal<typeof import('@/server/billing/config')>();
    return { ...actual, readBillingConfig: () => actual.readBillingConfig({ PRICING_PAGE_ENABLED: state.enabled ? '1' : undefined }) };
});

import HomePage from './page';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => {
    state.user = null;
    state.enabled = false;
    redirect.mockClear();
});

describe('root entry routing: / is the OS or its login, never a marketing page', () => {
    it.each([false, true])('anonymous visitors always get the computer-like login, never a marketing home (flag: %s)', async enabled => {
        state.enabled = enabled;
        await expect(HomePage()).rejects.toThrow('redirect:/login');
        expect(redirect).toHaveBeenCalledExactlyOnceWith('/login');
    });

    it.each([false, true])('signed-in visitors always enter /os (flag: %s)', async enabled => {
        state.enabled = enabled;
        state.user = { id: 'signed-in-user' };
        await expect(HomePage()).rejects.toThrow('redirect:/os');
        expect(redirect).toHaveBeenCalledExactlyOnceWith('/os');
    });

    it('keeps the login logo a document link so the OS can boot', () => {
        const source = read('./login/page.tsx');
        const softLink = /<Link[^>]*href=\{Routes\.HOME\}/;
        expect(softLink.test('<Link href={Routes.HOME}>Home</Link>')).toBe(true);
        expect(source).toMatch(/<a href=\{Routes\.HOME\}/);
        expect(source).not.toMatch(softLink);
    });
});
