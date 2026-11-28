// transport-clock-test.mjs — EZiL-authored. Run: node --test shell/ezil/assignment-video/transport-clock-test.mjs
//
// The transport's side of the server clock: the lease-free `clock` action, a server-named pause that is not an end, a
// bare checkpointed `paused` that still is, and the timeline bound that follows the server's deadline.
import assert from 'node:assert/strict';
import test from 'node:test';
import {checkAssignmentClock, createAssignmentVideoTransport} from './transport.js';

const id = '2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const recordingId = '01111111-2222-4333-8444-555555555555';
const phase = '3d5fd5d2-ad3e-47ea-9a95-60eb51bce32b';
const proof = 'p'.repeat(60);
const MIN = 60000;
const iso = ms => new Date(ms).toISOString();

function server(overrides = {}) {
    const calls = [];
    const state = {status: 'recording', ...overrides};
    const fetcher = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        if (body.action === 'preflight') return Response.json({status: 'eligible', attemptId: id, expiresAt: iso(Date.now() + 60000)});
        if (body.action === 'clock') return Response.json(state.clock ?? {revision: 1, serverNow: iso(Date.now()), startedAt: null, deadlineAt: null,
            pausedAt: null, pauseReason: null, remainingMs: null});
        if (body.action === 'begin') return Response.json({recordingId, status: 'recording', captureSessionId: phase, nextSequence: 1,
            startedAt: iso(Date.now() - 1000), deadlineAt: iso(Date.now() + 50 * MIN), revoked: false, stopRequestedAt: null});
        if (body.action === 'status') return Response.json({recordingId, captureSessionId: phase, revoked: false, stopRequestedAt: null,
            startedAt: iso(Date.now() - 1000), deadlineAt: iso(Date.now() + 50 * MIN), status: state.status, ...state.extra});
        return Response.json({});
    };
    return {fetcher, calls, state};
}

test('the clock action needs no capture lease and returns the server report', async () => {
    const s = server({clock: {revision: 4, serverNow: iso(Date.now()), startedAt: iso(Date.now() - MIN), deadlineAt: iso(Date.now() + 50 * MIN),
        pausedAt: null, pauseReason: null, remainingMs: null}});
    const report = await checkAssignmentClock(id, {fetcher: s.fetcher});
    assert.equal(report.revision, 4);
    assert.deepEqual(s.calls, [{action: 'clock', attemptId: id}], 'only the attempt id: no capture session, no proof');
});

test('a clock answer without a revision is refused, and a bad attempt id never leaves the page', async () => {
    const s = server({clock: {serverNow: iso(Date.now())}});
    await assert.rejects(checkAssignmentClock(id, {fetcher: s.fetcher}), {code: 'recording_unavailable'});
    await assert.rejects(checkAssignmentClock('nope', {fetcher: s.fetcher}), {code: 'invalid_assignment'});
    assert.equal(s.calls.length, 1);
});

test('a refusal from the clock route keeps its code, and a dead network is media_unavailable', async () => {
    const refuse = async () => Response.json({error: {code: 'recording_unavailable'}}, {status: 404});
    await assert.rejects(checkAssignmentClock(id, {fetcher: refuse}), {code: 'recording_unavailable'});
    await assert.rejects(checkAssignmentClock(id, {fetcher: async () => { throw new TypeError('offline'); }}), {code: 'media_unavailable'});
});

async function begun(options = {}, overrides) {
    const s = server(overrides);
    const stops = [];
    const t = createAssignmentVideoTransport({attemptId: id, repoOpenProof: proof, consentVersion: 4, captureSessionId: phase,
        onStop: (why, at) => stops.push([why, at]), fetcher: s.fetcher, pollMs: 100000, ...options});
    await t.begin();
    return {t, s, stops};
}

test('a server-named pause is a running share with a stopped clock, not an end', async () => {
    const {t, stops} = await begun({}, {status: 'paused', extra: {pauseReason: 'system_upgrade', pausedAt: iso(Date.now())}});
    try {
        const data = await t.status();
        assert.equal(data.status, 'paused');
        assert.deepEqual(stops, []);
    } finally { t.dispose(); }
});

test('a bare paused status (a checkpointed phase) still ends the share', async () => {
    const {t, stops} = await begun({}, {status: 'paused'});
    try {
        await t.status();
        assert.equal(stops.length, 1);
        assert.equal(stops[0][0], 'stopped');
    } finally { t.dispose(); }
});

