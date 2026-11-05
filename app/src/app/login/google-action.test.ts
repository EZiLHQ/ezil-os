import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Google action is reachable by a page cached before the button was removed, or by a hand-made post: with
// EZiL ID configured it must go to the EZiL ID entry and never start Supabase's Google OAuth.
vi.mock('server-only', () => ({}));
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'os-staging.ezil.work', 'x-forwarded-proto': 'https' }) }));
const supabase = vi.hoisted(() => ({
    createClient: vi.fn(async () => ({ auth: { signInWithOAuth: oauth } })),
}));
const oauth = vi.hoisted(() => vi.fn(async () => ({ data: { url: 'https://supabase.example/authorize' }, error: null })));
vi.mock('@/utils/supabase/server', () => supabase);

import { signInWithGoogle } from './actions';

beforeEach(() => { vi.stubEnv('AUTH0_CLIENT_ID', ''); vi.stubEnv('AUTH0_SECRET_ID', ''); redirect.mockClear(); oauth.mockClear(); supabase.createClient.mockClear(); });
afterEach(() => vi.unstubAllEnvs());

describe('signInWithGoogle', () => {
    it('with EZiL ID configured, goes to the EZiL ID entry with a narrowed destination and never calls Supabase', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', 'client');
        vi.stubEnv('AUTH0_SECRET_ID', 'private-test-secret');
        await expect(signInWithGoogle('/os?computer=one')).rejects.toThrow('NEXT_REDIRECT');
        expect(redirect).toHaveBeenCalledWith('/auth/auth0/login?returnUrl=%2Fos%3Fcomputer%3Done');
        expect(supabase.createClient).not.toHaveBeenCalled();
        expect(oauth).not.toHaveBeenCalled();
        // A foreign destination is narrowed to the app's own default (/computers) before it reaches EZiL ID. Literal
        // expectations, not the sanitizer's own output, so a weakened sanitizer cannot also weaken this test.
        await expect(signInWithGoogle('https://evil.example/x')).rejects.toThrow('NEXT_REDIRECT');
        expect(redirect).toHaveBeenLastCalledWith('/auth/auth0/login?returnUrl=%2Fcomputers');
        await expect(signInWithGoogle('//evil.example/x')).rejects.toThrow('NEXT_REDIRECT');
        expect(redirect).toHaveBeenLastCalledWith('/auth/auth0/login?returnUrl=%2Fcomputers');
        await expect(signInWithGoogle('/app/code?folder=%2Fworkspace')).rejects.toThrow('NEXT_REDIRECT');
        expect(redirect).toHaveBeenLastCalledWith('/auth/auth0/login?returnUrl=%2Fapp%2Fcode%3Ffolder%3D%252Fworkspace');
    });

    it('without EZiL ID, keeps the Supabase Google OAuth flow', async () => {
        await expect(signInWithGoogle('/os')).rejects.toThrow('NEXT_REDIRECT');
        expect(oauth).toHaveBeenCalledWith({ provider: 'google', options: { redirectTo: 'https://os-staging.ezil.work/auth/callback?returnUrl=%2Fos' } });
        expect(redirect).toHaveBeenCalledWith('https://supabase.example/authorize');
    });
});
