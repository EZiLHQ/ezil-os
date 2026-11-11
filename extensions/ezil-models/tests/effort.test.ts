import { test, expect } from 'bun:test';
import { parseGatewayEffort, effortConfigurationSchema, withSessionEffort } from '../src/effort';
import { buildGatewayBody } from '../src/gateway-messages';
import { buildGatewayResponsesBody } from '../src/gateway-responses';
import { parseGatewayModels, gatewayCatalogModels, withGatewayModelLimits, accountModelEvidence, forgetGatewayModels } from '../src/gateway';
import { gw, ask } from './fixtures/gateway';

test('capability is explicit, route-specific, bounded and never guessed', () => {
    const cap = { protocol: 'openai-responses', values: ['low', 'high'], default: null };
    expect(parseGatewayEffort(cap, 'openai-responses')?.values).toEqual(['low','high']);
    for (const value of [undefined, {}, {...cap, values:['low','low']}, {...cap, default:'max'}, {...cap, values:[]}, {...cap, values:['x'.repeat(33)]}, {...cap, extra:true}])
        expect(parseGatewayEffort(value,'openai-responses')).toBeUndefined();
    expect(parseGatewayEffort(cap,'anthropic-messages')).toBeUndefined();
    expect(effortConfigurationSchema(gw('gemini-3-pro'))).toBeUndefined();
    expect(() => withSessionEffort(gw('gemini-3-pro'),{reasoningEffort:'high'})).toThrow();
});

test('native provider modelConfiguration maps independently to Responses and Messages bytes', () => {
    for (const protocol of ['openai-responses','anthropic-messages'] as const) {
        const model = {...gw(), gatewayProtocol:protocol, gatewayEffort:{protocol,values:['low','high','max'],default:null}};
        const optionsA = {modelConfiguration:{reasoningEffort:'low'}};
        const optionsB = {modelConfiguration:{reasoningEffort:'high'}};
        const a = withSessionEffort(model,optionsA.modelConfiguration), b = withSessionEffort(model,optionsB.modelConfiguration);
        const build = protocol === 'openai-responses' ? buildGatewayResponsesBody : buildGatewayBody;
        const read = (m: typeof a) => JSON.parse(new TextDecoder().decode(build(m,ask()).bytes));
        const field = protocol === 'openai-responses' ? 'reasoning' : 'output_config';
        expect(read(a)[field]).toEqual({effort:'low'}); expect(read(b)[field]).toEqual({effort:'high'});
        expect(read(model)[field]).toBeUndefined(); expect(model).not.toHaveProperty('sessionEffort');
        // max is accepted ONLY when explicitly published for this exact route.
        expect(read(withSessionEffort(model,{reasoningEffort:'max'}))[field]).toEqual({effort:'max'});
        expect(() => withSessionEffort({...model,gatewayEffort:{...model.gatewayEffort,values:['low']}},{reasoningEffort:'max'})).toThrow();
        expect(() => build({...a,gatewayEffort:undefined},ask())).toThrow();
        expect(() => build({...a,gatewayProtocol: protocol === 'openai-responses' ? 'anthropic-messages':'openai-responses'},ask())).toThrow();
    }
});


test('catalog-only and configured models lose effort when account evidence is absent, stale or unavailable', async () => {
    const model = {...gw(),gatewayProtocol:'openai-responses' as const};
    const raw = {contract:'ezil.gateway.models.v1',killswitch:false,pause:null,data:[{id:model.model,enabled:true,max_input_tokens:131072,max_output_tokens:8192,
        protocols:['openai-responses'],availability:{state:'available',reasons:[]},effort:{protocol:'openai-responses',values:['low','high'],default:null}}]};
    const catalog = parseGatewayModels(raw)!;
    expect(gatewayCatalogModels(model.provider,catalog,[])[0]?.gatewayEffort?.values).toEqual(['low','high']);
    const selected = withGatewayModelLimits(model,catalog);
    expect(selected.gatewayEffort?.values).toEqual(['low','high']);
    expect(withGatewayModelLimits(selected,undefined).gatewayEffort).toBeUndefined();
    expect(withGatewayModelLimits(selected,{...catalog,killswitch:true}).gatewayEffort).toBeUndefined();
    expect(withGatewayModelLimits(selected,{...catalog,data:[{...catalog.data[0]!,enabled:false}]}).gatewayEffort).toBeUndefined();
    forgetGatewayModels();
    let clock = 1000;
    const fetcher = (async () => Response.json(raw)) as unknown as typeof fetch;
    const good = await accountModelEvidence([model],[model.id],fetcher,()=>clock);
    expect(good.efforts.get(model.id)?.values).toEqual(['low','high']);
    forgetGatewayModels();
    const slow = (async () => {clock += 16000; return Response.json(raw);}) as unknown as typeof fetch;
    const stale = await accountModelEvidence([model],[model.id],slow,()=>clock);
    expect(stale.available.size).toBe(0); expect(stale.efforts.size).toBe(0);
    forgetGatewayModels();
});


test('configured default Messages never advertises Responses-first effort; catalog-only Responses does', async () => {
    const configured = gw();
    expect(configured.gatewayProtocol).toBeUndefined();
    for (const protocols of [['openai-responses'], ['openai-responses', 'anthropic-messages']]) {
        forgetGatewayModels();
        const alias = 'catalog-only-responses';
        const row = (id: string) => ({id,enabled:true,max_input_tokens:131072,max_output_tokens:8192,
            protocols,availability:{state:'available',reasons:[]},effort:{protocol:'openai-responses',values:['low','high'],default:null}});
        const raw = {contract:'ezil.gateway.models.v1',killswitch:false,pause:null,data:[row(configured.model),row(alias)]};
        const catalog = parseGatewayModels(raw)!;
        const catalogModel = gatewayCatalogModels(configured.provider,catalog,[configured])[0]!;
        expect(catalogModel.gatewayProtocol).toBe('openai-responses');
        const fetcher = (async () => Response.json(raw)) as unknown as typeof fetch;
        const evidence = await accountModelEvidence([configured],[configured.id,catalogModel.id],fetcher,1000);
        // This is the source used to advertise effort, compared with actual execution helpers.
        expect(evidence.efforts.has(configured.id)).toBe(false);
        const messages = withGatewayModelLimits(configured,catalog);
        expect(effortConfigurationSchema(messages)).toBeUndefined();
        expect(() => withSessionEffort(messages,{reasoningEffort:'high'})).toThrow();
        expect(buildGatewayBody(messages,ask()).body).not.toHaveProperty('output_config');
        expect(evidence.efforts.get(catalogModel.id)).toEqual(catalogModel.gatewayEffort);
        const selected = withSessionEffort(catalogModel,{reasoningEffort:'high'});
        expect(buildGatewayResponsesBody(selected,ask()).body.reasoning).toEqual({effort:'high'});
        // Explicit configured Responses still uses the published Responses capability.
        const responses = {...configured,gatewayProtocol:'openai-responses' as const};
        const explicit = await accountModelEvidence([responses],[responses.id],fetcher,1000);
        expect(explicit.efforts.get(responses.id)).toEqual(withGatewayModelLimits(responses,catalog).gatewayEffort);
    }
    forgetGatewayModels();
});
