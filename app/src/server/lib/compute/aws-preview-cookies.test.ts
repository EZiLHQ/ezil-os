/**
 * Server-side readiness probes against an AWS desktop origin (Codex P1 on PR #200):
 * the bootstrap answers 302 + Set-Cookie and every later request to the origin is
 * 401 without the cookie, exactly as worker/src/aws-origin.ts `handleAwsBrowserHost`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    probeDesktopDisplay,
    probeDesktopFrame,
    resetNekoAdminTokenCacheForTests,
} from '@/server/lib/cloudflare-guacamole-provider';

import { cookieHeaderFor, getFollowingSameOriginCookies, storeSetCookies, type ProbeCookieJar } from './aws-preview-cookies';

const ORIGIN = 'https://aws-8181-guac-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-aws.preview.example';
const ELSEWHERE = 'https://elsewhere.example';
const BOOTSTRAP = `${ORIGIN}/preview-bootstrap?token=good&path=%2F`;
const COOKIE = 'ezil_preview=c1';

interface Seen { url: string; method: string; cookie: string | null }
let seen: Seen[];
let bootstrapTarget: string;

function server(input: RequestInfo | URL, init?: RequestInit): Response {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    seen.push({ url: url.toString(), method, cookie: headers.get('cookie') });
    if (url.origin === ELSEWHERE) return new Response('elsewhere', { status: 200 });
    if (url.pathname === '/preview-bootstrap') {
        if (url.searchParams.get('token') !== 'good') return Response.json({ ok: false, error: 'invalid_token' }, { status: 401 });
        return new Response(null, { status: 302, headers: {
            location: bootstrapTarget,
            'set-cookie': `${COOKIE}; Max-Age=300; HttpOnly; Secure; SameSite=None; Partitioned; Path=/`,
        } });
    }
    if (url.pathname === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } });
    if (!(headers.get('cookie') ?? '').split(/;\s*/).includes(COOKIE)) {
        return Response.json({ ok: false, error: 'aws_preview_auth_required' }, { status: 401 });
    }
    if (url.pathname === '/' && !url.search) return new Response(null, { status: 302, headers: { location: '/?usr=EZiL&pwd=ezil-preview&embed=1' } });
    if (url.pathname === '/') return new Response('<html>neko</html>', { status: 200 });
    if (url.pathname === '/api/login' && method === 'POST') return Response.json({ token: 'admin-token' });
    if (url.pathname === '/api/sessions') return Response.json([{ state: { is_watching: true } }]);
    if (url.pathname === '/api/logout') return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
}

beforeEach(() => {
    seen = [];
    bootstrapTarget = '/';
    resetNekoAdminTokenCacheForTests();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => server(input, init)));
});
afterEach(() => {
    vi.unstubAllGlobals();
    resetNekoAdminTokenCacheForTests();
});

// Compare parsed origins, never URL prefixes: `https://a.example` is a prefix of `https://a.example.evil`.
const originOf = (url: string) => new URL(url).origin;
const toOrigin = () => seen.filter((s) => originOf(s.url) === ORIGIN && new URL(s.url).pathname !== '/preview-bootstrap');

describe('frame probe through an AWS bootstrap', () => {
    it('carries the bootstrap cookie to the same origin, so a working desktop is alive', async () => {
        await expect(probeDesktopFrame(BOOTSTRAP)).resolves.toEqual({ alive: true, status: 200 });
        expect(toOrigin().length).toBeGreaterThan(0);
        for (const s of toOrigin()) expect(s.cookie).toBe(COOKIE);
        expect(seen[0]).toMatchObject({ url: BOOTSTRAP, cookie: null });
    });

    it('never forwards the cookie to another origin', async () => {
        bootstrapTarget = `${ELSEWHERE}/landing`;
        await expect(probeDesktopFrame(BOOTSTRAP)).resolves.toEqual({ alive: true, status: 200 });
        const hop = seen.find((s) => originOf(s.url) === ELSEWHERE);
        expect(hop).toBeDefined();
        expect(hop!.cookie).toBeNull();
    });

    it('a bad bootstrap token is still a dead frame', async () => {
        await expect(probeDesktopFrame(`${ORIGIN}/preview-bootstrap?token=bad`)).resolves.toEqual({
            alive: false, reason: 'http_error', status: 401,
        });
    });

    it('bounds redirects: a loop is unreachable, not a hang', async () => {
        const out = await probeDesktopFrame(`${ORIGIN}/loop`);
        expect(out).toMatchObject({ alive: false, reason: 'unreachable' });
        expect(seen.length).toBe(11);
    });
});

describe('display probe through an AWS bootstrap', () => {
    it('takes the cookie first and sends it on login and sessions to that origin', async () => {
        await expect(probeDesktopDisplay(BOOTSTRAP, 'admin-pass')).resolves.toMatchObject({ display: 'live', watching: 1 });
        const api = seen.filter((s) => originOf(s.url) === ORIGIN && new URL(s.url).pathname.startsWith('/api/'));
        expect(api.map((s) => new URL(s.url).pathname)).toEqual(['/api/login', '/api/sessions']);
        for (const s of api) expect(s.cookie).toBe(COOKIE);
    });

    it('a refused bootstrap is unknown (login_failed), never a verdict', async () => {
        await expect(probeDesktopDisplay(`${ORIGIN}/preview-bootstrap?token=bad`, 'admin-pass')).resolves.toEqual({
            display: 'unknown', reason: 'login_failed', status: 401,
        });
        expect(seen.some((s) => s.url.includes('/api/'))).toBe(false);
    });
});

describe('same-origin cookie jar', () => {
    it('replays only to the exact origin, honours Max-Age=0, and keeps Secure cookies off HTTP', () => {
        const jar: ProbeCookieJar = new Map();
        const https = new URL(`${ORIGIN}/x`);
        storeSetCookies(jar, https, new Headers([['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2; Secure']]));
        expect(cookieHeaderFor(jar, https)).toBe('a=1; b=2');
        expect(cookieHeaderFor(jar, new URL('https://aws-8181-other-aws.preview.example/'))).toBeUndefined();
        storeSetCookies(jar, https, new Headers([['set-cookie', 'a=gone; Max-Age=0']]));
        expect(cookieHeaderFor(jar, https)).toBe('b=2');
        const http = new URL('http://localhost:8787/');
        storeSetCookies(jar, http, new Headers([['set-cookie', 's=1; Secure'], ['set-cookie', 'p=1']]));
        expect(cookieHeaderFor(jar, http)).toBe('p=1');
    });

    it('follows at most the given hops', async () => {
        await expect(getFollowingSameOriginCookies(`${ORIGIN}/loop`, {}, new Map(), 2)).rejects.toThrow('too_many_redirects');
        expect(seen.length).toBe(3);
    });
});
