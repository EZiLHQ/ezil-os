import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runCodeJourney } from './staging-code-journey.mjs';

export const STAGING = 'https://os-staging.ezil.work';
const gateway = 'https://ai-staging.ezil.work';
const fullSha = /^[0-9a-f]{40}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const runtimeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ref = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const command = promisify(execFile);
const observedAt = () => new Date().toISOString();
const check = (name, status, detail) => ({ name, status, detail, observedAt: observedAt() });
const signedOutFixture = 'https://github.ezil.work/default/staging-code-evidence-fixture.git';

function requireMatch(pattern, value, name) {
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid or missing ${name}`);
    return value;
}

export function fixtureUrl(value) {
    const url = new URL(value);
    if (url.origin !== 'https://github.ezil.work' || url.username || url.password || url.search || url.hash ||
        !/^\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.git$/.test(url.pathname)) {
        throw new Error('Expected a canonical private Git fixture URL');
    }
    return url.href;
}

export function codeLink(repo, target = STAGING) {
    const link = new URL('/app/code', target);
    link.searchParams.set('repo', repo);
    return link;
}

export function isAssignmentLogin(landed, repo, target = STAGING) {
    const page = new URL(landed);
    if (page.origin !== target || page.pathname !== '/login') return false;
    const returnTo = page.searchParams.get('returnUrl');
    if (!returnTo?.startsWith('/app/code?')) return false;
    const afterLogin = new URL(returnTo, target);
    return afterLogin.pathname === '/app/code' && afterLogin.searchParams.getAll('repo').length === 1 &&
        afterLogin.searchParams.get('repo') === repo;
}

async function releaseCheck(name, endpoint, field, expected, fetcher) {
    try {
        const reply = await fetcher(endpoint, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!reply.ok) return check(name, 'fail', { httpStatus: reply.status, expected });
        const body = await reply.json();
        const actual = fullSha.test(typeof body[field] === 'string' ? body[field] : '') ? body[field] : null;
        return check(name, body.ok === true && actual === expected ? 'pass' : 'fail', { expected, actual });
    } catch {
        return check(name, 'fail', { expected, reason: 'release health response unavailable' });
    }
}

export async function verifyRelease(config, phase, fetcher = fetch) {
    const tasks = [releaseCheck(`app-sha-${phase}`, `${STAGING}/api/health`, 'sha', config.appSha, fetcher)];
    if (config.gatewaySha) tasks.push(releaseCheck(`gateway-sha-${phase}`, `${gateway}/health`, 'commit', config.gatewaySha, fetcher));
    return Promise.all(tasks);
}

function configFrom(env) {
    const mode = env.EZIL_STAGING_EVIDENCE_MODE ?? 'public';
    if (!['public', 'assignment'].includes(mode)) throw new Error('Invalid EZIL_STAGING_EVIDENCE_MODE');
    const appSha = requireMatch(fullSha, env.EZIL_STAGING_EXPECT_APP_SHA, 'EZIL_STAGING_EXPECT_APP_SHA');
    const gatewaySha = env.EZIL_STAGING_EXPECT_GATEWAY_SHA || null;
    if (gatewaySha || mode === 'assignment') requireMatch(fullSha, gatewaySha, 'EZIL_STAGING_EXPECT_GATEWAY_SHA');
    const repo = env.EZIL_STAGING_QA_REPO ? fixtureUrl(env.EZIL_STAGING_QA_REPO) : null;
    const sha = env.EZIL_STAGING_EXPECT_SUBMITTED_SHA || null;
    const gitRef = env.EZIL_STAGING_QA_GIT_REF || null;
    if (sha || gitRef) {
        requireMatch(fullSha, sha, 'EZIL_STAGING_EXPECT_SUBMITTED_SHA');
        requireMatch(ref, gitRef, 'EZIL_STAGING_QA_GIT_REF');
        if (!repo || mode !== 'assignment') throw new Error('Git readback requires an assignment fixture');
    }
    return { mode, appSha, gatewaySha, repo, sha, gitRef, agent: mode === 'assignment' && env.EZIL_STAGING_QA_AGENT === '1' };
}

/** One independently captured, recent observation must bind the QA computer to the expected runtime. */
export function runtimeMatches(receipt, expected, now = Date.now()) {
    if (!receipt || typeof receipt.runtimeId !== 'string' || !runtimeId.test(receipt.runtimeId) ||
        typeof receipt.observedAt !== 'string' || !receipt.observedAt.endsWith('Z')) return false;
    const observed = Date.parse(receipt.observedAt);
    return Number.isFinite(observed) && observed <= now && now - observed <= 60_000 &&
        observed >= (expected.observedAfter ?? 0) && receipt.computerId === expected.computerId &&
        receipt.appSha === expected.appSha && receipt.imageDigest === expected.imageDigest &&
        receipt.workerVersion === expected.workerVersion;
}

async function readRuntime(config, env, phase) {
    const reader = env.EZIL_STAGING_QA_RUNTIME_READER;
    const { EZIL_STAGING_EXPECT_CODE_IMAGE: imageDigest, EZIL_STAGING_EXPECT_WORKER_VERSION: workerVersion,
        EZIL_STAGING_QA_COMPUTER_ID: computerId } = env;
    if (!reader || !isAbsolute(reader) || !digest.test(imageDigest ?? '') ||
        !uuid.test(workerVersion ?? '') || !uuid.test(computerId ?? '')) return null;
    try {
        const observedAfter = Date.now();
        const { stdout } = await command(reader, [phase], { timeout: 25_000, maxBuffer: 20_000 });
        const receipt = JSON.parse(stdout);
        const expected = { appSha: config.appSha, imageDigest, workerVersion, computerId, observedAfter };
        return runtimeMatches(receipt, expected) ? receipt : null;
    } catch { return null; }
}

async function signedOut(browser, config) {
    const repo = config.repo ?? signedOutFixture;
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(codeLink(repo).href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        const result = isAssignmentLogin(page.url(), repo) &&
            await page.getByRole('link', { name: /continue with ezil id/i }).isVisible();
        return [check('signed-out-assignment-link', result ? 'pass' : 'fail', 'EZiL ID sign-in and retained repository target')];
    } finally { await context.close(); }
}

export async function gitEvidence(config, run = command) {
    try {
        const { stdout } = await run('git', ['ls-remote', '--exit-code', '--refs', config.repo, config.gitRef], {
            timeout: 18_000, maxBuffer: 64_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        });
        const line = stdout.trim().split('\n').find(value => value.split('\t')[1] === config.gitRef);
        const observed = line?.split('\t')[0];
        const actual = fullSha.test(observed ?? '') ? observed : null;
        return [check('submitted-git-sha', actual === config.sha ? 'pass' : 'fail', { ref: config.gitRef, expected: config.sha, actual })];
    } catch (error) {
        const missing = error.code === 2;
        return [check('submitted-git-sha', missing ? 'fail' : 'blocked', {
            expected: config.sha, reason: missing ? 'submitted ref was absent' : 'private ref could not be read',
        })];
    }
}

async function authenticated(browser, config, env, directory) {
    if (!config.repo || !env.EZIL_STAGING_QA_STORAGE_STATE || !env.EZIL_STAGING_QA_EXPECTED_FILE) {
        return [check('authenticated-code', 'blocked', 'Requires a dedicated repo, authenticated EZiL ID storage state, and checkout marker file')];
    }
    const runtime = await readRuntime(config, env, 'before');
    if (!runtime) return [check('running-code-image', 'blocked', 'Requires a recent live identity observation for the QA computer')];
    const result = await runCodeJourney({ browser, target: STAGING, storageState: env.EZIL_STAGING_QA_STORAGE_STATE,
        repo: { url: config.repo, fixtureUrl: config.repo, computerId: runtime.computerId,
            expectedFile: env.EZIL_STAGING_QA_EXPECTED_FILE, expectedText: env.EZIL_STAGING_QA_EXPECTED_TEXT,
            allowAgent: config.agent, modelName: env.EZIL_STAGING_QA_MODEL }, evidence: { directory } });
    const after = await readRuntime(config, env, 'after');
    const detail = ({ imageDigest, workerVersion, observedAt }) => ({ imageDigest, workerVersion, observedAt });
    const validAfter = after && after.runtimeId === runtime.runtimeId && Date.parse(after.observedAt) > Date.parse(runtime.observedAt);
    return [check('running-code-image-before', 'pass', detail(runtime)), ...result.checks,
        check('running-code-image-after', validAfter ? 'pass' : 'blocked', validAfter ? detail(after) : 'Running fixture identity could not be confirmed again')];
}

/** The lead gates independent evidence lanes on the live SHA and rechecks it after they finish. */
export async function collectEvidence(config, { fetcher = fetch, runLanes }) {
    const report = { version: 1, target: STAGING, mode: config.mode, startedAt: observedAt(), checks: [] };
    report.checks.push(...await verifyRelease(config, 'before', fetcher));
    if (report.checks.every(item => item.status === 'pass')) {
        let lanes;
        try { lanes = await runLanes(); }
        catch { lanes = [check('browser-and-git', 'fail', 'Evidence collection ended unexpectedly')]; }
        const required = ['signed-out-assignment-link'];
        if (config.mode === 'assignment' && !lanes.some(item => item.name === 'authenticated-code' || item.name === 'running-code-image')) {
            required.push('running-code-image-before', 'authenticated_isolated_computer', 'private_repo_checkout',
                'code_full_reload', 'running-code-image-after');
            if (config.agent) required.push('code_background_agent');
        }
        if (config.gitRef) required.push('submitted-git-sha');
        if (required.some(name => !lanes.some(item => item.name === name && item.status !== 'skip'))) {
            lanes.push(check('required-lane-evidence', 'blocked', 'One or more selected checks did not produce evidence'));
        }
        report.checks.push(...lanes, ...await verifyRelease(config, 'after', fetcher));
    } else {
        report.checks.push(check('browser-and-git', 'blocked', 'Expected deployment identity did not match'));
    }
    report.completedAt = observedAt();
    report.status = report.checks.some(item => item.status === 'fail') ? 'fail'
        : report.checks.some(item => item.status === 'blocked') ? 'blocked' : 'pass';
    return report;
}

async function browserLanes(config, env, directory) {
    const require = createRequire(join(env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'resolver.cjs'));
    let browser;
    try {
        const { chromium } = require('playwright');
        const proxyValue = env.https_proxy || env.HTTPS_PROXY;
        const proxy = proxyValue ? new URL(proxyValue) : null;
        browser = await chromium.launch({ headless: true,
            ...(proxy ? { proxy: { server: proxy.origin, bypass: env.no_proxy || env.NO_PROXY,
                username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } } : {}),
            ...(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
                : config.agent ? { channel: 'chromium' } : {}) });
        const tasks = [['signed-out-assignment-link', signedOut(browser, config)]];
        if (config.mode === 'assignment') tasks.push(['authenticated-code', authenticated(browser, config, env, directory)]);
        const results = await Promise.allSettled(tasks.map(([, task]) => task));
        return results.flatMap((result, index) => result.status === 'fulfilled' ? result.value
            : [check(tasks[index][0], 'fail', 'Lane failed before producing evidence')]);
    } catch { return [check('playwright', 'blocked', 'Playwright Chromium unavailable')]; }
    finally { await browser?.close(); }
}

async function allLanes(config, env, out) {
    const git = config.gitRef ? gitEvidence(config) : config.mode === 'assignment'
        ? [check('submitted-git-sha', 'skip', 'No submitted SHA and branch selected')] : [];
    const [browser, refs] = await Promise.all([browserLanes(config, env, out), git]);
    return [...browser, ...refs];
}

async function main(env = process.env) {
    const config = configFrom(env);
    if (env.https_proxy || env.HTTPS_PROXY) http.setGlobalProxyFromEnv?.();
    const directory = env.EZIL_STAGING_EVIDENCE_OUT ? resolve(env.EZIL_STAGING_EVIDENCE_OUT) : null;
    const out = directory ?? await mkdtemp(join(tmpdir(), 'ezil-staging-evidence-'));
    if (directory) await mkdir(out, { mode: 0o700 });
    const report = await collectEvidence(config, { runLanes: () => allLanes(config, env, out) });
    const body = JSON.stringify(report, null, 2) + '\n';
    await writeFile(join(out, 'evidence.json'), body, { mode: 0o600, flag: 'wx' });
    process.stdout.write(body);
    process.exitCode = report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(() => {
        process.stderr.write('Invalid staging evidence inputs or unavailable output directory. See e2e/README.md.\n');
        process.exitCode = 2;
    });
}
