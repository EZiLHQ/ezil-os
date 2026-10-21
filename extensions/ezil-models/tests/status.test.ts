import { describe, expect, mock, spyOn, test } from 'bun:test';
import { fakeVscode } from './fixtures/fake-vscode';
import type { ResolvedProvider } from '../src/config';
import { AI_NOTICE, readAIStatus, statusView } from '../src/status-data';
mock.module('vscode', () => fakeVscode);
const { EZiLAIStatus } = await import('../src/status');
const provider = { type: 'ezil-gateway', baseUrl: 'https://computer.test/ai/v1', apiKey: 'test-only' } as ResolvedProvider;
const balance = { available_micro: 12345678, held_micro: 1000000 };
const row = { model: 'qwen.qwen3-coder-next', created_at: '2026-10-21T12:00:00Z', status: 'settled', cost_micro: 1500000, uncollected_micro: 250000 };
function server(b: unknown = balance, u: unknown = { data: [row] }, status = 200) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Response.json(String(url).endsWith('/me/balance') ? b : u, { status: String(url).endsWith('/me/balance') ? status : 200 });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
}
function harness(doFetch: typeof fetch) {
    const item = { text: '', tooltip: '', name: '', command: '', show: mock(() => {}), dispose: mock(() => {}) };
    const popover = mock(async () => undefined);
    const ui = { StatusBarAlignment: { Right: 2 }, window: { createStatusBarItem: () => item, showQuickPick: popover } };
    const status = new EZiLAIStatus(() => provider, doFetch, ui as unknown as typeof import('vscode'));
    return { status, item, popover };
}

describe('EZiL AI Gateway status', () => {
    test('renders real balance, held credits and net usage in status item and popover', async () => {
        const s = server(); const h = harness(s.fetch);
        try {
            expect(h.item.text).toContain('Loading');
            await h.status.show();
            expect(h.item.text).toBe('EZiL AI · 12.345678 credits');
            expect(h.item.tooltip).toContain('Held credits: 1');
            expect(h.item.tooltip).toContain('qwen.qwen3-coder-next · settled · 1.25 credits');
            expect(h.item.tooltip).toContain(AI_NOTICE);
            expect(h.item.tooltip).not.toContain('$');
            expect(h.item.command).toBe('ezil-models.showStatus');
            expect(JSON.stringify(h.popover.mock.calls)).toContain('12.345678');
            expect(s.calls.map(c => c.url)).toEqual(['https://computer.test/ai/v1/me/balance', 'https://computer.test/ai/v1/me/usage?limit=5']);
            for (const call of s.calls) expect(call.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', headers: { authorization: 'Bearer test-only' } });
        } finally { h.status.dispose(); }
    });
    test('balance refusal replaces a prior balance with the code, never zero or unlimited', async () => {
        let fail = false;
        const h = harness((async (url, init) => (fail ? server({ error: { code: 'os_session_missing', message: 'secret upstream body' } }, { data: [row] }, 401) : server()).fetch(url, init)) as typeof fetch);
        try {
            await h.status.refresh(); fail = true; await h.status.show();
            expect(h.item.text).toBe('EZiL AI · os_session_missing');
            expect(h.item.tooltip).toContain('Credits unavailable (os_session_missing)');
            expect(h.item.tooltip).toContain('1.25 credits');
            for (const forbidden of ['12.345678', 'Available credits: 0', 'unlimited', 'secret upstream body']) expect(h.item.tooltip).not.toContain(forbidden);
        } finally { h.status.dispose(); }
    });
    test('invalid balances never become zero', async () => {
        for (const value of [{}, { ...balance, available_micro: -1 }, { ...balance, available_micro: '12' }, { ...balance, held_micro: 0.1 }]) {
            const state = await readAIStatus(provider, server(value).fetch);
            expect(statusView(state).text).toContain('invalid_response');
        }
    });
    test('real zero balance and empty usage remain valid', async () => {
        const view = statusView(await readAIStatus(provider, server({ available_micro: 0, held_micro: 0 }, { data: [] }).fetch));
        expect(view.text).toBe('EZiL AI · 0 credits'); expect(view.lines).toContain('No recent usage.');
    });
    test('usage failures preserve the fetched balance and show the usage error', async () => {
        const s = server();
        const state = await readAIStatus(provider, (async (url, init) => String(url).includes('/usage') ? Response.json({ error: { code: 'os_upstream_unavailable' } }, { status: 502 }) : s.fetch(url, init)) as typeof fetch);
        expect(statusView(state).text).toContain('12.345678');
        expect(statusView(state).lines).toContain('Usage unavailable (os_upstream_unavailable)');
    });
    test('pending usage and malformed charges cannot invent a charge', async () => {
        const pending = { ...row, status: 'pending', cost_micro: null, uncollected_micro: null };
        expect(statusView(await readAIStatus(provider, server(balance, { data: [pending] }).fetch)).lines.join('\n')).toContain('charge pending');
        for (const data of [[{ ...row, uncollected_micro: 2000000 }], [{ ...row, cost_micro: -1 }], [{}]]) {
            expect((await readAIStatus(provider, server(balance, { data }).fetch)).usage.code).toBe('invalid_response');
        }
    });
    test('transport, HTTP fallback and missing config have explicit codes', async () => {
        expect((await readAIStatus(provider, (async () => { throw new Error('private detail'); }) as unknown as typeof fetch)).balance.code).toBe('network_error');
        expect((await readAIStatus(provider, server({ error: { code: '<unsafe>' } }, { data: [] }, 503).fetch)).balance.code).toBe('http_503');
        const s = server(); expect((await readAIStatus(undefined, s.fetch)).balance.code).toBe('not_configured'); expect(s.calls).toHaveLength(0);
    });
    test('timeouts, cancellation and invalid JSON have honest error states', async () => {
        const aborting = (async (_url, init) => { init?.signal?.throwIfAborted(); return Response.json(balance); }) as typeof fetch;
        expect((await readAIStatus(provider, aborting, AbortSignal.abort())).balance.code).toBe('request_cancelled');
        const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
        try { expect((await readAIStatus(provider, aborting)).balance.code).toBe('request_timeout'); }
        finally { timeout.mockRestore(); }
        const invalid = (async () => new Response('<html>not JSON</html>')) as unknown as typeof fetch;
        expect((await readAIStatus(provider, invalid)).balance.code).toBe('invalid_response');
    });
    test('superseded requests and disposed items cannot publish old balances', async () => {
        const pending: ((r: Response) => void)[] = [];
        const h = harness((() => new Promise<Response>(resolve => pending.push(resolve))) as unknown as typeof fetch);
        const first = h.status.refresh(); const second = h.status.refresh();
        pending[2]!(Response.json({ ...balance, available_micro: 2000000 })); pending[3]!(Response.json({ data: [] })); await second;
        pending[0]!(Response.json(balance)); pending[1]!(Response.json({ data: [] })); await first;
        expect(h.item.text).toBe('EZiL AI · 2 credits');
        const last = h.status.refresh(); h.status.dispose(); const text = h.item.text;
        pending[4]!(Response.json(balance)); pending[5]!(Response.json({ data: [] })); await last;
        expect(h.item.text).toBe(text); expect(h.item.dispose).toHaveBeenCalledTimes(1);
    });
});
