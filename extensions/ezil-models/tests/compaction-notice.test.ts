import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { fakeVscode } from './fixtures/fake-vscode';
import type { CompactionInfo } from '../src/compact';

mock.module('vscode', () => fakeVscode);
const { CompactionNotice, compactionText, CHAT_VIEW, COMPACTING_CONTEXT } = await import('../src/compaction-notice');

const window = fakeVscode.window as Record<string, unknown>;
const commands = fakeVscode.commands as Record<string, unknown>;
const saved = { executeCommand: commands.executeCommand, withProgress: window.withProgress, showInformationMessage: window.showInformationMessage };
let context: boolean[] = [];
let progress: { location: unknown; title: string }[] = [];
let ran: string[] = [];
beforeEach(() => {
    context = []; progress = []; ran = [];
    commands.executeCommand = async (command: string, ...args: unknown[]) => {
        if (command === 'setContext' && args[0] === COMPACTING_CONTEXT) context.push(args[1] as boolean);
        else ran.push(command);
    };
    window.withProgress = async (options: { location: unknown; title: string }, task: () => Promise<void>) => { progress.push(options); return task(); };
});
afterEach(() => Object.assign(commands, { executeCommand: saved.executeCommand }) && Object.assign(window, { withProgress: saved.withProgress, showInformationMessage: saved.showInformationMessage }));

const info: CompactionInfo = { cause: 'local_input_too_large', fromBytes: 170_762, toBytes: 93_594, limitBytes: 130_016, folded: 12, shortened: 4 };
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { promise, done }; };

test('a compacted turn shows the title-bar item and view progress on the chat view while it runs, then clears it', async () => {
    const lines: string[] = [];
    const notice = new CompactionNotice(line => lines.push(line), 0);
    const turn = deferred();
    notice.show('Kimi K3', info, turn.promise);
    await tick();
    expect(context).toEqual([true]);
    expect(progress).toEqual([{ location: { viewId: CHAT_VIEW }, title: 'Compacting the conversation for Kimi K3' }]);
    turn.done(); await tick(20);
    expect(context).toEqual([true, false]);
    // Sizes and counts only.
    expect(lines).toEqual([`[compact] Kimi K3: ${JSON.stringify(info)}`]);
    notice.dispose();
});

test('an earlier turn ending does not clear the notice of a later one still running', async () => {
    const notice = new CompactionNotice(() => {}, 0);
    const first = deferred(); const second = deferred();
    notice.show('Kimi K3', info, first.promise);
    notice.show('Qwen3 Coder Next', info, second.promise);
    first.done(); await tick(20);
    expect(context).toEqual([true, true]);
    second.done(); await tick(20);
    expect(context).toEqual([true, true, false]);
});

test('a chat view that refuses view progress leaves no unhandled rejection; the item still shows', async () => {
    window.withProgress = async () => { throw new Error('Bad progress location'); };
    const notice = new CompactionNotice(() => {}, 0);
    notice.show('Kimi K3', info, Promise.resolve());
    await tick(20);
    expect(context).toEqual([true, false]);
});

test('the item explains what was compacted and that the conversation is kept, and offers AI status', async () => {
    const shown: string[] = [];
    window.showInformationMessage = async (message: string) => { shown.push(message); return 'Show AI Status'; };
    const notice = new CompactionNotice(() => {}, 0);
    await notice.explain();
    expect(shown[0]).toBe('EZiL has not compacted a conversation in this window.');
    notice.show('Kimi K3', info, Promise.resolve());
    await notice.explain();
    expect(shown[1]).toBe(compactionText('Kimi K3', info));
    expect(shown[1]).toBe('EZiL compacted this conversation to fit Kimi K3: 12 earlier messages summarized, 4 long outputs or replies shortened '
        + '(93,594 bytes sent, 170,762 before, limit 130,016). The full conversation is still saved in this chat, and a model with a larger input limit gets more of it.');
    expect(ran).toEqual(['ezil-models.showStatus', 'ezil-models.showStatus']);
    expect(compactionText('Kimi K3', { ...info, cause: 'remote', folded: 0 })).toContain('after EZiL AI refused its size: 4 long outputs');
});
