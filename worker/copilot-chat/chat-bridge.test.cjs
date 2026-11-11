// Run: node --test worker/copilot-chat/chat-bridge.test.cjs
// The workbench side of the EZiL Chat bridge (chat-bridge.js) against FAKE chat services that model
// the code-server 4.141.0 behaviour read from the shipped workbench.js: sendRequest throws "Unknown
// session" for an unacquired model and answers sent/queued/rejected; cancelCurrentRequestForSession
// stops whatever request is in flight; references are {object, dispose}. Mock boundary: this proves
// the adapter's own logic, not the real ChatService at runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CMD, deferred, world } = require('./chat-bridge-fake.cjs');

const OWNER = { ownerId: 'os-lease', epoch: 1, protocol: 3 };
const claimed = async (w, epoch = 1) => { assert.deepEqual(await w.bridge.handle({ op: 'claim', ownerId: 'os-lease', epoch }), { ok: true, owner: { id: 'os-lease', epoch } }); };
const submit = (w, n, extra = {}) => w.bridge.handle({ op: 'submit', protocol: 3, ownerId: 'os-lease', epoch: 1, commandId: CMD(n), sessionResource: 'vscode-chat-session://local/s1', text: 'Summarize the README', deliverWithinMs: 60000, ...extra });

test('hello and sessions describe this workbench and each open session\'s selected model', async () => {
    const w = world();
    assert.deepEqual(await w.bridge.handle({ op: 'hello' }), { ok: true, protocol: 2, supportedProtocols: [1, 2, 3], owner: null, workspaceFolders: ['vscode-remote://remote/workspace'] });
    assert.deepEqual(await w.bridge.handle({ op: 'sessions' }), { ok: false, error: 'no_owner' });
    await claimed(w);
    const listed = await w.bridge.handle({ op: 'sessions', ...OWNER });
    assert.deepEqual(listed, { ok: true, sessions: [
        { resource: 'vscode-chat-session://local/s1', title: 'Live s1', open: true, status: 'idle', model: 'ezil/kimi-k2', effort: null, requests: 1 },
        { resource: 'vscode-chat-session://local/s2', title: 'Saved s2', open: false, status: 'unknown', model: null, effort: null, requests: null },
    ] });
    assert.doesNotThrow(() => JSON.stringify(listed));
});

test('only a fixed operation set; anything else is refused without touching the chat service', async () => {
    const w = world();
    for (const request of [{ op: 'workbench.action.chat.open' }, { op: 'executeCommand', id: 'x' }, null, [], 'submit', { op: '__proto__' }]) {
        const result = await w.bridge.handle(request);
        assert.equal(result.ok, false);
    }
    assert.equal(w.calls.acquire + w.calls.send.length, 0);
});

test('submit requires a claimed, current owner; a stale epoch cannot act after a newer claim', async () => {
    const w = world();
    assert.deepEqual(await submit(w, 1), { ok: false, error: 'no_owner' });
    await claimed(w, 1);
    assert.equal((await w.bridge.handle({ op: 'claim', ownerId: 'os-lease', epoch: 2 })).ok, true);
    assert.deepEqual(await submit(w, 1), { ok: false, error: 'stale_owner', epoch: 2 });
    assert.deepEqual(await w.bridge.handle({ op: 'claim', ownerId: 'other', epoch: 2 }), { ok: false, error: 'stale_owner', epoch: 2 });
    assert.deepEqual(await w.bridge.handle({ op: 'claim', ownerId: 'os-lease', epoch: 1 }), { ok: false, error: 'stale_owner', epoch: 2 });
    assert.equal(w.calls.send.length, 0);
});

test('accepted: the exact session, with the open pane\'s own mode/model options, reported truthfully', async () => {
    const w = world();
    await claimed(w);
    const result = await submit(w, 1);
    assert.deepEqual(result, { ok: true, status: 'in_progress', commandId: CMD(1), sessionResource: 'vscode-chat-session://local/s1',
        requestId: 'req-1', mode: 'ask', selectedModelId: 'ezil/kimi-k2', selectedEffort: null, acceptedAt: 1700000000000 });
    assert.equal(w.calls.send.length, 1);
    const sent = w.calls.send[0];
    assert.equal(sent.id, 's1');
    assert.equal(sent.text, 'Summarize the README');
    assert.equal(sent.options.queue, undefined, 'never uses the upstream queue: busy is the caller\'s queue');
    assert.equal(sent.options.location, 'panel');
    assert.equal(sent.options.userSelectedModelId, 'ezil/kimi-k2');
    assert.deepEqual(sent.options.modeInfo, { kind: 'ask', isBuiltin: true });
    assert.equal(sent.options.attachedContext, undefined, 'no implicit editor context is attached');
    // Completion is read from the live response model, and the reference is released then.
    w.models.get('s1').lastRequest.response.finish(false);
    await new Promise((r) => setImmediate(r));
    assert.equal((await w.bridge.handle({ op: 'command', commandId: CMD(1), ...OWNER })).status, 'completed');
    assert.equal(w.calls.disposed, 1);
});

