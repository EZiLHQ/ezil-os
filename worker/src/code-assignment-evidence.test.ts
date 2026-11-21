import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

import traceFixture from '../../app/src/server/ai-traces/fixture.json';
import { attachAssignmentCodeEvidence } from '../../shell/ezil/apps/code-assignment-evidence.js';
import { codeAssignmentEvidenceScript, codeAssignmentEvidenceTag } from './code-assignment-evidence';

const shellOrigin = 'https://os-staging.ezil.work';
const editorOrigin = 'https://fixture-code.ezil.work';
const repositoryFolder = '/workspace/projects/11111111-1111-4111-8111-111111111111';
const root = repositoryFolder + '/assignment';
const scope = { computerId: 'computer-a', repositoryUrl: 'https://github.ezil.work/example/assignment.git' };
const search = '?folder=' + repositoryFolder + '&ezil_mint=AAAAAAAAAAAAAAAAAAAAAA';
const frameUrl = editorOrigin + '/' + search;

function fixture() {
    const records: unknown[] = [];
    const shell = new EventTarget();
    const editor = new EventTarget();
    const frame = new EventTarget();
    const hooks = { source: editor, readiness: false, frameVisible: true, showFile: false, range: [1, 5] };
    let path = root + '/before-start.ts';
    let observer: (() => void) | undefined;
    const shellDocument = { visibilityState: 'visible' };
    const editorDocument = { documentElement: { dataset: {} }, visibilityState: 'visible', querySelectorAll: () => hooks.showFile ? [buffer] : [] };
    const send = (recipient: EventTarget, type: string, properties: object) => {
        recipient.dispatchEvent(Object.assign(new Event(type), properties));
    };
    const buffer = {
        getClientRects: () => [{}], closest: () => null, getAttribute: () => 'vscode-remote://workspace' + path,
        dispatchEvent: (event: { detail: { report: (value: number[]) => void } }) => event.detail.report(hooks.range),
    };
    const iframe = Object.assign(frame, {
        isConnected: true, src: frameUrl, contentWindow: editor, getClientRects: () => hooks.frameVisible ? [{}] : [],
        ownerDocument: { defaultView: Object.assign(shell, { location: { origin: shellOrigin }, document: shellDocument, crypto, btoa }) },
    });
    Object.assign(shell, {
        postMessage(data: unknown, target: string) {
            expect(target).toBe(shellOrigin);
            send(shell, 'message', { data, source: editor, origin: editorOrigin });
        },
    });
    Object.assign(editor, {
        parent: shell, postMessage(data: unknown, target: string) {
            expect(target).toBe(editorOrigin);
            send(editor, 'message', { data, source: shell, origin: shellOrigin });
        },
    });
    runInNewContext(codeAssignmentEvidenceScript(), {
        window: editor, document: editorDocument, location: { search }, URLSearchParams, URL, TextEncoder, CustomEvent,
        setInterval: (callback: () => void) => { observer = callback; return 1; },
        clearInterval: () => { observer = undefined; },
    });
    let consentChange: ((active: boolean, permissions?: { chat?: boolean; terminal?: boolean }) => void) | undefined;
    const detach = attachAssignmentCodeEvidence({
        iframe, frameUrl, repositoryFolder, repositoryName: 'example/assignment', scope,
        subscribe: (requested: typeof scope, listener: (active: boolean, permissions?: { chat?: boolean; terminal?: boolean }) => void) => {
            expect(requested).toEqual(scope); consentChange = listener; listener(false);
            return () => { consentChange = undefined; };
        },
        record: (kind: string, detail: unknown, assignment: typeof scope) => records.push({ kind, detail, assignment }),
    });
    return {
        hooks, records, shell, editor, iframe, send, detach, editorDocument,
        setPath(value: string) { path = value; },
        sample() { observer?.(); },
        armed() { return observer !== undefined; },
        consent(active: boolean, permissions?: { chat?: boolean; terminal?: boolean }) { consentChange?.(active, permissions); },
        trace(value = traceFixture) { send(editor, 'ezil-ai-request-trace', { detail: JSON.stringify(value) }); },
    };
}

test('the two sides publish subsequent file activation, exact model ranges and existing model results with consent', () => {
    const f = fixture();
    f.hooks.showFile = true;
    f.sample();
    f.trace();
    expect(f.records).toEqual([]);
    expect(f.armed()).toBe(false);
    f.consent(true);
    expect(f.armed()).toBe(true);
    expect(f.records).toEqual([]);
    f.setPath(root + '/src/test file.ts');
    f.sample();
    f.hooks.range = [12, 25];
    f.sample();
    f.sample();
    f.trace();
    f.trace();
    expect(f.records).toEqual([
        { kind: 'code.file_opened', detail: { path: 'src/test file.ts' }, assignment: scope },
        { kind: 'code.file_reviewed', detail: { path: 'src/test file.ts', startLine: 12, endLine: 25 }, assignment: scope },
        { kind: 'model.completed', detail: { requestId: traceFixture.requestId, model: traceFixture.modelAlias, outcome: traceFixture.outcome, trace: traceFixture }, assignment: scope },
    ]);
    f.consent(false);
    expect(f.armed()).toBe(false);
    f.trace({ ...traceFixture, requestId: '00000000-0000-4000-8000-000000000001' });
    expect(f.records).toHaveLength(3);
    f.detach();
});