test('status reports reach the clock, and a later deadline is followed instead of ending at the old one', async () => {
    const reports = [];
    const {t, s, stops} = await begun({onClock: r => reports.push(r)}, {});
    try {
        await t.status();
        assert.equal(reports.length, 1);
        s.state.extra = {deadlineAt: iso(Date.now() + 80 * MIN)};
        await assert.doesNotReject(t.status());
        assert.equal(reports.length, 2);
        assert.deepEqual(stops, []);
    } finally { t.dispose(); }
});

test('the local expiry waits while the server clock is paused and ends the share only when it runs', async () => {
    let paused = true;
    const expiring = [], deadlineAt = iso(Date.now() + 120), startedAt = iso(Date.now() - 3599000);
    // A begin whose deadline is a moment away: the expiry fires inside the paused window.
    const soon = createAssignmentVideoTransport({attemptId: id, repoOpenProof: proof, consentVersion: 4, captureSessionId: phase,
        onStop: why => expiring.push(why), paused: () => paused, pollMs: 20, fetcher: async (u, o) => {
            const body = JSON.parse(o.body);
            if (body.action === 'preflight') return Response.json({status: 'eligible', attemptId: id, expiresAt: iso(Date.now() + 60000)});
            return Response.json({recordingId, status: 'recording', captureSessionId: phase, nextSequence: 1, startedAt, deadlineAt,
                revoked: false, stopRequestedAt: null});
        }});
    try {
        await soon.begin();
        await new Promise(r => setTimeout(r, 300));
        assert.deepEqual(expiring, [], 'paused: the old deadline does not end the share');
        paused = false;
        await new Promise(r => setTimeout(r, 100));
        assert.deepEqual(expiring, ['timeout'], 'running: it does');
    } finally { soon.dispose(); }
});

test('editor-ready sends the attempt, the phase and the open proof, never a time, and returns the canonical clock', async () => {
    const report = {revision: 3, serverNow: iso(Date.now()), startedAt: iso(Date.now()), deadlineAt: iso(Date.now() + 60 * MIN), pausedAt: null, pauseReason: null, remainingMs: null};
    const {t, s} = await begun({}, {});
    const inner = s.fetcher;
    const t2 = createAssignmentVideoTransport({attemptId: id, repoOpenProof: proof, consentVersion: 4, captureSessionId: phase, pollMs: 100000,
        fetcher: async (u, o) => JSON.parse(o.body).action === 'editor-ready' ? (s.calls.push(JSON.parse(o.body)), Response.json(report)) : inner(u, o)});
    try {
        await assert.rejects(t2.editorReady(), {code: 'recording_unavailable'}, 'not before the share began');
        await t2.begin();
        assert.deepEqual(await t2.editorReady(), report);
        const body = s.calls.findLast(c => c.action === 'editor-ready');
        assert.deepEqual(body, {action: 'editor-ready', attemptId: id, captureSessionId: phase, repoOpenProof: proof});
    } finally { t.dispose(); t2.dispose(); }
});

test('an editor-ready answer without a revision is refused', async () => {
    const t = createAssignmentVideoTransport({attemptId: id, repoOpenProof: proof, consentVersion: 4, captureSessionId: phase, pollMs: 100000,
        fetcher: async (u, o) => {
            const body = JSON.parse(o.body);
            if (body.action === 'editor-ready') return Response.json({serverNow: iso(Date.now())});
            return server().fetcher(u, o);
        }});
    try {
        await t.begin();
        await assert.rejects(t.editorReady(), {code: 'recording_unavailable'});
    } finally { t.dispose(); }
});

test('a clip may end past the first hour only as far as the server deadline allows', async () => {
    let span = 0;
    const {t} = await begun({maxEndMs: () => span}, {});
    try {
        const clip = {sequence: 1, startMs: 0, endMs: 1000, mimeType: 'video/webm', bytes: new Uint8Array([1])};
        const over = {...clip, startMs: 3600000 + 5000, endMs: 3600000 + 9000};
        await assert.rejects(t.upload(over), {code: 'invalid_segment'});
        span = 3600000 + 20000;
        await assert.rejects(t.upload(over), error => error.code !== 'invalid_segment', 'passes the bound, then fails later at the fake broker');
    } finally { t.dispose(); }
});
