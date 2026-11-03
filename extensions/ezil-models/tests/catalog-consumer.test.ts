// The VS Code consumer of the Gateway catalog and user limits, against a FULL catalog shaped like the Gateway's
// proposed consumer contract (`ezil.gateway.models.v1`, EZiL AI Gateway feat/gw-budgetcatalog-20261103,
// docs/CATALOG-CONSUMER-CONTRACT.md; PROPOSED, not ACKed). Zero inference: every response is a fixture.
// What this client does with it today: it lists only the models configured in models.json and reconciles them
// with the catalog (enabled, protocols, caps). New contract fields (contract, catalog_ttl_seconds, availability)
// are tolerated and not yet read. A protocol it does not speak never discards the catalog. `null` limits are
// "No limit set", never "unknown"; only the session window's resets_at is ever shown as a reset time.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseModelsConfig, type ResolvedProvider } from '../src/config';
import { creditState, forgetGatewayModels, gatewayModelAvailable, gatewayModels, withGatewayModelLimits } from '../src/gateway';
import { KIMI, QWEN } from '../src/gateway-messages';
import { readAIStatus, statusView } from '../src/status-data';

const config = parseModelsConfig(readFileSync(`${import.meta.dir}/../../../worker/ezil-models/models.json`, 'utf8'),
    { env: { EZIL_AI_BASE_URL: 'https://computer.test/ai/v1', EZIL_AI_PROXY_TOKEN: 'synthetic-proxy-token' } });
const kimi = config.models.find(m => m.model === KIMI)!;
const qwen = config.models.find(m => m.model === QWEN)!;
const provider = kimi.provider as ResolvedProvider;

const row = (id: string, enabled: boolean, caps: [number, number], protocols: string[], state: string, reasons: string[] = []) =>
    ({ id, enabled, max_input_tokens: caps[0], max_output_tokens: caps[1], protocols, availability: { state, reasons } });
// Every entry the Gateway source defines (contract §3), plus the two runtime rows this image configures, plus a
// row that speaks only a protocol this client does not know.
const fullCatalog = (over: Record<string, unknown> = {}) => ({
    object: 'list', contract: 'ezil.gateway.models.v1', catalog_ttl_seconds: 10, killswitch: false, pause: null,
    data: [
        row('claude-haiku-5-5', false, [100_000, 32_000], ['anthropic-messages'], 'unavailable', ['model_disabled']),
        row('claude-sonnet-5-5', false, [1_000_000, 64_000], ['anthropic-messages'], 'unavailable', ['model_disabled']),
        row('ezil-code', false, [16_384, 4_096], ['openai-responses'], 'unavailable', ['model_disabled', 'no_active_pricing']),
        row('ezil-fast', false, [32_768, 8_192], ['openai-responses'], 'unavailable', ['model_disabled']),
        row(QWEN, true, [262_144, 65_536], ['anthropic-messages'], 'available'),
        row(KIMI, true, [100_000, 4_096], ['anthropic-messages'], 'available'),
        row('future-model', true, [50_000, 4_096], ['openai-chat-v9'], 'available'),
    ],
    ...over,
});
const serve = (catalog: unknown, status = 200) => {
    let reads = 0;
    const fetch = (async () => { reads++; return Response.json(catalog, { status }); }) as unknown as typeof globalThis.fetch;
    return { fetch, reads: () => reads };
};

