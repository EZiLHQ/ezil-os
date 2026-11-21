import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { create_interview_consent } from './interview-consent.js';

const SHA = 'a73e2521409a299375aeac8dfb21d95a7daab7e788405d6dda4e4a064f0e7336';
const NOTICE_TEXT = 'EZiL interview recording notice (version 1)\n\n...verbatim body...\n';
const notice = { version: 1, sha256: SHA, text: NOTICE_TEXT };
const GITQA = 'https://git-qa.ezil.work/candidate-a/interview-1121.git';
const flush = () => new Promise(r => setTimeout(r, 0));

function setup (responses) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://os.test' });
    const fetchCalls = [];
    let i = 0;
    const fetchImpl = async (url, opts) => {
        fetchCalls.push(JSON.parse(opts.body));
        const r = responses[i++] ?? responses[responses.length - 1];
        return { status: r.status, async json () { return r.body; } };
    };
    const timers = [];
    const beginCalls = [];
    const consent = create_interview_consent({
        fetchImpl, timer: (fn) => { timers.push(fn); return timers.length; }, cancelTimer: () => {},
        win: dom.window, doc: dom.window.document, activity: { begin: (a) => beginCalls.push(a) }, now: () => 0,
    });
    const overlay = () => dom.window.document.querySelector('.ezil-interview-consent');
    return { dom, fetchCalls, timers, beginCalls, consent, overlay, firePoll: () => { const fn = timers.shift(); return fn && fn(); } };
}

test('a non-git-qa repo never fetches and never blocks boot', async () => {
    const b = setup([]);
    await b.consent.gate({ repoUrl: 'https://github.com/a/b.git' });
    await b.consent.gate({ repoUrl: undefined });
    assert.equal(b.fetchCalls.length, 0);
    assert.equal(b.overlay(), null);
});

test('interview:null and any refusal resolve immediately with no overlay (boot continues unchanged)', async () => {
    const nul = setup([{ status: 200, body: { interview: null } }]);
    await nul.consent.gate({ repoUrl: GITQA });
    assert.equal(nul.fetchCalls.length, 1);
    assert.equal(nul.overlay(), null);

    const refused = setup([{ status: 404, body: { error: { code: 'repo_not_found', message: 'x' } } }]);
    await refused.consent.gate({ repoUrl: GITQA });
    assert.equal(refused.overlay(), null);
});

test('an already-started interview begins recording and resolves, with no notice', async () => {
    const b = setup([{ status: 200, body: { interview: { interviewId: 'iv-1', state: 'started', notice } } }]);
    await b.consent.gate({ repoUrl: GITQA });
    assert.deepEqual(b.beginCalls, [{ interviewId: 'iv-1' }]);
    assert.equal(b.overlay(), null);
});

test('registered: the notice is shown verbatim; Accept -> waiting -> started resolves and begins recording', async () => {
    const b = setup([
        { status: 200, body: { interview: { interviewId: 'iv-1', state: 'registered', notice } } }, // status
        { status: 200, body: { accepted: true, state: 'consented' } }, // accept
        { status: 200, body: { interview: { interviewId: 'iv-1', state: 'consented', notice } } }, // poll 1
        { status: 200, body: { interview: { interviewId: 'iv-1', state: 'started', notice } } }, // poll 2
    ]);
    let settled = false;
    const done = b.consent.gate({ repoUrl: GITQA }).then(() => { settled = true; });
    await flush();
    assert.equal(b.overlay().querySelector('.ezil-interview-notice').textContent, NOTICE_TEXT);

    b.overlay().querySelector('.ezil-interview-accept').click();
    await flush();
    assert.deepEqual(b.fetchCalls[1], { action: 'accept', interviewId: 'iv-1', noticeVersion: 1, noticeSha256: SHA });
    assert.equal(settled, false);
    assert.match(b.overlay().querySelector('.ezil-interview-status').textContent, /Waiting/);

    b.firePoll(); await flush(); // consented: still waiting
    assert.equal(settled, false);
    b.firePoll(); await flush(); // started: resolve + begin
    await done;
    assert.deepEqual(b.beginCalls, [{ interviewId: 'iv-1' }]);
    assert.equal(b.overlay(), null);
});

test('a notice_mismatch on accept shows an error and does NOT resolve (boot stays blocked)', async () => {
    const b = setup([
        { status: 200, body: { interview: { interviewId: 'iv-1', state: 'registered', notice } } },
        { status: 409, body: { error: { code: 'notice_mismatch', message: 'x' } } },
    ]);
    let settled = false;
    b.consent.gate({ repoUrl: GITQA }).then(() => { settled = true; });
    await flush();
    b.overlay().querySelector('.ezil-interview-accept').click();
    await flush();
    assert.equal(settled, false);
    assert.match(b.overlay().querySelector('.ezil-interview-status').textContent, /notice changed/i);
});

test('Leave removes the notice and leaves boot blocked', async () => {
    const b = setup([{ status: 200, body: { interview: { interviewId: 'iv-1', state: 'registered', notice } } }]);
    let settled = false;
    b.consent.gate({ repoUrl: GITQA }).then(() => { settled = true; });
    await flush();
    b.overlay().querySelector('.ezil-interview-leave').click();
    await flush();
    assert.equal(b.overlay(), null);
    assert.equal(settled, false);
    assert.equal(b.beginCalls.length, 0);
});

test('a consented interview at status skips the notice and waits for the interviewer', async () => {
    const b = setup([
        { status: 200, body: { interview: { interviewId: 'iv-1', state: 'consented', notice } } }, // status
        { status: 200, body: { interview: { interviewId: 'iv-1', state: 'started', notice } } }, // poll
    ]);
    let settled = false;
    const done = b.consent.gate({ repoUrl: GITQA }).then(() => { settled = true; });
    await flush();
    assert.equal(b.overlay().querySelector('.ezil-interview-accept').style.display, 'none');
    assert.match(b.overlay().querySelector('.ezil-interview-status').textContent, /Waiting/);
    assert.equal(settled, false);
    b.firePoll(); await flush();
    await done;
    assert.deepEqual(b.beginCalls, [{ interviewId: 'iv-1' }]);
});

test('ezil:teardown cleans up and resolves so a closing window never hangs boot', async () => {
    const b = setup([{ status: 200, body: { interview: { interviewId: 'iv-1', state: 'registered', notice } } }]);
    let settled = false;
    const done = b.consent.gate({ repoUrl: GITQA }).then(() => { settled = true; });
    await flush();
    assert.ok(b.overlay());
    b.dom.window.dispatchEvent(new b.dom.window.Event('ezil:teardown'));
    await done;
    assert.equal(settled, true);
    assert.equal(b.overlay(), null);
});
