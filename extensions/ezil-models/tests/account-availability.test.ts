// Which picker models the editor bridge may mark `availability: "available"` (gateway.ts accountAvailableIds): only on a
// fresh `/v1/models` read with that provider's own token that says the account may use that exact alias.
import { beforeEach, expect, test } from 'bun:test';

import { ACCOUNT_EVIDENCE_MAX_AGE_MS, accountAvailableIds, forgetGatewayModels, freshGatewayModels, gatewayModels } from '../src/gateway';
import { model } from './fixtures/load';

const QWEN = 'qwen.qwen3-coder-next';
const KIMI = 'us.moonshotai.kimi-k3';
const row = (id: string, state: 'available' | 'unavailable' | 'unknown' | null, enabled = true) => ({ id, enabled, max_input_tokens: 131072, max_output_tokens: 8192,
    protocols: ['anthropic-messages'], ...(state ? { availability: { state, reasons: state === 'available' ? [] : ['not_allowed_for_caller'] } } : {}) });
const catalog = (rows: unknown[], extra = {}) => ({ contract: 'ezil.gateway.models.v1', killswitch: false, pause: null, data: rows, ...extra });

/** A token-bound Gateway stand-in: each bearer token sees its own catalog (or status). */
function gateway(byToken: Record<string, unknown>) {
    const calls: string[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
        const token = String((init.headers as Record<string, string>).authorization).replace(/^Bearer /, '');
        calls.push(`${token} ${url}`);
        const answer = byToken[token];
        if (answer === undefined) return Response.json({ error: { code: 'os_proxy_unauthorized' } }, { status: 401 });
        if (typeof answer === 'number') return new Response('', { status: answer });
        return Response.json(answer);
    }) as unknown as typeof fetch;
    return { doFetch, calls };
}
const gw = (token: string, over = {}) => ({ type: 'ezil-gateway' as const, name: 'ezil', baseUrl: 'https://code.example/ai/v1', apiKey: token, ...over });
const configured = (id: string, alias: string, token: string) => model({ id, model: alias }, gw(token));

beforeEach(() => forgetGatewayModels());

test('two accounts, two tokens: each gets exactly its own allowed set, with the configured ids preserved', async () => {
    const { doFetch } = gateway({ tokA: catalog([row(QWEN, 'available'), row(KIMI, 'unavailable')]), tokB: catalog([row(QWEN, 'available'), row(KIMI, 'available')]) });
    const ids = ['qwen', 'kimi'];
    expect([...await accountAvailableIds([configured('qwen', QWEN, 'tokA'), configured('kimi', KIMI, 'tokA')], ids, doFetch)]).toEqual(['qwen']);
    expect([...await accountAvailableIds([configured('qwen', QWEN, 'tokB'), configured('kimi', KIMI, 'tokB')], ids, doFetch)]).toEqual(['qwen', 'kimi']);
});

test('denied, disabled, missing, legacy (no availability), unknown, killswitch or pause: never available', async () => {
    const models = [configured('qwen', QWEN, 't')];
    for (const answer of [catalog([row(QWEN, 'unavailable')]), catalog([row(QWEN, 'available', false)]), catalog([row(KIMI, 'available')]),
        catalog([row(QWEN, null)]), catalog([row(QWEN, 'unknown')]), { killswitch: false, pause: null, data: [row(QWEN, 'available')] },
        catalog([row(QWEN, 'available')], { killswitch: true }), catalog([row(QWEN, 'available')], { pause: 'operations' })]) {
        forgetGatewayModels();
        expect([JSON.stringify(answer).slice(0, 60), (await accountAvailableIds(models, ['qwen'], gateway({ t: answer }).doFetch)).size]).toEqual([JSON.stringify(answer).slice(0, 60), 0]);
    }
});

test('a static (directly configured) model never has Gateway evidence, even when a Gateway row of the same alias is available', async () => {
    const { doFetch, calls } = gateway({ t: catalog([row('claude-probe', 'available')]) });
    const direct = model({ id: 'probe', model: 'claude-probe' }, { type: 'anthropic', apiKey: 't' });
    expect((await accountAvailableIds([direct], ['probe'], doFetch)).size).toBe(0);
    expect(calls).toEqual([]);
});

