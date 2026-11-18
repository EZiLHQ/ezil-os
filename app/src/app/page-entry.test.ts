import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ user: null as { id: string } | null, enabled: false, auth0: true }));
const redirect = vi.hoisted(() => vi.fn((destination: string): never => { throw new Error(`redirect:${destination}`); }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock('@/server/billing/config', async importOriginal => {
    const actual = await importOriginal<typeof import('@/server/billing/config')>();
    return { ...actual, readBillingConfig: () => actual.readBillingConfig({ PRICING_PAGE_ENABLED: state.enabled ? '1' : undefined }) };
});

vi.mock('@/server/auth/auth0', () => ({ auth0Enabled: () => state.auth0 }));

import HomePage from './page';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => {
    state.user = null;
    state.enabled = false;
    state.auth0 = true;
    redirect.mockClear();
});

describe('root entry routing: / is the OS or its login, never a marketing page', () => {
    it.each([false, true])('anonymous visitors always get the computer-like login, never a marketing home (flag: %s)', async enabled => {
        state.enabled = enabled;
        await expect(HomePage({})).rejects.toThrow('redirect:/login');
        expect(redirect).toHaveBeenCalledExactlyOnceWith('/login');
    });

    it.each([false, true])('signed-in visitors always enter /os (flag: %s)', async enabled => {
        state.enabled = enabled;
        state.user = { id: 'signed-in-user' };
        await expect(HomePage({})).rejects.toThrow('redirect:/os');
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

describe('/?coupon=<alias> goes to Billing through the normal sign-in', () => {
    const go = (query: Record<string, string | string[] | undefined>) => HomePage({ searchParams: Promise.resolve(query) });
    const billing = '/os?settings=billing&coupon=midhun';
    it('signed in: straight to Billing with the canonical alias', async () => {
        state.user = { id: 'u' };
        await expect(go({ coupon: ' MidHun ' })).rejects.toThrow(`redirect:${billing}`);
        expect(redirect).toHaveBeenCalledExactlyOnceWith(billing);
    });
    it('signed out: the EZiL ID sign-in returns to Billing, no separate landing or login form', async () => {
        await expect(go({ coupon: 'midhun' })).rejects.toThrow('redirect:/auth/auth0/login?');
        expect(redirect).toHaveBeenCalledExactlyOnceWith(`/auth/auth0/login?${new URLSearchParams({ returnUrl: billing })}`);
    });
    it('signed out with sign-in disabled: the login page keeps the same destination', async () => {
        state.auth0 = false;
        await expect(go({ coupon: 'midhun' })).rejects.toThrow('redirect:/login?');
        expect(redirect).toHaveBeenCalledExactlyOnceWith(`/login?${new URLSearchParams({ returnUrl: billing })}`);
    });
    it.each([[['midhun', 'other']], ['bad alias!'], [''], ['a'], ['x'.repeat(33)], ['mid_hun'], ['http://evil.example'], [undefined]])('malformed or repeated %j reaches Billing marked invalid, never the public offer', async coupon => {
        state.user = { id: 'u' };
        await expect(go({ coupon })).rejects.toThrow('redirect:/os?settings=billing&coupon_entry=invalid');
    });
    it('a link carrying a foreign destination field cannot choose where it goes', async () => {
        state.user = { id: 'u' };
        await expect(go({ coupon: 'midhun', returnUrl: 'https://evil.example', redirect: '//evil.example' })).rejects.toThrow(`redirect:${billing}`);
    });
    it.each(['ab', 'x'.repeat(32)])('the backend grammar accepts %j (2 to 32 characters)', async coupon => {
        state.user = { id: 'u' };
        await expect(go({ coupon })).rejects.toThrow(`redirect:/os?settings=billing&coupon=${coupon}`);
    });
    it('no coupon key keeps the plain entry', async () => {
        state.user = { id: 'u' };
        await expect(go({ other: 'x' })).rejects.toThrow('redirect:/os');
        expect(redirect).toHaveBeenCalledExactlyOnceWith('/os');
    });
});
