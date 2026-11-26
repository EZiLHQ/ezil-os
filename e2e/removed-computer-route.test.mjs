// Browser-free validation of the removed-/computer acceptance probe.
// Run: node --test e2e/removed-computer-route.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KEPT_PATHS, PROBE_COMPUTER_ID, REMOVED_PATHS, checkRemovedComputerRoute } from './removed-computer-route.mjs';

const APP = 'https://os.example.test';

/** A fake app: `answers(path)` returns `[status, location?]`; every request is recorded. */
function fakeApp(answers) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ path: `${url.pathname}${url.search}`, init });
        const [status, location] = answers(`${url.pathname}${url.search}`);
        return { status, headers: new Headers(location ? { location } : {}) };
    };
    return { calls, fetch };
}

const gate = path => [307, `/login?returnUrl=${encodeURIComponent(path)}`];
/** The app after the removal. */
const removed = path => (path.startsWith('/computer/') || path === '/computer' ? [404] : gate(path));
/** The app before it: bare `/computer` is already 404, the dynamic page bounces to login. */
const legacy = path => (path === '/computer' ? [404] : gate(path));

test('probes both shapes of the removed path, and never follows a redirect', async () => {
    const app = fakeApp(removed);
    const outcome = await checkRemovedComputerRoute({ app: APP, fetch: app.fetch, headers: { 'x-probe': '1' } });
    assert.equal(outcome.ok, true);
    assert.deepEqual(app.calls.map(call => call.path), [...REMOVED_PATHS, ...KEPT_PATHS]);
    assert.ok(REMOVED_PATHS.includes('/computer'));
    assert.ok(REMOVED_PATHS.includes(`/computer/${PROBE_COMPUTER_ID}`));
    for (const call of app.calls) {
        assert.equal(call.init.method, 'GET');
        assert.equal(call.init.redirect, 'manual');
        assert.deepEqual(call.init.headers, { 'x-probe': '1' });
    }
});

test('the bare 404 alone does not pass: a deployed dynamic page is named as such', async () => {
    const outcome = await checkRemovedComputerRoute({ app: APP, fetch: fakeApp(legacy).fetch });
    assert.equal(outcome.ok, false);
    const byPath = Object.fromEntries(outcome.results.map(result => [result.path, result]));
    assert.equal(byPath['/computer'].ok, true);
    const dynamic = byPath[`/computer/${PROBE_COMPUTER_ID}`];
    assert.equal(dynamic.ok, false);
    assert.equal(dynamic.status, 307);
    assert.match(dynamic.reason, /still deployed/);
    // Every other spelling of the dynamic page fails with it; the kept surfaces do not.
    assert.deepEqual(outcome.results.filter(result => !result.ok).map(result => result.path), REMOVED_PATHS.slice(1));
});

test('a removed path that answers anything but 404 fails, whatever it is', async () => {
    for (const answer of [[200], [500], [308, '/computers'], [307, 'https://evil.example/login']]) {
        const app = fakeApp(path => (path.startsWith('/computer/') ? answer : removed(path)));
        const outcome = await checkRemovedComputerRoute({ app: APP, fetch: app.fetch });
        assert.equal(outcome.ok, false, JSON.stringify(answer));
        const failed = outcome.results.find(result => !result.ok);
        assert.equal(failed.reason, `expected 404, got ${answer[0]}`);
    }
});

test('the kept surfaces must still gate, and return to their own address', async () => {
    const cases = [
        ['removed too', () => [404]],
        ['renders without a gate', () => [200]],
        ['returns somewhere else', () => [307, '/login?returnUrl=%2Fcomputers%2Fother']],
        ['bounces off-origin', path => [307, `https://evil.example/login?returnUrl=${encodeURIComponent(path)}`]],
        ['redirects without a Location', () => [307]],
    ];
    for (const [name, broken] of cases) {
        const app = fakeApp(path => (path === '/computers' ? broken(path) : removed(path)));
        const outcome = await checkRemovedComputerRoute({ app: APP, fetch: app.fetch });
        assert.equal(outcome.ok, false, name);
        assert.deepEqual(outcome.results.filter(result => !result.ok).map(result => result.path), ['/computers'], name);
    }
    // The viewer a /computers row opens keeps its computer through sign-in.
    assert.ok(KEPT_PATHS.includes(`/app/browser?computer=${PROBE_COMPUTER_ID}`));
});
