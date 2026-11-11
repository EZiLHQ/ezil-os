// Fake code-server 4.141.0 chat services for chat-bridge.js (see chat-bridge.test.cjs for the mock boundary).
// Shared by chat-bridge.test.cjs and the OS end-to-end chain test (app/src/server/agent-session/chain.pg.test.ts).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'chat-bridge.js'), 'utf8');
// Same realm as the assertions (a separate vm context would give results foreign prototypes).
const create = vm.runInThisContext(source, { filename: 'chat-bridge.js' });
const isolation = vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'session-effort-isolation.js'), 'utf8'));

const uri = (id) => ({ id, toString: () => `vscode-chat-session://local/${id}` });
const obs = (value) => ({ value, get() { return this.value; } });
const CMD = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function deferred() {
    let resolve; let reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}

// The picker's models, as ILanguageModelsService items.
const PICKER = [
    { identifier: 'ezil/kimi-k2', metadata: { id: 'kimi-k2', name: 'Kimi K2', vendor: 'ezil', isUserSelectable: true } },
    { identifier: 'ezil/qwen', metadata: { id: 'qwen', name: 'Qwen', vendor: 'ezil', isUserSelectable: true } },
    { identifier: 'ezil/hidden', metadata: { id: 'hidden', name: 'Hidden', vendor: 'ezil', isUserSelectable: false } },
];

