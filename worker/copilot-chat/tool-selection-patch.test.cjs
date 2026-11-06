// Run: COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/tool-selection-patch.test.cjs
// Applies patch-copilot-chat.sh to a copy of the pinned code-server 4.141.0 bundle and checks Agent tool selection
// (PATCHES.md "Agent tool selection") by running the bundle's own code: the workbench's stored-selection codec and
// selected-tools map (ChatSelectedTools.entriesMap), and Copilot's Agent tool function (Ret) with its tools service's
// getEnabledTools. Every case also runs against the pristine bundle; the ones marked `defect` must fail there.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wbFile = 'out/vs/code/browser/workbench/workbench.js';
const extFile = 'extensions/copilot/dist/extension.js';
const files = [extFile, 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wbFile, 'out/vs/code/browser/workbench/workbench.css'];
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

function between(code, startMark, endMark, from = 0) {
  const i = code.indexOf(startMark, from);
  assert.ok(i >= 0, `marker not found: ${startMark.slice(0, 60)}`);
  const j = code.indexOf(endMark, i + startMark.length);
  assert.ok(j >= 0, `end marker not found: ${endMark.slice(0, 60)}`);
  return code.slice(i, j + endMark.length);
}

// A `with` scope that resolves exactly the names given and nothing else: a bundle that starts using
// another free name fails with a ReferenceError instead of silently reading a test global.
const scope = names => new Proxy(names, { has: (t, k) => Object.hasOwn(t, k), get: (t, k) => t[k] });

// ── workbench: the stored-selection codec (j_e) and ChatSelectedTools.entriesMap ──────────────────────
function loadWorkbench(code) {
  // The codec module: `(n=>{function s(r){...}n.fromMap=s;...n.toStorage=i})(<name>||={})`.
  const storage = code.indexOf('function e(r){return ui(r)&&r.version===2&&Array.isArray(r.toolSetEntries)');
  const modStart = code.lastIndexOf('(n=>{function s(r){', storage);
  const modEnd = code.indexOf('n.toStorage=i})', storage) + 'n.toStorage=i})'.length;
  assert.ok(modStart > 0 && modEnd > storage, 'selected-tools storage codec not found');
  const isToolSet = x => !!x && x.isSet === true;
  const codec = {};
  new Function('scope', 'codec', `with(scope){(${code.slice(modStart, modEnd)})(codec)}`)(scope({ dm: isToolSet, ui: x => typeof x === 'object' && x !== null && !Array.isArray(x) }), codec);
  // entriesMap's derived function, from the class constructor.
  // An arrow in the bundle (its `this` is the model); as a function here so the test can supply `this`.
  const derived = between(code, 'this.entriesMap=be(e=>{', 'return jT.fromMap(t)});').slice('this.entriesMap=be(e=>'.length, -2);
  const entriesFn = new Function('scope', `with(scope){return function(e)${derived}}`)(scope({ j_e: codec, jT: { fromMap: m => m }, dm: isToolSet }));
  // ChatSelectedTools.set: where Configure Tools (`set(b,!1)`) and code (`set(map,!0)`) store a selection.
  const setSrc = between(code, 'set(e,t){let i=this._mode.get();', '}async updateCustomModeTools(').slice('set(e,t){'.length, -'}async updateCustomModeTools('.length);
  const setFn = new Function('scope', `with(scope){return function(e,t){${setSrc}}}`)(scope({ j_e: codec }));
  return { codec, entriesFn, setFn };
}
// Runs the bundle's set() for the plain Agent mode and returns the session state it stored (undefined if it wrote global).
function storeSession(wb, shown, byCode, { existing = false } = {}) {
  const sessions = new Map(existing ? [['agent', { toolSets: new Map(), tools: new Map() }]] : []);
  const self = { _mode: { get: () => ({ id: 'agent', kind: 'agent', customTools: undefined }) }, _sessionStates: { has: k => sessions.has(k), set: (k, v) => sessions.set(k, v) }, _globalState: { set() {} } };
  wb.setFn.call(self, new Map(shown), byCode);
  return sessions.get('agent');
}