test('a duplicate commandId never sends twice; the same id with other text is a conflict', async () => {
    const w = world();
    await claimed(w);
    await submit(w, 1);
    const again = await submit(w, 1);
    assert.equal(again.duplicate, true);
    assert.equal(again.requestId, 'req-1');
    assert.deepEqual(await submit(w, 1, { text: 'something else' }), { ok: false, error: 'command_conflict' });
    assert.equal(w.calls.send.length, 1);
});

test('concurrent submits to one session are serialized: the second finds it busy, nothing is queued upstream', async () => {
    const w = world();
    await claimed(w);
    const [a, b] = await Promise.all([submit(w, 1), submit(w, 2)]);
    assert.equal(a.status, 'in_progress');
    assert.deepEqual(b, { ok: true, status: 'busy', needsInput: false, blocked: false });
    assert.equal(w.calls.send.length, 1);
});

test('busy, waiting for a tool confirmation, blocked, or with pending requests: not sent', async () => {
    for (const set of [(m) => { m.requestInProgress.value = true; }, (m) => { m.requestNeedsInput.value = true; },
        (m) => { m.isInputBlocked.value = true; }, (m) => { m.isReadOnly.value = true; }, (m) => { m.pending.push({}); }]) {
        const w = world();
        await claimed(w);
        set(w.models.get('s1'));
        const result = await submit(w, 1);
        assert.equal(result.status, 'busy');
        assert.equal(w.calls.send.length, 0);
        assert.equal(w.calls.disposed, w.calls.acquire, 'the reference taken to check is released');
    }
});

test('not open in this window, unknown, or agent-locked sessions are never delivered (no focused-chat fallback)', async () => {
    const w = world();
    await claimed(w);
    assert.deepEqual(await submit(w, 1, { sessionResource: 'vscode-chat-session://local/s2' }), { ok: true, status: 'not_open' });
    assert.deepEqual(await submit(w, 2, { sessionResource: 'vscode-chat-session://local/nope' }), { ok: true, status: 'unknown_session' });
    const locked = world({ lockedAgent: true });
    await claimed(locked);
    assert.deepEqual(await submit(locked, 3), { ok: true, status: 'unsupported_session' });
    assert.equal(w.calls.send.length + locked.calls.send.length, 0);
    // Not recorded: the caller may retry the same command once the person opens the session.
    w.open.push('s2');
    assert.equal((await submit(w, 1, { sessionResource: 'vscode-chat-session://local/s2' })).status, 'in_progress');
});

test('rejected by the chat service is reported with its reason and not recorded', async () => {
    const w = world();
    await claimed(w);
    w.setNextSend(() => ({ kind: 'rejected', reason: 'Session input is blocked' }));
    assert.deepEqual(await submit(w, 1), { ok: true, status: 'rejected', reason: 'Session input is blocked' });
    assert.equal((await w.bridge.handle({ op: 'command', commandId: CMD(1), ...OWNER })).status, 'unknown_command');
});

test('a send that throws is "uncertain" and is never resent under the same commandId', async () => {
    const w = world();
    await claimed(w);
    w.setNextSend(() => { throw new Error('ext host gone'); });
    assert.equal((await submit(w, 1)).status, 'uncertain');
    const retry = await submit(w, 1);
    assert.equal(retry.status, 'uncertain');
    assert.equal(retry.duplicate, true);
    assert.equal(w.calls.send.length, 1);
});

test('cancel: only our in-flight request; cancel_requested until the model says cancelled', async () => {
    const w = world();
    await claimed(w);
    await submit(w, 1);
    const cancelled = await w.bridge.handle({ op: 'cancel', ownerId: 'os-lease', epoch: 1, commandId: CMD(1) });
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(w.calls.cancel, [{ id: 's1', source: 'ezil-chat-bridge' }]);
    // Already finished: no second cancel call.
    assert.equal((await w.bridge.handle({ op: 'cancel', ownerId: 'os-lease', epoch: 1, commandId: CMD(1) })).status, 'cancelled');
    assert.equal(w.calls.cancel.length, 1);
});

test('cancel never stops a request the person started after ours, and reports a pending cancel honestly', async () => {
    const w = world();
    await claimed(w);
    await submit(w, 1);
    const model = w.models.get('s1');
    // Someone else's request is now the session's current one while ours is not complete.
    model.requests.push({ id: 'person-typed', message: { text: 'mine' }, response: { isComplete: false, isCanceled: false } });
    const result = await w.bridge.handle({ op: 'cancel', ownerId: 'os-lease', epoch: 1, commandId: CMD(1) });
    assert.equal(result.cancel, 'cannot_verify');
    assert.equal(w.calls.cancel.length, 0);
    // A cancel whose effect is not yet visible stays cancel_requested.
    const slow = world();
    await claimed(slow);
    await submit(slow, 1);
    slow.models.get('s1').lastRequest.response.finish = () => {};
    assert.equal((await slow.bridge.handle({ op: 'cancel', ownerId: 'os-lease', epoch: 1, commandId: CMD(1) })).status, 'cancel_requested');
});

