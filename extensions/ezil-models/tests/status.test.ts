import { describe, expect, mock, spyOn, test } from 'bun:test';
import { fakeVscode } from './fixtures/fake-vscode';
import type { ResolvedProvider } from '../src/config';
import { AI_NOTICE, credits, localResetTime, readAIStatus, statusView } from '../src/status-data';
mock.module('vscode', () => fakeVscode);
const { EZiLAIStatus } = await import('../src/status');
const provider = { type: 'ezil-gateway', baseUrl: 'https://computer.test/ai/v1', apiKey: 'test-only' } as ResolvedProvider;
const balance = { available_micro: 12345678, held_micro: 1000000 };
const creditWindow = { seconds: 7200, budget_micro: '20000000', used_micro: '7500000', remaining_micro: '12500000',
    started_at: '2026-10-22T12:05:00Z', resets_at: '2026-10-22T14:05:00Z' };
// Shape returned by Gateway member_controls (0008, counters updated in 0021).
const limits = {
    entitlement: { required: false, basis: 'not_required', subscription: null },
    policy: { policy: {}, sources: {} }, models: {}, ceilings: { concurrency: 2, rpm: 60 }, pauses: [],
    counters: { inflight: 1, pending: 0, rpm: 3, tpm: 1200, open_micro: 1000000, day_micro: 3500000, month_micro: 12500000 },
};
const catalog = { killswitch: false, pause: null, data: [] };
const row = { model: 'qwen.qwen3-coder-next', created_at: '2026-10-21T12:00:00Z', status: 'settled', cost_micro: 1500000, uncollected_micro: 250000 };
function server(b: unknown = balance, u: unknown = { data: [row] }, status = 200, l: unknown = limits, m: unknown = catalog) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const path = new URL(String(url)).pathname;
        if (path === '/ai/v1/me/balance') return Response.json(b, { status });
        if (path === '/ai/v1/me/usage') return Response.json(u);
        if (path === '/ai/v1/me/limits') return Response.json(l);
        if (path === '/ai/v1/models') return Response.json(m);
        throw new Error(`Unexpected status URL: ${url}`);
    }) as typeof globalThis.fetch;
    return { calls, fetch };
}
function harness(doFetch: typeof fetch, currentProvider: () => ResolvedProvider | undefined = () => provider) {
    const item = { text: '', tooltip: '', name: '', command: '', show: mock(() => {}), dispose: mock(() => {}) };
    const popover = mock(async () => undefined);
    const ui = { StatusBarAlignment: { Right: 2 }, window: { createStatusBarItem: () => item, showQuickPick: popover } };
    const status = new EZiLAIStatus(currentProvider, doFetch, ui as unknown as typeof import('vscode'));
    return { status, item, popover };
}

