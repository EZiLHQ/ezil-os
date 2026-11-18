import assert from 'node:assert/strict';
import { createGitAccessRenewal, GIT_ACCESS_RENEW_MS } from './code-git-access.js';

let clock = 0;
let visible = true;
let current = { computerId: 'computer', repoUrl: 'https://github.ezil.work/default/repo.git' };
const notices = [];
const calls = [];
let reply = async () => ({ ok: true, json: async () => ({ ok: true, scope: 'write' }) });
let cleared = false;
const renew = createGitAccessRenewal({ target: () => current, eligible: () => visible, now: () => clock,
    notice: message => notices.push(message), interval: () => 1, clear: () => { cleared = true; },
    fetch: async (url, init) => { calls.push({ url, init }); return reply(); },
});
await renew.tick(); assert.equal(calls.length, 0, 'the initial open already installed a grant');
clock += GIT_ACCESS_RENEW_MS;
visible = false; await renew.tick(); assert.equal(calls.length, 0, 'hidden/inactive windows do not renew');
visible = true; await renew.tick(); assert.equal(calls.length, 1);
assert.equal(calls[0].url, '/api/shell/code-git-access');
assert.deepEqual(JSON.parse(calls[0].init.body), { computerId: 'computer', repository: { url: current.repoUrl } });
assert.equal(notices.at(-1), null);
reply = async () => ({ ok: true, json: async () => ({ ok: true, scope: 'read' }) });
clock += GIT_ACCESS_RENEW_MS; await renew.tick(); assert.match(notices.at(-1), /read-only/);
reply = async () => ({ ok: false, json: async () => ({ error: { code: 'IDENTITY_REFRESH_REQUIRED' } }) });
clock += GIT_ACCESS_RENEW_MS; await renew.tick(); assert.match(notices.at(-1), /sign-in again/);
let resolve;
reply = () => new Promise(done => { resolve = done; });
clock += GIT_ACCESS_RENEW_MS;
const waiting = renew.tick(); await Promise.resolve();
await renew.tick(); assert.equal(calls.length, 4, 'overlapping renewal is suppressed');
const signal = calls.at(-1).init.signal;
renew.reset(); assert.equal(signal.aborted, true, 'a new repository/mint cancels the prior renewal');
const before = notices.length;
resolve({ ok: true, json: async () => ({ ok: true, scope: 'read' }) }); await waiting;
assert.equal(notices.length, before, 'a stale repository answer cannot paint the current editor');
current = null; clock += GIT_ACCESS_RENEW_MS; await renew.tick(); assert.equal(calls.length, 4);
renew.dispose(); assert.equal(cleared, true);
current = { computerId: 'new', repoUrl: 'https://github.ezil.work/default/new.git' };
clock += GIT_ACCESS_RENEW_MS; await renew.tick(); assert.equal(calls.length, 4, 'a closed window never renews');
console.log('Code Git renewal checks passed');
