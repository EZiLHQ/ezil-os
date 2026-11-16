// Offline tests of the exact pinned patch literals; optional pristine bundle validates every real anchor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'patch-copilot-chat.sh'), 'utf8');
const literal = name => {
    const match = source.match(new RegExp(`^${name}='(.*)'$`, 'm'));
    assert(match, name); return match[1];
};
const patched = process.env.COPILOT_PATCHED_TEST_ROOT;

test('exact context anchors exist in pinned distribution and applied replacements', { skip: !process.env.COPILOT_TEST_ROOT }, () => {
    for (const name of ['SUMMARY_OWNER', 'CONTEXT_THRESHOLD', 'CONTEXT_RENDER_BUDGET', 'CONTEXT_OUTPUT', 'CONTEXT_TOOL_COUNT',
        'CONTEXT_CACHE_UNKNOWN', 'CONTEXT_FALLBACK', 'CONTEXT_USAGE_DETAIL', 'CONTEXT_HOVER', 'CONTEXT_ESTIMATED_LABEL', 'CONTEXT_MODEL_OWNER']) {
        const file = ['CONTEXT_HOVER', 'CONTEXT_ESTIMATED_LABEL', 'CONTEXT_MODEL_OWNER'].includes(name)
            ? 'out/vs/code/browser/workbench/workbench.js' : 'extensions/copilot/dist/extension.js';
        const pristine = fs.readFileSync(path.join(process.env.COPILOT_TEST_ROOT, file), 'utf8');
        assert.equal(pristine.split(literal('A_' + name)).length - 1, 1, name);
        if (patched) assert.equal(fs.readFileSync(path.join(patched, file), 'utf8').split(literal('R_' + name)).length - 1, 1, name);
    }
});

test('background compaction boundary uses reserved token budget; no jitter summaries at low occupancy', () => {
    const condition = literal('R_CONTEXT_THRESHOLD').slice(3, -1);
    const decide = new Function('he', 're', 'Ie', 'a5n', `return ${condition}`);
    const endpoint = { endpoint: { modelProvider: 'ezil' } };
    // min(131072 input, 262144 capacity - 8192 output) - 8192 summary - 2048 system - 8000 tools.
    for (const used of [1, 12000, 53000, 100000, 112831]) assert.equal(decide.call(endpoint, used / 112832, true, true, () => { throw Error('jitter used'); }), false);
    assert.equal(decide.call(endpoint, 112832 / 112832, true, true), true);
    assert.equal(decide.call(endpoint, 1.01, true, false), false); // summary already in progress
    assert.equal(decide.call({ endpoint: { modelProvider: 'other' } }, .81, true, true, () => true), true);
});

test('cancel/restart discards old summary success AND failure; separate sessions do not share results', async () => {
    class Cancel {
        constructor() { this.token = { isCancellationRequested: false }; }
        cancel() { this.token.isCancellationRequested = true; }
        dispose() {}
    }
    const Factory = new Function('Si', `return class {constructor(){this._state="Idle"} ${literal('R_SUMMARY_OWNER')} cancel(){this._cts.cancel();this._cts=undefined;this._state="Idle"}}`)(Cancel);
    for (const failOld of [false, true]) {
        const first = new Factory(), second = new Factory();
        let oldResolve, oldReject, newResolve;
        first.start(() => new Promise((resolve, reject) => { oldResolve = resolve; oldReject = reject; }));
        first.cancel();
        first.start(() => new Promise(resolve => { newResolve = resolve; }));
        second.start(() => Promise.resolve('other session'));
        if (failOld) oldReject(new Error('old')); else oldResolve('old');
        await Promise.resolve(); await Promise.resolve();
        assert.equal(first._state, 'InProgress'); assert.equal(first._result, undefined); assert.equal(first._error, undefined);
        assert.equal(second._result, 'other session');
        newResolve('current'); await first._promise;
        assert.equal(first._result, 'current');
        const parentCancelled = new Factory();
        parentCancelled.start(() => Promise.resolve('cancelled result'));
        parentCancelled._cts.token.isCancellationRequested = true;
        await parentCancelled._promise;
        assert.equal(parentCancelled._state, 'Idle');
        parentCancelled.start(() => Promise.resolve('next turn'));
        await parentCancelled._promise;
        assert.equal(parentCancelled._result, 'next turn');
    }
});

