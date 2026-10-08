import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openQuickInput } from './code-picker.mjs';

function fixture({ open = false, opensOn = 1 } = {}) {
  const calls = [];
  let clicks = 0;
  const input = { isVisible: async () => open, waitFor: async options => {
    calls.push(['wait', options]);
    if (!open) throw new Error('picker unavailable');
  } };
  const command = { click: async options => {
    calls.push(['click', options]);
    if (++clicks >= opensOn) open = true;
  } };
  const body = { press: async key => { calls.push(['press', key]); open = false; } };
  const frame = { locator: selector => {
    if (selector === '.quick-input-widget input:visible') return input;
    if (selector === '.command-center') return command;
    assert.equal(selector, 'body');
    return body;
  } };
  return { frame, input, calls };
}
test('returns an already open picker without clicking', async () => {
  const f = fixture({ open: true });
  assert.equal(await openQuickInput(f.frame), f.input);
  assert.deepEqual(f.calls, []);
});
test('opens on the second attempt after pressing Escape once', async () => {
  const f = fixture({ opensOn: 2 });
  assert.equal(await openQuickInput(f.frame), f.input);
  assert.deepEqual(f.calls, [
    ['click', { timeout: 10000 }], ['wait', { state: 'visible', timeout: 10000 }], ['press', 'Escape'],
    ['click', { timeout: 10000 }], ['wait', { state: 'visible', timeout: 10000 }],
  ]);
});
test('fails after the configured attempts when the picker never opens', async () => {
  const f = fixture({ opensOn: Infinity });
  await assert.rejects(openQuickInput(f.frame, { attempts: 2, timeout: 25 }), { message: 'Code quick input did not open' });
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 2);
  assert.deepEqual(f.calls.filter(c => c[0] === 'wait'), [
    ['wait', { state: 'visible', timeout: 25 }], ['wait', { state: 'visible', timeout: 25 }],
  ]);
});