describe('EZiL AI Gateway status', () => {
    test('shows window credits and local reset time in the item, tooltip and popover', async () => {
        const h = harness(server({ ...balance, window: creditWindow }).fetch);
        const date = new Date(creditWindow.resets_at);
        const reset = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        try {
            await h.status.show();
            expect(localResetTime(creditWindow.resets_at)).toBe(reset);
            expect(h.item.text).toBe(`EZiL AI · 12.5 credits left · resets ${reset}`);
            expect(h.item.tooltip).toContain('2-hour window: 12.5 credits left of 20');
            expect(h.item.tooltip).toContain('Window used (held + settled): 7.5 credits');
            expect(h.item.tooltip).toContain(`Resets at ${reset} (local time)`);
            expect(h.item.tooltip).toContain('Available credits: 12.345678');
            expect(JSON.stringify(h.popover.mock.calls)).toContain('2-hour window');
        } finally { h.status.dispose(); }
    });
    test('null window preserves the complete legacy view', async () => {
        const old = statusView(await readAIStatus(provider, server().fetch));
        const current = statusView(await readAIStatus(provider, server({ ...balance, window: null }).fetch));
        expect(current).toEqual(old);
        expect(current.text).toBe('EZiL AI · 12.345678 credits');
    });
    test('inactive windows show the allowance without inventing a reset time', async () => {
        const view = statusView(await readAIStatus(provider, server({ ...balance, window: { ...creditWindow,
            started_at: null, resets_at: null, used_micro: '0', remaining_micro: '20000000' } }).fetch));
        expect(view.text).toBe('EZiL AI · 20 credits left');
        expect(view.lines).toContain('Window starts with your next admitted request.');
        expect(view.lines.join()).not.toContain('Resets at');
    });
    test('zero remaining and non-default window length come from the gateway', async () => {
        const view = statusView(await readAIStatus(provider, server({ ...balance, window: { ...creditWindow,
            seconds: 5400, remaining_micro: '0', used_micro: creditWindow.budget_micro } }).fetch));
        expect(view.text).toStartWith('EZiL AI · 0 credits left · resets ');
        expect(view.lines).toContain('90-minute window: 0 credits left of 20');
    });
    test('micro-credit strings use the same unit, grouping and six-place precision as balances', () => {
        for (const [micro, expected] of [[0, '0'], [1, '0.000001'], [10, '0.00001'], [1000000, '1'], [12500000, '12.5'],
            [1234567890, '1,234.56789'], [9007199254740991, '9,007,199,254.740991']] as const) {
            expect(credits(micro)).toBe(expected);
            expect(credits(String(micro))).toBe(expected);
        }
        expect(credits('9007199254740991')).toBe('9,007,199,254.740991');
        expect(credits('9007199254740993123456')).toBe('9,007,199,254,740,993.123456');
    });
    test('malformed window payloads use the existing invalid-response fallback', async () => {
        for (const window of [false, {}, { ...creditWindow, seconds: 599 }, { ...creditWindow, seconds: 86401 },
            { ...creditWindow, seconds: 7200.5 }, { ...creditWindow, remaining_micro: 12500000 },
            { ...creditWindow, remaining_micro: '-1' }, { ...creditWindow, used_micro: '1.5' },
            { ...creditWindow, budget_micro: null }, { ...creditWindow, resets_at: 'not a date' }]) {
            expect(statusView(await readAIStatus(provider, server({ ...balance, window }).fetch)).text).toBe('EZiL AI · Credits unavailable');
        }
    });
    test('fetch errors clear prior window values and retain the existing fallback', async () => {
        let fail = false;
        const h = harness((async (url, init) => {
            if (fail) throw new Error('private detail');
            return server({ ...balance, window: creditWindow }).fetch(url, init);
        }) as typeof fetch);
        try {
            await h.status.refresh();
            expect(h.item.text).toContain('credits left');
            fail = true; await h.status.refresh();
            expect(h.item.text).toBe('EZiL AI · Credits unavailable · limits unavailable · availability unknown · usage unavailable');
            expect(h.item.tooltip).toContain('Credits unavailable. Could not load current information. Try again.');
            expect(h.item.tooltip).not.toMatch(/12\.5|Resets|private detail/);
        } finally { h.status.dispose(); }
    });
    test('existing minute timer fetches updated window credits and is disposed', async () => {
        let tick: () => void = () => { throw new Error('timer not registered'); };
        const timer = { unref: mock(() => {}) };
        const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
            expect(ms).toBe(60000); tick = callback; return timer;
        }) as unknown as typeof setInterval);
        const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
        let remaining_micro = '12500000';
        const h = harness((async (url, init) => server({ ...balance, window: { ...creditWindow, remaining_micro } }).fetch(url, init)) as typeof fetch);
        try {
            await h.status.refresh();
            expect(h.item.text).toContain('12.5 credits left');
            remaining_micro = '1000000'; tick();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(h.item.text).toContain('1 credits left');
            h.status.dispose();
            expect(clear).toHaveBeenCalledWith(timer);
        } finally { interval.mockRestore(); clear.mockRestore(); }
    });
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
            expect(s.calls.map(c => c.url)).toEqual(['https://computer.test/ai/v1/me/balance', 'https://computer.test/ai/v1/me/usage?limit=5', 'https://computer.test/ai/v1/me/limits', 'https://computer.test/ai/v1/models']);
            for (const call of s.calls) expect(call.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', headers: { authorization: 'Bearer test-only' } });
        } finally { h.status.dispose(); }
    });
    test('balance refusal replaces a prior balance with sign-in guidance, never zero or unlimited', async () => {
        let fail = false;
        const h = harness((async (url, init) => (fail ? server({ error: { code: 'os_session_missing', message: 'secret upstream body' } }, { data: [row] }, 401) : server()).fetch(url, init)) as typeof fetch);
        try {
            await h.status.refresh(); fail = true; await h.status.show();
            expect(h.item.text).toBe('EZiL AI · Sign-in needed');
            expect(h.item.tooltip).toContain('Credits unavailable. This computer has not received an AI sign-in.');
            expect(h.item.tooltip).toContain('1.25 credits');
            for (const forbidden of ['12.345678', 'Available credits: 0', 'unlimited', 'secret upstream body']) expect(h.item.tooltip).not.toContain(forbidden);
        } finally { h.status.dispose(); }
    });
    test('invalid balances never become zero', async () => {
        for (const value of [{}, { ...balance, available_micro: -1 }, { ...balance, available_micro: '12' }, { ...balance, held_micro: 0.1 }]) {
            const state = await readAIStatus(provider, server(value).fetch);
            expect(statusView(state).text).toContain('Credits unavailable');
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
        expect(statusView(state).lines).toContain('Usage unavailable. Could not load current information. Try again.');
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
        const s = server();
        expect(await readAIStatus(undefined, s.fetch)).toEqual({ balance: { code: 'not_configured' }, usage: { code: 'not_configured' }, limits: { code: 'not_configured' }, models: { code: 'not_configured' } });
        expect(s.calls).toHaveLength(0);
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
        pending[4]!(Response.json({ ...balance, available_micro: 2000000 })); pending[5]!(Response.json({ data: [] })); pending[6]!(Response.json(limits)); pending[7]!(Response.json(catalog)); await second;
        pending[0]!(Response.json(balance)); pending[1]!(Response.json({ data: [] })); pending[2]!(Response.json({ ...limits, pauses: [{ scope: 'user' }] })); pending[3]!(Response.json({ ...catalog, killswitch: true, pause: 'reconciliation' })); await first;
        expect(h.item.text).toBe('EZiL AI · 2 credits');
        expect(h.item.tooltip).not.toContain('AI paused');
        const last = h.status.refresh(); h.status.dispose(); const text = h.item.text;
        pending[8]!(Response.json(balance)); pending[9]!(Response.json({ data: [] })); pending[10]!(Response.json(limits)); pending[11]!(Response.json(catalog)); await last;
        expect(h.item.text).toBe(text); expect(h.item.dispose).toHaveBeenCalledTimes(1);
    });

    test('shows effective policy, platform ceilings, model limits and actual counters in the tooltip and popover', async () => {
        const h = harness(server(balance, { data: [row] }, 200, {
            ...limits,
            entitlement: { required: true, basis: 'subscription', subscription: { plan_id: 'starter' } },
            policy: {
                policy: { concurrency: 10, rpm: 30, tpm: 50000, max_output_tokens: 8192, daily_budget_micro: 0,
                    monthly_budget_micro: 12345678, allowed_models: ['qwen.qwen3-coder-next'] },
                sources: { concurrency: 'user', rpm: 'plan', tpm: 'account', max_output_tokens: 'role',
                    daily_budget_micro: 'default', monthly_budget_micro: 'plan', allowed_models: 'user' },
            },
            models: { 'qwen.qwen3-coder-next': { policy: { rpm: 5 }, sources: { rpm: 'user' } } },
        }).fetch);
        try {
            await h.status.show();
            expect(h.item.text).toBe('EZiL AI · Daily credit budget used');
            const rendered = JSON.stringify(h.popover.mock.calls);
            for (const line of ['Entitlement: subscription (required)', 'Concurrent requests: 2 (platform ceiling)',
                'Requests per minute: 30 (plan)', 'Tokens per minute: 50,000 (account)', 'Output tokens per request: 8,192 (role)',
                'Daily credit budget: 0 credits (default)', 'Monthly credit budget: 12.345678 credits (plan)',
                'Allowed models: qwen.qwen3-coder-next (user)', 'Current requests: 1 in flight, 0 pending',
                'Last minute: 3 requests, 1200 reserved tokens', 'Budget usage (held + settled): 3.5 credits this Gateway day, 12.5 this Gateway month',
                'Model limits — qwen.qwen3-coder-next (also subject to account limits)', 'Requests per minute: 5 (user)']) {
                expect(h.item.tooltip).toContain(line);
                expect(rendered).toContain(line);
            }
            expect(h.item.tooltip).not.toContain('Concurrent requests: 10');
        } finally { h.status.dispose(); }
    });

    test('absent policy values use reported ceilings without inventing other limits', async () => {
        const view = statusView(await readAIStatus(provider, server().fetch));
        expect(view.lines).toContain('Concurrent requests: 2 (platform ceiling)');
        expect(view.lines).toContain('Requests per minute: 60 (platform ceiling)');
        for (const label of ['Daily credit budget', 'Monthly credit budget', 'Tokens per minute']) expect(view.lines).toContain(`${label}: unknown`);
        expect(view.lines.join('\n')).not.toContain('unlimited');
    });

    test('entitlement and member pauses override credit availability while model/client pauses stay scoped', async () => {
        const view = async (l: unknown) => statusView(await readAIStatus(provider, server(balance, undefined, 200, l).fetch));
        expect((await view({ ...limits, entitlement: { required: true, basis: null } })).text).toBe('EZiL AI · AI access needed');
        for (const scope of ['user', 'account', 'role']) {
            const paused = await view({ ...limits, pauses: [{ scope }] });
            expect(paused.text).toBe('EZiL AI · Paused');
            expect(paused.lines).toContain(`AI paused: ${scope}`);
            expect(paused.lines).toContain('Available credits: 12.345678');
        }
        const scoped = await view({ ...limits, pauses: [{ scope: 'model' }, { scope: 'client' }] });
        expect(scoped.text).toBe('EZiL AI · 12.345678 credits');
        expect(scoped.lines).toContain('Scoped pauses may apply: model, client');
    });

    test('limits failure replaces prior limits and pauses without hiding fresh balance and usage', async () => {
        let fail = false;
        const h = harness((async (url, init) => {
            if (fail && String(url).endsWith('/me/limits')) return Response.json({ error: { code: 'policy_unavailable', message: 'private detail' } }, { status: 503 });
            return server(balance, undefined, 200, { ...limits, pauses: [{ scope: 'user' }] }).fetch(url, init);
        }) as typeof fetch);
        try {
            await h.status.refresh();
            expect(h.item.text).toBe('EZiL AI · Paused');
            fail = true;
            await h.status.show();
            expect(h.item.text).toBe('EZiL AI · 12.345678 credits · limits unavailable');
            expect(h.item.tooltip).toContain('Limits unavailable. Could not load current information. Try again.');
            expect(h.item.tooltip).toContain('qwen.qwen3-coder-next · settled · 1.25 credits');
            expect(h.item.tooltip).not.toMatch(/AI paused|platform ceiling|private detail|unlimited/);
        } finally { h.status.dispose(); }
    });

    test('invalid or partial limits never render fabricated allowance or availability', async () => {
        for (const l of [null, [], {}, { ...limits, policy: {} }, { ...limits, policy: { policy: [], sources: {} } },
            { ...limits, ceilings: { concurrency: 0, rpm: 60 } }, { ...limits, counters: { ...limits.counters, day_micro: -1 } },
            { ...limits, counters: { ...limits.counters, tpm: Number.MAX_SAFE_INTEGER + 1 } },
            { ...limits, entitlement: { required: true, basis: 'invented' } }, { ...limits, pauses: [{ scope: 'invented' }] },
            { ...limits, models: { qwen: { policy: { rpm: '60' }, sources: { rpm: 'user' } } } },
            { ...limits, policy: { policy: { rpm: 60 }, sources: {} } },
            { ...limits, policy: { policy: { daily_budget_micro: -1 }, sources: { daily_budget_micro: 'user' } } },
            { ...limits, policy: { policy: { allowed_models: [42] }, sources: { allowed_models: 'user' } } }]) {
            const state = await readAIStatus(provider, server(balance, undefined, 200, l).fetch);
            expect(state.limits.code).toBe('invalid_response');
            const view = statusView(state);
            expect(view.lines).toContain('Limits unavailable. Could not load current information. Try again.');
            expect(view.text).toBe('EZiL AI · 12.345678 credits · limits unavailable');
            expect(view.lines.join('\n')).not.toMatch(/unlimited|platform ceiling|Effective limits/);
        }
    });

    test('limits use bounded, cancellable GET requests and sanitized error codes', async () => {
        const aborted = (async (_url: string | URL | Request, init?: RequestInit) => { init?.signal?.throwIfAborted(); throw new Error('private detail'); }) as unknown as typeof fetch;
        expect((await readAIStatus(provider, aborted)).limits.code).toBe('network_error');
        expect((await readAIStatus(provider, aborted, AbortSignal.abort())).limits.code).toBe('request_cancelled');
        const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
        try { expect((await readAIStatus(provider, aborted)).limits.code).toBe('request_timeout'); }
        finally { timeout.mockRestore(); }
        const invalid = (async () => new Response('<html>not JSON</html>')) as unknown as typeof fetch;
        expect((await readAIStatus(provider, invalid)).limits.code).toBe('invalid_response');
        const refused = (async () => Response.json({ error: { code: '<unsafe>', message: 'private detail' } }, { status: 401 })) as unknown as typeof fetch;
        expect((await readAIStatus(provider, refused)).limits.code).toBe('http_401');
    });

    test('one refresh makes four authenticated no-store reads with a deadline on each', async () => {
        const s = server();
        const deadlines: number[] = [];
        const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
            deadlines.push(ms); return new AbortController().signal;
        });
        const controller = new AbortController();
        try {
            await readAIStatus({ ...provider, baseUrl: `${provider.baseUrl}///` }, s.fetch, controller.signal);
            expect(s.calls.map(call => call.url)).toEqual([
                'https://computer.test/ai/v1/me/balance', 'https://computer.test/ai/v1/me/usage?limit=5',
                'https://computer.test/ai/v1/me/limits', 'https://computer.test/ai/v1/models',
            ]);
            expect(deadlines).toEqual([5000, 5000, 5000, 5000]);
            for (const call of s.calls) expect(call.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error', headers: { authorization: 'Bearer test-only' } });
            controller.abort();
            for (const call of s.calls) expect(call.init?.signal?.aborted).toBe(true);
        } finally { timeout.mockRestore(); }
    });

    test('microcredits 1, 999999 and 1000001 stay exact in balance, window and net usage', async () => {
        for (const [micro, formatted] of [[1, '0.000001'], [999999, '0.999999'], [1000001, '1.000001']] as const) {
            const view = statusView(await readAIStatus(provider, server({ available_micro: micro, held_micro: micro,
                window: { ...creditWindow, remaining_micro: String(micro) } }, { data: [{ ...row, cost_micro: micro + 1, uncollected_micro: 1 }] }).fetch));
            expect(view.text).toStartWith(`EZiL AI · ${formatted} credits left`);
            expect(view.lines).toContain(`Available credits: ${formatted}`);
            expect(view.lines).toContain(`Held credits: ${formatted}`);
            expect(view.lines.join('\n')).toContain(`settled · ${formatted} credits`);
        }
        const large = '9007199254740993123456';
        const view = statusView(await readAIStatus(provider, server({ ...balance, window: {
            ...creditWindow, budget_micro: large, remaining_micro: large, used_micro: '0',
        } }).fetch));
        expect(view.text).toStartWith('EZiL AI · 9,007,199,254,740,993.123456 credits left');
    });

    test('global operations and reconciliation pauses override positive credits and preserve their details', async () => {
        for (const [pause, label, detail] of [
            ['operations', 'EZiL AI · Paused', 'AI is temporarily unavailable. Your credits are safe.'],
            ['reconciliation', 'EZiL AI · Paused · reconciling usage', 'AI is paused while usage is being reconciled. Your credits are safe.'],
            [null, 'EZiL AI · Paused', 'AI is temporarily unavailable. Your credits are safe.'],
        ] as const) {
            const h = harness(server({ ...balance, window: creditWindow }, undefined, 200, limits, { killswitch: true, pause }).fetch);
            try {
                await h.status.show();
                expect(h.item.text).toBe(label);
                expect(h.item.tooltip).toContain(detail);
                expect(h.item.tooltip).toContain('Available credits: 12.345678');
                expect(JSON.stringify(h.popover.mock.calls)).toContain(detail);
            } finally { h.status.dispose(); }
        }
        const view = statusView(await readAIStatus(provider, server(balance, undefined, 200, limits, { killswitch: false, pause: 'reconciliation' }).fetch));
        expect(view.text).not.toContain('Paused'); // The flag, not a stale reason alone, controls availability.
    });

    test('each refresh reads the current catalog and limits without sharing the model picker cache', async () => {
        let paused = false;
        const calls: string[] = [];
        const h = harness((async (url, init) => {
            calls.push(String(url));
            return server(balance, undefined, 200, { ...limits, ceilings: { concurrency: paused ? 1 : 2, rpm: 60 } },
                { killswitch: paused, pause: paused ? 'operations' : null }).fetch(url, init);
        }) as typeof fetch);
        try {
            await h.status.refresh();
            paused = true; await h.status.refresh();
            expect(h.item.text).toBe('EZiL AI · Paused');
            expect(h.item.tooltip).toContain('Concurrent requests: 1 (platform ceiling)');
            paused = false; await h.status.refresh();
            expect(h.item.text).toBe('EZiL AI · 12.345678 credits');
            expect(calls.filter(url => url.endsWith('/models'))).toHaveLength(3);
            expect(calls.filter(url => url.endsWith('/me/limits'))).toHaveLength(3);
        } finally { h.status.dispose(); }
    });

    test('missing or malformed catalog keeps availability unknown without hiding valid data', async () => {
        for (const value of [{}, null, { data: [] }, { killswitch: false }, { pause: null },
            { killswitch: 'false', pause: null }, { killswitch: true, pause: 'secret-code' }]) {
            const state = await readAIStatus(provider, server(balance, undefined, 200, limits, value).fetch);
            expect(state.models.code).toBe('invalid_response');
            const view = statusView(state);
            expect(view.text).toBe('EZiL AI · 12.345678 credits · availability unknown');
            expect(view.lines.join('\n')).toContain('Global AI availability unknown.');
            expect(view.lines).toContain('Concurrent requests: 2 (platform ceiling)');
            expect(view.lines.join('\n')).not.toMatch(/secret-code|invalid_response|none reported|unlimited/);
        }
        // Unused catalog and member fields are not required or displayed by status.
        const state = await readAIStatus(provider, server(balance, undefined, 200,
            { ...limits, account_public_id: 'private-id', counters: { ...limits.counters, open_micro: 'unused' } },
            { killswitch: true, pause: 'reconciliation', data: 'unused', private_metadata: 'private-value' }).fetch);
        expect(statusView(state).text).toContain('reconciling usage');
        expect(state.limits.value).toBeDefined();
        expect(statusView(state).lines.join('\n')).not.toMatch(/private-id|private-value|unused/);
    });

    test('partial endpoint failures show missing information without fabricating a healthy snapshot', async () => {
        for (const failed of ['/me/limits', '/models', '/me/balance', '/me/usage']) {
            const s = server();
            const state = await readAIStatus(provider, (async (url, init) => String(url).includes(failed)
                ? Response.json({ error: { code: 'not_found', message: 'private upstream detail' } }, { status: 404 }) : s.fetch(url, init)) as typeof fetch);
            const view = statusView(state);
            const rendered = view.lines.join('\n');
            expect(rendered).toContain(failed === '/me/limits' ? 'Limits unavailable.' : failed === '/models' ? 'Global AI availability unknown.'
                : failed === '/me/balance' ? 'Credits unavailable.' : 'Usage unavailable.');
            if (failed !== '/me/balance') expect(rendered).toContain('Available credits: 12.345678');
            if (failed !== '/me/usage') expect(rendered).toContain('settled · 1.25 credits');
            expect(rendered).not.toMatch(/not_found|private upstream detail|unlimited/);
        }
    });

    test('auth failures from any of the four reads show actionable copy without codes or secrets', async () => {
        for (const path of ['/me/balance', '/me/usage', '/me/limits', '/models']) {
            for (const [code, reason, label] of [
                ['os_session_missing', undefined, 'Sign-in needed'], ['os_session_expired', undefined, 'Session expired'],
                ['access_token_expired', undefined, 'Session expired'], ['unauthorized', 'expired', 'Session expired'],
                ['unauthorized', 'token_expired', 'Session expired'], ['os_proxy_unauthorized', undefined, 'Reconnect needed'],
            ] as const) {
                const s = server();
                const view = statusView(await readAIStatus(provider, (async (url, init) => String(url).includes(path)
                    ? Response.json({ error: { code, reason, message: 'secret response', token: 'private-token' } }, { status: 401 }) : s.fetch(url, init)) as typeof fetch));
                expect(view.text).toBe(`EZiL AI · ${label}`);
                const rendered = view.lines.join('\n');
                for (const raw of [code, 'secret response', 'private-token', 'test-only']) expect(rendered).not.toContain(raw);
            }
        }
        const s = server();
        expect(statusView(await readAIStatus(undefined, s.fetch)).text).toBe('EZiL AI · Not configured');
        expect(s.calls).toHaveLength(0);
    });

    test('held, window-used and budget-used states use exact server values, never a low-credit threshold', async () => {
        const held = statusView(await readAIStatus(provider, server({ available_micro: 0, held_micro: 1 }).fetch));
        expect(held.text).toBe('EZiL AI · Credits held');
        expect(held.lines).toContain('Held credits: 0.000001');
        const used = statusView(await readAIStatus(provider, server({ ...balance, window: { ...creditWindow, remaining_micro: '0' } }).fetch));
        expect(used.text).toContain('0 credits left');
        expect(used.text).toContain('window used');
        expect(used.lines).toContain('This window’s AI credits are used up.');
        for (const [key, counter, label] of [['daily_budget_micro', 'day_micro', 'Daily'], ['monthly_budget_micro', 'month_micro', 'Monthly']] as const) {
            const effective = { ...limits, policy: { policy: { [key]: 1000001 }, sources: { [key]: 'user' } },
                counters: { ...limits.counters, [counter]: 1000001 } };
            expect(statusView(await readAIStatus(provider, server(balance, undefined, 200, effective).fetch)).text).toBe(`EZiL AI · ${label} credit budget used`);
            effective.counters[counter] = 1000000;
            expect(statusView(await readAIStatus(provider, server(balance, undefined, 200, effective).fetch)).text).toBe('EZiL AI · 12.345678 credits');
        }
    });

    test('cancellation during either new read rejects a late successful response', async () => {
        for (const path of ['/me/limits', '/models']) {
            const controller = new AbortController();
            let resolve!: (response: Response) => void;
            const s = server();
            const pending = readAIStatus(provider, (async (url, init) => String(url).endsWith(path)
                ? new Promise<Response>(done => { resolve = done; }) : s.fetch(url, init)) as typeof fetch, controller.signal);
            controller.abort();
            resolve(Response.json(path === '/models' ? catalog : limits));
            const state = await pending;
            expect((path === '/models' ? state.models : state.limits).code).toBe('request_cancelled');
        }
    });

    test('config and bearer changes cannot publish a pending snapshot, even before the next refresh event', async () => {
        for (const change of ['bearer', 'baseUrl', 'unconfigured'] as const) {
            let configured: ResolvedProvider | undefined = { ...provider };
            const calls: { init?: RequestInit; resolve: (response: Response) => void }[] = [];
            const h = harness((async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>(resolve => calls.push({ init, resolve }))) as typeof fetch, () => configured);
            try {
                const old = h.status.refresh();
                if (change === 'unconfigured') configured = undefined;
                else if (change === 'bearer') configured!.apiKey = 'new-test-bearer';
                else configured!.baseUrl = 'https://other.test/ai/v1';
                for (const [index, payload] of [balance, { data: [] }, limits, { killswitch: true, pause: 'operations' }].entries()) calls[index]!.resolve(Response.json(payload));
                await old;
                expect(h.item.text).toBe('EZiL AI · Loading…');
                expect(h.item.tooltip).not.toMatch(/12\.345678|AI is temporarily unavailable/);
                const next = h.status.refresh();
                if (configured) {
                    for (const call of calls.slice(4)) expect(call.init?.headers).toEqual({ authorization: `Bearer ${configured.apiKey}` });
                    for (const [index, payload] of [balance, { data: [] }, limits, catalog].entries()) calls[index + 4]!.resolve(Response.json(payload));
                }
                await next;
                expect(h.item.text).toBe(configured ? 'EZiL AI · 12.345678 credits' : 'EZiL AI · Not configured');
            } finally { h.status.dispose(); }
        }
    });
});
