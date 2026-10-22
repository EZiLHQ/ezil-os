import { afterEach, expect, it, vi } from 'vitest';
import { imageDesktopHealthy } from './aws-rebase-health';
import { rebaseSetup } from './aws-rebase.test-support';
afterEach(() => vi.unstubAllGlobals());
it.each(['healthy', 'editor-down', 'foreign-redirect'])('desktop health checks authenticated origins: %s', async mode => {
    const s = rebaseSetup(), p = (await s.store.inspect(s.source.computerId)).placement!;
    const calls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (raw: string, init: RequestInit) => {
        const url = new URL(raw); calls.push(url);
        expect(url.hostname).toMatch(/^aws-(8181|8443)-.*-aws\.example\.com$/);
        if (url.pathname === '/preview-bootstrap') return new Response(null, { status: 302, headers: {
            location: mode === 'foreign-redirect' ? 'https://foreign.example/' : url.searchParams.get('path')!,
            'set-cookie': 'ezil_preview=test; Secure; Path=/' } });
        expect(new Headers(init.headers).get('cookie')).toBe('ezil_preview=test');
        return new Response('', { status: mode === 'editor-down' && url.pathname === '/healthz' ? 503 : 200 });
    }));
    const healthy = await imageDesktopHealthy({ ...p, lastError: 'enroll_succeeded', enrollConsumedHash: 'a'.repeat(64) },
        { ...s.env, CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'test-only-secret' }, s.deps.now().getTime());
    expect(healthy).toBe(mode === 'healthy');
    expect(calls.every(u => u.hostname.endsWith('.example.com'))).toBe(true);
});
