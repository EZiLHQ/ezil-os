import { expect, test } from 'bun:test';
import type { ChatEvent, SessionSummary } from '../src/opencode/adapter';
import { applyEvent, groupModels, initialState, lastUsage, reduce, type UiState } from '../src/webview/reducer';

const session: SessionSummary = { id: 'ses_1', title: 'One', directory: '/ws', created: 1, updated: 1, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };

function withSession(): UiState {
    let state = reduce(initialState(), { type: 'sessions', sessions: [session], currentSessionId: 'ses_1' });
    state = reduce(state, { type: 'messages', sessionId: 'ses_1', messages: [], permissions: [], questions: [] });
    return state;
}

function run(state: UiState, events: ChatEvent[]): UiState {
    return events.reduce((current, event) => applyEvent(current, event), state);
}

test('a streamed turn accumulates text, tool cards and usage in order', () => {
    const state = run(withSession(), [
        { type: 'message.user', message: { id: 'u1', sessionId: 'ses_1', role: 'user', created: 1, parts: [{ type: 'text', key: 'text:0', text: 'hi' }], streaming: false } },
        { type: 'session.busy', sessionId: 'ses_1' },
        { type: 'turn.started', sessionId: 'ses_1', messageId: 'a1', agent: 'build', model: { providerID: 'p', modelID: 'm' }, created: 2 },
        { type: 'text.delta', sessionId: 'ses_1', messageId: 'a1', key: 'text:0', delta: 'Hel' },
        { type: 'text.delta', sessionId: 'ses_1', messageId: 'a1', key: 'text:0', delta: 'lo' },
        { type: 'tool.started', sessionId: 'ses_1', messageId: 'a1', toolId: 'c1', name: 'read' },
        { type: 'tool.called', sessionId: 'ses_1', messageId: 'a1', toolId: 'c1', input: { path: 'a.ts' } },
        { type: 'tool.completed', sessionId: 'ses_1', messageId: 'a1', toolId: 'c1', output: 'contents' },
        { type: 'text.delta', sessionId: 'ses_1', messageId: 'a1', key: 'text:2', delta: 'Done' },
        { type: 'turn.ended', sessionId: 'ses_1', messageId: 'a1', finish: 'stop', tokens: { input: 10, output: 4, reasoning: 0, cacheRead: 8, cacheWrite: 1 }, cost: 0.002 },
        { type: 'session.idle', sessionId: 'ses_1', reason: 'succeeded' },
    ]);
    expect(state.busy).toBe(false);
    expect(state.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    const assistant = state.messages[1];
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.parts).toEqual([
        { type: 'text', key: 'text:0', text: 'Hello' },
        { type: 'tool', key: 'c1', tool: { id: 'c1', name: 'read', status: 'completed', input: { path: 'a.ts' }, output: 'contents' } },
        { type: 'text', key: 'text:2', text: 'Done' },
    ]);
    expect(lastUsage(state)).toEqual({ tokens: { input: 10, output: 4, reasoning: 0, cacheRead: 8, cacheWrite: 1 }, cost: 0.002 });
});

test('busy is set on user send and cleared by session idle even without a step end', () => {
    let state = run(withSession(), [{ type: 'message.user', message: { id: 'u1', sessionId: 'ses_1', role: 'user', created: 1, parts: [], streaming: false } }]);
    expect(state.busy).toBe(true);
    state = run(state, [{ type: 'turn.failed', sessionId: 'ses_1', error: { type: 'ProviderError', message: 'no key' } }]);
    expect(state.busy).toBe(false);
    expect(state.error).toBe('ProviderError: no key');
});

test('events for other sessions do not touch the current transcript, but session metadata updates do', () => {
    const state = run(withSession(), [
        { type: 'text.delta', sessionId: 'ses_2', messageId: 'a9', key: 'text:0', delta: 'nope' },
        { type: 'session.created', session: { ...session, id: 'ses_2', title: 'Two' } },
        { type: 'session.updated', sessionId: 'ses_2', title: 'Renamed' },
        { type: 'session.updated', sessionId: 'ses_1', model: { providerID: 'azure', modelID: 'gpt-5' }, agent: 'plan' },
    ]);
    expect(state.messages).toEqual([]);
    expect(state.sessions.map(item => [item.id, item.title])).toEqual([['ses_2', 'Renamed'], ['ses_1', 'One']]);
    expect(state.selectedModel).toEqual({ providerID: 'azure', modelID: 'gpt-5' });
    expect(state.selectedAgent).toBe('plan');
});

