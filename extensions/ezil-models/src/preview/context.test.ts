import { expect, test } from 'bun:test';
import vectors from '../../../../docs/contracts/code-preview-v1.vectors.json';
import { SelectionContext } from './context';
import type { Attachment, Selection } from './contract';

const sel = () => structuredClone(vectors.selection.accept[0]!.sel) as Selection;
const token = () => 'AAAAAAAAAAAAAAAAAAAAAA';

test('selection is refused for a wrong generation, absent ready document, or Interact mode', async () => {
    const sent: Attachment[] = []; const status: string[] = [];
    const context = new SelectionContext(token, async value => { sent.push(value); return true; }, text => status.push(text));
    context.selecting = true;
    await context.select(sel());
    await context.observe({ ...sel().doc, gen: 'BBBBBBBBBBBBBBBBBBBBBB' });
    await context.select(sel());
    await context.observe(sel().doc); context.selecting = false; await context.select(sel());
    expect(sent).toHaveLength(0); expect(status).toHaveLength(2);
});

for (const change of ['mut', 'gen', 'path']) test(`marks changed ${change} stale once, with the original ID`, async () => {
    const sent: Attachment[] = [];
    const context = new SelectionContext(token, async value => { sent.push(value); return true; }, () => {});
    context.selecting = true; await context.observe(sel().doc); await context.select(sel());
    await context.observe(sel().doc); expect(sent).toHaveLength(1);
    const doc = { ...sel().doc, ...(change === 'mut' ? { mut: 4 } : change === 'path' ? { path: '/next' } : { gen: 'BBBBBBBBBBBBBBBBBBBBBB' }) };
    await context.observe(doc);
    expect(sent).toHaveLength(2);
    expect((context as any).selections.size).toBe(0);
    await context.observe(doc); await context.observe({ ...doc, mut: 5 });
    expect(sent).toHaveLength(2); expect(sent[1]!.id).toBe(sent[0]!.id);
    expect(sent[0]!.stale).toBe(false); expect(sent[1]!.stale).toBe(true);
    expect(sent[1]!.value.startsWith('**Stale snapshot:')).toBe(true);
});

test('a selection arriving after navigation is immediately stale even with the same mutation counter', async () => {
    const sent: Attachment[] = [];
    const context = new SelectionContext(token, async value => { sent.push(value); return true; }, () => {});
    context.selecting = true;
    await context.observe({ ...sel().doc, path: '/next' });
    await context.select(sel());
    await context.observe({ ...sel().doc, path: '/another' });
    expect(sent.map(value => value.stale)).toEqual([false, true]);
    expect((context as any).selections.size).toBe(0);
});

test('a slow hook cannot overwrite the stale attachment and hook failures are non-modal', async () => {
    const sent: Attachment[] = [], status: string[] = [];
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { release = resolve; });
    const context = new SelectionContext(token, async value => { sent.push(value); return sent.length === 1 ? pending : true; }, text => status.push(text));
    context.selecting = true; await context.observe(sel().doc);
    const add = context.select(sel());
    await Promise.resolve();
    void context.observe({ ...sel().doc, path: '/next' });
    void context.observe({ ...sel().doc, mut: 4 });
    const changed = context.observe({ ...sel().doc, path: '/another' });
    expect((context as any).selections.size).toBe(0);
    release(true); await add; await changed;
    expect(sent.map(value => value.stale)).toEqual([false, true]);
    const failed = new SelectionContext(token, async () => { throw new Error('PRIVATE'); }, text => status.push(text));
    failed.selecting = true; await failed.observe(sel().doc); await failed.select(sel());
    expect(status.at(-1)).toBe('Could not update the chat attachment.');
    expect(status.join('')).not.toContain('PRIVATE');
});