const tool = (id, extra = {}) => ({ id, canBeReferencedInPrompt: false, ...extra });
const set = (id, members, extra = {}) => ({ id, isSet: true, members, getTools: () => members, ...extra });

// One selected-tools model: `stored` is what storage holds (a JSON string as the workbench writes it), `tools` the
// referenceable tools and `sets` the tool sets registered right now. Returns id -> enabled for every entry.
function entries(wb, { stored, tools = [], sets = [], session, mode = { id: 'agent', kind: 'agent' } }) {
  const globalState = stored === undefined ? { toolSets: new Map(), tools: new Map() } : wb.codec.fromStorage(stored);
  const self = {
    languageModel: { read: () => ({ metadata: {} }) },
    _mode: { read: () => mode },
    _sessionStates: { observable: { read: () => new Map(session ? [[mode.id, session instanceof Map ? wb.codec.fromMap(session) : session]] : []) } },
    _globalState: { read: () => globalState },
    _currentTools: { read: () => tools },
    _toolsService: {
      getToolSetsForModel: () => sets,
      toToolAndToolSetEnablementMap: names => {
        const m = new Map();
        for (const s of sets) { const on = names.includes(s.id); m.set(s, on); if (on) for (const t of s.members) m.set(t, true); }
        for (const t of [...tools, ...sets.flatMap(s => s.members)]) if (!m.has(t)) m.set(t, names.includes(t.id));
        return m;
      },
    },
  };
  const result = wb.entriesFn.call(self, undefined);
  return Object.fromEntries([...result].map(([k, v]) => [k.id, v]));
}
// What Configure Tools saves: the full map of every entry it showed (`set(b,!1)` -> toStorage(fromMap(b))).
const save = (wb, shown) => wb.codec.toStorage(wb.codec.fromMap(new Map(shown)));

// The registrations QA saw: before Copilot activates, the workbench's own sets; after, Copilot's edit/search/web too.
function registry() {
  const readFile = tool('copilot_readFile'), problems = tool('copilot_getErrors'), runInTerminal = tool('run_in_terminal'), runSubagent = tool('runSubagent');
  const read = set('read', [readFile, problems]), execute = set('execute', [runInTerminal]), agent = set('agent', [runSubagent]), vscode = set('vscode', [tool('copilot_runVscodeCommand')]);
  const createFile = tool('copilot_createFile'), editFiles = tool('copilot_editFiles'), findFiles = tool('copilot_findFiles'), githubRepo = tool('copilot_githubRepo');
  const edit = set('edit', [createFile, editFiles]), search = set('search', [findFiles]), web = set('web', [githubRepo]);
  const todo = tool('manage_todo_list', { canBeReferencedInPrompt: true });
  return { early: { tools: [todo], sets: [read, execute, agent, vscode] }, late: { tools: [todo], sets: [read, execute, agent, vscode, edit, search, web] } };
}
const shownEntries = ({ tools, sets }, value) => [...tools.map(t => [t, typeof value === 'function' ? value(t) : value]), ...sets.flatMap(s => [[s, typeof value === 'function' ? value(s) : value], ...s.members.map(t => [t, typeof value === 'function' ? value(t) : value])])];