test('cancel of a command this workbench never received is unknown_command (the caller withdraws it)', async () => {
    const w = world();
    await claimed(w);
    assert.deepEqual(await w.bridge.handle({ op: 'cancel', ownerId: 'os-lease', epoch: 1, commandId: CMD(9) }), { ok: true, status: 'unknown_command' });
    assert.deepEqual(await w.bridge.handle({ op: 'cancel', ownerId: 'other', epoch: 1, commandId: CMD(9) }), { ok: false, error: 'stale_owner', epoch: 1 });
});

test('read: the same conversation back, with a strictly increasing version across changes', async () => {
    const w = world();
    await claimed(w);
    await submit(w, 1);
    const model = w.models.get('s1');
    const first = await w.bridge.handle({ op: 'read', sessionResource: 'vscode-chat-session://local/s1', ...OWNER });
    assert.equal(first.requestInProgress, true);
    assert.deepEqual(first.requests, [
        { id: 'earlier-s1', text: 'earlier', response: { text: 'earlier answer', isComplete: true, isCanceled: false } },
        { id: 'req-1', text: 'Summarize the README', response: { text: '', isComplete: false, isCanceled: false } }]);
    model.lastRequest.response.text = 'The README says…';
    model.fire();
    model.lastRequest.response.finish(false);
    const second = await w.bridge.handle({ op: 'read', sessionResource: 'vscode-chat-session://local/s1', ...OWNER });
    assert.ok(second.version > first.version);
    assert.equal(second.requests.at(-1).response.text, 'The README says…');
    assert.equal(second.requests.at(-1).response.isComplete, true);
    assert.doesNotThrow(() => JSON.stringify(second));
});

test('read of an unloaded session loads it only for the snapshot; dispose releases everything', async () => {
    const w = world();
    await claimed(w);
    const result = await w.bridge.handle({ op: 'read', sessionResource: 'vscode-chat-session://local/s2', ...OWNER });
    assert.equal(result.status, 'ok');
    assert.equal(result.version, null);
    assert.equal(w.calls.disposed, 1);
    await submit(w, 1);
    w.bridge.dispose();
    assert.equal(w.calls.disposed, 2, 'the reference held for the in-flight request is released');
    assert.deepEqual(await w.bridge.handle({ op: 'hello' }), { ok: false, error: 'disconnected' });
});

test('input validation: commandId, text and resource bounds', async () => {
    const w = world();
    await claimed(w);
    for (const bad of [{ commandId: 'x' }, { text: '' }, { text: '   ' }, { text: 'a'.repeat(32001) }, { sessionResource: 42 }]) {
        assert.deepEqual(await submit(w, 1, bad), { ok: false, error: 'bad_request' });
    }
    assert.equal(w.calls.send.length, 0);
});

test('read, command and sessions are fenced too: a stale owner cannot read the conversation', async () => {
    const w = world();
    await claimed(w, 1);
    await w.bridge.handle({ op: 'claim', ownerId: 'os-lease', epoch: 2 });
    for (const op of [{ op: 'read', sessionResource: 'vscode-chat-session://local/s1' }, { op: 'command', commandId: CMD(1) }, { op: 'sessions' }]) {
        assert.deepEqual(await w.bridge.handle({ ...op, ...OWNER }), { ok: false, error: 'stale_owner', epoch: 2 });
    }
});

test('a request whose response model never appears is finished_unverified once it completes, never in_progress forever', async () => {
    const w = world();
    await claimed(w);
    const complete = deferred();
    w.setNextSend(() => ({ kind: 'sent', data: { responseCreatedPromise: new Promise(() => {}), responseCompletePromise: complete.promise } }));
    const accepted = await submit(w, 1);
    assert.equal(accepted.status, 'in_progress');
    assert.equal(accepted.requestId, null);
    assert.equal((await w.bridge.handle({ op: 'cancel', ...OWNER, commandId: CMD(1) })).cancel, 'cannot_verify');
    complete.resolve();
    await new Promise((r) => setImmediate(r));
    assert.equal((await w.bridge.handle({ op: 'command', commandId: CMD(1), ...OWNER })).status, 'finished_unverified');
});