describe('GET /models: the full catalog, as this client reads it', () => {
    test('the whole catalog is accepted with the new fields; configured models are reconciled, everything else is not listed', async () => {
        forgetGatewayModels();
        const catalog = await gatewayModels(provider, serve(fullCatalog()).fetch, 0);
        expect(catalog?.data.map(e => e.id)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'ezil-code', 'ezil-fast', QWEN, KIMI, 'future-model']);
        expect([gatewayModelAvailable(qwen, catalog), gatewayModelAvailable(kimi, catalog)]).toEqual([true, true]);
        // Caps: never raised above this image's configuration, lowered to the catalog's.
        expect(withGatewayModelLimits(kimi, catalog).maxInputTokens).toBe(Math.min(kimi.maxInputTokens, 100_000));
        expect(withGatewayModelLimits(qwen, catalog).maxInputTokens).toBe(qwen.maxInputTokens);
        expect(config.models.map(m => m.model).sort()).toEqual([KIMI, QWEN].sort()); // the picker lists these two only
        forgetGatewayModels();
    });

    test('a protocol this client does not speak drops out of its row only; it never discards the catalog', async () => {
        forgetGatewayModels();
        const catalog = await gatewayModels(provider, serve(fullCatalog()).fetch, 0);
        expect(catalog).toBeDefined();
        expect(catalog!.data.find(e => e.id === 'future-model')?.protocols).toEqual([]);
        // A configured model whose row speaks nothing we know is not selectable (never assumed Messages).
        const only = await (forgetGatewayModels(), gatewayModels(provider, serve(fullCatalog({ data: [row(KIMI, true, [100_000, 4_096], ['openai-chat-v9'], 'available')] })).fetch, 0));
        expect(gatewayModelAvailable(kimi, only)).toBe(false);
        forgetGatewayModels();
    });

    test('disabled, paused and unknown: the reason this client shows for each', async () => {
        const read = async (catalog: unknown, status = 200) => { forgetGatewayModels(); return gatewayModels(provider, serve(catalog, status).fetch, 0); };
        const disabled = await read(fullCatalog({ data: [row(KIMI, false, [100_000, 4_096], ['anthropic-messages'], 'unavailable', ['model_disabled'])] }));
        expect(gatewayModelAvailable(kimi, disabled)).toBe(false);
        expect(creditState(disabled, { available_micro: 5, held_micro: 0, grants: [] }, KIMI).text).toBe('This model is not available right now.');
        const reconciling = await read(fullCatalog({ killswitch: true, pause: 'reconciliation' }));
        expect(creditState(reconciling, undefined, KIMI).state).toBe('paused_reconciliation');
        const operations = await read(fullCatalog({ killswitch: true, pause: 'operations' }));
        expect(creditState(operations, undefined, KIMI).state).toBe('paused_operations');
        // Unreadable is unknown, never "unavailable": configured models stay selectable, the request decides.
        const unknown = await read({ error: { code: 'internal' } }, 500);
        expect(unknown).toBeUndefined();
        expect([gatewayModelAvailable(qwen, unknown), gatewayModelAvailable(kimi, unknown)]).toEqual([true, true]);
        forgetGatewayModels();
    });

    test('the catalog is read at most once per five minutes for one base URL and token', async () => {
        forgetGatewayModels();
        const s = serve(fullCatalog());
        for (const at of [0, 10_000, 299_999]) await gatewayModels(provider, s.fetch, at);
        expect(s.reads()).toBe(1);
        await gatewayModels(provider, s.fetch, 300_000);
        expect(s.reads()).toBe(2);
        forgetGatewayModels();
    });
});

describe('GET /me/limits and /me/balance: per-user budgets and reset, as shown', () => {
    const limits = (policy: Record<string, unknown>, sources: Record<string, string>) => ({
        entitlement: { required: false, basis: 'not_required' }, policy: { policy, sources }, models: {},
        ceilings: { concurrency: 2, rpm: 60 }, pauses: [], counters: { inflight: 0, pending: 0, rpm: 0, tpm: 0, day_micro: 3_000_000, month_micro: 9_000_000 } });
    const window = { seconds: 7200, budget_micro: '20000000', used_micro: '5000000', remaining_micro: '15000000', started_at: '2026-11-03T12:00:00Z', resets_at: '2026-11-03T14:00:00Z' };
    const status = (l: unknown, b: unknown = { available_micro: 15_000_000, held_micro: 0, window }) => {
        const fetch = (async (url: string) => {
            const path = new URL(url).pathname;
            if (path.endsWith('/me/balance')) return Response.json(b);
            if (path.endsWith('/me/usage')) return Response.json({ data: [] });
            if (path.endsWith('/me/limits')) return Response.json(l);
            return Response.json({ killswitch: false, pause: null, data: [] });
        }) as unknown as typeof globalThis.fetch;
        return readAIStatus(provider, fetch).then(statusView);
    };

    test('a null budget is "No limit set" (configured), never unknown and never "budget used"', async () => {
        const view = await status(limits({ daily_budget_micro: null, monthly_budget_micro: 10_000_000 }, { daily_budget_micro: 'plan', monthly_budget_micro: 'account' }));
        expect(view.lines).toContain('Daily credit budget: No limit set (plan)');
        expect(view.lines).toContain('Monthly credit budget: 10 credits (account)');
        expect(view.text).not.toContain('budget used');
        expect(view.text).not.toContain('limits unavailable');
    });

    test('a numeric budget that is reached still says so', async () => {
        const view = await status(limits({ daily_budget_micro: 3_000_000 }, { daily_budget_micro: 'user' }));
        expect(view.text).toBe('EZiL AI · Daily credit budget used');
    });

    test('only the session window shows a reset time; no daily or monthly reset is invented', async () => {
        const view = await status(limits({ daily_budget_micro: 5_000_000, monthly_budget_micro: null }, { daily_budget_micro: 'role', monthly_budget_micro: 'plan' }));
        expect(view.lines.filter(l => /reset/i.test(l))).toEqual([expect.stringMatching(/^Resets at \d{2}:\d{2} \(local time\)$/)]);
        const noWindow = await status(limits({}, {}), { available_micro: 15_000_000, held_micro: 0, window: { ...window, resets_at: null, started_at: null } });
        expect(noWindow.lines).toContain('Window starts with your next admitted request.');
    });

    test('limits that cannot be read are unknown, never unlimited', async () => {
        const view = await status({ error: { code: 'forbidden' } });
        expect(view.text).toContain('limits unavailable');
        expect(view.lines.join('\n')).not.toMatch(/unlimited|no limit/i);
    });
});
