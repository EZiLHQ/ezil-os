import { describe, expect, it, vi } from 'vitest';

const refreshSession = vi.fn(async () => ({ data: { session: {} }, error: null as null | { status?: number } }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { refreshSession } }) }));

const { GET } = await import('./route');

describe('GET /auth/refresh', () => {
    it('refreshes the caller\'s session and returns to a same-origin path', async () => {
        const res = await GET(new Request('https://os.example.test/auth/refresh?returnUrl=%2Fos%3Fezil_account%3Drefreshed') as never);
        expect(refreshSession).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toBe('https://os.example.test/os?ezil_account=refreshed');
    });

    it('never redirects off-origin', async () => {
        const res = await GET(new Request('https://os.example.test/auth/refresh?returnUrl=%2F%2Fevil.example') as never);
        expect(new URL(res.headers.get('location')!).origin).toBe('https://os.example.test');
    });

    it('still returns when the refresh fails (the /os marker stops a loop)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        refreshSession.mockResolvedValueOnce({ data: { session: null } as never, error: { status: 400 } });
        const res = await GET(new Request('https://os.example.test/auth/refresh?returnUrl=%2Fos%3Fezil_account%3Drefreshed') as never);
        expect(res.headers.get('location')).toBe('https://os.example.test/os?ezil_account=refreshed');
    });
});
