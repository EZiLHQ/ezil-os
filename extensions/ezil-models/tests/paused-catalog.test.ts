// Pausing inference must not unregister the user's selected model or leave the picker stuck after recovery.
import { beforeEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseModelsConfig } from '../src/config';
import { forgetGatewayModels, INCLUDED_MODELS_HEADER } from '../src/gateway';
import { KIMI, QWEN } from '../src/gateway-messages';
import { fakeVscode, TextPart } from './fixtures/fake-vscode';
mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider } = await import('../src/provider');
const FLASH = 'gemini-3.8-flash', CARBON = 'gemini-4-carbon', RESP = 'synthetic-responses';
const config = () => parseModelsConfig(readFileSync(`${import.meta.dir}/../../../worker/ezil-models/models.json`, 'utf8'),
    { env: { EZIL_AI_BASE_URL: 'https://computer.test/ai/v1', EZIL_AI_PROXY_TOKEN: 'synthetic-pause-token' } });
function harness(pause: 'reconciliation' | 'operations', free = false) {
    const parsed = config();
    const state = { paused: true, gets: 0, posts: 0 };
    const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, enabled: true, max_input_tokens: 100000, max_output_tokens: 4096,
        protocols: ['anthropic-messages'], availability: { state: state.paused ? 'unavailable' : 'available', reasons: state.paused ? ['gateway_paused'] : [] },
        capabilities: { tool_calling: true, streaming: true }, ...extra });
    const doFetch = (async (input: string | URL | Request) => {
        if (!String(input).endsWith('/models')) { state.posts++; throw new Error('No inference or balance request expected'); }
        state.gets++;
        return Response.json({ object: 'list', contract: 'ezil.gateway.models.v1', killswitch: state.paused, pause: state.paused ? pause : null,
            data: [row(QWEN), row(KIMI), row(FLASH), row(CARBON), row(RESP, { protocols: ['openai-responses'] }),
                row('synthetic-disabled', { enabled: false }),
                row('synthetic-denied', { availability: { state: 'unavailable', reasons: ['gateway_paused', 'not_allowed_for_caller'] } }),
                row('synthetic-entitlement', { availability: { state: 'unavailable', reasons: ['gateway_paused', 'entitlement_required'] } }),
                row('synthetic-route', { availability: { state: 'unavailable', reasons: ['gateway_paused', 'route_not_ready'] } }),
                row('synthetic-paused-future-restriction', { availability: { state: 'unavailable', reasons: ['gateway_paused', 'future-private-reason'] } }),
                row('synthetic-unknown-reason', { availability: { state: 'unavailable', reasons: ['future-private-reason'] } }),
                row('synthetic-unsupported', { protocols: ['future-protocol'] })] },
            { headers: free ? { [INCLUDED_MODELS_HEADER]: FLASH } : {} });
    }) as typeof fetch;
    const provider = new EZiLModelsProvider({ models: () => parsed.models, configError: () => undefined, secrets: () => parsed.secrets,
        logRequests: () => false, log: () => {}, recordUsage: () => {}, fetch: doFetch });
    let changes = 0;
    provider.onDidChangeLanguageModelChatInformation(() => changes++);
    return { provider, state, changes: () => changes };
}
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
const list = async (p: InstanceType<typeof EZiLModelsProvider>) => await p.provideLanguageModelChatInformation({} as never, token() as never) as { id: string; isUserSelectable?: boolean }[];
const send = (p: InstanceType<typeof EZiLModelsProvider>, info: unknown) => p.provideLanguageModelChatResponse(info as never,
    [{ role: 1, content: [new TextPart('hello')] }] as never, { tools: [], modelOptions: {} } as never, { report: () => {} }, token() as never);
beforeEach(() => forgetGatewayModels());
for (const pause of ['reconciliation', 'operations'] as const) {
    test(`${pause}: enabled models and selected Carbon ID stay registered while inference remains paused`, async () => {
        const h = harness(pause);
        const infos = await list(h.provider);
        expect(infos.map(i => i.id)).toEqual([QWEN, KIMI, `ezil/${FLASH}`, `ezil/${CARBON}`, `ezil/${RESP}`]);
        for (const id of [QWEN, `ezil/${CARBON}`, `ezil/${RESP}`]) {
            await expect(send(h.provider, infos.find(i => i.id === id))).rejects.toThrow(pause === 'reconciliation' ? /paused.*reconciled/i : /temporarily unavailable/i);
        }
        expect(h.state.posts).toBe(0);
    });
    test(`${pause}: an existing Free plan stays locked and no inference is sent`, async () => {
        const h = harness(pause, true);
        const infos = await list(h.provider);
        expect(infos.find(i => i.id === `ezil/${FLASH}`)?.isUserSelectable).toBe(true);
        expect(infos.find(i => i.id === `ezil/${CARBON}`)?.isUserSelectable).toBe(false);
        await expect(send(h.provider, infos.find(i => i.id === `ezil/${CARBON}`))).rejects.toThrow();
        expect(h.state.posts).toBe(0);
    });
    test(`${pause}: periodic recovery refreshes a valid paused catalog and announces unpause without a restart`, async () => {
        const h = harness(pause);
        const before = await list(h.provider);
        h.state.paused = false;
        await h.provider.recoverCatalog();
        expect(h.state.gets).toBe(2);
        expect(h.changes()).toBe(1);
        expect((await list(h.provider)).map(i => i.id)).toEqual(before.map(i => i.id));
        await h.provider.recoverCatalog();
        expect(h.state.gets).toBe(2);
        expect(h.state.posts).toBe(0);
    });
}
