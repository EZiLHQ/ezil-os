import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let provider: typeof import('./cloudflare-guacamole-provider');
let warn: ReturnType<typeof vi.spyOn>;
const ORIGIN = 'https://aws-8181-guac-test-aws.preview.example';
const URL = `${ORIGIN}/preview-bootstrap?token=bootstrap-secret&path=private-path#private-fragment`;
const PASSWORD = 'private-admin-password';
const TOKEN = 'private-session-token';
const COOKIE = 'ezil_preview=private-cookie';
const MEMBER = 'private-member-id';
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);
const member = (watching: unknown = false) => ({
    id: MEMBER,
    username: 'private-username',
    profile: { name: 'private-profile-name', is_admin: false },
    state: { is_watching: watching, is_connected: true },
});
type Options = {
    entries?: unknown;
    loginBody?: unknown;
    bootstrapStatus?: number;
    loginStatus?: number;
    listStatuses?: number[];
    invalidListJson?: boolean;
    failAt?: 'bootstrap' | 'login' | 'sessions';
};

function wire(options: Options = {}) {
    let listCalls = 0;
    const calls: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | globalThis.URL, init?: RequestInit) => {
        const path = new globalThis.URL(String(input)).pathname;
        calls.push({ path, init });
        const stage = path === '/preview-bootstrap' ? 'bootstrap' : path === '/api/login' ? 'login' : 'sessions';
        if (options.failAt === stage) throw new Error(`do not log ${PASSWORD} ${TOKEN}`);
        if (stage === 'bootstrap') return new Response(null, {
            status: options.bootstrapStatus ?? 302,
            headers: options.bootstrapStatus ? {} : { 'set-cookie': `${COOKIE}; Secure; Path=/`, location: '/' },
        });
        if (stage === 'login') return Response.json(
            options.loginBody === undefined ? { token: TOKEN, profile: { is_admin: true } } : options.loginBody,
            { status: options.loginStatus ?? 200 },
        );
        if (options.invalidListJson) return new Response('not JSON: private-response-body');
        return Response.json(options.entries === undefined ? [member()] : options.entries, {
            status: options.listStatuses?.[listCalls++] ?? 200,
        });
    }));
    return calls;
}

const log = () => {
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(2);
    expect(warn.mock.calls[0]![0]).toBe('[display-probe]');
    return JSON.parse(String(warn.mock.calls[0]![1]));
};