test('permission and question cards appear once and disappear on reply', () => {
    const request = { id: 'per_1', sessionId: 'ses_1', action: 'bash', resources: ['rm -rf'] };
    let state = run(withSession(), [{ type: 'permission.asked', request }, { type: 'permission.asked', request }]);
    expect(state.permissions).toHaveLength(1);
    state = run(state, [{ type: 'permission.replied', sessionId: 'ses_1', requestId: 'per_1', decision: 'reject' }]);
    expect(state.permissions).toHaveLength(0);
    const question = { id: 'frm_1', sessionId: 'ses_1', title: 'Which?', fields: [] };
    state = run(state, [{ type: 'question.asked', question }]);
    expect(state.questions).toEqual([question]);
    state = run(state, [{ type: 'question.replied', sessionId: 'ses_1', questionId: 'frm_1' }]);
    expect(state.questions).toEqual([]);
});

test('switching session clears the transcript and stale message payloads are ignored', () => {
    let state = run(withSession(), [{ type: 'text.delta', sessionId: 'ses_1', messageId: 'a1', key: 'text:0', delta: 'x' }]);
    state = reduce(state, { type: 'selection', sessionId: 'ses_2' });
    expect(state.messages).toEqual([]);
    expect(state.currentSessionId).toBe('ses_2');
    state = reduce(state, { type: 'messages', sessionId: 'ses_1', messages: [{ id: 'old', sessionId: 'ses_1', role: 'user', created: 1, parts: [], streaming: false }], permissions: [], questions: [] });
    expect(state.messages).toEqual([]);
});

test('server status flows through the reducer; composer-only messages leave state untouched', () => {
    let state = reduce(initialState(), { type: 'server', server: { status: 'error', message: 'crashed' } });
    expect(state.error).toBe('crashed');
    state = reduce(state, { type: 'server', server: { status: 'ready', version: '2.0.19', baseUrl: 'http://127.0.0.1:1' } });
    expect(state.server.status).toBe('ready');
    expect(reduce(state, { type: 'mention', mention: { path: 'a.ts', label: 'a.ts' } })).toBe(state);
    expect(reduce(state, { type: 'fileResults', requestId: 1, files: ['a.ts'] })).toBe(state);
});

test('cards raised by a subagent show on the parent transcript; cards for unrelated sessions do not', () => {
    const state = run(withSession(), [
        { type: 'permission.asked', request: { id: 'per_c', sessionId: 'ses_child', rootSessionId: 'ses_1', action: 'bash', resources: ['ls'] } },
        { type: 'permission.asked', request: { id: 'per_o', sessionId: 'ses_other', action: 'bash', resources: ['ls'] } },
        { type: 'question.asked', question: { id: 'frm_c', sessionId: 'ses_child', rootSessionId: 'ses_1', title: 'Which?', fields: [] } },
        { type: 'question.asked', question: { id: 'frm_o', sessionId: 'ses_other', title: 'Nope', fields: [] } },
    ]);
    expect(state.permissions.map(request => request.id)).toEqual(['per_c']);
    expect(state.questions.map(question => question.id)).toEqual(['frm_c']);
    const replied = run(state, [{ type: 'permission.replied', sessionId: 'ses_child', requestId: 'per_c', decision: 'once' }, { type: 'question.replied', sessionId: 'ses_child', questionId: 'frm_c' }]);
    expect(replied.permissions).toEqual([]);
    expect(replied.questions).toEqual([]);
});

test('models are grouped by provider name and disabled ones hidden', () => {
    const groups = groupModels([
        { providerID: 'azure', modelID: 'b', name: 'B', variants: [], enabled: true, contextLimit: 1, status: 'active' },
        { providerID: 'azure', modelID: 'a', name: 'A', variants: ['high'], enabled: true, contextLimit: 1, status: 'active' },
        { providerID: 'opencode', modelID: 'x', name: 'X', variants: [], enabled: false, contextLimit: 1, status: 'active' },
        { providerID: 'anthropic', modelID: 'c', name: 'C', variants: [], enabled: true, contextLimit: 1, status: 'beta' },
    ], [{ id: 'azure', name: 'Azure', enabled: true }]);
    expect(groups.map(group => [group.name, group.models.map(model => model.modelID)])).toEqual([['anthropic', ['c']], ['Azure', ['a', 'b']]]);
});