// ── extension: Ret (the Agent intent's tool function) and the tools service's getEnabledTools ─────────────────
function loadExtension(code) {
  const retSrc = between(code, 'var Ret=async(t,e,n)=>{', 'return h},Yx=class').slice('var Ret='.length, -',Yx=class'.length);
  const getEnabledSrc = between(code, 'getEnabledTools(n,r,o){let a=this.tools,', '}*getToolOverridesForEndpoint(');
  const body = getEnabledSrc.slice('getEnabledTools(n,r,o){'.length, -'}*getToolOverridesForEndpoint('.length);
  // `$a` is the bundle's Iterable helper; only `some` is reached on these paths.
  const iter = { some: (it, fn) => { for (const x of it) if (fn(x)) return true; return false; }, map: (it, fn) => Array.from(it, fn) };
  // Contributed (manifest) names for the internal tool names; the bundle fills this map at load time.
  const contributed = new Map([['insert_edit_into_file', 'copilot_insertEdit'], ['replace_string_in_file', 'copilot_replaceString'], ['multi_replace_string_in_file', 'copilot_multiReplaceString'], ['apply_patch', 'copilot_applyPatch'], ['create_file', 'copilot_createFile'], ['read_file', 'copilot_readFile'], ['session_store_sql', 'copilot_sessionStoreSql'], ['file_search', 'copilot_findFiles'], ['tool_search', 'tool_search'], ['create_new_workspace', 'copilot_createNewWorkspace'], ['install_extension', 'copilot_installExtension']]);
  const config = { getExperimentBasedConfig: () => false };
  const getEnabledTools = new Function('scope', `with(scope){return function(n,r,o){${body}}}`)(scope({
    $a: iter, Y: new Proxy({}, { get: () => new Proxy({}, { get: () => 'cfg' }) }), SG: () => false, uH: n => contributed.get(n) ?? n, Ap: n => n,
  }));
  return ({ toolNames, request, endpoint = {} }) => {
    const tools = toolNames.map(name => ({ name, tags: name === 'create_new_workspace' ? ['enable_other_tool_install_extension'] : [] }));
    const svc = { tools, getToolOverridesForEndpoint: () => [], getModelSpecificTools: () => new Map(), _configurationService: config, _experimentationService: {}, getCopilotTool: () => undefined, _toolExtensions: { value: new Map() }, getTool: n => toolNames.includes(n) ? {} : undefined };
    svc.getEnabledTools = getEnabledTools;
    const ep = { family: 'claude-sonnet', supportsToolSearch: true, ...endpoint };
    const tokens = { Hr: svc, Zq: { hasAnyTests: async () => true }, YI: { getTasks: () => [{}] }, Ee: config, Xe: {}, _t: { getChatEndpoint: async () => ep, getAllChatEndpoints: async () => [] }, mN: { getPreferredEndpointEditTool: () => undefined }, mt: {}, ae: { warn() {} } };
    const accessor = { get: k => k };
    const Ret = new Function('scope', `with(scope){return ${retSrc}}`)(scope({
      ...Object.fromEntries(Object.keys(tokens).map(k => [k, tokens[k]])),
      $a: iter, Y: new Proxy({}, { get: () => new Proxy({}, { get: () => 'cfg' }) }), Bo: 'tool_search', k7e: 'search-family',
      Q8e: () => true, Wkn: () => true, tTn: () => false, Vkn: () => false, wwe: () => true, Zxe: () => false, wM: () => false, Tet: () => false, nTn: () => false, Tvr: '', Lvr: '', Pvr: '',
    }));
    return Ret(accessor, { tools: request.tools, toolReferences: request.toolReferences ?? [], permissionLevel: request.permissionLevel }, undefined).then(list => list.map(t => t.name).sort());
  };
}

