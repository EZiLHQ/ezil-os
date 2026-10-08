import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signIn } from './sign-in.mjs';

function fixture({ expanded = true, ignoredClicks = 0, navigates = true } = {}) {
  const calls = [];
  let elapsed = 0, toggled = false, ready = false;
  const form = { waitFor: async ({ state, timeout }) => {
    calls.push(['form', state]);
    if ((state === 'visible') !== expanded) {
      elapsed += timeout;
      throw new Error('hydration unavailable: private-test-session');
    }
    ready = toggled && expanded;
  }, locator: () => ({ click: async () => { assert.ok(ready); calls.push(['submit']); } }) };
  const disclosure = { getAttribute: async () => String(expanded), click: async () => {
    calls.push(['disclosure']);
    if (ignoredClicks-- > 0) return;
    expanded = !expanded;
    toggled = true;
  } };
  const page = { locator: selector => selector === '#email-sign-in' ? form : disclosure,
    waitForFunction: async () => { assert.ok(ready); calls.push(['email-focus']); },
    fill: async (selector) => { assert.ok(ready); calls.push(['fill', selector]); },
    waitForURL: async (matches, options) => {
      calls.push(['destination', matches(new URL('https://staging.example/computers'))]);
      assert.equal(options.waitUntil, 'commit');
      if (!navigates) throw new Error('cookie: private-test-session');
    } };
  return { page, calls, now: () => elapsed, visible: () => expanded };
}
test('waits for a real hydrated disclosure interaction and leaves an initially expanded form visible', async () => {
  const f = fixture();
  await signIn(f.page, { email: 'test@example.invalid', password: 'test', destination: '/computers' });
  assert.deepEqual(f.calls.slice(0, 4), [['disclosure'], ['form', 'hidden'], ['disclosure'], ['form', 'visible']]);
  assert.deepEqual(f.calls.slice(4, 7), [['email-focus'], ['fill', '#email'], ['fill', '#password']]);
  assert.equal(f.calls.filter(c => c[0] === 'submit').length, 1);
  assert.deepEqual(f.calls.find(c => c[0] === 'destination'), ['destination', true]);
  assert.equal(f.visible(), true);
});
test('opens an initially collapsed form', async () => {
  const f = fixture({ expanded: false });
  await signIn(f.page, { email: 'test@example.invalid', password: 'test' });
  assert.deepEqual(f.calls.slice(0, 2), [['disclosure'], ['form', 'visible']]);
  assert.equal(f.visible(), true);
});
test('retries two ignored clicks before filling credentials and submits once', async () => {
  const f = fixture({ ignoredClicks: 2 });
  await signIn(f.page, { email: 'test@example.invalid', password: 'test', now: f.now });
  assert.deepEqual(f.calls.slice(0, 8), [
    ['disclosure'], ['form', 'hidden'], ['disclosure'], ['form', 'hidden'],
    ['disclosure'], ['form', 'hidden'], ['disclosure'], ['form', 'visible'],
  ]);
  assert.deepEqual(f.calls.slice(8, 11), [['email-focus'], ['fill', '#email'], ['fill', '#password']]);
  assert.equal(f.calls.filter(c => c[0] === 'submit').length, 1);
  assert.equal(f.now(), 6000);
  assert.equal(f.visible(), true);
});
test('never fills or submits when hydration misses the deadline', async () => {
  const failed = fixture({ ignoredClicks: Infinity });
  await assert.rejects(signIn(failed.page, { email: 'test@example.invalid', password: 'test', now: failed.now }), error => {
    assert.equal(error.message, 'Hosted sign-in form did not hydrate');
    assert.equal(error.stack.includes('private-test-session'), false);
    return true;
  });
  assert.equal(failed.now(), 30000);
  assert.equal(failed.calls.filter(c => c[0] === 'disclosure').length, 10);
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
