import { expect, test } from 'bun:test';
import { localUrlFor } from '../container/run-spec.ts';
import { isOwnFrameOrigin, probeFrameOrigin, type FrameSurface } from './frame-origin.ts';

test('surface pins include offsets and reject sibling ports and URL authority tricks', () => {
    const surfaces: FrameSurface[] = ['desktop', 'code', 'preview'];
    for (const offset of [0, 10000]) for (const surface of surfaces) {
        const own = localUrlFor(surface === 'preview' ? 'appPreview' : surface, offset);
        expect(isOwnFrameOrigin(own, surface, offset)).toBe(true);
        for (const other of surfaces.filter(s => s !== surface)) expect(isOwnFrameOrigin(own, other, offset)).toBe(false);
        for (const url of [own.replace('127.0.0.1', 'localhost'), own.replace('http:', 'https:'), own.replace('127.0.0.1', 'user@127.0.0.1'), 'file:///tmp/example', 'http://192.168.1.1']) {
            expect(isOwnFrameOrigin(url, surface, offset)).toBe(false);
        }
    }
});
test('redirects cannot confirm a foreign frame and response streams are cancelled', async () => {
    const own = localUrlFor('code');
    for (const location of ['https://foreign.example/', localUrlFor('desktop'), '/login']) {
        let cancelled = false;
        const fetcher = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
            status: 302, headers: { location },
        })) as unknown as typeof fetch;
        const probe = await probeFrameOrigin(own, 'code', 0, fetcher);
        expect(probe.alive).toBe(location === '/login');
        expect(cancelled).toBe(true);
    }
});
test('foreign origins never fetch; correct code/preview origins probe without redirects', async () => {
    const calls: { url: string; redirect: unknown }[] = [];
    const fetcher = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calls.push({ url: String(url), redirect: init?.redirect });
        return new Response('ready', { status: 200 });
    }) as unknown as typeof fetch;
    expect((await probeFrameOrigin(localUrlFor('desktop'), 'code', 0, fetcher)).reason).toBe('foreign_origin');
    expect(calls).toHaveLength(0);
    for (const surface of ['code', 'preview'] as const) {
        expect((await probeFrameOrigin(localUrlFor(surface === 'preview' ? 'appPreview' : surface), surface, 0, fetcher)).alive).toBe(true);
    }
    expect(calls).toHaveLength(2); expect(calls.every(call => call.redirect === 'manual')).toBe(true);
});
