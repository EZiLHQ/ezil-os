import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    context: vi.fn(), get: vi.fn(), defaultComputer: vi.fn(), provider: vi.fn(), payload: vi.fn(), redirect: vi.fn(), notFound: vi.fn(),
}));
// The page reads `env` at import for the per-user shell feature flags (round-3 feedback port); keep the test env-free.
vi.mock('@/env', () => ({ env: {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock('@/server/api/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/api/root', () => ({ appRouter: { createCaller: () => ({ computer: { get: mocks.get, getOrCreateDefault: mocks.defaultComputer }, cloudflareGuacamole: { isConfigured: mocks.provider } }) } }));
vi.mock('@/server/shell/boot-payload', () => ({ buildShellBootPayload: mocks.payload, bootPayloadScript: () => '' }));
vi.mock('./boot-watchdog', () => ({ BootWatchdog: () => null }));
vi.mock('./hydration-signal', () => ({ HydrationSignal: () => null }));
import Page from './page';
import AppPage from '../app/[appId]/page';
import { safeReturnUrl } from '@/utils/constants';
// The shell's own parser, so the sign-in round trip is proved end to end.
import { parseAppLink } from '../../../../shell/ezil/app-link.js';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ user: { id: 'owner' } });
    mocks.get.mockResolvedValue({ id, name: 'Chosen computer' });
    mocks.defaultComputer.mockResolvedValue({ computer: { id: 'default' }, created: false });
    mocks.provider.mockResolvedValue({ isConfigured: true });
    mocks.redirect.mockImplementation((url: string) => { throw Error(url); });
    mocks.notFound.mockImplementation(() => { throw Error('NEXT_NOT_FOUND'); });
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

const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const R = '12345678-9abc-4def-8123-456789abcdef';
const app = (appId: string, query: Record<string, string | string[]> = {}) =>
    AppPage({ params: Promise.resolve({ appId }), searchParams: Promise.resolve(query) });
async function signInDestination(render: () => Promise<unknown>) {
    mocks.context.mockResolvedValue({ user: null });
    await expect(render()).rejects.toThrow('/login?');
    return new URL(mocks.redirect.mock.calls.at(-1)![0], 'https://os.example').searchParams.get('returnUrl')!;
}
describe('/app/<appId> (docs/APP-ROUTES.md)', () => {
    it('renders exactly the /os document — not a redirect', async () => {
        const os = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
        for (const appId of ['code', 'settings', 'browser', 'desktop']) {
            expect(renderToStaticMarkup(await app(appId) as React.ReactElement), appId).toBe(os);
        }
        expect(os).toContain('id="ezil-os-root"');
        expect(os).toContain('/os/bundle.min.js');
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('🔴 sign-in returns to the full path and query, and the shell still reads the project from it', async () => {
        const returnUrl = await signInDestination(() => app('code', { project: P, repo: R, path: 'src/main.ts' }));
        expect(returnUrl).toBe(`/app/code?project=${P}&repo=${R}&path=src/main.ts`);
        // The login page narrows it with safeReturnUrl; it must survive as is…
        expect(safeReturnUrl(returnUrl)).toBe(returnUrl);
        // …and still be a Code link with its path, not one whose `/` came back encoded.
        expect(parseAppLink(returnUrl, [{ id: 'code' }])).toEqual({ id: 'code', project: { projectId: P, repoId: R, path: 'src/main.ts' } });
        expect(mocks.defaultComputer).not.toHaveBeenCalled();
    });

    it.each([
        ['settings', { tab: 'billing' }, '/app/settings?tab=billing'],
        ['browser', { computer: id }, `/app/browser?computer=${id}`],
        ['desktop', {}, '/app/desktop'],
    ] as const)('sign-in for /app/%s returns to it', async (appId, query, expected) => {
        const returnUrl = await signInDestination(() => app(appId, query));
        expect(returnUrl).toBe(expected);
        expect(safeReturnUrl(returnUrl)).toBe(expected);
    });

    it('🔴 an id the shell registry does not know is a 404, before any session lookup', async () => {
        for (const appId of ['unknown', 'launcher', '__proto__', 'constructor', 'Code', '..', '%2e%2e', 'code/x', '']) {
            await expect(app(appId), appId).rejects.toThrow('NEXT_NOT_FOUND');
        }
        expect(mocks.context).not.toHaveBeenCalled();
        expect(mocks.redirect).not.toHaveBeenCalled();
        // Positive control: the same call with a known id gets as far as the gate.
        await expect(app('code')).resolves.toBeTruthy();
        expect(mocks.context).toHaveBeenCalledTimes(1);
    });

    it('the /os page will not build a return URL from an app id that is not allowlisted', async () => {
        await expect(Page({ params: Promise.resolve({ appId: 'unknown' }), searchParams: Promise.resolve({}) })).rejects.toThrow('Not a shell app id');
        expect(mocks.context).not.toHaveBeenCalled();
    });

    it('a selected computer is still the ownership-checked lookup', async () => {
        await app('code', { computer: id });
        expect(mocks.get).toHaveBeenCalledWith({ id });
        expect(mocks.defaultComputer).not.toHaveBeenCalled();
        const html = renderToStaticMarkup(await app('code', { computer: 'bad' }) as React.ReactElement);
        expect(html).toContain('open your computer</h1>');
    });
});