test('a newer owner claiming while a submit waits for the session lock or loads the session: the old submit never sends', async () => {
    let releaseLoad;
    const gate = new Promise((resolve) => { releaseLoad = resolve; });
    let loads = 0;
    const w = world({ acquireDelay: () => (++loads === 1 ? gate : Promise.resolve()) });
    await claimed(w);
    const first = submit(w, 1);
    const queued = submit(w, 2, { text: 'second' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await w.bridge.handle({ op: 'claim', ownerId: 'os-lease-2', epoch: 2 }), { ok: true, owner: { id: 'os-lease-2', epoch: 2 } });
    releaseLoad();
    assert.deepEqual(await first, { ok: false, error: 'stale_owner', epoch: 2 });
    assert.deepEqual(await queued, { ok: false, error: 'stale_owner', epoch: 2 });
    assert.equal(w.calls.send.length, 0);
    // The queued submit was refused inside the lock, before it ever loaded the session.
    assert.equal(w.calls.acquire, 1);
});

test('one command id sent concurrently to two sessions is sent once; the other is refused before any send', async () => {
    const w = world({ open: ['s1', 's2'] });
    await claimed(w);
    const [a, b] = await Promise.all([
        submit(w, 7),
        submit(w, 7, { sessionResource: 'vscode-chat-session://local/s2' }),
    ]);
    assert.equal(w.calls.send.length, 1);
    assert.deepEqual([a.status ?? a.error, b.status ?? b.error].sort(), ['command_conflict', 'in_progress'].sort());
    const s2 = { sessionResource: 'vscode-chat-session://local/s2' };
    const again = await Promise.all([submit(w, 8, s2), submit(w, 8, s2)]);
    assert.equal(w.calls.send.length, 2);
    assert.deepEqual(again.map((r) => r.status ?? r.error).sort(), ['command_in_flight', 'in_progress'].sort());
});

test('past its delivery deadline (checked right before the send), a command is refused as expired and never sent', async () => {
    let clock = 1700000000000;
    const w = world({ now: () => clock, acquireDelay: async () => { clock += 5000; } });
    await claimed(w);
    assert.deepEqual(await submit(w, 3, { deliverWithinMs: 4000 }), { ok: true, status: 'expired' });
    assert.equal(w.calls.send.length, 0);
    assert.equal((await submit(w, 4, { deliverWithinMs: 60000 })).status, 'in_progress');
    for (const bad of [-1, 1.5, '100', undefined]) assert.deepEqual(await submit(w, 5, { deliverWithinMs: bad }), { ok: false, error: 'bad_request' });
});

test('a response that ends with the model\'s error is reported failed, not completed', async () => {
    const w = world();
    await claimed(w);
    assert.equal((await submit(w, 9)).status, 'in_progress');
    const response = w.models.get('s1').requests.at(-1).response;
    response.result = { errorDetails: { code: 'quotaExceeded', message: 'no allowance' } };
    response.finish(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await w.bridge.handle({ op: 'command', ownerId: 'os-lease', epoch: 1, commandId: CMD(9) })).status, 'failed');
});


// ── Protocol 2: models, create, setModel ────────────────────────────────────────────────────────────────────────
const control = (w, op, n, extra = {}) => w.bridge.handle({ op, ...OWNER, commandId: CMD(n), deliverWithinMs: 60000, ...extra });

test('models: exactly what the picker offers (user-selectable only), fenced; unavailable without a chat widget', async () => {
    const w = world();
    assert.deepEqual(await w.bridge.handle({ op: 'models' }), { ok: false, error: 'no_owner' });
    await claimed(w);
    assert.deepEqual(await w.bridge.handle({ op: 'models', ...OWNER }), { ok: true, status: 'ok', observedAt: 1700000000000, models: [
        { id: 'ezil/kimi-k2', label: 'Kimi K2', vendor: 'ezil', modelId: 'kimi-k2', configurable: false, efforts: [], defaultEffort: null },
        { id: 'ezil/qwen', label: 'Qwen', vendor: 'ezil', modelId: 'qwen', configurable: false, efforts: [], defaultEffort: null },
    ] });
    const none = world({ open: [] });
    await claimed(none);
    assert.deepEqual(await none.bridge.handle({ op: 'models', ...OWNER }), { ok: true, status: 'unavailable', reason: 'no_chat_widget' });
});

test('create: a NEW empty session, opened as a tab without focus, with the model read back from its own input', async () => {
    // A runtime that does not list an empty chat yet: the bridge still lists (and sends to) the one it created.
    const w = world({ listEmpty: false });
    await claimed(w);
    const before = (await w.bridge.handle({ op: 'sessions', ...OWNER })).sessions.map((s) => s.resource);
    const made = await control(w, 'create', 1, { model: 'ezil/qwen' });
    assert.deepEqual(made, { ok: true, status: 'created', commandId: CMD(1), kind: 'create', sessionResource: 'vscode-chat-session://local/new1',
        model: 'ezil/qwen', effort: null, requestCount: 0, reason: null, observedAt: 1700000000000 });
    assert.ok(!before.includes(made.sessionResource));
    assert.deepEqual(w.calls.opened, [{ id: 'new1', target: -1, options: { preserveFocus: true, pinned: true } }]);
    // Selected for this session only: a user action that is not stored as the window's default.
    assert.deepEqual(w.calls.switched, [{ id: 'new1', identifier: 'ezil/qwen', persist: false, userAction: true }]);
    // Every other session keeps its own model; the new one is listed (empty) and can be sent to.
    const after = (await w.bridge.handle({ op: 'sessions', ...OWNER })).sessions;
    assert.deepEqual(after.find((s) => s.resource.endsWith('/s1')).model, 'ezil/kimi-k2');
    assert.deepEqual(after.find((s) => s.resource === made.sessionResource), { resource: made.sessionResource, title: '', open: true, status: 'idle', model: 'ezil/qwen', effort: null, requests: 0 });
    const sent = await submit(w, 2, { sessionResource: made.sessionResource });
    assert.equal(sent.status, 'in_progress');
    assert.equal(sent.selectedModelId, 'ezil/qwen');
    assert.equal(w.calls.send[0].options.userSelectedModelId, 'ezil/qwen');
});