// The tools Copilot registers (internal names) that these cases look at.
const EXT_TOOLS = ['insert_edit_into_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'apply_patch', 'create_file', 'read_file', 'session_store_sql', 'file_search', 'tool_search', 'create_new_workspace', 'install_extension'];

test('Agent tool selection: explicit all-off holds for late registrations; defaults and partial choices unchanged', { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-selection-patch-'));
  try {
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.copyFileSync(path.join(source, f), path.join(tmp, f)); }
    const pristine = { wb: loadWorkbench(fs.readFileSync(path.join(source, wbFile), 'utf8')), ext: loadExtension(fs.readFileSync(path.join(source, extFile), 'utf8')) };
    const patched = run(tmp);
    assert.equal(patched.status, 0, patched.stderr + patched.stdout);
    assert.equal(run('--verify', tmp).status, 0);
    const after = { wb: loadWorkbench(fs.readFileSync(path.join(tmp, wbFile), 'utf8')), ext: loadExtension(fs.readFileSync(path.join(tmp, extFile), 'utf8')) };

    // Each case runs on both bundles. `defect: true` cases must fail on the pristine bundle (the bug they pin).
    const both = async (name, fn, { defect = false } = {}) => {
      await t.test(name, async () => { await fn(after); });
      await t.test(`${name} [pristine ${defect ? 'shows the defect' : 'agrees'}]`, async () => {
        // The pristine bundle must fail the assertion itself, not crash on the harness.
        if (defect) await assert.rejects(async () => fn(pristine), assert.AssertionError); else await fn(pristine);
      });
    };
    const { early, late } = registry();

    await both('all off before Copilot activates: its later edit/search/web sets and their members stay off', ({ wb }) => {
      const stored = save(wb, shownEntries(early, false));
      const map = entries(wb, { stored, ...late });
      assert.deepEqual(Object.entries(map).filter(([, v]) => v).map(([k]) => k), []);
    }, { defect: true });

    await both('all off, then a later standalone referenceable tool stays off too', ({ wb }) => {
      const stored = save(wb, shownEntries(early, false));
      const map = entries(wb, { stored, tools: [...late.tools, tool('mcp_late', { canBeReferencedInPrompt: true })], sets: late.sets });
      assert.equal(map.mcp_late, false);
    }, { defect: true });

    await both('all off saved by the image-33 workbench (version 2 JSON) is honoured on the next load', ({ wb }) => {
      const stored = JSON.stringify({ version: 2, toolSetEntries: [['read', false], ['execute', false], ['agent', false], ['vscode', false]], toolEntries: [['manage_todo_list', false], ['copilot_readFile', false], ['copilot_getErrors', false], ['run_in_terminal', false], ['runSubagent', false], ['copilot_runVscodeCommand', false]] });
      const map = entries(wb, { stored, ...late });
      assert.equal(map.edit, false); assert.equal(map.copilot_createFile, false); assert.equal(map.copilot_githubRepo, false);
    }, { defect: true });

    await both('never configured: every tool on, including late ones (upstream default)', ({ wb }) => {
      const map = entries(wb, { ...late });
      assert.ok(Object.values(map).every(Boolean), JSON.stringify(map));
    });

    await both('all on, explicitly saved: late ones on', ({ wb }) => {
      const map = entries(wb, { stored: save(wb, shownEntries(early, true)), ...late });
      assert.ok(Object.values(map).every(Boolean));
    });

    await both('partial (read off, rest on): read stays off, late sets follow upstream (on)', ({ wb }) => {
      const stored = save(wb, shownEntries(early, x => !['read', 'copilot_readFile', 'copilot_getErrors'].includes(x.id)));
      const map = entries(wb, { stored, ...late });
      assert.equal(map.read, false); assert.equal(map.copilot_readFile, false);
      assert.equal(map.edit, true); assert.equal(map.copilot_createFile, true); assert.equal(map.execute, true);
    });

    await both('partial (only read on): late sets follow upstream (on); the choices shown stay as chosen', ({ wb }) => {
      const stored = save(wb, shownEntries(early, x => ['read', 'copilot_readFile', 'copilot_getErrors'].includes(x.id)));
      const map = entries(wb, { stored, ...late });
      assert.equal(map.read, true); assert.equal(map.execute, false); assert.equal(map.run_in_terminal, false); assert.equal(map.edit, true);
    });

    await both('all off, then one tool switched back on in a set that is off: only that tool', ({ wb }) => {
      const stored = save(wb, shownEntries(early, x => x.id === 'copilot_readFile'));
      const map = entries(wb, { stored, ...late });
      assert.equal(map.copilot_readFile, true); assert.equal(map.copilot_getErrors, false); assert.equal(map.read, false);
    });

    await both('pre-version-2 storage (disabled lists only) keeps missing-means-on', ({ wb }) => {
      const stored = JSON.stringify({ disabledToolSets: ['read'], disabledTools: ['manage_todo_list'] });
      const map = entries(wb, { stored, ...late });
      assert.equal(map.read, false); assert.equal(map.copilot_readFile, false); assert.equal(map.manage_todo_list, false);
      assert.equal(map.execute, true); assert.equal(map.run_in_terminal, true); assert.equal(map.edit, true);
    });

    await both('pre-version-2 storage that lists every set as disabled is still read as listed, others on', ({ wb }) => {
      const stored = JSON.stringify({ disabledToolSets: ['read', 'execute', 'agent', 'vscode'] });
      const map = entries(wb, { stored, ...late });
      assert.equal(map.read, false); assert.equal(map.edit, true);
    });

    await both('prompt file naming sets not registered yet (all-off snapshot, set(..., true)): late sets on as upstream', ({ wb }) => {
      // toToolAndToolSetEnablementMap(['edit','search']) before Copilot's sets exist: every known entry false.
      const session = storeSession(wb, shownEntries(early, false), true);
      const map = entries(wb, { session, ...late });
      assert.equal(map.edit, true); assert.equal(map.search, true); assert.equal(map.copilot_createFile, true); assert.equal(map.read, false);
    });

    await both('Configure Tools all off in a chat that has a session selection (set(..., false)): late sets off', ({ wb }) => {
      const session = storeSession(wb, shownEntries(early, false), false, { existing: true });
      const map = entries(wb, { session, ...late });
      assert.ok(Object.values(map).every(v => v === false), JSON.stringify(map));
    }, { defect: true });

    await both('Configure Tools without a session selection writes the global state, not a session', ({ wb }) => {
      assert.equal(storeSession(wb, shownEntries(early, false), false), undefined);
    });

    await both('per-session partial selection is kept; late sets on as upstream', ({ wb }) => {
      const session = storeSession(wb, shownEntries(early, x => x.id === 'execute' || x.id === 'run_in_terminal'), true);
      const map = entries(wb, { session, ...late });
      assert.equal(map.execute, true); assert.equal(map.read, false); assert.equal(map.web, true);
    });

    await both('custom agent `tools: []`: nothing on; `tools: [read]`: read only (computed over every registered tool)', ({ wb }) => {
      const none = entries(wb, { ...late, mode: { id: 'c', kind: 'agent', customTools: { read: () => [] } } });
      assert.ok(Object.values(none).every(v => v === false));
      const readOnly = entries(wb, { ...late, mode: { id: 'c', kind: 'agent', customTools: { read: () => ['read'] } } });
      assert.equal(readOnly.read, true); assert.equal(readOnly.copilot_readFile, true); assert.equal(readOnly.edit, false); assert.equal(readOnly.copilot_createFile, false);
    });

    await both('a version change of the stored blob keeps working: v2 round trip is unchanged', ({ wb }) => {
      const shown = shownEntries(early, x => x.id !== 'agent');
      const back = wb.codec.fromStorage(save(wb, shown));
      assert.deepEqual([...back.toolSets], [['read', true], ['execute', true], ['agent', false], ['vscode', true]]);
      assert.equal(back.ezilMissingOn, undefined);
    });

    // ── extension side ──
    const forced = ['insert_edit_into_file', 'replace_string_in_file', 'session_store_sql', 'tool_search', 'apply_patch'];
    await both('Copilot: request map all off: no forced edit/SQL/search tools, nothing at all', async ({ ext }) => {
      const tools = new Map([['copilot_readFile', false], ['copilot_createFile', false], ['copilot_findFiles', false]]);
      assert.deepEqual(await ext({ toolNames: EXT_TOOLS, request: { tools } }), []);
    }, { defect: true });

    await both('Copilot: request map all off with copilot_editFiles off: still nothing (session_store_sql was forced)', async ({ ext }) => {
      const tools = new Map([['copilot_editFiles', false], ['copilot_readFile', false]]);
      const got = await ext({ toolNames: EXT_TOOLS, request: { tools } });
      assert.ok(!got.includes('session_store_sql'), got.join());
      assert.deepEqual(got, []);
    }, { defect: true });

    await both('Copilot: all off but the prompt references a tool that enables another: only that reference path (upstream) adds a tool', async ({ ext }) => {
      const tools = new Map([['copilot_readFile', false]]);
      const got = await ext({ toolNames: EXT_TOOLS, request: { tools, toolReferences: [{ name: 'create_new_workspace' }] } });
      assert.deepEqual(got, ['install_extension']);
    }, { defect: true });

    await both('Copilot: partial map: upstream forcing intact (edit tools, SQL, tool search on; explicit off honoured)', async ({ ext }) => {
      const tools = new Map([['copilot_readFile', true], ['copilot_createFile', false]]);
      const got = await ext({ toolNames: EXT_TOOLS, request: { tools } });
      for (const n of forced) assert.ok(got.includes(n), `${n} missing from ${got}`);
      assert.ok(got.includes('read_file')); assert.ok(!got.includes('create_file'));
    });

    await both('Copilot: copilot_editFiles explicitly off in a partial map drops the edit tools (upstream)', async ({ ext }) => {
      const tools = new Map([['copilot_editFiles', false], ['copilot_readFile', true]]);
      const got = await ext({ toolNames: EXT_TOOLS, request: { tools } });
      for (const n of ['insert_edit_into_file', 'replace_string_in_file', 'apply_patch']) assert.ok(!got.includes(n), `${n} in ${got}`);
      assert.ok(got.includes('session_store_sql') && got.includes('read_file'));
    });

    await both('Copilot: empty request map (no selection reached the extension): upstream forcing intact', async ({ ext }) => {
      const got = await ext({ toolNames: EXT_TOOLS, request: { tools: new Map() } });
      for (const n of forced) assert.ok(got.includes(n), `${n} missing from ${got}`);
    });

    await both('Copilot: explicit off for a forced tool is honoured even in a partial map (upstream)', async ({ ext }) => {
      const tools = new Map([['copilot_readFile', true], ['copilot_sessionStoreSql', false]]);
      assert.ok(!(await ext({ toolNames: EXT_TOOLS, request: { tools } })).includes('session_store_sql'));
    });

    // Each anchor, moved in its own copy: the build stops at that patch and names it.
    const moves = [
      ['tools-forced', extFile, 'let h=r.getEnabledTools(e,n,y=>{', 'let h=r.getEnabledTools(e,n,(y)=>{'],
      ['tools-absent', wbFile, 'let c=r.toolSets.get(a.id)!==!1;', 'let c=r.toolSets.get(a.id)!=!1;'],
      ['tools-session', wbFile, 'if(t||this._sessionStates.has(i.id)){', 'if(this._sessionStates.has(i.id)||t){'],
      ['tools-legacy', wbFile, 'return{toolSets:new Map(c),tools:new Map(l)}}', 'return{tools:new Map(l),toolSets:new Map(c)}}'],
    ];
    for (const [id, file, from, to] of moves) {
      await t.test(`a moved ${id} anchor fails the build and names it`, () => {
        const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-selection-moved-'));
        try {
          for (const f of files) { fs.mkdirSync(path.dirname(path.join(moved, f)), { recursive: true }); fs.copyFileSync(path.join(source, f), path.join(moved, f)); }
          const target = path.join(moved, file), code = fs.readFileSync(target, 'utf8');
          assert.equal(code.split(from).length - 1, 1, `fixture text for ${id} occurs once`);
          fs.writeFileSync(target, code.replace(from, to));
          const r = run(moved);
          assert.notEqual(r.status, 0);
          assert.match(r.stderr, new RegExp(`\\[${id}\\] anchor occurs 0 times`));
        } finally { fs.rmSync(moved, { recursive: true, force: true }); }
      });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