test('a catalog-only id is <provider>/<alias> and needs its own row available; unknown ids are never available', async () => {
    const { doFetch } = gateway({ t: catalog([row(QWEN, 'available'), row('glm-5', 'available')]) });
    const models = [configured('qwen', QWEN, 't')];
    expect([...await accountAvailableIds(models, ['ezil/glm-5', 'ezil/nope', 'other/glm-5', 'nothing'], doFetch)]).toEqual(['ezil/glm-5']);
});

test('freshness: a read within the window is reused; older evidence is re-read, and a failed re-read is no evidence (never the stale catalog)', async () => {
    let answer: unknown = catalog([row(QWEN, 'available')]);
    const calls: number[] = [];
    const doFetch = (async () => { calls.push(1); return typeof answer === 'number' ? new Response('', { status: answer }) : Response.json(answer); }) as unknown as typeof fetch;
    const models = [configured('qwen', QWEN, 't')];
    const t0 = 1_800_000_000_000;
    expect((await accountAvailableIds(models, ['qwen'], doFetch, t0)).size).toBe(1);
    expect((await accountAvailableIds(models, ['qwen'], doFetch, t0 + ACCOUNT_EVIDENCE_MAX_AGE_MS)).size).toBe(1);
    expect(calls.length).toBe(1);
    answer = 503;
    expect((await accountAvailableIds(models, ['qwen'], doFetch, t0 + ACCOUNT_EVIDENCE_MAX_AGE_MS + 1)).size).toBe(0);
    expect(calls.length).toBe(2);
    answer = 'not json';
    expect((await accountAvailableIds(models, ['qwen'], doFetch, t0 + 10 * ACCOUNT_EVIDENCE_MAX_AGE_MS)).size).toBe(0);
    const thrown = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await accountAvailableIds(models, ['qwen'], thrown, t0 + 20 * ACCOUNT_EVIDENCE_MAX_AGE_MS)).size).toBe(0);
});

test('one read per token per catalog build, whatever the number of rows', async () => {
    const { doFetch, calls } = gateway({ t: catalog([row(QWEN, 'available'), row(KIMI, 'available')]) });
    await accountAvailableIds([configured('qwen', QWEN, 't'), configured('kimi', KIMI, 't')], ['qwen', 'kimi', 'ezil/x'], doFetch);
    expect(calls.length).toBe(1);
});

/** A clock the test moves, and a Gateway stand-in whose read takes `slow[token]` ms of that clock. */
function slowGateway(byToken: Record<string, unknown>, slow: Record<string, number>, clock: { t: number }) {
    const reads: Record<string, number[]> = {};
    const doFetch = (async (_url: string, init: RequestInit) => {
        const token = String((init.headers as Record<string, string>).authorization).replace(/^Bearer /, '');
        (reads[token] ??= []).push(clock.t);
        clock.t += slow[token] ?? 0;
        return Response.json(byToken[token]);
    }) as unknown as typeof fetch;
    return { doFetch, reads };
}

test('a slow provider read fails closed: evidence whose read began more than the window before emission is dropped, a fresh one kept', async () => {
    const clock = { t: 1_800_000_000_000 };
    const { doFetch } = slowGateway({ slowTok: catalog([row(QWEN, 'available')]), fastTok: catalog([row(KIMI, 'available')]) }, { slowTok: ACCOUNT_EVIDENCE_MAX_AGE_MS + 5_000 }, clock);
    const models = [configured('qwen', QWEN, 'slowTok'), configured('kimi', KIMI, 'fastTok')];
    // qwen's read begins at t0 and ends 20 s later; kimi's begins then. At emission qwen's evidence is 20 s old: not evidence.
    expect([...await accountAvailableIds(models, ['qwen', 'kimi'], doFetch, () => clock.t)]).toEqual(['kimi']);
    // The same collection on a fixed instant (the pre-existing form) still works.
    forgetGatewayModels();
    expect([...await accountAvailableIds(models, ['qwen', 'kimi'], gateway({ slowTok: catalog([row(QWEN, 'available')]), fastTok: catalog([row(KIMI, 'available')]) }).doFetch, clock.t)]).toEqual(['qwen', 'kimi']);
});