test('create: a duplicate command id creates once and returns the same session; other input under it is a conflict', async () => {
    const w = world();
    await claimed(w);
    const [a, b] = await Promise.all([control(w, 'create', 1, { model: 'ezil/qwen' }), control(w, 'create', 1, { model: 'ezil/qwen' })]);
    assert.equal(a.status, 'created');
    assert.deepEqual(b, { ok: false, error: 'command_in_flight' });
    assert.deepEqual(await control(w, 'create', 1, { model: 'ezil/qwen' }), { ...a, duplicate: true });
    assert.deepEqual(await control(w, 'create', 1), { ok: false, error: 'command_conflict' });
    assert.deepEqual(await submit(w, 1), { ok: false, error: 'command_conflict' });
    assert.deepEqual(await w.bridge.handle({ op: 'cancel', ...OWNER, commandId: CMD(1) }), { ok: false, error: 'bad_request' });
    assert.equal(w.calls.started, 1);
});

test('create: refused before anything starts when stale, expired, or the model is not offered', async () => {
    let t = 1700000000000;
    const w = world({ now: () => t });
    await claimed(w);
    assert.deepEqual(await control(w, 'create', 1, { model: 'ezil/hidden' }), { ok: true, status: 'rejected', reason: 'model_not_offered' });
    assert.deepEqual(await control(w, 'create', 2, { model: 'not a model id' }), { ok: false, error: 'bad_request' });
    assert.deepEqual(await control(w, 'create', 3, { ownerId: 'os-lease', epoch: 0 }), { ok: false, error: 'stale_owner', epoch: 1 });
    const late = control(w, 'create', 4, { deliverWithinMs: 0 });
    t += 1;
    assert.deepEqual(await late, { ok: true, status: 'expired' });
    assert.equal(w.calls.started, 0);
});

test('create: once started, a failure is never retried: thrown start is uncertain, an unopened chat is failed', async () => {
    const thrown = world({ startThrows: true });
    await claimed(thrown);
    const u = await control(thrown, 'create', 1);
    assert.equal(u.status, 'uncertain');
    assert.deepEqual(await control(thrown, 'create', 1), { ...u, duplicate: true });
    assert.equal(thrown.calls.started, 1);
    const unopened = world({ openFails: true });
    await claimed(unopened);
    const f = await control(unopened, 'create', 1);
    assert.equal(f.status, 'failed');
    assert.equal(f.reason, 'not_opened');
    // Our reference was released, so the empty chat is gone and is not listed.
    assert.ok(!(await unopened.bridge.handle({ op: 'sessions', ...OWNER })).sessions.some((s) => s.resource === f.sessionResource));
});

test('create: a model the runtime does not keep is reported as read back (model_not_applied), never as requested', async () => {
    const w = world({ sticky: false });
    await claimed(w);
    const made = await control(w, 'create', 1, { model: 'ezil/qwen' });
    assert.equal(made.status, 'uncertain');
    assert.equal(made.model, 'ezil/kimi-k2');
    assert.equal(made.reason, 'model_not_applied');
});

test('setModel: one open, idle session only, read back; busy, closed, unknown and locked sessions are not changed', async () => {
    const w = world({ open: ['s1'] });
    await claimed(w);
    const s1 = 'vscode-chat-session://local/s1';
    const applied = await control(w, 'setModel', 1, { sessionResource: s1, model: 'ezil/qwen' });
    assert.deepEqual(applied, { ok: true, status: 'applied', commandId: CMD(1), kind: 'configure', sessionResource: s1, model: 'ezil/qwen', effort: null,
        requestCount: 1, reason: null, observedAt: 1700000000000 });
    assert.deepEqual(await control(w, 'setModel', 1, { sessionResource: s1, model: 'ezil/qwen' }), { ...applied, duplicate: true });
    assert.deepEqual(await control(w, 'setModel', 1, { sessionResource: s1, model: 'ezil/kimi-k2' }), { ok: false, error: 'command_conflict' });
    assert.deepEqual(await control(w, 'setModel', 2, { sessionResource: 'vscode-chat-session://local/s2', model: 'ezil/qwen' }), { ok: true, status: 'not_open' });
    assert.deepEqual(await control(w, 'setModel', 3, { sessionResource: 'vscode-chat-session://local/zz', model: 'ezil/qwen' }), { ok: true, status: 'unknown_session' });
    assert.deepEqual(await control(w, 'setModel', 4, { sessionResource: s1, model: 'ezil/hidden' }), { ok: true, status: 'rejected', reason: 'model_not_offered' });
    w.models.get('s1').requestInProgress.value = true;
    assert.deepEqual(await control(w, 'setModel', 5, { sessionResource: s1, model: 'ezil/kimi-k2' }), { ok: true, status: 'busy' });
    assert.equal(w.widget('s1').input.currentLanguageModel, 'ezil/qwen');
    const locked = world({ lockedAgent: true });
    await claimed(locked);
    assert.deepEqual(await control(locked, 'setModel', 1, { sessionResource: s1, model: 'ezil/qwen' }), { ok: true, status: 'unsupported_session' });
});