beforeEach(async () => {
    vi.resetModules(); // Fresh diagnostic limiter without a production test hook.
    provider = await import('./cloudflare-guacamole-provider');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('AWS display diagnostics (verdicts remain observational)', () => {
    it('an AWS list containing only the disconnected admin probe cannot refute a legacy viewer', async () => {
        wire({ entries: [{ id: MEMBER, profile: { is_admin: true }, state: { is_connected: false, is_watching: false } }] });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'unknown', reason: 'unrecognised' });
        expect(log()).toMatchObject({ display: 'unknown', session_count: 1, http_statuses: { bootstrap: 302, login: [200], sessions: [200] } });
    });
    it('an observed AWS watcher still reports live and a Cloudflare admin-only list retains its verdict', async () => {
        wire({ entries: [member(true)] });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'live', sessions: 1, watching: 1 });
        wire({ entries: [{ profile: { is_admin: true }, state: { is_connected: false, is_watching: false } }] });
        expect(await provider.probeDesktopDisplay(`${ORIGIN}/`, PASSWORD)).toEqual({ display: 'blank', sessions: 1 });
    });
    it('logs exactly the allowlisted shape, host and 8-hex SHA256 ids on blank', async () => {
        const calls = wire({ entries: [member(), { id: 'second-private-id', state: { is_watching: false } }] });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'blank', sessions: 2 });
        expect(log()).toEqual({
            origin: new globalThis.URL(ORIGIN).hostname,
            display: 'blank', login_is_admin: true, session_count: 2,
            sessions: [
                { is_watching: false, connected: true, is_admin: false, id: hash(MEMBER) },
                { is_watching: false, id: hash('second-private-id') },
            ],
            http_statuses: { bootstrap: 302, login: [200], sessions: [200] },
        });
        for (const secret of [PASSWORD, TOKEN, COOKIE, MEMBER, 'second-private-id', 'private-username',
            'private-profile-name', 'bootstrap-secret', 'private-path', 'private-fragment', '/preview-bootstrap']) {
            expect(warn.mock.calls[0]![1]).not.toContain(secret);
        }
        expect(calls.map(c => c.path)).toEqual(['/preview-bootstrap', '/api/login', '/api/sessions']);
        expect(new Set(calls.map(c => c.init?.signal)).size).toBe(1);
        expect(calls.every(c => c.init?.redirect === 'manual')).toBe(true);
    });

    it.each([true, false, undefined, null, 'private-untrusted-value'])('login profile %s is diagnostic only', async (isAdmin) => {
        wire({ loginBody: { token: TOKEN, profile: { is_admin: isAdmin } } });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'blank', sessions: 1 });
        expect(log().login_is_admin).toBe(typeof isAdmin === 'boolean' ? isAdmin : null);
    });

    it('strips URL userinfo and port from the origin label', async () => {
        wire();
        const url = URL.replace('https://', 'https://private-url-user:private-url-password@').replace('.example/', '.example:8443/');
        expect(await provider.probeDesktopDisplay(url, PASSWORD)).toEqual({ display: 'blank', sessions: 1 });
        expect(log().origin).toBe(new globalThis.URL(ORIGIN).hostname);
        expect(warn.mock.calls[0]![1]).not.toContain('private-url');
        expect(warn.mock.calls[0]![1]).not.toContain('8443');
    });

    it('does not fetch a login solely for a cached profile', async () => {
        provider.cacheNekoAdminToken(ORIGIN, PASSWORD, TOKEN);
        const calls = wire();
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'blank', sessions: 1 });
        expect(log()).toMatchObject({ login_is_admin: null, http_statuses: { login: [], sessions: [200] } });
        expect(calls.map(c => c.path)).toEqual(['/preview-bootstrap', '/api/sessions']);
    });

    it.each([401, 403])('records both list statuses when cached auth returns %s without changing retry', async (status) => {
        provider.cacheNekoAdminToken(ORIGIN, PASSWORD, TOKEN);
        const calls = wire({ listStatuses: [status, 200] });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'blank', sessions: 1 });
        expect(log()).toMatchObject({ login_is_admin: true, http_statuses: { bootstrap: 302, login: [200], sessions: [status, 200] } });
        expect(calls.map(c => c.path)).toEqual(['/preview-bootstrap', '/api/sessions', '/api/login', '/api/sessions']);
    });

    it.each([
        { options: { bootstrapStatus: 401 }, reason: 'login_failed', status: 401, statuses: { bootstrap: 401, login: [], sessions: [] } },
        { options: { loginStatus: 403 }, reason: 'login_failed', status: 403, statuses: { bootstrap: 302, login: [403], sessions: [] } },
        { options: { loginBody: { profile: { is_admin: false } } }, reason: 'login_failed', status: undefined, statuses: { bootstrap: 302, login: [200], sessions: [] } },
        { options: { listStatuses: [502] }, reason: 'http_error', status: 502, statuses: { bootstrap: 302, login: [200], sessions: [502] } },
    ])('retains $reason and HTTP $status on refusal', async ({ options, reason, status, statuses }) => {
        wire(options);
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'unknown', reason, status });
        expect(log()).toMatchObject({ display: 'unknown', session_count: null, sessions: [], http_statuses: statuses });
    });

    it.each(['bootstrap', 'login', 'sessions'] as const)('retains unreachable on %s transport failure without logging the error', async (stage) => {
        wire({ failAt: stage });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'unknown', reason: 'unreachable' });
        expect(log().display).toBe('unknown');
        expect(warn.mock.calls[0]![1]).not.toContain(PASSWORD);
        expect(warn.mock.calls[0]![1]).not.toContain(TOKEN);
    });

    it.each([null, {}, 'private-body', [member('private-not-a-boolean')], [null], [member(true), {}]])(
        'malformed sessions stay unknown and never leak arbitrary fields (%j)', async (entries) => {
            wire({ entries });
            expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'unknown', reason: 'unrecognised' });
            expect(log().session_count).toBe(Array.isArray(entries) ? entries.length : null);
            expect(warn.mock.calls[0]![1]).not.toContain('private');
        },
    );

    it('invalid JSON retains unrecognised and the received HTTP status', async () => {
        wire({ invalidListJson: true });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'unknown', reason: 'unrecognised' });
        expect(log()).toMatchObject({ session_count: null, http_statuses: { sessions: [200] } });
    });

    it('empty sessions stay blank with zero entries', async () => {
        wire({ entries: [] });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'blank', sessions: 0 });
        expect(log()).toMatchObject({ session_count: 0, sessions: [] });
    });

    it('one live watcher remains live and never consumes a warning slot', async () => {
        wire({ entries: [member(false), member(true)] });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'live', sessions: 2, watching: 1 });
        expect(warn).not.toHaveBeenCalled();
        wire();
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'blank', sessions: 1 });
        expect(log().display).toBe('blank');
    });

    it.each([ORIGIN, `${ORIGIN}/preview-bootstrap`, 'not-a-url', 'file:///preview-bootstrap?token=private'])('never logs a non-bootstrap URL: %s', async (url) => {
        wire();
        await provider.probeDesktopDisplay(url, PASSWORD);
        expect(warn).not.toHaveBeenCalled();
    });

    it('shares the 30s limiter across results and tokens, isolates origins, and admits the exact boundary', async () => {
        let now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        wire();
        await Promise.all(Array.from({ length: 5 }, () => provider.probeDesktopDisplay(URL, PASSWORD)));
        expect(warn).toHaveBeenCalledTimes(1);
        now += 29_999;
        wire({ entries: {} });
        await provider.probeDesktopDisplay(URL.replace('bootstrap-secret', 'rotated-secret'), PASSWORD);
        expect(warn).toHaveBeenCalledTimes(1);
        await provider.probeDesktopDisplay(URL.replace('guac-test', 'guac-other'), PASSWORD);
        expect(warn).toHaveBeenCalledTimes(2);
        now += 1;
        await provider.probeDesktopDisplay(URL, PASSWORD);
        expect(warn).toHaveBeenCalledTimes(3);
        expect(JSON.parse(String(warn.mock.calls[2]![1])).display).toBe('unknown');
    });

    it('a logging failure does not change the result', async () => {
        wire();
        warn.mockImplementation(() => { throw new Error('log sink failed'); });
        expect(await provider.probeDesktopDisplay(URL, PASSWORD)).toEqual({ display: 'blank', sessions: 1 });
    });

    it('keeps the caller timeout and makes no extra requests while diagnosing it', async () => {
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        const fetch = vi.fn((_input: RequestInfo | globalThis.URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new Error('private-transport-error')), { once: true });
        }));
        vi.stubGlobal('fetch', fetch);
        expect(await provider.probeDesktopDisplay(URL, PASSWORD, 10)).toEqual({ display: 'unknown', reason: 'unreachable' });
        expect(timeout).toHaveBeenCalledExactlyOnceWith(10);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(log()).toMatchObject({ http_statuses: { bootstrap: null, login: [], sessions: [] } });
    });
});
