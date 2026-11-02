// Run: COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/summarize-budget-patch.test.cjs
// Part 1b (PATCHES.md). Executes the agent intent's real buildPrompt control flow, extracted from
// the PATCHED Copilot Chat 0.69.0 bundle: tool count -> budget -> normal render -> budget exceeded
// -> foreground summarization U -> fallback B. Copilot's own extension-model endpoint (Ok) and
// tokenizer (dft) classes and its helpers (w6o, A_r, rp, M7e) are the real ones from the bundle.
// Stubbed: the prompt renderer factory vn.create (it records the endpoint each render gets and
// throws or returns as scripted), prompt-tsx's BudgetExceededError, metadata classes, services.
// The same harness on the unmodified input is the negative control. Skips without a local bundle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const providerSrc = path.join(__dirname, '..', '..', 'extensions', 'ezil-models', 'src');
const provider = path.join(providerSrc, 'provider.ts');
const ext = 'extensions/copilot/dist/extension.js';
const files = [ext, 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', 'out/vs/code/browser/workbench/workbench.js', 'out/vs/code/browser/workbench/workbench.css'];
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

const U_OLD = 'return await vn.create(this.instantiationService,this.endpoint,this.prompt,{...we,endpoint:this.endpoint,promptContext:we.promptContext,triggerSummarize:!0,forceSimpleSummary:!0}).render(r,o)';
const U_NEW = 'return await vn.create(this.instantiationService,I,this.prompt,{...we,endpoint:this.endpoint,promptContext:we.promptContext,triggerSummarize:!0,forceSimpleSummary:!0}).render(r,o)';
const B_CREATE = 'let he=vn.create(this.instantiationService,this.endpoint,this.prompt,{...we,endpoint:this.endpoint,enableSummarization:!1,enableCacheBreakpoints:!1});';
const SPAN_START = 'let u=n.tools?.availableTools,d=!!this.endpoint.supportsToolSearch,';
const SPAN_END = 'this._lastRenderTokenCount=k.tokenCount;';
const ADVERTISED = 120480; // what ezil-models advertises as maxInputTokens for Qwen/Kimi today

const once = (code, literal) => {
  const i = code.indexOf(literal); assert(i >= 0, `missing ${literal.slice(0, 60)}`);
  assert.equal(code.indexOf(literal, i + 1), -1, `${literal.slice(0, 60)} occurs more than once`);
  return i;
};
const between = (code, start, end) => {
  const i = once(code, start); const j = code.indexOf(end, i + start.length); assert(j > i, `missing ${end.slice(0, 60)}`);
  return code.slice(i, j);
};
const span = code => between(code, SPAN_START, SPAN_END) + SPAN_END;

// Loads the real code from a bundle and returns a runner for one buildPrompt pass.
function harness(code) {
  const body = [
    between(code, 'var F7a=3,Q7a=3,dft=class{', 'Ok=R([b(1,J),b(2,wr),b(3,Ee)],Ok);'),   // tokenizer + extension endpoint
    between(code, 'function w6o(t,e,n){', 'var Ret='),                                  // summarize threshold
    between(code, 'function A_r(t,e,n){', 'function C6o('),                              // Responses context management
    between(code, 'function rp(t,e,n=t.length-1){', 'function lM('),                     // findLast
    'var M7e=' + between(code, '{warmJitterMin:', ';function a5n('),                       // background compaction ratios
    `return { dft, Ok, buildPromptSpan: async function (n, r, o, c) {\n${span(code)}\nreturn { k, q, I, E, x, p, h, y, _ }; } };`,
  ].join(';\n');
  class BudgetExceededError extends Error { constructor(m) { super(m); this.metadata = { getAll: () => [] }; } }
  class Kh { constructor(id, text, meta) { Object.assign(this, meta); this.toolCallRoundId = id; this.text = text; } }
  class QT {}
  class DF {}
  const Y = {
    Advanced: { SummarizeAgentConversationHistoryThreshold: { id: 'chat.advanced.summarizeAgentConversationHistoryThreshold' }, UseResponsesApiTruncation: 'chat.advanced.useResponsesApiTruncation' },
    SummarizeAgentConversationHistory: 'chat.summarizeAgentConversationHistory.enabled',
    ResponsesApiContextManagementEnabled: 'chat.responsesApiContextManagement.enabled',
  };
  const dm = { LanguageModelChatApiType: { ChatCompletions: 1, Responses: 2, Messages: 3 } };
  let calls = [], behaviours = [];
  const vn = { create(inst, endpoint, ctor, props) { const call = { inst, endpoint, ctor, props }; calls.push(call); return { render: async () => { const next = behaviours.shift(); assert(next, 'unexpected extra render'); return next(call); } }; } };
  const names = ['Oj', 'dm', 'D5e', 'Qne', 'N8e', 'p5e', 'Y', 'DF', 'QT', 'Kh', 'jw', 'Gy', 'vn', 'dBe', 'Tr', '$v'];
  const values = [{ OutputMode: { Raw: 'raw' }, Raw: { ChatCompletionContentPartKind: {} } }, dm, () => true, () => undefined, () => false, new Set(), Y, DF, QT, Kh,
    class { constructor(t) { this.title = t; } }, { t: s => s }, vn, { BudgetExceededError }, { incrementAgentSummarizationCount() {} }, Symbol('toolResultMetadata')];
  const { dft, Ok, buildPromptSpan } = new Function(...names, body)(...values);
  const services = { createInstance(C, ...args) { return new C(...args, services, {}, {}); } };

  // The endpoint Copilot builds for a provider model: the real Ok class over a LanguageModelChat
  // shaped like the one the extension host hands out (capabilities.apiType only when declared).
  const endpoint = ({ apiType } = {}) => services.createInstance(Ok, {
    id: 'ezil/kimi', vendor: 'ezil', family: 'kimi', name: 'Kimi', version: '1', maxInputTokens: ADVERTISED,
    capabilities: { supportsImageToText: false, supportsToolCalling: true, editToolsHint: undefined, apiType, supportsAdaptiveThinking: undefined },
    countTokens: async s => Buffer.byteLength(String(s)),   // any monotone count; the budget arithmetic is what is under test
  });
  const throwBudget = () => { throw new BudgetExceededError('prompt exceeds budget'); };
  const ok = tokenCount => () => ({ tokenCount, messages: [], metadata: { get: () => undefined } });

  async function pass({ tools, script: seq, priorOutcome, apiType, truncation = false }) {
    calls = []; behaviours = [...seq];
    const turn = { meta: new Map(), getMetadata(C) { return this.meta.get(C); }, setMetadata(v) { this.meta.set(v.constructor, v); } };
    if (priorOutcome) turn.meta.set(Kh, { source: 'foreground', outcome: priorOutcome });
    const config = { [Y.SummarizeAgentConversationHistory]: true, [Y.Advanced.UseResponsesApiTruncation]: truncation };
    const self = {
      endpoint: endpoint({ apiType }), prompt: DF, request: {}, location: 1, extraPromptProps: {}, stableToolReferences: [], instantiationService: { id: 'agent-intent' },
      configurationService: { getConfig: k => config[k], getExperimentBasedConfig: () => false }, expService: {},
      logService: { debug() {}, error() {}, warn() {} }, telemetryService: { sendMSFTTelemetryEvent() {} }, otelService: {},
      _getOrCreateBackgroundSummarizer: () => undefined, _lastRenderTokenCount: 0,
    };
    const n = { tools: tools && { availableTools: tools }, conversation: { sessionId: 's', turns: [], getLatestTurn: () => turn }, chatVariables: {} };
    const out = await buildPromptSpan.call(self, n, { report() {} }, {}, n.chatVariables);
    assert.equal(behaviours.length, 0, 'every scripted render ran');
    return { self, calls: calls.slice(), turn, out };
  }
  return { pass, throwBudget, ok, Kh, dft, Ok, endpoint, BudgetExceededError };
}

// Copilot's countToolTokens, written out independently of the bundle (cross-checks the real dft).
const countTools = tools => {
  const obj = o => Object.entries(o).reduce((n, [k, v]) => !v ? n : n + Buffer.byteLength(k) + (typeof v === 'string' ? Buffer.byteLength(v) : typeof v === 'object' ? obj(v) : 0), 0);
  return Math.floor(((tools.length ? 16 : 0) + tools.reduce((n, t) => n + 8 + obj({ name: t.name, description: t.description, parameters: t.inputSchema }), 0)) * 1.1);
};
const agentTools = Array.from({ length: 39 }, (_, i) => ({ name: `tool_${i}`, description: 'Reads or edits workspace files. '.repeat(30), inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'A workspace-relative path. '.repeat(10) } }, required: ['path'] } }));

