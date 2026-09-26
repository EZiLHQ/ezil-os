import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
vi.mock('@/utils/supabase/middleware', () => ({ updateSession: vi.fn() }));
import { updateSession } from '@/utils/supabase/middleware';
import { proxy } from './proxy';

it('lets the signed mount endpoint authenticate itself without Supabase cookie refresh', async () => {
    const result = await proxy(new NextRequest('https://control.example/api/internal/computers/mount-authority',
        { headers: { cookie: 'sb-session=untrusted' } }));
    expect(result?.headers.get('set-cookie')).toBeNull(); expect(updateSession).not.toHaveBeenCalled();
    await proxy(new NextRequest('https://control.example/os'));
    expect(updateSession).toHaveBeenCalledOnce();
});