test('setModel changes only that session: two sessions keep separate models and send with their own', async () => {
    const w = world({ open: ['s1', 's2'] });
    await claimed(w);
    await control(w, 'setModel', 1, { sessionResource: 'vscode-chat-session://local/s2', model: 'ezil/qwen' });
    await submit(w, 2);
    await submit(w, 3, { sessionResource: 'vscode-chat-session://local/s2' });
    assert.deepEqual(w.calls.send.map((c) => [c.id, c.options.userSelectedModelId]), [['s1', 'ezil/kimi-k2'], ['s2', 'ezil/qwen']]);
});

test('a created chat hidden by a later one is shown again (tab, no focus) before a send or a model change; a person\'s chat never is', async () => {
    const w = world();
    await claimed(w);
    const a = await control(w, 'create', 1, { model: 'ezil/qwen' });
    const b = await control(w, 'create', 2);
    const listed = (await w.bridge.handle({ op: 'sessions', ...OWNER })).sessions;
    assert.equal(listed.find((s) => s.resource === a.sessionResource).open, false);
    assert.equal(listed.find((s) => s.resource === b.sessionResource).open, true);
    const sent = await submit(w, 3, { sessionResource: a.sessionResource });
    assert.equal(sent.status, 'in_progress');
    assert.equal(sent.selectedModelId, 'ezil/qwen');
    assert.deepEqual(w.calls.opened.map((o) => [o.id, o.target, o.options.preserveFocus]), [['new1', -1, true], ['new2', -1, true], ['new1', -1, true]]);
    w.models.get('new1').requestInProgress.value = false;
    assert.equal((await control(w, 'setModel', 4, { sessionResource: b.sessionResource, model: 'ezil/qwen' })).status, 'applied');
    assert.deepEqual(await submit(w, 5, { sessionResource: 'vscode-chat-session://local/s2' }), { ok: true, status: 'not_open' });
    assert.equal(w.calls.opened.length, 4);
});

test('reveal: a chat OS says it created is shown again even after this window forgot it; without it, not_open', async () => {
    const w = world({ open: ['s1'] });
    await claimed(w);
    const s2 = 'vscode-chat-session://local/s2';
    assert.deepEqual(await submit(w, 1, { sessionResource: s2 }), { ok: true, status: 'not_open' });
    const sent = await submit(w, 2, { sessionResource: s2, reveal: true });
    assert.equal(sent.status, 'in_progress');
    assert.deepEqual(w.calls.opened.map((o) => [o.id, o.target, o.options.preserveFocus]), [['s2', -1, true]]);
});

// Ownership can change at an asynchronous service boundary, not only while waiting on a session lock.
for (const boundary of ['list', 'open']) test(`setModel rechecks ownership after ${boundary} resolves`, async () => {
    const entered = deferred(), release = deferred();
    const delay = async () => { entered.resolve(); await release.promise; };
    const w = world({ [boundary === 'list' ? 'listDelay' : 'openDelay']: delay });
    await claimed(w);
    const pending = control(w, 'setModel', 90, { sessionResource: 'vscode-chat-session://local/s2', model: 'ezil/qwen', reveal: true });
    await entered.promise;
    await w.bridge.handle({ op: 'claim', ownerId: 'next-owner', epoch: 2 });
    release.resolve();
    assert.deepEqual(await pending, { ok: false, error: 'stale_owner', epoch: 2 });
    assert.equal(w.calls.switched.length, 0);
    if (boundary === 'list') assert.equal(w.calls.opened.length, 0, 'stale lookup must not reveal a chat');
});

test('create that loses ownership while opening never selects a model or retries its partial creation', async () => {
    const entered = deferred(), release = deferred();
    const w = world({ openDelay: async () => { entered.resolve(); await release.promise; } });
    await claimed(w);
    const pending = control(w, 'create', 91, { model: 'ezil/qwen' });
    await entered.promise;
    await w.bridge.handle({ op: 'claim', ownerId: 'next-owner', epoch: 2 });
    release.resolve();
    const result = await pending;
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'stale_owner');
    assert.equal(w.calls.started, 1);
    assert.equal(w.calls.switched.length, 0);
    const retry = await control(w, 'create', 91, { ownerId: 'next-owner', epoch: 2, model: 'ezil/qwen' });
    assert.equal(retry.status, 'uncertain');
    assert.equal(retry.duplicate, true);
    assert.equal(w.calls.started, 1);
});

test('submit whose session lookup loses ownership does not reveal or acquire that session', async () => {
    const entered = deferred(), release = deferred();
    const w = world({ listDelay: async () => { entered.resolve(); await release.promise; } });
    await claimed(w);
    const pending = submit(w, 92, { sessionResource: 'vscode-chat-session://local/s2', reveal: true });
    await entered.promise;
    await w.bridge.handle({ op: 'claim', ownerId: 'next-owner', epoch: 2 });
    release.resolve();
    assert.deepEqual(await pending, { ok: false, error: 'stale_owner', epoch: 2 });
    assert.equal(w.calls.opened.length + w.calls.acquire + w.calls.send.length, 0);
});