test('EZiL tool counting serializes numbers/booleans once; output reserve uses the selected model', async () => {
    const count = literal('R_CONTEXT_TOOL_COUNT').replace('async countToolTokens(e){', '').split('let r=0;')[0];
    const seen = [];
    const result = await new Function('e', `return (async()=>{${count}})()`).call({ languageModel: { vendor: 'ezil', countTokens: value => { seen.push(value); return 31; } } }, [{ name: 'tool', inputSchema: { minimum: 123, additionalProperties: false } }]);
    assert.equal(result, 47);
    assert.equal(seen.length, 1); assert.match(seen[0], /123/); assert.match(seen[0], /false/);
    const expression = literal('R_CONTEXT_OUTPUT').split('outputBuffer:')[1].split(',copilotCredits:')[0];
    const reserve = new Function('he', 'y', `return ${expression}`);
    // LanguageModelChat has NO maxOutputTokens property in the pinned extension host. Use request metadata.
    assert.equal(reserve({ usage: { ezil_usage: { output_limit: 4096 } } }, { maxOutputTokens: 8192 }), 4096);
    assert.equal(reserve({ usage: {} }, { maxOutputTokens: 8192 }), 8192);

});

test('missing usage fallback is an estimate, and cancellation cannot report successful zero usage', async () => {
    const body = literal('R_CONTEXT_FALLBACK').split('return x||E>0?')[0];
    const run = new Function('m', 'I', `return (async()=>{let k="req",n=[],y={tools:[]},x="reply",E=0;${body};return I})()`);
    const host = { modelProvider: 'ezil', acquireTokenizer: () => ({ countMessagesTokens: async () => 300, countToolTokens: async () => 50, tokenLength: async () => 12 }) };
    assert.deepEqual(await run.call(host, { isCancellationRequested: false }), { prompt_tokens: 350, completion_tokens: 12, total_tokens: 362, ezil_usage: { source: 'estimated' } });
    const measured = { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 };
    assert.equal(await run.call(host, { isCancellationRequested: false }, measured), measured);
    assert.equal((await run.call(host, { isCancellationRequested: true })).type, 'canceled');
    const cancellation = { isCancellationRequested: false };
    const slow = { ...host, acquireTokenizer: () => ({ countMessagesTokens: async () => { cancellation.isCancellationRequested = true; return 300; }, countToolTokens: async () => 50, tokenLength: async () => 12 }) };
    assert.equal((await run.call(slow, cancellation)).type, 'canceled');
});

test('context widget uses response model ownership, nonzero sub-percent counts, and estimate labels', () => {
    const render = literal('R_CONTEXT_ESTIMATED_LABEL');
    const show = new Function('e', 't', 'd', render);
    const widget = { percentageLabel: {}, domNode: { setAttribute(key, value) { this[key] = value; } } };
    show.call(widget, { usedTokens: 53, promptTokenDetails: [{ category: 'EZiL usage', label: 'Local context budget utilization; full model capacity unknown; usage estimated; input 53' }] }, 0, () => 'usage');
    assert.equal(widget.percentageLabel.textContent, '~<1% budget');
    assert.equal(widget.domNode['aria-label'], 'Local context budget utilization: ~<1% budget');
    show.call(widget, { usedTokens: 53, promptTokenDetails: [] }, 0, () => 'usage');
    assert.equal(widget.percentageLabel.textContent, '<1%');
    const owner = new Function('n', `let r;${literal('R_CONTEXT_MODEL_OWNER')};return r`);
    assert.equal(owner.call({ _selectedModelId: 'new', resolveContextWindow: id => id }, 'answered'), 'answered');
});


