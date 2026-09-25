import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/utils/supabase/middleware', () => ({ updateSession: vi.fn(async () => new Response('session path')) }));
import { updateSession } from '@/utils/supabase/middleware';
import { proxy } from './proxy';

beforeEach(() => vi.clearAllMocks());
it.each(['/api/internal/apps/configuration-authority', '/api/internal/computers/lifecycle-authority', '/api/internal/computers/cancellation-authority'])('leaves %s to dedicated authentication without refreshing browser cookies', async path => {
    const request = new NextRequest(`https://control.example${path}`, {
        method: 'POST', headers: { cookie: 'sb-session=untrusted', authorization: 'Bearer untrusted' } });
    const response = await proxy(request);
    expect(updateSession).not.toHaveBeenCalled(); expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
});
it('preserves normal session refresh on OS and existing API routes', async () => {
    for (const path of ['/os', '/api/trpc/apps.catalog', '/api/internal/apps/configuration-authority/other', '/api/internal/computers/lifecycle-authority/other', '/api/internal/computers/cancellation-authority/other']) {
        const request = new NextRequest(`https://control.example${path}`);
        expect(await (await proxy(request)).text()).toBe('session path');
        expect(updateSession).toHaveBeenLastCalledWith(request);
    }
});
