// `@ezil` (participant.ts): a no-tools chat path. The request it makes through the selected model must reach the
// Gateway body with no `tools` and no `tool_choice`, while the Agent path keeps its tools (with a fake `vscode`).

import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';

import { ChatRequestTurn, ChatResponseMarkdownPart, ChatResponseTurn, fakeVscode } from './fixtures/fake-vscode';
import { gw, tool, txt, msg } from './fixtures/gateway';

mock.module('vscode', () => fakeVscode);
const { PARTICIPANT_ID, handleNoToolsRequest, noToolsMessages, registerNoToolsParticipant } = await import('../src/participant');
const { toNeutralRequest } = await import('../src/provider');
const { buildGatewayBody } = await import('../src/gateway-messages');

const KIMI = 'us.moonshotai.kimi-k3';
type Sent = { messages: unknown[]; options: Record<string, unknown> };

function fakeModel(vendor = 'ezil', reply: string[] | Error = ['Hel', 'lo']) {
    const sent: Sent[] = [];
    const model = {
        vendor, id: KIMI,
        sendRequest: async (messages: unknown[], options: Record<string, unknown>) => {
            sent.push({ messages, options });
            if (reply instanceof Error) throw reply;
            return { text: (async function* () { yield* reply; })() };
        },
    };
    return { model, sent };
}

async function ask(prompt: string, opts: { vendor?: string; reply?: string[] | Error; history?: unknown[]; references?: unknown[] } = {}) {
    const { model, sent } = fakeModel(opts.vendor, opts.reply);
    const shown: string[] = [];
    const result = await handleNoToolsRequest({ prompt, model, references: opts.references ?? [] } as never, { history: opts.history ?? [] } as never,
        { markdown: (value: string) => shown.push(value) } as never, { isCancellationRequested: false } as never);
    return { result, sent, shown };
}

/** What VS Code hands the provider for the participant's call, through the real provider and serializer. */
function gatewayBody(sent: Sent) {
    return buildGatewayBody(gw(KIMI), toNeutralRequest(sent.messages as never, sent.options as never)).body as Record<string, unknown>;
}

describe('@ezil no-tools participant', () => {
    test('sends the prompt with NO options: no tools and no tool mode', async () => {
        const { result, sent, shown } = await ask('What is a monad?');
        expect(result).toEqual({});
        expect(sent).toHaveLength(1);
        expect(sent[0]!.options).toEqual({});
        expect(shown.join('')).toBe('Hello');
    });

    test('the Gateway body for that call carries no tools and no tool_choice, and Kimi stays non-streamed', async () => {
        const { sent } = await ask('Reply with exactly MARKER_OK and nothing else.');
        const body = gatewayBody(sent[0]!);
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('tool_choice');
        expect(body.stream).toBe(false);
        expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly MARKER_OK and nothing else.' }] }]);
    });

    test('two identical @ezil questions in new chats give byte-identical bodies (exact-cache eligible)', async () => {
        const one = await ask('Same question?');
        const two = await ask('Same question?');
        const bytes = (sent: Sent) => buildGatewayBody(gw(KIMI), toNeutralRequest(sent.messages as never, sent.options as never)).bytes;
        expect(Buffer.from(bytes(one.sent[0]!)).equals(Buffer.from(bytes(two.sent[0]!)))).toBe(true);
    });

    test('the Agent path is unchanged: offered tools still reach the body with tool_choice auto', () => {
        const body = buildGatewayBody(gw(KIMI), { messages: [msg('user', txt('Edit it'))], tools: [tool], toolMode: 'auto', modelOptions: {} }).body as Record<string, unknown>;
        expect((body.tools as { name: string }[]).map(t => t.name)).toEqual([tool.name]);
        expect(body.tool_choice).toEqual({ type: 'auto' });
    });

    test('only earlier @ezil turns become history; other participants are left out', () => {
        const history = [
            new ChatRequestTurn('first', PARTICIPANT_ID), new ChatResponseTurn([new ChatResponseMarkdownPart('answer one')], PARTICIPANT_ID),
            new ChatRequestTurn('agent work', 'github.copilot.editsAgent'), new ChatResponseTurn([new ChatResponseMarkdownPart('agent reply')], 'github.copilot.editsAgent'),
        ];
        const messages = noToolsMessages({ history } as never, 'second') as unknown as { role: number; content: { value: string }[] }[];
        expect(messages.map(m => [m.role, m.content[0]!.value])).toEqual([[1, 'first'], [2, 'answer one'], [1, 'second']]);
    });

    test('a non-EZiL model is not called; the user is told to pick an EZiL model', async () => {
        const { result, sent, shown } = await ask('hi', { vendor: 'copilot' });
        expect(sent).toHaveLength(0);
        expect(result).toEqual({});
        expect(shown.join('')).toContain('EZiL models only');
    });

    test('attached references are not sent, and the user is told so', async () => {
        const { sent, shown } = await ask('look at this', { references: [{ id: 'file', value: 'x' }] });
        expect(shown[0]).toContain('not sent');
        const body = gatewayBody(sent[0]!);
        expect(JSON.stringify(body)).not.toContain('"x"');
    });

    test('a model error is returned as errorDetails, never as a successful answer', async () => {
        const { result, shown } = await ask('hi', { reply: new Error('No EZiL session for this computer yet.') });
        expect(result).toEqual({ errorDetails: { message: 'No EZiL session for this computer yet.' } });
        expect(shown).toEqual([]);
    });

    test('registers under the manifest id, and the manifest contributes exactly that participant', () => {
        const participant = registerNoToolsParticipant() as unknown as { id: string };
        expect(participant.id).toBe(PARTICIPANT_ID);
        const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        expect(manifest.contributes.chatParticipants).toEqual([expect.objectContaining({ id: PARTICIPANT_ID, name: 'ezil' })]);
        expect(manifest.contributes.languageModelChatProviders[0].vendor).toBe('ezil');
    });
});