test('a cached read that ages out while another provider is read is read again, never reused stale', async () => {
    const clock = { t: 1_800_000_000_000 };
    const { doFetch, reads } = slowGateway({ slowTok: catalog([row(QWEN, 'available')]), cachedTok: catalog([row(KIMI, 'available')]) }, { slowTok: 7_000 }, clock);
    const models = [configured('qwen', QWEN, 'slowTok'), configured('kimi', KIMI, 'cachedTok')];
    const t0 = clock.t;
    await accountAvailableIds([models[1]!], ['kimi'], doFetch, () => clock.t);
    expect(reads.cachedTok).toEqual([t0]);
    // 10 s later the cache is still inside the window when the collection starts; the 7 s slow read pushes it to 17 s.
    clock.t = t0 + 10_000;
    expect([...await accountAvailableIds(models, ['qwen', 'kimi'], doFetch, () => clock.t)].sort()).toEqual(['kimi', 'qwen']);
    expect(reads.cachedTok).toEqual([t0, t0 + 17_000]);
    // A clock that runs backwards is no evidence either.
    forgetGatewayModels();
    const back = { t: t0 + 100_000 };
    const gw2 = gateway({ slowTok: catalog([row(QWEN, 'available')]) });
    let calls = 0;
    expect((await accountAvailableIds([models[0]!], ['qwen'], gw2.doFetch, () => (calls++ === 0 ? back.t : back.t - 1))).size).toBe(0);
});

test('evidence collected for one id that ages out before a later id of the same token is decided is read again, not reused', async () => {
    const clock = { t: 1_800_000_000_000 };
    const t0 = clock.t;
    const { doFetch, reads } = slowGateway({ tokOne: catalog([row(QWEN, 'available'), row(KIMI, 'available')]), slowTok: catalog([row('glm-5', 'available')]), tokTwo: catalog([row('other', 'available')]) },
        { slowTok: ACCOUNT_EVIDENCE_MAX_AGE_MS + 1_000 }, clock);
    const models = [configured('first', QWEN, 'tokOne'), model({ id: 'filler', model: 'glm-5' }, gw('slowTok')), model({ id: 'plain', model: 'other' }, gw('tokTwo')), configured('again', KIMI, 'tokOne')];
    const allowed = [...await accountAvailableIds(models, ['first', 'filler', 'plain', 'again'], doFetch, () => clock.t)].sort();
    // The 16 s filler read ages the first tokOne read out: 'first' and 'filler' are dropped at emission, 'again' re-reads and stays.
    expect(allowed).toEqual(['again', 'plain']);
    expect(reads.tokOne).toEqual([t0, t0 + ACCOUNT_EVIDENCE_MAX_AGE_MS + 1_000]);
});

test('joined pending evidence retains the underlying read start, not the joining caller time', async () => {
    const models = [configured('qwen', QWEN, 'joined-token')];
    const t0 = 1_800_000_000_000;
    let clock = t0, reads = 0;
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finish = resolve; });
    const doFetch = (async () => { reads++; return response; }) as unknown as typeof fetch;
    const original = gatewayModels(models[0]!.provider, doFetch, clock, undefined, true);
    clock += 20_000;
    const joined = freshGatewayModels(models[0]!.provider, doFetch, clock);
    const allowed = accountAvailableIds(models, ['qwen'], doFetch, () => clock);
    clock += 1_000;
    finish(Response.json(catalog([row(QWEN, 'available')])));
    await original;
    expect((await joined)?.at).toBe(t0);
    expect([...await allowed]).toEqual([]);
    expect(reads).toBe(1);
});

test('a joined pending read still inside the evidence window remains usable without a duplicate fetch', async () => {
    const models = [configured('qwen', QWEN, 'fresh-joined-token')];
    const t0 = 1_800_000_000_000;
    let clock = t0, reads = 0;
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finish = resolve; });
    const doFetch = (async () => { reads++; return response; }) as unknown as typeof fetch;
    const original = gatewayModels(models[0]!.provider, doFetch, clock, undefined, true);
    clock += 1_000;
    const joined = freshGatewayModels(models[0]!.provider, doFetch, clock);
    const allowed = accountAvailableIds(models, ['qwen'], doFetch, () => clock);
    finish(Response.json(catalog([row(QWEN, 'available')])));
    await original;
    expect((await joined)?.at).toBe(t0);
    expect([...await allowed]).toEqual(['qwen']);
    expect(reads).toBe(1);
});