for (const op of ['read', 'sessions']) test(`${op} does not return session data after ownership changes during lookup`, async () => {
    const entered = deferred(), release = deferred();
    const w = world({ listDelay: async () => { entered.resolve(); await release.promise; } });
    await claimed(w);
    const pending = w.bridge.handle({ op, ...OWNER, sessionResource: 'vscode-chat-session://local/s2' });
    await entered.promise;
    await w.bridge.handle({ op: 'claim', ownerId: 'next-owner', epoch: 2 });
    release.resolve();
    assert.deepEqual(await pending, { ok: false, error: 'stale_owner', epoch: 2 });
    assert.equal(w.calls.acquire, 0);
});

test('setModel cannot mutate after disposal during an awaited open', async () => {
    const entered = deferred(), release = deferred();
    const w = world({ openDelay: async () => { entered.resolve(); await release.promise; } });
    await claimed(w);
    const pending = control(w, 'setModel', 93, { sessionResource: 'vscode-chat-session://local/s2', model: 'ezil/qwen', reveal: true });
    await entered.promise;
    w.bridge.dispose();
    release.resolve();
    assert.deepEqual(await pending, { ok: false, error: 'disconnected' });
    assert.equal(w.calls.switched.length, 0);
});

test('protocol3 effort is local to two chats, flushed, read back and carried to the exact request', async () => {
    const { PICKER } = require('./chat-bridge-fake.cjs');
    const picker = structuredClone(PICKER);
    picker[0].metadata.configurationSchema = { properties: { reasoningEffort: { type: 'string', enum: ['low', 'high'] } } };
    const w = world({ mode: 'agent', open: ['s1', 's2'], picker });
    await claimed(w);
    for (const [n, id, effort] of [[1, 's1', 'low'], [2, 's2', 'high']]) {
        const res = await control(w, 'setModel', n, { sessionResource: `vscode-chat-session://local/${id}`, effort });
        assert.equal(res.status, 'applied'); assert.equal(res.effort, effort);
        assert.equal(w.models.get(id).inputState.modelConfiguration.reasoningEffort, effort);
    }
    assert.equal(w.widget('s1').input.getModelConfiguration('ezil/kimi-k2').reasoningEffort, 'low');
    // Hide/show does not transfer configuration between widgets.
    w.open.splice(w.open.indexOf('s1'), 1); w.open.push('s1');
    const sent = await submit(w, 3);
    assert.equal(sent.selectedEffort, 'low');
    assert.equal(w.calls.send[0].options.userSelectedModelConfiguration.reasoningEffort, 'low');
    assert.equal(w.calls.send[0].options.modeInfo.kind, 'agent');
    w.models.get('s1').lastRequest.response.finish(false);
    assert.equal(w.widget('s2').input.getModelConfiguration('ezil/kimi-k2').reasoningEffort, 'high');
});

test('effort refuses missing capability, changed keys, busy sessions and failed persistence readback', async () => {
    const { PICKER } = require('./chat-bridge-fake.cjs');
    const picker = structuredClone(PICKER);
    picker[0].metadata.configurationSchema = { properties: { reasoningEffort: { type: 'string', enum: ['low', 'high'] } } };
    const w = world({ mode: 'agent', picker }); await claimed(w);
    const sessionResource = 'vscode-chat-session://local/s1';
    assert.equal((await control(w, 'setModel', 1, { sessionResource, effort: 'max' })).reason, 'effort_unavailable');
    assert.equal((await control(w, 'setModel', 2, { sessionResource, effort: 'low' })).status, 'applied');
    assert.equal((await control(w, 'setModel', 2, { sessionResource, effort: 'high' })).error, 'command_conflict');
    w.models.get('s1').requestInProgress.value = true;
    assert.equal((await control(w, 'setModel', 3, { sessionResource, effort: 'high' })).status, 'busy');
    w.models.get('s1').requestInProgress.value = false;
    w.widget('s1').input.getCurrentInputState = () => ({});
    assert.equal((await control(w, 'setModel', 4, { sessionResource, effort: 'high' })).status, 'uncertain');
    const old = world({mode:'agent'}); await claimed(old);
    assert.equal((await control(old, 'setModel', 1, { sessionResource, effort: 'high' })).reason, 'effort_unavailable');
});

test('effort cannot change while approval is pending even without a running request', async () => {
    const { PICKER } = require('./chat-bridge-fake.cjs');
    const picker = structuredClone(PICKER);
    picker[0].metadata.configurationSchema = {properties:{reasoningEffort:{type:'string',enum:['low','high']}}};
    const w = world({picker}); await claimed(w);
    w.models.get('s1').requestInProgress.value = false;
    w.models.get('s1').requestNeedsInput.value = true;
    const response = await control(w,'setModel',1,{sessionResource:'vscode-chat-session://local/s1',effort:'high'});
    assert.equal(response.status,'busy');
    assert.equal(w.models.get('s1').inputState,undefined);
    assert.equal(w.widget('s1').input.currentModeKind,'ask');
});

