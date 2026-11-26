import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    headers:vi.fn(), stage:vi.fn(), identity:vi.fn(), context: vi.fn(), get: vi.fn(), defaultComputer: vi.fn(), provider: vi.fn(), payload: vi.fn(), redirect: vi.fn(), notFound: vi.fn(),
}));
// The page reads `env` at import for the per-user shell feature flags (round-3 feedback port); keep the test env-free.
vi.mock('@/env', () => ({ env: {} }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('@/server/git/assignment-enrollment',()=>({assignmentEnrollmentEnabled:mocks.stage}));
vi.mock('@/server/auth/retained-identity',()=>({retainedIdentity:mocks.identity}));
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
import { routeLaunchContext } from '../../../../shell/ezil/app-history.js';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers());
    mocks.stage.mockReturnValue(true);
    mocks.identity.mockResolvedValue({subject:'auth0|owner'});
    mocks.context.mockResolvedValue({ user: { id: 'owner' } });
    mocks.get.mockResolvedValue({ id, name: 'Chosen computer' });
    mocks.defaultComputer.mockResolvedValue({ computer: { id: 'default' }, created: false });
    mocks.provider.mockResolvedValue({ isConfigured: true });
    mocks.redirect.mockImplementation((url: string) => { throw Error(url); });
    mocks.notFound.mockImplementation(() => { throw Error('NEXT_NOT_FOUND'); });
});
describe('OS entry URL', () => {
    it('🔴 a signed-in framed Code assignment whose retained EZiL ID is refused gets the silent sign-in document, not the shell',async()=>{
        const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git', NOTICE='Continue to EZiL OS sign-in from your Universe assignment tab';
        const open=(query:Record<string,string>,appId='code')=>AppPage({params:Promise.resolve({appId}),searchParams:Promise.resolve(query)});
        mocks.headers.mockResolvedValue(new Headers({'sec-fetch-dest':'iframe'}));
        mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        const html=renderToStaticMarkup(await open({assignment:id,repo}));
        expect(html).toContain(NOTICE);
        expect(html).not.toContain('/os/bundle.min.js');
        expect(mocks.identity).toHaveBeenCalledExactlyOnceWith('owner');
        expect(mocks.defaultComputer).not.toHaveBeenCalled();
        // Kept: the shell, exactly as before.
        mocks.identity.mockResolvedValue({subject:'auth0|owner'});
        expect(renderToStaticMarkup(await open({assignment:id,repo}))).toContain('/os/bundle.min.js');
        // Every other entry never asks for the identity at all: a top-level tab, another app, a non-canonical or
        // unassigned repository, a disabled stage, and a delegated caller all keep the shell.
        mocks.identity.mockClear();mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        const shell=async(query:Record<string,string>,appId?:string)=>expect(renderToStaticMarkup(await open(query,appId))).toContain('/os/bundle.min.js');
        await shell({assignment:id,repo},'desktop');
        await shell({repo});
        await shell({assignment:id,repo:'https://github.com/example/other.git'});
        await shell({assignment:id,repo,attempt:id});
        mocks.stage.mockReturnValue(false);await shell({assignment:id,repo});mocks.stage.mockReturnValue(true);
        mocks.context.mockResolvedValue({user:{id:'owner'},delegation:{status:'accepted'}});await shell({assignment:id,repo});
        mocks.context.mockResolvedValue({user:{id:'owner'}});
        mocks.headers.mockResolvedValue(new Headers({'sec-fetch-dest':'document'}));await shell({assignment:id,repo});
        expect(mocks.identity).not.toHaveBeenCalled();
    });
    it('keeps an unauthenticated embedded Code assignment off the identity-provider frame path',async()=>{
        mocks.context.mockResolvedValue({user:null});
        mocks.headers.mockResolvedValue(new Headers({'sec-fetch-dest':'iframe'}));
        const params={appId:'code'};
        const searchParams={assignment:id,repo:'https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git'};
        const call=(query:Record<string,string>)=>AppPage({params:Promise.resolve(params),searchParams:Promise.resolve(query)});
        const html=renderToStaticMarkup(await call(searchParams));
        expect(html).toContain('Continue to EZiL OS sign-in from your Universe assignment tab');
        expect(mocks.redirect).not.toHaveBeenCalled();
        expect(mocks.defaultComputer).not.toHaveBeenCalled();
        await expect(call({...searchParams,repo:'https://github.com/example/other.git'})).rejects.toThrow('/login?');
        mocks.headers.mockResolvedValue(new Headers({'sec-fetch-dest':'document'}));
        await expect(call(searchParams)).rejects.toThrow('/login?');
    });
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
        ['code', {}, '/app/code'],
        ['settings', { tab: 'billing' }, '/app/settings?tab=billing'],
        ['browser', { computer: id }, `/app/browser?computer=${id}`],
        ['desktop', {}, '/app/desktop'],
        ['desktop', { computer: id }, `/app/desktop?computer=${id}`],
    ] as const)('sign-in for /app/%s returns to it', async (appId, query, expected) => {
        const returnUrl = await signInDestination(() => app(appId, query));
        expect(returnUrl).toBe(expected);
        expect(safeReturnUrl(returnUrl)).toBe(expected);
    });

    /**
     * What the shell does with that return (docs/APP-ROUTES.md §6, "After
     * sign-in"): its boot opens the linked app from the URL, with no click.
     * Code opens in full view; the Browser (`desktop`, alias `browser`) gets
     * no view. Each window's own open then mints through the server's
     * `ensure()`, which starts a stopped computer; that is not tested here.
     */
    it('🔴 /app/code and /app/desktop come back as the same app: Code in full view, the Browser with no view', async () => {
        const apps = [{ id: 'code' }, { id: 'desktop' }];
        for (const [appId, opened, launch] of [
            ['code', 'code', { view: 'full' }], ['desktop', 'desktop', {}], ['browser', 'desktop', {}],
        ] as const) {
            const returnUrl = safeReturnUrl(await signInDestination(() => app(appId, { computer: id })));
            expect(returnUrl, appId).toBe(`/app/${appId}?computer=${id}`);
            const link = parseAppLink(returnUrl, apps);
            expect(link, appId).toEqual({ id: opened });
            expect(routeLaunchContext(link, { hasWindow: false }), appId).toEqual(launch);
        }
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
