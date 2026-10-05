import { expect, test } from 'bun:test';
import type { OpenCodeEvent } from '@opencode/client';
import * as normalize from '../src/opencode/normalize';

const base = { id: 'evt_1', created: 1, location: { directory: '/ws' } };
const durable = { aggregateID: 'ses_1', seq: 1, version: 1 as const };

test('text and reasoning deltas are keyed by ordinal per assistant message', () => {
    const delta: OpenCodeEvent = { ...base, type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 2, delta: 'Hel' } };
    expect(normalize.event(delta)).toEqual([{ type: 'text.delta', sessionId: 'ses_1', messageId: 'msg_a', key: 'text:2', delta: 'Hel' }]);
    const reasoning: OpenCodeEvent = { ...base, type: 'session.reasoning.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 0, delta: 'hm' } };
    expect(normalize.event(reasoning)[0]).toMatchObject({ type: 'reasoning.delta', key: 'reasoning:0' });
});

test('step lifecycle maps to turn events with token usage flattened', () => {
    const started: OpenCodeEvent = { ...base, type: 'session.step.started', durable, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', agent: 'build', model: { id: 'claude-sonnet-4-5', providerID: 'azure', variant: 'high' }, started: 5 } };
    expect(normalize.event(started)).toEqual([{ type: 'turn.started', sessionId: 'ses_1', messageId: 'msg_a', agent: 'build', model: { providerID: 'azure', modelID: 'claude-sonnet-4-5', variant: 'high' }, created: 5 }]);
    const ended: OpenCodeEvent = { ...base, type: 'session.step.ended', durable, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', finish: 'stop', cost: 0.01, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 3 } } } };
    expect(normalize.event(ended)).toEqual([{ type: 'turn.ended', sessionId: 'ses_1', messageId: 'msg_a', finish: 'stop', cost: 0.01, tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 7, cacheWrite: 3 } }]);
    const failed: OpenCodeEvent = { ...base, type: 'session.execution.failed', durable, data: { sessionID: 'ses_1', error: { type: 'ProviderError', message: 'no model', status: 400 } } };
    expect(normalize.event(failed).map(event => event.type)).toEqual(['turn.failed', 'session.idle']);
});

test('tool success with edit metadata yields tool.completed plus file.edited', () => {
    const files = [{ file: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b\n', additions: 1, deletions: 1, status: 'modified' as const }];
    const success: OpenCodeEvent = { ...base, type: 'session.tool.success', durable: { ...durable, version: 2 }, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', id: 'call_1', executed: true, content: [{ type: 'text', text: 'Edited src/a.ts' }], metadata: { files } } };
    const events = normalize.event(success);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'tool.completed', toolId: 'call_1', output: 'Edited src/a.ts', files });
    expect(events[1]).toEqual({ type: 'file.edited', sessionId: 'ses_1', files });
    const plain: OpenCodeEvent = { ...base, type: 'session.tool.success', durable: { ...durable, version: 2 }, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', id: 'call_2', executed: true, content: [{ type: 'text', text: 'ok' }] } };
    expect(normalize.event(plain)).toHaveLength(1);
    const failed: OpenCodeEvent = { ...base, type: 'session.tool.failed', durable: { ...durable, version: 2 }, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', id: 'call_3', executed: true, error: { type: 'ToolFailure', message: 'boom' } } };
    expect(normalize.event(failed)).toEqual([{ type: 'tool.failed', sessionId: 'ses_1', messageId: 'msg_a', toolId: 'call_3', error: { type: 'ToolFailure', message: 'boom' } }]);
});

test('permission and form events become permission/question cards', () => {
    const asked: OpenCodeEvent = { ...base, type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_1', action: 'edit', resources: ['/ws/a.ts'], save: ['*'], metadata: { files: [{ file: 'a.ts', patch: 'p', additions: 1, deletions: 0, status: 'modified' }] } } };
    const [event] = normalize.event(asked);
    expect(event).toMatchObject({ type: 'permission.asked', request: { id: 'per_1', sessionId: 'ses_1', action: 'edit', resources: ['/ws/a.ts'], save: ['*'] } });
    expect(event?.type === 'permission.asked' && event.request.files?.[0]?.file).toBe('a.ts');
    const replied: OpenCodeEvent = { ...base, type: 'permission.replied', data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'always' } };
    expect(normalize.event(replied)).toEqual([{ type: 'permission.replied', sessionId: 'ses_1', requestId: 'per_1', decision: 'always' }]);
    const form: OpenCodeEvent = { ...base, type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Pick one', fields: [{ key: 'choice', type: 'string', options: [{ value: 'a', label: 'A' }], custom: true }] } } };
    expect(normalize.event(form)).toEqual([{ type: 'question.asked', question: { id: 'frm_1', sessionId: 'ses_1', title: 'Pick one', fields: [{ key: 'choice', type: 'string', options: [{ value: 'a', label: 'A' }], custom: true }] } }]);
});

test('session created/renamed/model selected map to summaries and updates; unknown events are dropped', () => {
    const created: OpenCodeEvent = { ...base, type: 'session.created', durable, data: { sessionID: 'ses_9', projectID: 'p', location: { directory: '/ws' }, slug: 'x', version: '2.0.19', title: 'Hi', agent: 'plan' } };
    expect(normalize.event(created)).toEqual([{ type: 'session.created', session: { id: 'ses_9', title: 'Hi', directory: '/ws', created: 1, updated: 1, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, agent: 'plan' } }]);
    const renamed: OpenCodeEvent = { ...base, type: 'session.renamed', durable, data: { sessionID: 'ses_9', title: 'New' } };
    expect(normalize.event(renamed)).toEqual([{ type: 'session.updated', sessionId: 'ses_9', title: 'New' }]);
    const selected: OpenCodeEvent = { ...base, type: 'session.model.selected', durable, data: { sessionID: 'ses_9', model: { id: 'gpt-5', providerID: 'azure' } } };
    expect(normalize.event(selected)).toEqual([{ type: 'session.updated', sessionId: 'ses_9', model: { providerID: 'azure', modelID: 'gpt-5' } }]);
    expect(normalize.event({ ...base, type: 'models-dev.refreshed', data: {} } as unknown as OpenCodeEvent)).toEqual([]);
    for (const type of ['agent.updated', 'model.updated', 'provider.updated']) {
        expect(normalize.event({ ...base, type, data: {} } as unknown as OpenCodeEvent)).toEqual([{ type: 'catalog.changed' }]);
    }
});

test('stored messages convert to chat messages with tool states', () => {
    const user = normalize.message({ id: 'm1', time: { created: 1 }, type: 'user', text: 'hi' }, 'ses_1');
    expect(user).toEqual({ id: 'm1', sessionId: 'ses_1', role: 'user', created: 1, parts: [{ type: 'text', key: 'text:0', text: 'hi' }], streaming: false });
    const assistant = normalize.message({
        id: 'm2', time: { created: 2, completed: 3 }, type: 'assistant', agent: 'build', model: { id: 'x', providerID: 'p' }, finish: 'stop',
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
        content: [
            { type: 'text', text: 'Reading' },
            { type: 'tool', id: 'call', name: 'read', state: { status: 'completed', input: { path: 'a' }, content: [{ type: 'text', text: 'body' }] }, time: { created: 2 } },
            { type: 'tool', id: 'call2', name: 'bash', state: { status: 'error', input: { command: 'x' }, error: { type: 'E', message: 'bad' } }, time: { created: 2 } },
        ],
    }, 'ses_1');
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.parts).toEqual([
        { type: 'text', key: 'text:0', text: 'Reading' },
        { type: 'tool', key: 'call', tool: { id: 'call', name: 'read', status: 'completed', input: { path: 'a' }, output: 'body' } },
        { type: 'tool', key: 'call2', tool: { id: 'call2', name: 'bash', status: 'error', input: { command: 'x' }, error: 'bad' } },
    ]);
    expect(normalize.message({ id: 'm3', time: { created: 1 }, type: 'idle', outcome: 'succeeded' }, 'ses_1')).toBeUndefined();
});
