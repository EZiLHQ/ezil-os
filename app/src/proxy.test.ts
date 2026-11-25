import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updateSession: vi.fn() }));
vi.mock('@/utils/supabase/middleware', () => ({ updateSession: mocks.updateSession }));
import { proxy } from './proxy';

const id = 'ba4cf399-1f9b-43e5-be10-45e403bc0190';
const repo = 'https://github.ezil.work/default/u-0123456789abcdef-a-' + id + '.git';
const entry = '/app/code?repo=' + encodeURIComponent(repo) + '&assignment=' + id;
const request = (path: string, host = 'os.ezil.work', extra: Record<string, string> = {}) => new NextRequest('http://127.0.0.1:3000' + path,
    { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site', ...extra } });
beforeEach(() => { vi.clearAllMocks(); mocks.updateSession.mockImplementation(async () => NextResponse.next()); });

describe('proxy framing for the embedded assignment Code entry', () => {
    it.each([['os.ezil.work', 'https://universe.ezil.work'], ['os-staging.ezil.work', 'https://universe-staging.ezil.work']])(
        'lets only the paired Universe origin frame the exact assignment entry on %s, after the session refresh', async (host, universe) => {
            const response = await proxy(request(entry, host));
            expect(mocks.updateSession).toHaveBeenCalledTimes(1);
            expect(response.headers.get('content-security-policy')).toBe('frame-ancestors ' + universe);
            expect(response.headers.get('x-frame-options')).toBeNull();
        });
    it('keeps the policy on a session redirect from that entry', async () => {
        mocks.updateSession.mockImplementation(async () => NextResponse.redirect('https://os.ezil.work/login'));
        expect((await proxy(request(entry))).headers.get('content-security-policy')).toBe('frame-ancestors https://universe.ezil.work');
    });
    it.each([
        ['plain Code', '/app/code', 'os.ezil.work'],
        ['the desktop', '/os', 'os.ezil.work'],
        ['the desktop with the assignment query', '/os?repo=' + encodeURIComponent(repo) + '&assignment=' + id, 'os.ezil.work'],
        ['another app', '/app/browser?repo=' + encodeURIComponent(repo) + '&assignment=' + id, 'os.ezil.work'],
        ['the legacy landing host', entry, 'os.ezil.org'],
        ['os-prod', entry, 'os-prod.ezil.work'],
        ['an unowned host', entry, 'universe.ezil.work'],
        ['a look-alike host', entry, 'os.ezil.work.evil.example'],
        ['plain HTTP', entry, 'os.ezil.work', { 'x-forwarded-proto': 'http' }],
        ['an ordinary repository', '/app/code?repo=' + encodeURIComponent('https://github.com/example/demo.git'), 'os.ezil.work'],
        ['a mismatched attempt', entry.replace('assignment=' + id, 'assignment=11111111-1111-4111-8111-111111111111'), 'os.ezil.work'],
    ] as [string, string, string, Record<string, string>?][])('adds no framing policy for %s', async (_name, path, host, extra) => {
        const response = await proxy(request(path, host, extra));
        expect(response.headers.get('content-security-policy')).toBeNull();
        expect(response.headers.get('x-frame-options')).toBeNull();
    });
    it('still refuses a cross-origin write before the session is touched', async () => {
        const response = await proxy(new NextRequest('https://os.ezil.work' + entry, { method: 'POST',
            headers: { 'sec-fetch-site': 'cross-site', origin: 'https://example.org', host: 'os.ezil.work' } }));
        expect(response.status).toBe(403);
        expect(mocks.updateSession).not.toHaveBeenCalled();
    });
});