test('missing or mismatched native session input binding never advertises effort or reports success', async () => {
    const { PICKER, uri } = require('./chat-bridge-fake.cjs');
    const picker=structuredClone(PICKER);
    picker[0].metadata.configurationSchema={properties:{reasoningEffort:{type:'string',enum:['low']}}};
    for(const missing of [true,false]) {
        const w=world({picker,mode:'agent'});await claimed(w);
        if(missing) w.widget('s1').input._inputModel=undefined;
        else w.widget('s1').input._inputModelSessionResource=uri('s2');
        const rows=(await w.bridge.handle({op:'models',...OWNER})).models;
        assert.deepEqual(rows[0].efforts,[]);
        const result=await control(w,'setModel',1,{sessionResource:'vscode-chat-session://local/s1',effort:'low'});
        assert.equal(result.status,'rejected');
        assert.equal(w.models.get('s1').inputState,undefined);
    }
});

for (const protocol of [undefined, 2, 3]) test(`model mismatch preserves negotiated workbench semantics: ${protocol ?? 'legacy'}`, async () => {
    const w = world({sticky:false});
    await claimed(w);
    const made = await control(w, 'create', 301, {model:'ezil/qwen', protocol});
    assert.equal(made.status, protocol === 3 ? 'uncertain' : 'created');
    assert.equal(made.model, 'ezil/kimi-k2');
    assert.equal(made.reason, 'model_not_applied');
    const changed = await control(w, 'setModel', 302, {sessionResource:'vscode-chat-session://local/s1', model:'ezil/qwen', protocol});
    assert.equal(changed.status, protocol === 3 ? 'uncertain' : 'failed');
    assert.equal(changed.model, 'ezil/kimi-k2');
    assert.equal(changed.reason, 'model_not_applied');
    if (protocol !== 3) {
        assert.equal(Object.hasOwn(made, 'effort'), false);
        assert.equal(Object.hasOwn(changed, 'effort'), false);
    }
});

for (const mode of ['ask', 'plan', undefined]) test(`explicit effort refuses unsupported mode ${mode} before mutation/send`, async () => {
    const {PICKER} = require('./chat-bridge-fake.cjs');
    const picker=structuredClone(PICKER);picker[0].metadata.configurationSchema={properties:{reasoningEffort:{type:'string',enum:['low']}}};
    const w=world({picker});await claimed(w);w.widget('s1').input.currentModeKind=mode;
    const res=await control(w,'setModel',801,{sessionResource:'vscode-chat-session://local/s1',model:'ezil/qwen',effort:'low'});
    assert.equal(res.reason,'effort_mode_unsupported');assert.equal(w.calls.switched.length,0);assert.equal(w.models.get('s1').inputState,undefined);
    w.widget('s1').input.restoreModelConfiguration('ezil/kimi-k2',{reasoningEffort:'low'},false);
    assert.equal((await submit(w,802)).reason,'effort_mode_unsupported');assert.equal(w.calls.send.length,0);
});
test('old native input without isolation hook is model-only, never advertises or applies effort',async()=>{
    const {PICKER}=require('./chat-bridge-fake.cjs');const picker=structuredClone(PICKER);
    picker[0].metadata.configurationSchema={properties:{reasoningEffort:{type:'string',enum:['low']}}};
    const w=world({picker,mode:'agent',isolationHook:false});await claimed(w);
    assert.deepEqual((await w.bridge.handle({op:'models',...OWNER})).models[0].efforts,[]);
    assert.equal((await control(w,'setModel',803,{sessionResource:'vscode-chat-session://local/s1',effort:'low',model:'ezil/qwen'})).status,'rejected');
    assert.equal(w.calls.switched.length,0);
    assert.equal((await control(w,'setModel',804,{sessionResource:'vscode-chat-session://local/s1',model:'ezil/qwen'})).status,'applied');
});
test('new actual widget unsupported mode leaves one empty identity, uncertain and never recreates on retry',async()=>{
    const {PICKER}=require('./chat-bridge-fake.cjs');const picker=structuredClone(PICKER);
    picker[0].metadata.configurationSchema={properties:{reasoningEffort:{type:'string',enum:['low']}}};
    const w=world({picker,mode:'agent',openDelay:async()=>{w.widget('new1').input.currentModeKind='ask';}});await claimed(w);
    const first=await control(w,'create',805,{model:'ezil/kimi-k2',effort:'low'});
    assert.equal(first.status,'uncertain');assert.equal(first.reason,'created_effort_mode_unsupported');assert.ok(first.sessionResource);
    assert.equal((await control(w,'create',805,{model:'ezil/kimi-k2',effort:'low'})).sessionResource,first.sessionResource);
    assert.equal(w.calls.started,1);assert.equal(w.calls.switched.length,0);assert.equal(w.calls.send.length,0);
});

test('obsolete single-marker native hook cannot qualify effort capability',async()=>{
    const {PICKER}=require('./chat-bridge-fake.cjs');const picker=structuredClone(PICKER);
    picker[0].metadata.configurationSchema={properties:{reasoningEffort:{type:'string',enum:['low']}}};
    const w=world({picker,mode:'agent',isolationHook:false});await claimed(w);
    w.widget('s1').input._ezilSessionEffortV1=()=>{throw new Error('obsolete hook must not execute')};
    assert.deepEqual((await w.bridge.handle({op:'models',...OWNER})).models[0].efforts,[]);
    assert.equal((await control(w,'setModel',806,{sessionResource:'vscode-chat-session://local/s1',effort:'low'})).status,'rejected');
    assert.equal(w.calls.switched.length,0);
});