function world({ sessions = ['s1', 's2'], open = ['s1'], lockedAgent = false, now = () => 1700000000000, acquireDelay = null, listDelay = null, openDelay = null, used = true,
    mode = 'ask', isolationHook = true, picker = PICKER, startThrows = false, openFails = false, sticky = true, listEmpty = true } = {}) {
    const models = new Map();
    const loaded = new Map();
    const calls = { send: [], cancel: [], acquire: 0, disposed: 0, started: 0, opened: [], switched: [] };
    const addModel = (id, used) => {
        const listeners = new Set();
        models.set(id, {
            // One earlier, finished exchange, as in a chat the person has used.
            sessionResource: uri(id), requests: used ? [{ id: `earlier-${id}`, message: { text: 'earlier' }, response: { isComplete: true, isCanceled: false, entireResponse: { getMarkdown: () => 'earlier answer' } } }] : [], pending: [],
            requestInProgress: obs(false), requestNeedsInput: obs(false), isInputBlocked: obs(false), isReadOnly: obs(false),
            getRequests() { return this.requests; }, getPendingRequests() { return this.pending; },
            get lastRequest() { return this.requests.at(-1); },
            onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
            fire() { for (const fn of listeners) fn(); },
        });
    };
    for (const id of sessions) addModel(id, used);
    let created = 0;
    // An open chat widget holds its own reference to the session model, as the real view model does.
    for (const id of open) if (models.has(id)) loaded.set(id, 1);
    let nextSend = null;
    const chatService = {
        // listEmpty: false models a runtime that lists a chat only once it has a request.
        async getLiveSessionItems() { if (listDelay) await listDelay(); return [...loaded.keys()].filter((id) => listEmpty || models.get(id).requests.length).map((id) => ({ sessionResource: uri(id), title: `Live ${id}` })); },
        async getHistorySessionItems() { return sessions.filter((id) => !loaded.has(id)).map((id) => ({ sessionResource: uri(id), title: `Saved ${id}` })); },
        async acquireOrLoadSession(resource, location, token, owner) {
            calls.acquire++;
            if (acquireDelay) await acquireDelay();
            assert.equal(location, 'panel');
            assert.equal(token.isCancellationRequested, false);
            const model = models.get(resource.id);
            if (!model) return undefined;
            loaded.set(resource.id, (loaded.get(resource.id) || 0) + 1);
            return { object: model, dispose: () => { calls.disposed++; const n = loaded.get(resource.id) - 1; n ? loaded.set(resource.id, n) : loaded.delete(resource.id); } };
        },
        getSession(resource) { return loaded.has(resource.id) ? models.get(resource.id) : undefined; },
        // A new empty local session, held by the returned reference (and by any widget that opens it).
        startNewLocalSession(location, options) {
            calls.started++;
            assert.equal(location, 'panel');
            assert.equal(options.canUseTools, true);
            if (startThrows) throw new Error('start failed');
            const id = `new${++created}`;
            addModel(id, false);
            loaded.set(id, (loaded.get(id) || 0) + 1);
            return { object: models.get(id), dispose: () => { const n = loaded.get(id) - 1; n ? loaded.set(id, n) : loaded.delete(id); } };
        },
        async sendRequest(resource, text, options) {
            if (!loaded.has(resource.id)) throw new Error(`Unknown session: ${resource}`);
            calls.send.push({ id: resource.id, text, options });
            if (nextSend) { const fn = nextSend; nextSend = null; return fn(resource, text); }
            const model = models.get(resource.id);
            const request = { id: `req-${calls.send.length}`, message: { text }, response: null };
            const response = { requestId: request.id, isComplete: false, isCanceled: false, entireResponse: { getMarkdown: () => response.text || '' }, text: '' };
            request.response = response;
            model.requests.push(request);
            model.requestInProgress.value = true;
            const complete = deferred();
            const created = deferred();
            created.resolve(response);
            const finish = (canceled) => { response.isComplete = true; response.isCanceled = canceled; model.requestInProgress.value = false; model.fire(); complete.resolve(); };
            response.finish = finish;
            return { kind: 'sent', data: { responseCreatedPromise: created.promise, responseCompletePromise: complete.promise } };
        },
        async cancelCurrentRequestForSession(resource, source) {
            calls.cancel.push({ id: resource.id, source });
            const current = models.get(resource.id).lastRequest;
            if (current && !current.response.isComplete) current.response.finish(true);
        },
    };
    // One widget per open session, each with its own input (and so its own selected model, restored when shown again).
    const widgets = new Map();
    let editorShown = null;
    const widget = (id) => {
        if (widgets.has(id)) return widgets.get(id);
        const configurations = new Map();
        const w = {
            viewModel: { sessionResource: uri(id) }, location: 'panel',
            _lockedAgent: lockedAgent ? { id: 'agent-host' } : undefined,
            _lastSelectedAgent: { id: 'ezil', capabilities: { images: true } },
            input: {
                currentModeKind: mode, currentModeInfo: { kind: mode, isBuiltin: true }, currentLanguageModel: 'ezil/kimi-k2',
                _inputModel: { state: { get: () => models.get(id).inputState } },
                _inputModelSessionResource: uri(id), _currentSessionKey: uri(id).toString(),
                getModels: () => picker,
                restoreModelConfiguration(modelId, config, persist) {
                    assert.equal(persist, false, 'must never write shared model preferences');
                    configurations.set(modelId, structuredClone(config));
                },
                getModelConfiguration(modelId) { return configurations.get(modelId); },
                getCurrentInputState() { return isolation.annotate(this, { selectedModel: { identifier: this.currentLanguageModel }, contrib: {}, modelConfiguration: this.getModelConfiguration(this.currentLanguageModel) }); },
                flushInputStateToModel() { models.get(id).inputState = structuredClone(this.getCurrentInputState()); },
                setModelConfiguration() { throw new Error('global preference setter forbidden'); },
                switchModelByIdentifier(identifier, persist, userAction) {
                    calls.switched.push({ id, identifier, persist, userAction });
                    const found = picker.find((m) => m.identifier === identifier);
                    if (found && sticky) this.currentLanguageModel = identifier;
                    return !!found;
                },
            },
            getSelectedModelRequestOptions: () => ({ userSelectedModelId: w.input.currentLanguageModel, userSelectedModelConfiguration: w.input.getModelConfiguration(w.input.currentLanguageModel) }),
            getModeRequestOptions: () => ({ modeInfo: { kind: 'ask', isBuiltin: true }, userSelectedTools: { get: () => ({}) } }),
            _getInstructionRouting: () => ({ enabledTools: undefined }),
        };
        if (isolationHook) w.input._ezilSessionEffortV2 = function(resource, model, effort) { return isolation.set(this, resource, model, effort); };
        widgets.set(id, w);
        return w;
    };
    const chatWidgetService = {
        getWidgetBySessionResource: (resource) => (open.includes(resource.id) ? widget(resource.id) : undefined),
        getAllWidgets: () => open.map(widget),
        // One chat editor pane per group (observed in 4.141.0): opening a chat as a tab hides the one shown before it.
        async openSession(resource, target, options) {
            calls.opened.push({ id: resource.id, target, options });
            if (openDelay) await openDelay();
            if (openFails) return undefined;
            if (editorShown && editorShown !== resource.id && open.includes(editorShown)) open.splice(open.indexOf(editorShown), 1);
            editorShown = resource.id;
            if (!open.includes(resource.id)) open.push(resource.id);
            loaded.set(resource.id, (loaded.get(resource.id) || 0) + 1);
            return widget(resource.id);
        },
    };
    const bridge = create({ chatService, chatWidgetService, workspaceFolders: () => ['vscode-remote://remote/workspace'], now, createdTimeoutMs: 20 });
    return { bridge, models, calls, open, widget, loaded, setNextSend: (fn) => { nextSend = fn; } };
}

module.exports = { create, uri, obs, CMD, deferred, world, PICKER };
