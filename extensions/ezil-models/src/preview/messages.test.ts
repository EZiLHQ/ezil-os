import { expect, test } from 'bun:test';
import vectors from '../../../../docs/contracts/code-preview-v1.vectors.json';
import { FrameMessages } from './messages';
import type { Selection } from './contract';

const origin = 'https://3002-guac-u1-c1-app.ezil.org';
const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
const sel = vectors.selection.accept[0]!.sel as Selection;
const frame = {};
const event = (type = 'ready', more = {}) => ({ source: frame, origin, data: { type: `ezil.preview.${type}`, v: 1, nonce, ...(type === 'select' ? { sel } : { doc: sel.doc }), ...more } });

for (const wrong of ['origin', 'source', 'nonce', 'version', 'before hello', 'after navigation', 'previous hello']) test(`frame refuses ${wrong}`, () => {
    const gate = new FrameMessages(origin);
    const ev = event();
    if (wrong !== 'before hello') gate.hello(nonce);
    if (wrong === 'origin') ev.origin = 'https://3002-other-app.ezil.org';
    if (wrong === 'source') ev.source = {};
    if (wrong === 'nonce') ev.data.nonce = 'BBBBBBBBBBBBBBBBBBBBBB';
    if (wrong === 'version') ev.data.v = 2;
    if (wrong === 'after navigation') gate.invalidate();
    if (wrong === 'previous hello') gate.hello('CCCCCCCCCCCCCCCCCCCCCC');
    expect(gate.accept(ev, frame)).toBeUndefined();
});

test('only ready authorizes selection, and only the toolbar can opt into Select', () => {
    const gate = new FrameMessages(origin); gate.hello(nonce);
    gate.selecting = true;
    expect(gate.accept(event('select'), frame)).toBeUndefined();
    expect(gate.accept(event(), frame)).toEqual({ type: 'ready', doc: sel.doc });
    gate.selecting = false;
    expect(gate.accept(event('select'), frame)).toBeUndefined();
    gate.selecting = true;
    expect(gate.accept(event('select'), frame)).toEqual({ type: 'select', sel });
    expect(gate.accept(event('changed'), frame)).toEqual({ type: 'changed', doc: sel.doc });
    expect(gate.accept(event('navigate'), frame)).toEqual({ type: 'navigate', doc: sel.doc });
    expect(gate.accept(event('select', { sel: { ...sel, extra: 1 } }), frame)).toBeUndefined();
    expect(gate.accept(event('select', { command: 'workbench.action.chat.submit' }), frame)).toBeUndefined();
    expect(gate.accept(event('submit'), frame)).toBeUndefined();
    const diagnostic = { source: frame, origin, data: { type: 'ezil.preview.state', v: 1, nonce, state: 'port_not_listening' } };
    expect(gate.accept(diagnostic, frame)).toEqual({ type: 'state', state: 'port_not_listening' });
    expect(gate.accept(event('select'), frame)).toBeUndefined();
});
