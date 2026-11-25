import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updateSession: vi.fn() }));
vi.mock('@/utils/supabase/middleware', () => ({ updateSession: mocks.updateSession }));
import { proxy } from './proxy';

const id = 'ba4cf399-1f9b-43e5-be10-45e403bc0190';
const repo = 'https://github.ezil.work/default/u-0123456789abcdef-a-' + id + '.git';
const entry = '/app/code?repo=' + encodeURIComponent(repo) + '&assignment=' + id;
const request = (path: string, host = 'os-staging.ezil.work', extra: Record<string, string> = {}) => new NextRequest('http://127.0.0.1:3000' + path,
    { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site', ...extra } });
beforeEach(() => { vi.clearAllMocks(); mocks.updateSession.mockImplementation(async () => NextResponse.next()); });

describe('proxy framing for the embedded assignment Code entry', () => {
    it('lets only Universe staging frame the exact staged assignment entry, after the session refresh', async () => {
        const response = await proxy(request(entry));
        expect(mocks.updateSession).toHaveBeenCalledTimes(1);
        expect(response.headers.get('content-security-policy')).toBe('frame-ancestors https://universe-staging.ezil.work');
        expect(response.headers.get('x-frame-options')).toBeNull();
    });
    it('keeps the policy on a session redirect from that entry', async () => {
        mocks.updateSession.mockImplementation(async () => NextResponse.redirect('https://os-staging.ezil.work/login'));
        expect((await proxy(request(entry))).headers.get('content-security-policy')).toBe('frame-ancestors https://universe-staging.ezil.work');
    });
    it.each([
        ['plain Code', '/app/code', 'os-staging.ezil.work'],
        ['the desktop', '/os', 'os-staging.ezil.work'],
        ['production', entry, 'os.ezil.work'],
        ['os-prod', entry, 'os-prod.ezil.work'],
        ['an unowned host', entry, 'universe-staging.ezil.work'],
        ['an ordinary repository', '/app/code?repo=' + encodeURIComponent('https://github.com/example/demo.git'), 'os-staging.ezil.work'],
    ])('adds no framing policy for %s', async (_name, path, host) => {
        const response = await proxy(request(path, host));
        expect(response.headers.get('content-security-policy')).toBeNull();
        expect(response.headers.get('x-frame-options')).toBeNull();
    });
    it('still refuses a cross-origin write before the session is touched', async () => {
        const response = await proxy(new NextRequest('https://os-staging.ezil.work' + entry, { method: 'POST',
            headers: { 'sec-fetch-site': 'cross-site', origin: 'https://example.org', host: 'os-staging.ezil.work' } }));
        expect(response.status).toBe(403);
        expect(mocks.updateSession).not.toHaveBeenCalled();
    });
});
