import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    context: vi.fn(), get: vi.fn(), defaultComputer: vi.fn(), provider: vi.fn(), payload: vi.fn(), redirect: vi.fn(),
}));
// The page reads `env` at import for the per-user shell feature flags (round-3 feedback port); keep the test env-free.
vi.mock('@/env', () => ({ env: {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/server/api/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/api/root', () => ({ appRouter: { createCaller: () => ({ computer: { get: mocks.get, getOrCreateDefault: mocks.defaultComputer }, cloudflareGuacamole: { isConfigured: mocks.provider } }) } }));
vi.mock('@/server/shell/boot-payload', () => ({ buildShellBootPayload: mocks.payload, bootPayloadScript: () => '' }));
vi.mock('./boot-watchdog', () => ({ BootWatchdog: () => null }));
vi.mock('./hydration-signal', () => ({ HydrationSignal: () => null }));
import Page from './page';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ user: { id: 'owner' } });
    mocks.get.mockResolvedValue({ id, name: 'Chosen computer' });
    mocks.defaultComputer.mockResolvedValue({ computer: { id: 'default' }, created: false });
    mocks.provider.mockResolvedValue({ isConfigured: true });
    mocks.redirect.mockImplementation((url: string) => { throw Error(url); });
});
describe('OS entry URL', () => {
    it.each(['code', 'browser', 'settings'])('retains %s target and relative app parameters through the sign-in gate', async app => {
        mocks.context.mockResolvedValue({ user: null });
        let destination = '';
        try { await Page({ searchParams: Promise.resolve({ app, computer: id, path: '/project/a b', project: 'demo', settings: 'account' }) }); }
        catch (error) { destination = (error as Error).message; }
        const returnUrl = new URL(destination, 'https://os.example').searchParams.get('returnUrl')!;
        expect(returnUrl.startsWith('/os?')).toBe(true);
        expect(Object.fromEntries(new URL(returnUrl, 'https://os.example').searchParams)).toEqual({ app, computer: id, path: '/project/a b', project: 'demo', settings: 'account' });
        expect(mocks.defaultComputer).not.toHaveBeenCalled();
        expect(mocks.get).not.toHaveBeenCalled();
    });
    it('keeps attacker-controlled values inside a fixed relative OS return URL', async () => {
        mocks.context.mockResolvedValue({ user: null });
        await expect(Page({ searchParams: Promise.resolve({ app: ['code', 'browser'], returnUrl: '//evil.example', path: '\\evil.example' }) })).rejects.toThrow('/login?');
        const dest = mocks.redirect.mock.calls[0][0];
        const returned = new URL(new URL(dest, 'https://os.example').searchParams.get('returnUrl')!, 'https://os.example');
        expect(returned.origin).toBe('https://os.example');
        expect(returned.pathname).toBe('/os');
        expect(returned.searchParams.getAll('app')).toEqual(['code', 'browser']);
    });
    it('uses existing ownership-checked lookup for a selected computer, including refresh', async () => {
        for (let i = 0; i < 2; i++) await Page({ searchParams: Promise.resolve({ app: 'code', computer: id }) });
        expect(mocks.get).toHaveBeenCalledTimes(2);
        expect(mocks.get).toHaveBeenCalledWith({ id });
        expect(mocks.defaultComputer).not.toHaveBeenCalled();
        expect(mocks.payload).toHaveBeenLastCalledWith(expect.objectContaining({ computer: { id, name: 'Chosen computer' }, isNew: false }));
    });
    it.each(['bad', ['one', 'two'], '//evil.example'])('does not silently open the default for invalid target %j', async computer => {
        const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ computer }) }));
        expect(html).toContain('open your computer</h1>');
        expect(mocks.get).not.toHaveBeenCalled();
        expect(mocks.defaultComputer).not.toHaveBeenCalled();
        expect(mocks.payload).not.toHaveBeenCalled();
    });
    it('does not substitute another computer for an unowned target', async () => {
        mocks.get.mockRejectedValue(Error('NOT_FOUND'));
        const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ computer: id }) }));
        expect(html).toContain('open your computer</h1>');
        expect(mocks.defaultComputer).not.toHaveBeenCalled();
    });
    it('keeps ordinary default-computer entry working', async () => {
        await Page({});
        expect(mocks.defaultComputer).toHaveBeenCalledTimes(1);
        expect(mocks.get).not.toHaveBeenCalled();
    });
});