test('Part 1b: summarization render gets the tool-adjusted budget; fallback B unchanged', { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-summarize-budget-'));
  try {
    for (const file of files) { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, file), dest); }
    for (const args of [[root], ['--verify', root]]) {
      const result = run(...args); assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /gate ok \[summarize-scope\]/);
      assert.match(result.stdout, /gate ok \[summarize-fallback-unpatched\] extension\.js x1/);
    }
    const pristine = fs.readFileSync(path.join(source, ext), 'utf8');
    const patched = fs.readFileSync(path.join(root, ext), 'utf8');
    const p = countTools(agentTools);
    const toolBudget = Math.max(1, Math.floor((ADVERTISED - p) * 0.9));

    await t.test('only U changed in the whole buildPrompt span', () => {
      assert.equal(span(patched), span(pristine).replace(U_OLD, U_NEW));
      once(patched, U_NEW); assert.equal(patched.indexOf(U_OLD), -1); once(patched, B_CREATE);
    });

    const after = harness(patched), before = harness(pristine);

    await t.test('patched: budget exceeded -> U renders with I (tool-adjusted), summarizer keeps the full endpoint', async () => {
      const { self, calls, out } = await after.pass({ tools: agentTools, script: [after.throwBudget, after.ok(42)] });
      assert.equal(out.p, p, 'real countToolTokens matches the written-out formula');
      assert.equal(out.y, false); assert.equal(out.E, toolBudget);
      assert.notEqual(out.I, self.endpoint); assert.equal(out.I.modelMaxPromptTokens, toolBudget);
      assert.equal(self.endpoint.modelMaxPromptTokens, ADVERTISED);
      assert.equal(calls.length, 2);
      const [normal, u] = calls;
      assert.equal(normal.endpoint, out.I); assert.equal(normal.props.endpoint, out.I); assert.equal(normal.props.triggerSummarize, undefined);
      assert.equal(u.props.triggerSummarize, true); assert.equal(u.props.forceSimpleSummary, true);
      assert.equal(u.endpoint, out.I, 'U render budget / IPromptEndpoint is I');
      assert.equal(u.endpoint.modelMaxPromptTokens, toolBudget);
      assert.equal(u.props.endpoint, self.endpoint, 'summary request endpoint stays the full one (simple mode sends no tools)');
      assert.equal(u.props.promptContext, normal.props.promptContext, 'same conversation, nothing dropped by the patch');
      assert.equal(out.k.tokenCount, 42); assert.equal(self._lastRenderTokenCount, 42); assert.equal(out.q, true);
    });

    await t.test('negative control: the unpatched bundle renders U at the full advertised budget', async () => {
      const { self, calls, out } = await before.pass({ tools: agentTools, script: [before.throwBudget, before.ok(42)] });
      assert.equal(out.I.modelMaxPromptTokens, toolBudget);
      assert.equal(calls[1].props.triggerSummarize, true);
      assert.equal(calls[1].endpoint, self.endpoint); assert.equal(calls[1].endpoint.modelMaxPromptTokens, ADVERTISED);
    });

    await t.test('U over I budget -> failure recorded, B renders at the full endpoint as upstream', async () => {
      const { self, calls, turn } = await after.pass({ tools: agentTools, script: [after.throwBudget, after.throwBudget, after.ok(7)] });
      assert.equal(calls.length, 3);
      const b = calls[2];
      assert.equal(b.endpoint, self.endpoint); assert.equal(b.props.endpoint, self.endpoint);
      assert.equal(b.props.enableSummarization, false); assert.equal(b.props.enableCacheBreakpoints, false);
      assert.equal(turn.getMetadata(after.Kh).outcome, 'budgetExceeded'); assert.equal(turn.getMetadata(after.Kh).source, 'foreground');
    });

    await t.test('B over its budget -> upstream "Unable to build prompt" with the advertised number', async () => {
      await assert.rejects(after.pass({ tools: agentTools, script: [after.throwBudget, after.throwBudget, after.throwBudget] }),
        new RegExp(`^Error: Unable to build prompt, modelMaxPromptTokens = ${ADVERTISED} \\(prompt exceeds budget\\)$`));
    });

    await t.test('prior foreground failure in the turn -> straight to B at the full endpoint (no second summary)', async () => {
      const { self, calls } = await after.pass({ tools: agentTools, priorOutcome: 'error', script: [after.throwBudget, after.ok(5)] });
      assert.equal(calls.length, 2); assert.equal(calls[1].props.triggerSummarize, undefined);
      assert.equal(calls[1].props.enableSummarization, false); assert.equal(calls[1].endpoint, self.endpoint);
    });

    await t.test('no tools -> I is the endpoint itself, U identical to upstream', async () => {
      for (const tools of [undefined, []]) {
        const { self, calls, out } = await after.pass({ tools, script: [after.throwBudget, after.ok(3)] });
        assert.equal(out.p, 0); assert.equal(out.I, self.endpoint); assert.equal(calls[1].endpoint, self.endpoint);
      }
    });

    await t.test('y and D: apiType comes only from capabilities.apiType; ezil models declare none', async () => {
      assert.equal(after.endpoint().apiType, undefined);
      // No apiType: D is false, so the normal render and U keep cache breakpoints (prompt-tsx cannot
      // prune content before the last one, so an over-budget render throws instead of dropping rounds).
      const e = await after.pass({ tools: agentTools, script: [after.throwBudget, after.ok(1)] });
      assert.equal(e.out.y, false);
      assert.equal(e.calls[0].props.enableCacheBreakpoints, true); assert.equal(e.calls[1].props.enableCacheBreakpoints, true);
      // Control: a Responses endpoint with useResponsesApiTruncation would make E unbounded.
      const r = await after.pass({ tools: agentTools, apiType: 2, truncation: true, script: [after.throwBudget, after.ok(1)] });
      assert.equal(r.out.y, true); assert.equal(r.calls[1].endpoint.modelMaxPromptTokens, Number.MAX_SAFE_INTEGER);
      // Control: a Messages endpoint sets D, which turns cache breakpoints off for the normal render
      // and U: they would then prune older rounds silently instead of throwing (Part 1b would not hold).
      const m = await after.pass({ tools: agentTools, apiType: 3, script: [after.throwBudget, after.ok(1)] });
      assert.equal(m.self.endpoint.apiType, 'messages'); assert.equal(m.out.y, false);
      assert.equal(m.calls[0].props.enableCacheBreakpoints, false); assert.equal(m.calls[1].props.enableCacheBreakpoints, false);
      // The extension host passes capabilities.apiType through only when the provider declares it.
      const host = fs.readFileSync(path.join(source, 'out/vs/workbench/api/node/extensionHostProcess.js'), 'utf8');
      once(host, 'apiType:n.metadata.capabilities?.apiType===void 0?void 0:HX[n.metadata.capabilities.apiType]');
      // Any apiType in ezil-models trips this, whatever its value or form: Responses can make y true,
      // Messages makes D true, and Ok compares enum values, so a word match would miss `apiType: 2` or a
      // constant. A false positive fails loudly, which is the safe direction.
      assert(fs.existsSync(provider), `missing ${provider}`);
      const sources = fs.readdirSync(providerSrc, { recursive: true }).filter(f => /\.[cm]?[jt]s$/.test(f)).map(f => path.join(providerSrc, f));
      assert(sources.includes(provider));
      for (const f of sources) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /apiType/i, `${path.relative(providerSrc, f)} mentions apiType: re-check y and D (PATCHES.md Part 1b)`);
    });

    await t.test('rerun: a second patch run fails loudly and leaves the tree verifiable', () => {
      const again = run(root); assert.notEqual(again.status, 0); assert.match(again.stderr, /anchor occurs 0 times/);
      const verify = run('--verify', root); assert.equal(verify.status, 0, verify.stdout + verify.stderr);
    });

    const file = path.join(root, ext);
    await t.test('verify rejects a restored U', () => {
      fs.writeFileSync(file, patched.replace(U_NEW, U_OLD));
      const result = run('--verify', root); assert.notEqual(result.status, 0); assert.match(result.stderr, /GATE FAILED \[summarize-budget\]/);
    });
    await t.test('verify rejects a patched B (B must stay upstream)', () => {
      fs.writeFileSync(file, patched.replace(B_CREATE, B_CREATE.replace('vn.create(this.instantiationService,this.endpoint,', 'vn.create(this.instantiationService,I,')));
      const result = run('--verify', root); assert.notEqual(result.status, 0); assert.match(result.stderr, /GATE FAILED \[summarize-fallback-unpatched\]/);
    });
    const fresh = mutate => { for (const f of files) fs.copyFileSync(path.join(source, f), path.join(root, f)); fs.writeFileSync(file, mutate(pristine)); return run(root); };
    await t.test('patch rejects a moved I definition', () => {
      const result = fresh(s => s.replace('I=p>0?this.endpoint.cloneWithTokenOverride(E):this.endpoint;', 'I=p>0?this.endpoint.withBudget(E):this.endpoint;'));
      assert.notEqual(result.status, 0); assert.match(result.stderr, /GATE FAILED \[summarize-names\]/);
    });
    await t.test('patch rejects an I rebound between its definition and U', () => {
      const result = fresh(s => s.replace('this.logService.debug(`[ConversationHistorySummarizer] ${oe}, triggering summarization`);', 'let I=this.endpoint;this.logService.debug(`[ConversationHistorySummarizer] ${oe}, triggering summarization`);'));
      assert.notEqual(result.status, 0); assert.match(result.stderr, /summarize-scope: I may be rebound/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
