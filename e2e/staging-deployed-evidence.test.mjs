import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STAGING, codeLink, collectEvidence, fixtureUrl, gitEvidence, isAssignmentLogin, runtimeMatches } from './staging-deployed-evidence.mjs';

const appSha = 'a'.repeat(40);
const gatewaySha = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const workerVersion = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const repo = 'https://github.ezil.work/default/fixture-code.git';

const response = body => Response.json({ ok: true, ...body });
const health = endpoint => endpoint.startsWith(STAGING) ? response({ sha: appSha }) : response({ commit: gatewaySha });

test('the signed-out deep link keeps exactly the private repository through login', () => {
    assert.equal(fixtureUrl(repo), repo);
    const login = new URL('/login', STAGING);
    login.searchParams.set('returnUrl', codeLink(repo).pathname + codeLink(repo).search);
    assert.equal(isAssignmentLogin(login.href, repo), true);
    assert.equal(isAssignmentLogin(login.href, repo.replace('fixture-code', 'other')), false);
    assert.equal(isAssignmentLogin(login.href.replace('os-staging', 'os'), repo), false);
    login.searchParams.set('returnUrl', '/os');
    assert.equal(isAssignmentLogin(login.href, repo), false);
    for (const rejected of [repo.replace('https', 'http'), repo.replace('github.ezil.work', 'other.invalid'),
        repo.replace('github.ezil.work', 'secret@github.ezil.work'), repo + '?credential=fixture']) {
        assert.throws(() => fixtureUrl(rejected));
    }
});

test('a stale app blocks all browser and Git work even when the Gateway matches', async () => {
    let ran = false;
    const result = await collectEvidence({ mode: 'assignment', appSha: 'd'.repeat(40), gatewaySha }, {
        fetcher: health, runLanes: async () => { ran = true; return []; },
    });
    assert.equal(ran, false);
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.checks.map(item => item.status), ['fail', 'pass', 'blocked']);
    assert.equal(result.checks[0].detail.actual, appSha);
});

test('the release identities are checked again after successful lanes', async () => {
    let released = false;
    const result = await collectEvidence({ mode: 'public', appSha, gatewaySha }, {
        fetcher: endpoint => released && endpoint.startsWith(STAGING) ? response({ sha: 'd'.repeat(40) }) : health(endpoint),
        runLanes: async () => { released = true; return [{ name: 'signed-out-assignment-link', status: 'pass' }]; },
    });
    assert.equal(result.status, 'fail');
    assert.equal(result.checks.find(item => item.name === 'app-sha-after').status, 'fail');
    assert.equal(result.checks.find(item => item.name === 'gateway-sha-after').status, 'pass');
});

test('missing authorized evidence remains blocked while other lanes and release checks complete', async () => {
    const result = await collectEvidence({ mode: 'assignment', appSha, gatewaySha }, {
        fetcher: health,
        runLanes: async () => [{ name: 'signed-out-assignment-link', status: 'pass' }, { name: 'authenticated-code', status: 'blocked' }],
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.checks.at(-1).name, 'gateway-sha-after');
});

test('an empty browser result cannot mark the live version as tested', async () => {
    const result = await collectEvidence({ mode: 'public', appSha, gatewaySha }, {
        fetcher: health, runLanes: async () => [],
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.checks.find(item => item.name === 'required-lane-evidence').status, 'blocked');
});

test('a requested background probe cannot be silently skipped', async () => {
    const lanes = ['signed-out-assignment-link', 'running-code-image-before', 'authenticated_isolated_computer',
        'private_repo_checkout', 'code_full_reload', 'running-code-image-after'].map(name => ({ name, status: 'pass' }));
    lanes.push({ name: 'code_background_agent', status: 'skip' });
    const result = await collectEvidence({ mode: 'assignment', appSha, gatewaySha, agent: true }, {
        fetcher: health, runLanes: async () => lanes,
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.checks.find(item => item.name === 'required-lane-evidence').status, 'blocked');
});

test('live runtime observations must match app, image and Worker and be recent', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const expected = { appSha, imageDigest, workerVersion, computerId, observedAfter: now - 30_000 };
    const recent = { ...expected, runtimeId: 'runtime-42', observedAt: '2026-11-20T11:59:50Z' };
    assert.equal(runtimeMatches(recent, expected, now), true);
    for (const changes of [{ observedAt: '2026-11-20T11:58:00Z' }, { observedAt: '2026-11-20T12:00:01Z' },
        { observedAt: '2026-11-20T11:59:20Z' }, { runtimeId: '' }, { appSha: 'd'.repeat(40) },
        { workerVersion: computerId }, { imageDigest: `sha256:${'d'.repeat(64)}` }, { computerId: 'unknown' }]) {
        assert.equal(runtimeMatches({ ...recent, ...changes }, expected, now), false);
    }
});

test('Git ref evidence distinguishes a match, divergence, missing branch, and access failure', async () => {
    const gitRef = 'refs/heads/fixture';
    const config = { repo, gitRef, sha: appSha };
    const runner = actual => async (file, args) => {
        assert.equal(file, 'git');
        assert.deepEqual(args, ['ls-remote', '--exit-code', '--refs', repo, gitRef]);
        return { stdout: `${actual}\t${gitRef}\n` };
    };
    assert.equal((await gitEvidence(config, runner(appSha)))[0].status, 'pass');
    assert.equal((await gitEvidence(config, runner(gatewaySha)))[0].status, 'fail');
    const fail = code => async () => { throw Object.assign(new Error('private output'), { code }); };
    assert.equal((await gitEvidence(config, fail(2)))[0].status, 'fail');
    const blocked = (await gitEvidence(config, fail(128)))[0];
    assert.equal(blocked.status, 'blocked');
    assert.doesNotMatch(JSON.stringify(blocked), /private output/);
});
