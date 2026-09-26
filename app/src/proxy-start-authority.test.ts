import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
vi.mock('@/utils/supabase/middleware', () => ({ updateSession: vi.fn() }));
import { updateSession } from '@/utils/supabase/middleware';
import { proxy } from './proxy';

it('lets only the exact startup path authenticate itself without browser cookie refresh', async () => {
    const path = 'https://control.example/api/internal/computers/start-authority';
    const result = await proxy(new NextRequest(path, { headers: { cookie: 'sb-session=untrusted' } }));
    expect(result?.headers.get('set-cookie')).toBeNull(); expect(updateSession).not.toHaveBeenCalled();
    for (const target of [path+'/extra', 'https://control.example/os']) await proxy(new NextRequest(target));
    expect(updateSession).toHaveBeenCalledTimes(2);
});