test('cache hover labels actual zero separately from missing counters, without adding a context slice', () => {
    const expression = literal('R_CONTEXT_USAGE_DETAIL').slice('promptTokenDetails:'.length, -'}):this._accumulatedCopilotCredits'.length);
    const details = new Function('he', 'Ie', `return ${expression}`);
    const base = { prompt_tokens: 1000, completion_tokens: 120, ezil_usage: { source: 'measured' } };
    const unknown = details({ usage: base }, []);
    assert.match(unknown[0].label, /cache read unknown; cache write unknown/);
    assert.match(unknown[0].label, /Local context budget utilization; full model capacity unknown; usage measured/);
    assert.doesNotMatch(unknown[0].label, /Context measured/);
    const reported = details({ usage: { ...base, prompt_tokens_details: { cached_tokens: 700, cache_creation_input_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 90 } } }, []);
    assert.match(reported[0].label, /cache read 700; cache write 0; reasoning 90 \(included in output\)/);
    assert.equal(reported[0].percentageOfPrompt, 0);
    const body = literal('R_CONTEXT_HOVER').slice('renderTokenDetails(e,t){'.length) + '{this.tokenDetailsContainer.style.display="none";return}return e';
    const render = new Function('e', 't', '$e', 'jb', body);
    const container = { children: [], style: {}, get childElementCount() { return this.children.length; }, appendChild(child) { this.children.push(child); return child; } };
    render.call({ tokenDetailsContainer: container }, reported, 1, node => { node.children = []; }, () => ({}));
    assert.equal(container.style.display, '');
    assert.equal(container.children[0].textContent, reported[0].label);
});

test('trace command: real pristine anchor and applied registration dispatch valid Carbon v1 only', { skip: !process.env.COPILOT_TEST_ROOT || !patched }, () => {
    const { runInNewContext } = require('node:vm');
    const wb = 'out/vs/code/browser/workbench/workbench.js';
    const pristine = fs.readFileSync(path.join(process.env.COPILOT_TEST_ROOT, wb), 'utf8');
    const actual = fs.readFileSync(path.join(patched, wb), 'utf8');
    assert.equal(pristine.split(literal('A_AI_REQUEST_TRACE')).length - 1, 1);
    assert.equal(actual.split(literal('R_AI_REQUEST_TRACE')).length - 1, 1);
    const start = actual.indexOf('function ezilDispatchAIRequestTrace(');
    const registration = actual.slice(start, actual.indexOf(literal('A_AI_REQUEST_TRACE'), start));
    const handlers = new Map(), events = [];
    const window = { dispatchEvent: event => events.push(event) };
    runInNewContext(registration, { TextEncoder, window, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, qe: { registerCommand: (id, handler) => handlers.set(id, handler) } });
    const counts = { read: 0, search: 0, write: 0, other: 0 };
    const id = '01234567-89ab-4cde-8fab-0123456789ab';
    const record = { contract: 'ezil.inference.v1', adapterVersion: '0.1.0+carbon-progress.1', requestId: id, turnId: id,
        modelAlias: 'gemini-4-carbon', clientRequestId: id, gatewayRequestId: id, conversationId: null,
        toolCalls: [], toolResults: [], observationsTruncated: false, offered: counts, requested: counts,
        results: { matched: 0, error: 0, reportedSuccess: 0, unknown: 0, unmatched: 0 }, writeRequested: false,
        toolReportedSuccess: false, verifiedFileChange: null, usage: null, usageSource: 'unknown', estimatedInputTokens: 12,
        wireBytes: null, totalWireBytes: 0, attempts: 0, compaction: null, finishReason: null, durationMs: 1,
        cancelled: false, outcome: 'completed', thought_signature_replayed: false, readHeavyWithoutVerifiedEdit: false };
    const send = r => handlers.get('_ezil.aiRequestTrace')({}, r);
    send(record); assert.equal(events.length, 1); assert.equal(events[0].type, 'ezil-ai-request-trace');
    assert.deepEqual(JSON.parse(events[0].detail), record);
    for (const bad of [{ ...record, prompt: 'private' }, { ...record, outcome: 'stalled' }, { ...record, verifiedFileChange: true }, { ...record, requestId: 'bad' }, { ...record, usageSource: 'provider_reported' }]) send(bad);
    assert.equal(events.length, 1);
    window.dispatchEvent = () => { throw Error('observer unavailable'); }; assert.doesNotThrow(() => send(record));
});