test('a wrong frame, mint, repository subtree, credential path or hidden editor supplies no file observation', () => {
    const f = fixture();
    f.send(f.editor, 'message', { source: f.editor, origin: shellOrigin, data: { type: 'ezil.code.assignment.start', v: 1, nonce: 'BBBBBBBBBBBBBBBBBBBBBB', mint: 'AAAAAAAAAAAAAAAAAAAAAA', root } });
    f.send(f.editor, 'message', { source: f.shell, origin: 'https://wrong.example', data: { type: 'ezil.code.assignment.start', v: 1, nonce: 'BBBBBBBBBBBBBBBBBBBBBB', mint: 'AAAAAAAAAAAAAAAAAAAAAA', root } });
    f.send(f.editor, 'message', { source: f.shell, origin: shellOrigin, data: { type: 'ezil.code.assignment.start', v: 1, nonce: 'BBBBBBBBBBBBBBBBBBBBBB', mint: 'invalid', root } });
    expect(f.armed()).toBe(false);
    f.consent(true);
    f.hooks.showFile = true;
    for (const value of [root + '2/test.ts', root + '/.git/config', root + '/.env.local', root + '/id_ed25519', root + '/server.pem', root + '/%2e%2e/test.ts']) {
        f.setPath(value); f.sample();
    }
    f.hooks.frameVisible = false;
    f.setPath(root + '/visible-on-another-surface.ts');
    f.sample();
    f.trace({ ...traceFixture, modelAlias: 'token-a86' });
    expect(f.records).toEqual([]);
    f.detach();
    expect(f.armed()).toBe(false);
});

test('the workbench script is omitted in production and uses the original CSP nonce in staging', () => {
    expect(codeAssignmentEvidenceTag(['https://os.ezil.work'], 'test-nonce')).toBe('');
    expect(codeAssignmentEvidenceTag([shellOrigin, 'https://evil.example'], 'test-nonce')).toBe('');
    expect(codeAssignmentEvidenceTag([shellOrigin], '";bad')).toBe('');
    expect(codeAssignmentEvidenceTag([shellOrigin], 'test-nonce')).toStartWith('<script nonce="test-nonce" data-ezil-assignment-evidence="1">');
});

test('Chat, correlated model traces, and safe terminal completion require their respective arm flags', () => {
    const f = fixture();
    const chatRequestId = 'request_11111111-1111-4111-8111-111111111111';
    const executionId = '22222222-2222-4222-8222-222222222222';
    const event = (type: string, detail: unknown) => f.send(f.editor, type, { detail });
    const prompt = { kind: 'chat.prompt_submitted', chatRequestId, text: 'Add a search field to the synthetic directory.' };
    const trace = { ...traceFixture, clientRequestId: executionId, gatewayRequestId: '33333333-3333-4333-8333-333333333333' };
    const retryChatRequestId = 'request_44444444-4444-4444-8444-444444444444';
    const link = { chatRequestId: retryChatRequestId, requestId: trace.requestId };

    f.consent(true);
    event('ezil:assignment-chat', prompt);
    event('ezil:assignment-terminal', { executionId, command: 'git status', exitCode: 0, durationMs: 8 });
    expect(f.records).toEqual([]);
    f.consent(false);

    f.consent(true, { chat: true, terminal: true });
    expect(f.editorDocument.documentElement.dataset).toMatchObject({
        ezilAssignmentChat: '1', ezilAssignmentTerminal: '1', ezilAssignmentRoot: root,
    });
    event('ezil:assignment-gateway-link', link); // no preceding matching inference
    event('ezil:assignment-chat', prompt);
    event('ezil:assignment-chat', { kind: 'chat.request_retried', chatRequestId, retryChatRequestId });
    f.trace(trace);
    event('ezil:assignment-gateway-link', link);
    event('ezil:assignment-chat', { ...prompt, kind: 'chat.response_completed', text: 'Example password=synthetic-marker' });
    event('ezil:assignment-terminal', { executionId, command: 'git status', exitCode: 0, durationMs: 8 });
    event('ezil:assignment-terminal', { executionId, command: 'echo synthetic-marker', exitCode: 0, durationMs: 3 });
    expect(f.records).toEqual([
        { kind: 'chat.prompt_submitted', assignment: scope, detail: {
            chatRequestId, contentStatus: 'captured', text: prompt.text,
        } },
        { kind: 'chat.request_retried', assignment: scope, detail: { chatRequestId, retryChatRequestId } },
        { kind: 'model.completed', assignment: scope, detail: {
            requestId: trace.requestId, model: trace.modelAlias, outcome: trace.outcome, trace,
        } },
        { kind: 'chat.gateway_linked', assignment: scope, detail: link },
        { kind: 'chat.response_completed', assignment: scope, detail: {
            chatRequestId, contentStatus: 'withheld',
        } },
        { kind: 'terminal.command_finished', assignment: scope, detail: { executionId, command: 'git status', exitCode: 0, durationMs: 8 } },
        { kind: 'terminal.command_finished', assignment: scope, detail: { executionId, command: null, exitCode: 0, durationMs: 3 } },
    ]);
    f.consent(false);
    expect(f.editorDocument.documentElement.dataset).toEqual({});
    event('ezil:assignment-chat', prompt);
    expect(f.records).toHaveLength(7);
    f.detach();
});
