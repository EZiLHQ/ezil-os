import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signIn } from './sign-in.mjs';

function fixture({ expanded = true, hydrate = true, navigates = true } = {}) {
  const calls = [];
  const form = { waitFor: async ({ state }) => {
    calls.push(['form', state]);
    if (!hydrate) throw new Error('hydration unavailable');
  }, locator: () => ({ click: async () => { calls.push(['submit']); } }) };
  const disclosure = { getAttribute: async () => String(expanded), click: async () => { calls.push(['disclosure']); } };
  const page = { locator: selector => selector === '#email-sign-in' ? form : disclosure,
    waitForFunction: async () => { calls.push(['email-focus']); },
    fill: async (selector) => { calls.push(['fill', selector]); },
    waitForURL: async (matches, options) => {
      calls.push(['destination', matches(new URL('https://staging.example/computers'))]);
      assert.equal(options.waitUntil, 'commit');
      if (!navigates) throw new Error('cookie: private-test-session');
    } };
  return { page, calls };
}
test('waits for a real hydrated disclosure interaction before entering credentials', async () => {
  const f = fixture();
  await signIn(f.page, { email: 'test@example.invalid', password: 'test', destination: '/computers' });
  assert.deepEqual(f.calls.slice(0, 4), [['disclosure'], ['form', 'hidden'], ['disclosure'], ['form', 'visible']]);
  assert.deepEqual(f.calls.slice(4, 7), [['email-focus'], ['fill', '#email'], ['fill', '#password']]);
  assert.equal(f.calls.filter(c => c[0] === 'submit').length, 1);
  assert.deepEqual(f.calls.find(c => c[0] === 'destination'), ['destination', true]);
});
test('opens an initially collapsed form and never submits when hydration fails', async () => {
  const f = fixture({ expanded: false });
  await signIn(f.page, { email: 'test@example.invalid', password: 'test' });
  assert.deepEqual(f.calls.slice(0, 2), [['disclosure'], ['form', 'visible']]);
  const failed = fixture({ hydrate: false });
  await assert.rejects(signIn(failed.page, { email: 'test@example.invalid', password: 'test' }), /hydration unavailable/);
  assert.equal(failed.calls.some(c => c[0] === 'fill' || c[0] === 'submit'), false);
});
test('failed authentication remains a redacted failure without another submission', async () => {
  const f = fixture({ navigates: false });
  await assert.rejects(signIn(f.page, { email: 'test@example.invalid', password: 'test' }), error => {
    assert.equal(error.message, 'Hosted sign-in did not reach its destination');
    assert.equal(error.stack.includes('private-test-session'), false);
    return true;
  });
  assert.equal(f.calls.filter(c => c[0] === 'submit').length, 1);
});
