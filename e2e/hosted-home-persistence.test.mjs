// Offline: no browser, no network, no hosted computer. Step scripts that only
// need bash/coreutils run for real against a temporary HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHmac } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  assertStagingTarget, TargetRefused, PRODUCTION_HOSTS, assertRunId, newRunId, newNonce, runPaths, checksumTargets,
  stepCommand, stepLines, stepPlan, chunkAcked, MAX_TYPED_LINE, readMarker, parseFields, probeScript, parseProbe, checksumScript, parseChecksums, compareChecksums,
  opencodeInstallScript, parseOpencodeInstall, opencodeCheckScript, hangDiagnosticScript, restoreFactsScript, projectScript, depsWaitScript, parseDepsStatus, parseDepsWait,
  depsWaitOutcome, projectDepsState, devServerScript, parseDevServer, cleanupPlan, cleanupScript, parseCleanup,
  EVIDENCE_FILE, clampWait, RUN_BUDGET_MS, CLEANUP_RESERVE_MS, POWER_CUT_RPO_MS, powerCutAfterRpo,
  AcceptanceFailure, FAILURE_CODES, OPENCODE_VERSION, OPENCODE_INSTALLER_URL, OPENCODE_INSTALL_FAILURES, publicFailureLine, assertAppOrigin,
} from './hosted-home-persistence.mjs';

const script = fileURLToPath(new URL('./hosted-home-persistence.mjs', import.meta.url));
const refusedCode = env => { try { assertStagingTarget(env); return null; } catch (error) { assert.ok(error instanceof TargetRefused); return error.code; } };

test('power cut waits for the 90 s RPO and uses the signed acceptance fault without a duration', async () => {
  assert.equal(POWER_CUT_RPO_MS, 90000);
  for (const age of [0, 37000, 90000, 120000]) {
    const lastWriteFinishedAt = 1_000_000;
    let clock = lastWriteFinishedAt + age, calls = 0, waited = 0;
    const evidence = {};
    const sandboxId = 'guac-abcdef0123456789-fedcba9876543210';
    await powerCutAfterRpo({ sandboxId, worker: 'https://worker.example.invalid/', secret: 'offline-test-secret',
      lastWriteFinishedAt, evidence, now: () => clock,
      wait: async ms => {
        assert.equal(calls, 0);
        assert.equal(evidence.operation, 'power cut RPO wait');
        assert.ok(ms > 0 && ms <= 1000);
        // Early timer wakeups must not shorten the guarantee.
        const elapsed = Math.min(ms, 500); clock += elapsed; waited += elapsed;
      },
      fetchImpl: async (url, options) => {
        calls++;
        assert.ok(clock - lastWriteFinishedAt >= 90000);
        assert.equal(evidence.operation, 'power cut');
        assert.equal(url, `https://worker.example.invalid/sandbox/${sandboxId}/acceptance-fault`);
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { fault: 'power_cut' });
        const signature = createHmac('sha256', 'offline-test-secret').update(`${clock}.POST./sandbox/preview.`).digest('hex');
        assert.equal(options.headers.authorization, `Bearer t=${clock},v1=${signature}`);
        assert.equal(options.headers['content-type'], 'application/json');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        return { status: 200, json: async () => ({ ok: true }) };
      },
    });
    assert.equal(calls, 1);
    assert.equal(waited, Math.max(0, 90000 - age));
    assert.deepEqual(evidence.powerCut, { writeAgeMs: Math.max(age, 90000), httpStatus: 200, ok: true });
    assert.ok(!JSON.stringify(evidence).includes('offline-test-secret'));
  }
});

test('power cut refuses failed HTTP/acknowledgment and never fires if its wait fails', async () => {
  const options = { sandboxId: 'guac-test-computer', worker: 'https://worker.example.invalid', secret: 'test',
    lastWriteFinishedAt: 0, now: () => 90000, evidence: {}, wait: async () => {} };
  for (const response of [{ status: 404, json: async () => ({ ok: true }) }, { status: 200, json: async () => ({ ok: false }) }]) {
    await assert.rejects(powerCutAfterRpo({ ...options, evidence: {}, fetchImpl: async () => response }), /power_cut_unconfirmed/);
  }
  let called = false;
  await assert.rejects(powerCutAfterRpo({ ...options, now: () => 0,
    wait: async () => { throw new Error('budget exhausted'); },
    fetchImpl: async () => { called = true; },
  }), /budget exhausted/);
  assert.equal(called, false);
});

test('runStep retries terminal read errors while waiting for the result marker', async () => {
  const source = readFileSync(script, 'utf8');
  const runStepSource = source.match(/  const runStep = async \(name, body, timeoutMs\) => \{[\s\S]*?\n  \};/)[0];
  let reads = 0, enters = 0;
  const nonce = 'a'.repeat(24);
  const context = { evidence: {}, stepInFlight: false, newNonce: () => nonce, stepCommand, stepLines, stepPlan, chunkAcked, readMarker, parseFields, wait: async () => {},
    terminalInput: () => ({ pressSequentially: async () => {}, press: async key => { assert.equal(key, 'Enter'); enters++; } }),
    terminalText: async () => { reads++; if (reads === 1) throw new Error('transient detached terminal'); return `EZQ:${nonce}:x=1:END`; },
    bounded: async (_name, action) => { const first = await action(); return first ?? action(); },
  };
  const runStep = runInNewContext(`${runStepSource}\nrunStep`, context);
  assert.deepEqual(await runStep('probe', 'emit "x=1"', 1000), { x: '1' });
  assert.equal(reads, 2);
  assert.equal(enters, 1);
  assert.equal(context.stepInFlight, false);
});

test('failure evidence retains the fixed failing operation when cleanup overwrites operation', () => {
  const source = readFileSync(script, 'utf8');
  const catchBody = source.match(/  \} catch \(error\) \{\n    \/\/ Driver messages[\s\S]*?\n  \} finally \{/)[0]
    .replace(/^  \} catch \(error\) \{/, '').replace(/\n  \} finally \{$/, '');
  const evidence = { operation: 'step next project typed', phases: [{ name: 'Code terminal ready' }] };
  const printed = [];
  runInNewContext(catchBody, { evidence, error: new Error('private driver details'), AcceptanceFailure, FAILURE_CODES, publicFailureLine,
    console: { error() {}, log: line => printed.push(line) }, process: {} });
  evidence.operation = 'step cleanup result';
  assert.equal(evidence.failedOperation, 'step next project typed');
  assert.equal(evidence.failedPhase, 'Code terminal ready');
  assert.ok(!JSON.stringify(evidence).includes('private driver details'));
  assert.deepEqual(printed, ['FAIL-DETAIL hosted HOME persistence: code=none; phase=Code terminal ready; operation=step next project typed; error=Error; install_fail=none; install_before=none; missing=none']);
});

test('hosted flow cuts power between checksum samples and retains graceful stop only for cleanup', () => {
  const source = readFileSync(script, 'utf8');
  const flow = source.slice(source.indexOf("const before = parseChecksums(await runStep('checksums before'"),
    source.indexOf("const after = parseChecksums(await runStep('checksums after'"));
  assert.match(flow, /const lastWriteFinishedAt = Date\.now\(\)/);
  assert.match(flow, /await powerCutAfterRpo\(\{ sandboxId, worker, secret, lastWriteFinishedAt, evidence/);
  assert.ok(flow.indexOf('await powerCutAfterRpo') < flow.indexOf("await close('code')"));
  assert.ok(flow.indexOf('await powerCutAfterRpo') < flow.indexOf('await openTerminal()'));
  assert.ok(!flow.includes('/api/shell/stop'));
  assert.equal(source.match(/await stopIsolatedComputer\(/g).length, 1);
});

test('target guard refuses production hosts, any *.ezil.org and a missing target', () => {
  for (const host of PRODUCTION_HOSTS) assert.equal(refusedCode({ EZIL_E2E_APP: `https://${host}` }), 'production_target');
  for (const app of ['https://OS.EZIL.ORG', 'https://os.ezil.org.', 'https://os.ezil.org/', 'https://staging.ezil.org',
    'https://api-desktop.ezil.org', 'https://ezil.org', 'https://a.b.ezil.org:8443', 'http://os.ezil.org', 'https://ezil-os.vercel.app.']) {
    assert.equal(refusedCode({ EZIL_E2E_APP: app }), 'production_target', app);
  }
  assert.equal(refusedCode({}), 'missing_target');
  assert.equal(refusedCode({ EZIL_E2E_APP: '' }), 'missing_target');
  assert.equal(refusedCode({ EZIL_E2E_APP: '   ' }), 'missing_target');
  assert.equal(refusedCode({ EZIL_E2E_APP: 'not a url' }), 'invalid_target');
  assert.equal(refusedCode({ EZIL_E2E_APP: 'http://preview.example.vercel.app' }), 'https_required');
  assert.equal(refusedCode({ EZIL_E2E_APP: 'http://localhost:3000' }), 'https_required');
  assert.equal(refusedCode({ EZIL_E2E_APP: 'https://user:pw@ezil-os-abc123-ezil.vercel.app' }), 'invalid_target');
});

test('target guard accepts a staging preview origin, including look-alikes of production', () => {
  assert.equal(assertStagingTarget({ EZIL_E2E_APP: 'https://ezil-os-abc123-ezil.vercel.app' }), 'https://ezil-os-abc123-ezil.vercel.app');
  assert.equal(assertStagingTarget({ EZIL_E2E_APP: 'https://preview-test.vercel.app/' }), 'https://preview-test.vercel.app');
  // Suffix match is on a label boundary, not a substring.
  assert.equal(assertStagingTarget({ EZIL_E2E_APP: 'https://notezil.org' }), 'https://notezil.org');
});

function runScript(env, cwd) {
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME, ...env };
  return spawnSync(process.execPath, [script], { cwd, env: clean, encoding: 'utf8', timeout: 20000 });
}

test('the script refuses production before any browser prerequisite and writes refusal evidence', () => {
  for (const [app, code] of [['https://os.ezil.org', 'production_target'], ['https://ezil-os-ezil.vercel.app', 'production_target'], [undefined, 'missing_target']]) {
    const cwd = mkdtempSync(join(tmpdir(), 'ezq-guard-'));
    try {
      // Every other prerequisite is present except Playwright, so a guard that
      // ran late would fail on PLAYWRIGHT_REQUIRE_DIR or a browser launch instead.
      const env = { EZIL_E2E_COMPUTER_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', EZIL_E2E_EMAIL: 'e2e@example.invalid', EZIL_E2E_PASSWORD: 'do-not-print-pw' };
      if (app) env.EZIL_E2E_APP = app;
      const result = runScript(env, cwd);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /REFUSED hosted HOME persistence/);
      for (const text of [result.stdout, result.stderr, readFileSync(join(cwd, EVIDENCE_FILE), 'utf8')]) {
        assert.ok(!text.includes('do-not-print-pw'));
        assert.ok(!text.includes('aaaaaaaa-aaaa'));
      }
      const evidence = JSON.parse(readFileSync(join(cwd, EVIDENCE_FILE), 'utf8'));
      assert.equal(evidence.ok, false);
      assert.equal(evidence.refused, code);
      assert.equal(evidence.errorType, 'TargetRefused');
      assert.equal(evidence.missingPrerequisite, undefined);
      assert.equal('runId' in evidence, false);
      assert.equal('cleanupStopped' in evidence, false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
});

test('a staging target still names a missing prerequisite before any cloud access', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ezq-prereq-'));
  try {
    const result = runScript({ EZIL_E2E_APP: 'https://ezil-os-abc123-ezil.vercel.app' }, cwd);
    assert.equal(result.status, 1);
    const evidence = JSON.parse(readFileSync(join(cwd, EVIDENCE_FILE), 'utf8'));
    assert.equal(evidence.refused, undefined);
    assert.equal(evidence.missingPrerequisite, 'EZIL_E2E_COMPUTER_ID');
    assert.equal(evidence.failedPhase, 'setup');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('run ids and nonces are validated before any interpolation into shell', () => {
  const id = newRunId();
  assert.match(id, /^[a-f0-9]{12}$/);
  assert.match(newNonce(), /^[a-f0-9]{24}$/);
  for (const bad of ['', 'ABCDEF123456', 'abc', '0123456789abc', '012345678a; rm', '../../etc/x', null, 12]) {
    assert.throws(() => assertRunId(bad), /Invalid run id/);
    assert.throws(() => runPaths(bad), /Invalid run id/);
    assert.throws(() => probeScript(bad));
    assert.throws(() => cleanupPlan({ runId: bad }));
  }
  assert.throws(() => stepCommand('nonce; rm -rf /', 'true'), /Invalid step nonce/);
  assert.throws(() => depsWaitScript(id, 0));
  assert.throws(() => depsWaitScript(id, 1.5));
  assert.throws(() => devServerScript(id, -1));
  const p = runPaths('0123456789ab');
  assert.equal(p.project, 'ezq-home-0123456789ab');
  assert.equal(p.note, 'ezq-note-0123456789ab.md');
  assert.equal(p.configDir, '.config/ezq-0123456789ab');
  assert.deepEqual(checksumTargets('0123456789ab').map(([label]) => label), ['opencode', 'bashrc', 'note', 'config', 'package', 'lock', 'page']);
});

test('the typed command never contains its own result marker and decodes to the step script', () => {
  const nonce = newNonce();
  const line = stepCommand(nonce, 'emit "x=1"');
  assert.ok(!line.includes('EZQ'));
  assert.ok(!line.includes(nonce));
  assert.ok(!/[\n!`']/.test(line), 'single line, no history expansion or quoting hazards');
  const encoded = line.match(/^bash -c "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d \| gzip -dc\)"$/)[1];
  const decoded = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
  assert.ok(decoded.includes(`N=${nonce}`));
  assert.ok(decoded.includes('emit "x=1"'));
  assert.equal(readMarker(line, nonce), null);
});

test('marker reader joins soft-wrapped rows, ignores other nonces and keeps the latest result', () => {
  const nonce = 'a'.repeat(24), other = 'b'.repeat(24);
  const text = `$ bash -c "..."\nEZQ:${other}:x=9:END\nEZQ:${nonce}:x=1,y=2:END\nEZQ:${nonce}:x=3`;
  assert.equal(readMarker(text, nonce), 'x=1,y=2');
  const wrapped = `EZQ:${nonce}:digest=${'c'.repeat(40)}\n${'c'.repeat(24)},s_a=MISS\nING:END\n$ `;
  assert.equal(readMarker(wrapped, nonce), `digest=${'c'.repeat(64)},s_a=MISSING`);
  assert.equal(readMarker(`EZQ:${nonce}:x=1:EN`, nonce), null, 'an incomplete line is not a result');
  assert.equal(readMarker(`EZQ:${nonce}:x=1:END EZQ:${nonce}:x=2:END`, nonce), 'x=2');
  assert.equal(readMarker('', nonce), null);
  assert.throws(() => readMarker('x', 'bad'), /Invalid step nonce/);
});

test('field parser keeps base64 padding and rejects malformed or duplicate keys', () => {
  assert.deepEqual(parseFields('a=1,b=YWI=,c='), { a: '1', b: 'YWI=', c: '' });
  assert.throws(() => parseFields('a=1,a=2'), /Duplicate/);
  assert.throws(() => parseFields('=1'), /Malformed/);
  assert.throws(() => parseFields('A=1'), /key/);
  assert.throws(() => parseFields(null), /Missing step result/);
});

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'ezq-home-test-'));
  const runId = newRunId();
  try { return fn(home, runId); } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(`/tmp/ezq-${runId}`, { recursive: true, force: true });
    rmSync(`/tmp/ezq-alive-${runId}`, { force: true });
  }
}
function step(home, body) {
  const nonce = newNonce();
  const result = spawnSync('bash', ['-c', stepCommand(nonce, body)], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const payload = readMarker(result.stdout, nonce);
  assert.ok(payload !== null, `no marker in: ${result.stdout}`);
  return parseFields(payload);
}
function seedHome(home, runId) {
  const p = runPaths(runId);
  mkdirSync(join(home, '.opencode/bin'), { recursive: true });
  writeFileSync(join(home, '.opencode/bin/opencode'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  writeFileSync(join(home, '.bashrc'), '# user rc\nexport PATH=/root/.opencode/bin:$PATH\n');
  writeFileSync(join(home, p.note), 'note\n');
  mkdirSync(join(home, p.configDir), { recursive: true });
  writeFileSync(join(home, p.config), '{}\n');
  mkdirSync(join(home, p.project, 'app'), { recursive: true });
  writeFileSync(join(home, p.project, 'package.json'), '{"name":"x"}\n');
  writeFileSync(join(home, p.project, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(home, p.project, 'app/page.js'), `export default () => '${p.marker}';\n`);
}

test('checksum step runs for real: identical files compare equal, a changed or lost file is named', () => withHome((home, runId) => {
  seedHome(home, runId);
  const before = parseChecksums(step(home, checksumScript(runId, { sentinel: 'write' })), runId);
  assert.equal(before.sentinelPresent, true);
  assert.ok(Object.values(before.prefixes).every(v => /^[a-f0-9]{16}$/.test(v)));
  const same = parseChecksums(step(home, checksumScript(runId, { sentinel: 'check' })), runId);
  assert.equal(same.sentinelPresent, true, 'same container keeps its /tmp sentinel');
  assert.deepEqual(compareChecksums(before, same), { identical: true, digestEqual: true, differing: [], missingBefore: [], missingAfter: [] });

  // A replaced container: no /tmp sentinel; the lockfile rewritten, the note lost.
  rmSync(`/tmp/ezq-alive-${runId}`);
  appendFileSync(join(home, runPaths(runId).project, 'package-lock.json'), '\n');
  rmSync(join(home, runPaths(runId).note));
  const after = parseChecksums(step(home, checksumScript(runId, { sentinel: 'check' })), runId);
  assert.equal(after.sentinelPresent, false);
  const diff = compareChecksums(before, after);
  assert.equal(diff.identical, false);
  assert.equal(diff.digestEqual, false);
  assert.deepEqual(diff.differing, ['note', 'lock']);
  assert.deepEqual(diff.missingAfter, ['note']);
}));

test('checksum comparison never passes when both sides are missing the same file', () => {
  const prefixes = { opencode: 'MISSING', bashrc: 'a'.repeat(16) };
  const side = { digest: 'd'.repeat(64), prefixes };
  const result = compareChecksums(side, { ...side, prefixes: { ...prefixes } });
  assert.equal(result.digestEqual, true);
  assert.equal(result.identical, false);
  assert.deepEqual(result.missingBefore, ['opencode']);
  // Equal 16-hex prefixes do not decide equality; the full-manifest digest does.
  const full = { digest: 'd'.repeat(64), prefixes: { bashrc: 'a'.repeat(16) } };
  assert.equal(compareChecksums(full, { ...full, digest: 'e'.repeat(64) }).identical, false);
  assert.equal(compareChecksums(full, { ...full }).identical, true);
});

test('checksum parser rejects a truncated or forged result', () => {
  const runId = '0123456789ab';
  const good = { digest: 'a'.repeat(64), boot: 'b'.repeat(16), alive: '1' };
  for (const [label] of checksumTargets(runId)) good[`s_${label}`] = 'c'.repeat(16);
  assert.equal(parseChecksums(good, runId).sentinelPresent, true);
  assert.throws(() => parseChecksums({ ...good, digest: 'xyz' }, runId), /digest/);
  const { s_lock, ...withoutLock } = good;
  assert.throws(() => parseChecksums(withoutLock, runId), /lock/);
  assert.throws(() => parseChecksums({ ...good, s_page: 'c'.repeat(15) }, runId), /page/);
  assert.throws(() => parseChecksums({ ...good, alive: '' }, runId), /alive/);
});

test('ezil-deps status parsing follows the pinned contract', () => {
  const text = 'scanning\npending\t/root/a\nrestoring\t/root/ezq-home-0123456789ab\nready\t/home/u/b\nfailed\t/root/c\nmissing\t/root/d\n';
  const status = parseDepsStatus(text);
  assert.equal(status.scanning, true);
  assert.deepEqual(status.entries.map(e => e.state), ['pending', 'restoring', 'ready', 'failed', 'missing']);
  assert.equal(projectDepsState(status, '/root/ezq-home-0123456789ab'), 'restoring');
  assert.equal(projectDepsState(parseDepsStatus('ready\t/root/ezq-home-0123456789ab/\n'), '/root/ezq-home-0123456789ab'), 'ready');
  assert.equal(projectDepsState(status, '/root/other'), null);
  assert.deepEqual(parseDepsStatus(''), { scanning: false, entries: [] });
  assert.throws(() => parseDepsStatus('done\t/root/a'), /Unknown ezil-deps state/);
  assert.throws(() => parseDepsStatus('ready /root/a'), /Malformed/);
  assert.throws(() => parseDepsStatus('ready\trelative'), /Malformed/);
});

test('ezil-deps wait exit codes map to named outcomes', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(depsWaitOutcome), ['ready', 'failed', 'timeout', 'untracked', 'missing']);
  assert.equal(depsWaitOutcome(124), 'harness_timeout');
  assert.equal(depsWaitOutcome(127), 'not_installed');
  assert.equal(depsWaitOutcome(9), 'unexpected_exit');
  const dir = '/root/ezq-home-0123456789ab';
  const b64 = s => Buffer.from(s).toString('base64');
  const parsed = parseDepsWait({ present: '1', nm: '0', rc: '0', nextbin: '1', before: b64(`scanning\nrestoring\t${dir}\n`), after: b64(`ready\t${dir}\n`) }, dir);
  assert.deepEqual(parsed, { installed: true, nodeModulesAtReopen: false, nextBinary: true, exitCode: 0, outcome: 'ready',
    statusBefore: { scanning: true, state: 'restoring' }, statusAfter: { scanning: false, state: 'ready' } });
  assert.equal(parseDepsWait({ present: '1', nm: '0', rc: '4', nextbin: '0', before: '', after: '' }, dir).outcome, 'missing');
  assert.throws(() => parseDepsWait({ present: '1', nm: '0', rc: '', nextbin: '0', before: '', after: '' }, dir), /rc/);
  // Captured status outside the pinned contract never masks the asserted exit code.
  const odd = parseDepsWait({ present: '1', nm: '1', rc: '1', nextbin: '0', before: b64('restoring /root/x\n'), after: b64(`done\t${dir}\n`) }, dir);
  assert.equal(odd.outcome, 'failed');
  assert.deepEqual(odd.statusBefore, { scanning: null, state: 'unrecognized' });
  assert.deepEqual(odd.statusAfter, { scanning: null, state: 'unrecognized' });
});

test('deps and dev steps use the pinned tool path, a lockfile-restoring wait and a free port', () => {
  const id = '0123456789ab';
  const deps = depsWaitScript(id, 600);
  assert.ok(deps.includes('D=/usr/local/bin/ezil-deps'));
  assert.ok(deps.includes('"$D" wait "$P" --timeout 600'));
  assert.ok(deps.includes('P="$H/ezq-home-0123456789ab"'));
  const dev = devServerScript(id, 300);
  assert.ok(dev.includes('npm run dev -- --port "$port"'));
  assert.ok(dev.includes("grep -qF 'ezq-marker-0123456789ab'"));
  assert.ok(dev.includes("'^EZiL: restoring dependencies for '"));
  assert.ok(dev.includes('kill -TERM -- "-$pid"'));
  const parsed = parseDevServer({ port: '41234', http: '200', marker: '1', notfound: '0', restoring: '0', ready: '0', exited: '0' });
  assert.equal(parsed.httpStatus, 200);
  assert.equal(parsed.marker, true);
  assert.equal(parseDevServer({ port: '0', http: '000', marker: '0', notfound: '1', restoring: '0', ready: '0', exited: '1' }).nextNotFound, true);
  assert.throws(() => parseDevServer({ port: '1', http: '', marker: '0', notfound: '0', restoring: '0', ready: '0', exited: '0' }), /http/);
  const project = projectScript(id);
  assert.ok(project.includes('npm install --no-audit --no-fund next react react-dom'));
  assert.ok(project.includes('<main>ezq-marker-0123456789ab</main>'));
  const install = opencodeInstallScript(id);
  assert.ok(!/\|\s*bash/.test(install), 'never pipe the installer into bash: a failed fetch exits 0');
  assert.ok(install.includes(`'${OPENCODE_INSTALLER_URL}'`) && install.includes(`V=${OPENCODE_VERSION}`));
  assert.ok(install.includes('bash "$I" --version "$V"'), 'the official installer runs from a file, pinned');
  // Worst case stays inside the step's 660 s runStep budget, so a slow install reports its own class.
  const budget = 3 * Number(install.match(/--max-time (\d+)/)[1]) + 2 * 5 + Number(install.match(/timeout (\d+) bash "\$I"/)[1])
    + Number(install.match(/got=\$\(timeout (\d+) /)[1]);
  assert.ok(budget <= 650, `install step worst case ${budget}s`);
  const flow = readFileSync(script, 'utf8');
  assert.match(flow, /runStep\('opencode install', opencodeInstallScript\(runId\), 660000\)/);
});

// A stand-in for the official installer's contract (opencode.ai/install, read 2026-10-12):
// `--version V` skips the api.github.com latest lookup; `opencode` on PATH at V exits 0
// ("already installed"); otherwise it installs V into ~/.opencode/bin and adds a PATH line.
function fakeInstaller(dir, body = '') {
  const file = join(dir, 'install.sh');
  writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
v=""; while [ $# -gt 0 ]; do case "$1" in --version) v="$2"; shift 2;; *) shift;; esac; done
[ -n "$v" ] || { echo "Failed to fetch version information"; exit 1; }
${body}
if command -v opencode >/dev/null 2>&1 && [ "$(opencode --version 2>/dev/null)" = "$v" ]; then echo "Version $v already installed"; exit 0; fi
mkdir -p "$HOME/.opencode/bin"
printf '#!/bin/sh\necho %s\n' "$v" > "$HOME/.opencode/bin/opencode"; chmod 755 "$HOME/.opencode/bin/opencode"
printf '\n# opencode\nexport PATH=%s/.opencode/bin:$PATH\n' "$HOME" >> "$HOME/.bashrc"
`, { mode: 0o755 });
  return `file://${file}`;
}
function installStep(home, runId, options, env = {}) {
  const nonce = newNonce();
  const result = spawnSync('bash', ['-c', stepCommand(nonce, opencodeInstallScript(runId, { retryDelaySeconds: 0, ...options }))],
    { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const payload = readMarker(result.stdout, nonce);
  assert.ok(payload !== null, `no marker in: ${result.stdout}`);
  assert.ok(!/already installed|Failed to fetch|not found|Installing/.test(result.stdout), 'installer output never reaches the terminal');
  return parseOpencodeInstall(parseFields(payload));
}
const passes = install => install.exitCode === 0 && install.binary && install.versionMatches && install.failure === 'none';
function seedOpencode(home, version) {
  mkdirSync(join(home, '.opencode/bin'), { recursive: true });
  writeFileSync(join(home, '.opencode/bin/opencode'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
}

test('the pinned OpenCode version is one released constant and the installer URL is the official one', () => {
  assert.match(OPENCODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(OPENCODE_INSTALLER_URL, 'https://opencode.ai/install');
  assert.throws(() => opencodeInstallScript('0123456789ab', { version: '1.0; rm -rf ~' }), /Invalid OpenCode version/);
  assert.throws(() => opencodeInstallScript('0123456789ab', { installerUrl: "https://evil.example/x' ;id;'" }), /Invalid installer URL/);
});

test('a failed installer fetch FAILS even when a usable OpenCode already exists', () => withHome((home, runId) => {
  seedOpencode(home, OPENCODE_VERSION);
  const install = installStep(home, runId, { installerUrl: `file://${home}/missing-installer.sh` });
  assert.equal(install.before, true);
  assert.equal(install.failure, 'installer_fetch');
  assert.notEqual(install.exitCode, 0);
  assert.equal(passes(install), false);
}));

test('an empty installer download is a fetch failure, never a silent success', () => withHome((home, runId) => {
  seedOpencode(home, '1.0.0');
  writeFileSync(join(home, 'empty.sh'), '');
  const install = installStep(home, runId, { installerUrl: `file://${home}/empty.sh` });
  assert.equal(install.failure, 'installer_fetch');
  assert.equal(passes(install), false);
}));

test('fresh install of the pinned version passes and records the PATH line it added', () => withHome((home, runId) => {
  writeFileSync(join(home, '.bashrc'), '# mine\n');
  step(home, probeScript(runId));
  const install = installStep(home, runId, { installerUrl: fakeInstaller(home) });
  assert.deepEqual({ exitCode: install.exitCode, binary: install.binary, versionMatches: install.versionMatches, failure: install.failure, before: install.before },
    { exitCode: 0, binary: true, versionMatches: true, failure: 'none', before: false });
  assert.deepEqual(install.addedRcLines, { bashrc: ['# opencode', `export PATH=${home}/.opencode/bin:$PATH`] });
}));

test('rerun with the pinned version already installed passes deterministically and changes nothing', () => withHome((home, runId) => {
  const url = fakeInstaller(home);
  seedOpencode(home, OPENCODE_VERSION);
  writeFileSync(join(home, '.bashrc'), `export PATH=${home}/.opencode/bin:$PATH\n`);
  const env = { PATH: `${home}/.opencode/bin:${process.env.PATH}` };
  const bytes = readFileSync(join(home, '.opencode/bin/opencode'));
  for (let i = 0; i < 2; i++) {
    const install = installStep(home, runId, { installerUrl: url }, env);
    assert.ok(passes(install), JSON.stringify(install));
    assert.equal(install.before, true);
  }
  assert.deepEqual(readFileSync(join(home, '.opencode/bin/opencode')), bytes);
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), `export PATH=${home}/.opencode/bin:$PATH\n`);
}));

test('an older pre-existing OpenCode is upgraded to the pinned version, not accepted as is', () => withHome((home, runId) => {
  seedOpencode(home, '1.0.0');
  const install = installStep(home, runId, { installerUrl: fakeInstaller(home) }, { PATH: `${home}/.opencode/bin:${process.env.PATH}` });
  assert.ok(passes(install));
  assert.equal(install.before, true);
}));

test('installer exit 0 with another version on disk is version_mismatch, never a pass', () => withHome((home, runId) => {
  seedOpencode(home, '1.0.0');
  const install = installStep(home, runId, { installerUrl: fakeInstaller(home, 'exit 0') });
  assert.equal(install.exitCode, 0);
  assert.equal(install.failure, 'version_mismatch');
  assert.equal(passes(install), false);
}));

test('installer failures map to fixed classes found by grep, never raw text', () => withHome((home, runId) => {
  seedOpencode(home, '1.0.0');
  const cases = [
    ['echo "Failed to fetch version information ,evil=1"; exit 1', 'version_fetch'],
    ['echo "Error: Release v$v not found"; exit 1', 'release_missing'],
    ['echo "gzip: stdin: not in gzip format"; echo "tar: Child returned status 1"; exit 2', 'extract'],
    ['echo "curl: (6) Could not resolve host: github.com"; exit 6', 'download'],
    ['echo "something else entirely"; exit 3', 'other'],
  ];
  for (const [body, expected] of cases) {
    const install = installStep(home, runId, { installerUrl: fakeInstaller(home, body) });
    assert.equal(install.failure, expected, body);
    assert.ok(OPENCODE_INSTALL_FAILURES.includes(install.failure));
    assert.equal(passes(install), false);
  }
  const slow = installStep(home, runId, { installerUrl: fakeInstaller(home, 'sleep 20'), timeoutSeconds: 1 });
  assert.equal(slow.failure, 'timeout');
  assert.equal(passes(slow), false);
}));

test('install result parser refuses classes outside the allow-list', () => {
  const base = { rc: '0', bin: '1', ver: '1', before: '0' };
  assert.equal(parseOpencodeInstall({ ...base, fail: 'none' }).failure, 'none');
  assert.throws(() => parseOpencodeInstall({ ...base, fail: 'curl_said_hi' }), /Step result fail/);
  assert.throws(() => parseOpencodeInstall({ rc: '0', bin: '1', fail: 'none', before: '0' }), /Step result ver/);
});

test('probe runs for real: reports pre-existing OpenCode and snapshots rc files', () => withHome((home, runId) => {
  writeFileSync(join(home, '.bashrc'), '# mine\n');
  const fresh = parseProbe(step(home, probeScript(runId)));
  assert.equal(fresh.opencodeExisted, false);
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.homeIsRoot, false);
  assert.equal(readFileSync(`/tmp/ezq-${runId}/rc-before/bashrc`, 'utf8'), '# mine\n');
  seedHome(home, runId);
  const seeded = parseProbe(step(home, probeScript(runId)));
  assert.equal(seeded.opencodeExisted, true);
  assert.equal(seeded.fresh, false);
}));

test('install result exposes only opencode lines the installer added', () => {
  const b64 = s => Buffer.from(s).toString('base64');
  const ok = { rc: '0', bin: '1', ver: '1', fail: 'none', before: '0' };
  const parsed = parseOpencodeInstall({ ...ok, rc_bashrc: b64('\n# opencode\nexport PATH=/root/.opencode/bin:$PATH\n') });
  assert.deepEqual(parsed, { exitCode: 0, binary: true, versionMatches: true, failure: 'none', before: false,
    addedRcLines: { bashrc: ['# opencode', 'export PATH=/root/.opencode/bin:$PATH'] } });
  assert.throws(() => parseOpencodeInstall({ ...ok, rc_bashrc: b64('alias ls=rm\n') }), /Unexpected rc lines/);
});

test('cleanup plan removes ~/.opencode only when this run created it', () => {
  const runId = '0123456789ab';
  assert.equal(cleanupPlan({ runId, probe: { opencodeExisted: false } }).removeOpencode, true);
  assert.equal(cleanupPlan({ runId, probe: { opencodeExisted: true } }).removeOpencode, false);
  assert.equal(cleanupPlan({ runId, probe: null }).removeOpencode, false, 'unknown origin is kept');
  const plan = cleanupPlan({ runId, probe: { opencodeExisted: true }, install: { addedRcLines: { bashrc: ['# opencode', 'export PATH=x'] } } });
  assert.deepEqual(plan.rcLines, { bashrc: ['# opencode'] }, 'only opencode lines are ever removable');
  assert.equal(plan.rcFromSnapshot, false);
  assert.deepEqual(plan.removePaths, ['ezq-home-0123456789ab', 'ezq-note-0123456789ab.md', '.config/ezq-0123456789ab']);
  assert.ok(!cleanupScript(cleanupPlan({ runId, probe: { opencodeExisted: true }, install: { addedRcLines: {} } })).includes('.opencode"'));
  assert.throws(() => cleanupPlan({ runId, install: { addedRcLines: { evil: ['# opencode'] } } }), /Unknown rc label/);
});

test('cleanup runs for real: removes run files, created OpenCode and only the added rc lines', () => withHome((home, runId) => {
  writeFileSync(join(home, '.bashrc'), '# user rc\n# my own opencode alias\nalias oc=opencode\n');
  writeFileSync(join(home, '.profile'), 'export X=1\n');
  mkdirSync(join(home, '.config/keep'), { recursive: true });
  const probe = parseProbe(step(home, probeScript(runId)));
  // What the official installer does.
  seedHome(home, runId);
  writeFileSync(join(home, '.bashrc'), '# user rc\n# my own opencode alias\nalias oc=opencode\n\n# opencode\nexport PATH=/root/.opencode/bin:$PATH\n');
  const install = { addedRcLines: { bashrc: ['# opencode', 'export PATH=/root/.opencode/bin:$PATH'] } };
  const result = parseCleanup(step(home, cleanupScript(cleanupPlan({ runId, probe, install }))));
  assert.deepEqual(result, { pathsLeft: false, rcLinesLeft: false });
  assert.equal(existsSync(join(home, '.opencode')), false);
  const p = runPaths(runId);
  for (const path of [p.project, p.note, p.configDir]) assert.equal(existsSync(join(home, path)), false, path);
  assert.equal(existsSync(join(home, '.config/keep')), true);
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), '# user rc\n# my own opencode alias\nalias oc=opencode\n\n');
  assert.equal(readFileSync(join(home, '.profile'), 'utf8'), 'export X=1\n');
  assert.equal(existsSync(`/tmp/ezq-${runId}`), false);
}));

test('cleanup keeps a pre-existing OpenCode and every rc line when nothing was added', () => withHome((home, runId) => {
  seedHome(home, runId);
  const rc = readFileSync(join(home, '.bashrc'), 'utf8');
  const probe = parseProbe(step(home, probeScript(runId)));
  assert.equal(probe.opencodeExisted, true);
  // An empty drop list must not turn awk's first-file rule onto the rc file.
  const result = parseCleanup(step(home, cleanupScript(cleanupPlan({ runId, probe, install: { addedRcLines: {} } }))));
  assert.equal(result.pathsLeft, false);
  assert.equal(existsSync(join(home, '.opencode/bin/opencode')), true);
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), rc);
}));

test('interrupted install: cleanup diffs against the same-container snapshot, never without it', () => withHome((home, runId) => {
  writeFileSync(join(home, '.bashrc'), '# user rc\nexport PATH=/root/.opencode/bin:$PATH\n');
  writeFileSync(join(home, '.profile'), '# opencode was here before\nexport X=1\n');
  const probe = parseProbe(step(home, probeScript(runId)));
  appendFileSync(join(home, '.bashrc'), '# opencode\nexport PATH=/root/.opencode/bin:$PATH\n');
  writeFileSync(join(home, '.zshrc'), '# opencode\n');
  const plan = cleanupPlan({ runId, probe, install: null });
  assert.equal(plan.rcFromSnapshot, true);
  step(home, cleanupScript(plan));
  // The pre-existing PATH line is in the snapshot, so its duplicate counts as
  // not added; only the new comment goes. The zshrc did not exist before.
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), '# user rc\nexport PATH=/root/.opencode/bin:$PATH\nexport PATH=/root/.opencode/bin:$PATH\n');
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), '');
  // Nothing added to .profile: an empty drop list leaves it byte-identical.
  assert.equal(readFileSync(join(home, '.profile'), 'utf8'), '# opencode was here before\nexport X=1\n');

  // Another container: no snapshot directory, so nothing is attributed to this run.
  writeFileSync(join(home, '.bashrc'), '# opencode\n');
  rmSync(`/tmp/ezq-${runId}`, { recursive: true, force: true });
  mkdirSync(`/tmp/ezq-${runId}`); // later steps recreate the scratch dir, never its snapshot
  step(home, cleanupScript(plan));
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), '# opencode\n');
}));

test('the workflow runs this suite only in the staging job, never for manual previews or production', () => {
  const workflow = readFileSync(new URL('../.github/workflows/preview.yml', import.meta.url), 'utf8');
  assert.equal(workflow.split('node e2e/hosted-home-persistence.mjs').length - 1, 1);
  const preview = workflow.split('\n  preview:\n')[1].split('\n  images:\n')[0];
  const production = workflow.split('\n  production:\n')[1];
  assert.ok(!production.includes('hosted-home-persistence'));
  const stepText = preview.split('      - name: Hosted HOME persistence acceptance\n')[1].split('      - name:')[0];
  // Staging only, never manual previews; runs even if the continuity gate failed (never on cancel).
  assert.match(stepText, /if: \$\{\{ !cancelled\(\) && needs\.trust\.outputs\.manual_preview != 'true' \}\}/);
  assert.match(stepText, /EZIL_E2E_EMAIL: \$\{\{ secrets\.EZIL_E2E_EMAIL \}\}/);
  assert.ok(!/EZIL_E2E_APP:/.test(stepText), 'the target comes from the deployed preview URL only');
  assert.ok(preview.indexOf('run: node e2e/hosted-continuity.mjs') < preview.indexOf('run: node e2e/hosted-home-persistence.mjs'));
  const upload = preview.split('      - name: Upload hosted HOME persistence evidence\n')[1].split('      - name:')[0];
  assert.match(upload, /if: always\(\) && needs\.trust\.outputs\.manual_preview != 'true'/);
  assert.match(upload, /path: hosted-home-persistence-evidence\//);
});

test('cleanup stops a process still working inside the project before removing it', () => withHome((home, runId) => {
  seedHome(home, runId);
  const probe = { opencodeExisted: true };
  const outside = spawnSync('bash', ['-c', 'sleep 30 > /dev/null 2>&1 & echo $!'], { cwd: home, encoding: 'utf8' });
  const inside = spawnSync('bash', ['-c', 'sleep 30 > /dev/null 2>&1 & echo $!'], { cwd: join(home, runPaths(runId).project, 'app'), encoding: 'utf8' });
  const alive = pid => {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    // Linux: an unreaped zombie still answers kill(pid, 0); /proc tells it apart.
    // No /proc (macOS): kill(pid, 0) succeeding is the only signal, so it is alive.
    if (!existsSync('/proc/self')) return true;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat[stat.lastIndexOf(')') + 2] !== 'Z';
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const [outsidePid, insidePid] = [Number(outside.stdout.trim()), Number(inside.stdout.trim())];
  try {
    assert.ok(alive(insidePid) && alive(outsidePid));
    assert.equal(parseCleanup(step(home, cleanupScript(cleanupPlan({ runId, probe, install: { addedRcLines: {} } })))).pathsLeft, false);
    // SIGKILL is asynchronous, and kill(pid, 0) still succeeds for an unreaped zombie.
    const deadline = performance.now() + 2000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (alive(insidePid) && performance.now() < deadline) Atomics.wait(pause, 0, 0, 20);
    assert.equal(alive(insidePid), false, 'process inside the project survived cleanup');
    assert.equal(alive(outsidePid), true, 'cleanup killed a process outside this run');
  } finally { for (const pid of [outsidePid, insidePid]) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
}));

test('waits before cleanup end inside the CI step budget; cleanup itself is never capped', () => {
  assert.ok(RUN_BUDGET_MS + 7 * 60000 <= 45 * 60000, 'script budget leaves headroom inside timeout-minutes: 45');
  const workflow = readFileSync(new URL('../.github/workflows/preview.yml', import.meta.url), 'utf8');
  const stepText = workflow.split('      - name: Hosted HOME persistence acceptance\n')[1].split('      - name:')[0];
  assert.equal(Number(stepText.match(/timeout-minutes: (\d+)/)[1]) * 60000 >= RUN_BUDGET_MS + 5 * 60000, true);
  const started = 1_000_000;
  const workEnd = started + RUN_BUDGET_MS - CLEANUP_RESERVE_MS;
  assert.equal(clampWait(60000, { now: started, started }), 60000);
  assert.equal(clampWait(960000, { now: workEnd - 30000, started }), 30000);
  assert.equal(clampWait(60000, { now: workEnd, started }), 0);
  assert.equal(clampWait(60000, { now: workEnd + 1, started }), 0);
  assert.equal(clampWait(120000, { now: workEnd + 600000, started, cleanup: true }), 120000);
});

test('long steps are typed as short chunks that rebuild and run the same script', () => {
  const nonce = 'b'.repeat(24);
  const home = mkdtempSync(join(tmpdir(), 'ezq-chunk-'));
  // Incompressible payload, so the encoded step really exceeds one typed line.
  const noise = Array.from({ length: 1500 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join('').slice(0, 2000);
  const body = `# ${noise}\nemit "x=$(printf %s '${'y'.repeat(2000)}' | wc -c)"`;
  const lines = stepLines(nonce, body);
  assert.ok(lines.length > 2, 'a long step is chunked');
  for (const line of lines) assert.ok(line.length <= MAX_TYPED_LINE, `typed line ${line.length} > ${MAX_TYPED_LINE}`);
  const out = spawnSync('bash', ['-c', lines.join('\n')], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30000 });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(parseFields(readMarker(out.stdout, nonce)), { x: '2000' });
  assert.deepEqual(stepLines(nonce, 'emit "x=1"'), [stepCommand(nonce, 'emit "x=1"')]);
  rmSync(home, { recursive: true, force: true });
});

test('every real hosted step types only lines within the proven length', () => {
  const id = newRunId(), nonce = 'c'.repeat(24);
  for (const body of [probeScript(id), opencodeInstallScript(id), projectScript(id), checksumScript(id, { sentinel: 'write' })]) {
    for (const line of stepLines(nonce, body)) assert.ok(line.length <= MAX_TYPED_LINE);
  }
});

test('long steps upload acknowledged chunks; a lost chunk is retyped, never silently run', async () => {
  const source = readFileSync(script, 'utf8');
  const runStepSource = source.match(/  const runStep = async \(name, body, timeoutMs\) => \{[\s\S]*?\n  \};/)[0];
  const nonce = 'e'.repeat(24);
  const noise = Array.from({ length: 1500 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join('').slice(0, 2000);
  const body = `# ${noise}\nemit "x=1"`;
  const plan = stepPlan(nonce, body);
  assert.ok(plan.chunks.length >= 2);
  for (const c of plan.chunks) assert.ok(c.line.length <= MAX_TYPED_LINE);
  // The typed line's own echo never satisfies the ack.
  assert.equal(chunkAcked(plan.chunks[0].line, nonce, 0, plan.chunks[0].bytes), false);
  let screen = '', typed = [], ctrlC = 0, droppedOnce = false;
  const context = { evidence: {}, stepInFlight: false, newNonce: () => nonce, stepCommand, stepLines, stepPlan, chunkAcked, readMarker, parseFields, wait: async () => {},
    terminalInput: () => ({ pressSequentially: async v => { typed.push(v); }, press: async key => {
      if (key === 'Control+C') { ctrlC++; return; }
      const line = typed.at(-1);
      const c = plan.chunks.find(x => x.line === line);
      if (c && c.index === 1 && !droppedOnce) { droppedOnce = true; return; } // first try of chunk 1 is lost
      if (c) screen += `\nEZQC:${nonce}:${c.index}:${c.bytes}\n`;
      else if (line === plan.run) screen += `\nEZQ:${nonce}:x=1:END\n`;
    } }),
    terminalText: async () => screen,
    bounded: async (name, action) => { const r = await action(); if (r) return r; throw new Error(`${name}: deadline exceeded`); },
  };
  const runStep = runInNewContext(`${runStepSource}\nrunStep`, context);
  assert.deepEqual(await runStep('big', body, 1000), { x: '1' });
  assert.equal(ctrlC, 1);
  assert.equal(context.evidence.chunkRetries, 1);
  assert.equal(typed.filter(l => l === plan.chunks[1].line).length, 2);
  assert.equal(typed.at(-1), plan.run);
});

test('acknowledged chunks rebuild and run the same script in a real shell', () => {
  const nonce = 'f'.repeat(24);
  const home = mkdtempSync(join(tmpdir(), 'ezq-ack-'));
  const noise = Array.from({ length: 1500 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join('').slice(0, 2000);
  const plan = stepPlan(nonce, `# ${noise}\nemit "x=$(printf %s '${'y'.repeat(2000)}' | wc -c)"`);
  const out = spawnSync('bash', ['-c', [...plan.chunks.map(c => c.line), plan.run].join('\n')], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30000 });
  assert.equal(out.status, 0, out.stderr);
  for (const c of plan.chunks) assert.ok(chunkAcked(out.stdout, nonce, c.index, c.bytes), `chunk ${c.index} acked`);
  assert.deepEqual(parseFields(readMarker(out.stdout, nonce)), { x: '2000' });
  rmSync(home, { recursive: true, force: true });
});

test('interactive-shell checks run in their own session so they cannot seize the hosted terminal', () => {
  const body = opencodeCheckScript();
  assert.equal((body.match(/bash -ic/g) ?? []).length, (body.match(/setsid -w bash -ic/g) ?? []).length);
  assert.ok(/setsid -w bash -ic 'command -v opencode'/.test(body) && /setsid -w bash -ic 'opencode --version'/.test(body));
});

test('after the power cut the dead container\'s Code frame is never reused and Code gets a cold-boot budget', () => {
  const source = readFileSync(script, 'utf8');
  const cut = source.indexOf("phase('computer power cut without a final checkpoint')");
  const reopen = source.indexOf('await openTerminal();', cut);
  const between = source.slice(cut, reopen);
  assert.ok(cut > 0 && reopen > cut);
  assert.match(between, /retiredFrames\.add\(f\)/);
  assert.match(between, /commandReadyMs = 120000/);
  assert.match(source, /!frame\.isDetached\(\) && !retiredFrames\.has\(frame\)/);
  // Never a webview nested inside a Code frame.
  const pick = runInNewContext(`(() => { const retiredFrames = new Set(); ${source.match(/  const isCode = [^\n]+\n  const codeFrame = [^;]+;/)[0]}; return codeFrame; })()`,
    { page: { frames: () => frames } });
  const top = { url: () => 'https://8443-guac-a-b-t.code.example/?folder=/workspace', parentFrame: () => null, isDetached: () => false };
  top.url = () => 'https://8443-guac-a-b-t-code.example.org/?folder=/workspace';
  const webview = { url: () => 'https://8443-guac-a-b-t-code.example.org/stable/webview/index.html', parentFrame: () => top, isDetached: () => false };
  var frames = [top, webview];
  assert.equal(pick(), top);
  // A failed click is a retry, never an exception out of the readiness loop.
  const ready = source.slice(source.indexOf("await bounded('Code command ready'"), source.indexOf('}, commandReadyMs);'));
  assert.ok(ready.indexOf('try {') < ready.indexOf(".command-center').click"));
});

test('the hang diagnostic reports fixed process names and states, the load, and the stuck step\'s files', () => {
  const nonce = 'c'.repeat(24), stuck = 'd'.repeat(24);
  writeFileSync(`/tmp/ezq-step-${stuck}.000`, 'x');
  const sleeper = spawnSync('bash', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  try {
    const out = spawnSync('bash', ['-c', stepCommand(nonce, hangDiagnosticScript(stuck))], { encoding: 'utf8', timeout: 30000 });
    assert.equal(out.status, 0, out.stderr);
    const fields = parseFields(readMarker(out.stdout, nonce));
    assert.match(fields.procs, /sleep_S-\d+\./);
    assert.match(fields.load, /^[0-9.]+$/);
    assert.equal(fields.result, '0');
    assert.equal(fields.chunks, '1');
    assert.ok(!/\//.test(fields.procs), 'no paths');
  } finally {
    process.kill(Number(sleeper.stdout.trim()), 'SIGKILL');
    rmSync(`/tmp/ezq-step-${stuck}.000`, { force: true });
  }
});

test('restore facts report fixed 0/1 values and counts only', () => {
  const nonce = 'e'.repeat(24), runId = newRunId();
  const out = spawnSync('bash', ['-c', stepCommand(nonce, restoreFactsScript(runId))], { env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'ezq-facts-')) }, encoding: 'utf8', timeout: 30000 });
  assert.equal(out.status, 0, out.stderr);
  const fields = parseFields(readMarker(out.stdout, nonce));
  for (const key of ['replaced', 'pkg', 'lock', 'nm', 'opencode', 'sysmanifest', 'syshydrated', 'log', 'bootmarker', 'scanned', 'script']) assert.match(fields[key], /^[01]$/, key);
  for (const key of ['sysage', 'installing', 'done', 'failed', 'tracked', 'running']) assert.match(fields[key], /^-?[0-9]+$/, key);
  assert.equal(fields.replaced, '1'); assert.equal(fields.pkg, '0');
});

test('the public failure line holds fixed fields only and drops anything URL- or secret-shaped', () => {
  const line = publicFailureLine({ failureCode: 'opencode_install_failed', failedPhase: 'Code terminal ready', failedOperation: 'step opencode install result',
    errorType: 'AcceptanceFailure', install: { failure: 'installer_fetch', before: true }, missingPrerequisite: undefined });
  assert.equal(line, 'FAIL-DETAIL hosted HOME persistence: code=opencode_install_failed; phase=Code terminal ready; operation=step opencode install result; error=AcceptanceFailure; install_fail=installer_fetch; install_before=1; missing=none');
  const hostile = publicFailureLine({ failureCode: 'not-a-code', failedPhase: 'https://x.example/?t=secret', failedOperation: 'a;b=c',
    errorType: 'Error', install: { failure: 'rm -rf', before: 'x' }, missingPrerequisite: 'lower_case' });
  assert.equal(hostile, 'FAIL-DETAIL hosted HOME persistence: code=none; phase=unlisted; operation=unlisted; error=Error; install_fail=none; install_before=none; missing=none');
  assert.match(publicFailureLine({ failedPhase: 'cdn.example//private/path' }), /; phase=unlisted;/);
});

test('the script prints the public failure line to stdout when a prerequisite is missing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ezq-failline-'));
  try {
    const result = runScript({ EZIL_E2E_APP: 'https://preview-x.vercel.app' }, directory);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL-DETAIL hosted HOME persistence: code=none; phase=setup; operation=none; error=AssertionError; install_fail=none; install_before=none; missing=[A-Z0-9_]+$/m);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the hosted install check requires the pinned version and no failure class, under the same code', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /check\(install\.exitCode === 0 && install\.binary && install\.versionMatches && install\.failure === 'none', 'opencode_install_failed'\);/);
  assert.equal((source.match(/'opencode_install_failed'\)/g) ?? []).length, 1);
});

test('the page must still be on the approved staging origin, or credentials are never typed', () => {
  const app = 'https://ezil-os-abc123-ezil.vercel.app';
  assert.doesNotThrow(() => assertAppOrigin(`${app}/login?method=email`, app));
  assert.doesNotThrow(() => assertAppOrigin(`${app}/os#x`, app));
  for (const url of ['https://os.ezil.org/login?method=email', 'http://ezil-os-abc123-ezil.vercel.app/login',
    'https://ezil-os-abc123-ezil.vercel.app.evil.example/login', 'about:blank', 'not a url', '']) {
    assert.throws(() => assertAppOrigin(url, app), error => error instanceof AcceptanceFailure && error.code === 'app_origin_mismatch', url);
  }
  assert.ok(FAILURE_CODES.includes('app_origin_mismatch'));
});

test('every navigation is origin-checked before sign-in and before any computer is touched', () => {
  const source = readFileSync(script, 'utf8');
  const flow = source.slice(source.indexOf('async function main()'));
  const gotos = [...flow.matchAll(/await page\.goto\(/g)].map(m => m.index);
  assert.ok(gotos.length >= 2);
  for (const at of gotos) {
    const next = flow.slice(at).split('\n').slice(1, 2).join('');
    assert.match(next, /assertAppOrigin\(page\.url\(\), APP\);/, `navigation at ${at} is not followed by an origin check`);
  }
  const signInAt = flow.indexOf('await signIn(');
  assert.ok(flow.lastIndexOf('assertAppOrigin(page.url(), APP)', signInAt) > flow.lastIndexOf('await page.goto(', signInAt));
  assert.ok(flow.indexOf('assertAppOrigin(page.url(), APP)', signInAt) < flow.indexOf('verifySelectedComputer'));
});

test('the exact candidate image runs every required container suite, persistence included, with the pinned OpenCode', () => {
  // Review r4242645464: ci.yml's container job tests the previous good main image; image.yml tests
  // the candidate digest through test-desktop.sh, which ran only three of the four suites.
  const root = new URL('../', import.meta.url);
  const sh = readFileSync(new URL('.github/scripts/test-desktop.sh', root), 'utf8');
  const required = JSON.parse(readFileSync(new URL('.github/scripts/container-required-cases.json', root), 'utf8'));
  for (const suite of Object.keys(required)) assert.ok(sh.includes(suite), `test-desktop.sh never runs ${suite}`);
  assert.ok(sh.includes('worker/src/workspace-checkpoint.container.test.ts'));
  assert.match(sh, /EZIL_TEST_REQUIRED=\.github\/scripts\/container-required-cases\.json/);
  assert.match(sh, /bash \.github\/scripts\/run-checked-tests\.sh container-test\.log bun test/);
  assert.ok(sh.includes(`opencode_version=${OPENCODE_VERSION}`), 'the image test pins the same OpenCode release as the hosted suite');
  assert.ok(!/\|\s*bash/.test(sh), 'never pipe an installer into bash');
  assert.match(sh, /EZIL_REQUIRE_OPENCODE=1/);
  // workspace-checkpoint.container.test.ts reads EZIL_CHECKPOINT_IMAGE before EZIL_VALIDATE_IMAGE.
  assert.match(sh, /export EZIL_CHECKPOINT_IMAGE="\$EZIL_VALIDATE_IMAGE"/, 'the persistence suite must test this exact digest');
  assert.match(sh, /EZIL_NEXT_NPM_CACHE=/);
});

test("ci.yml's container job installs the same pinned OpenCode, never by piping the installer into bash", () => {
  // Without --version the official installer asks the unauthenticated GitHub API for the latest
  // release first (rate-limited on shared egress), and `curl | bash` without pipefail exits 0 when
  // the fetch fails.
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = yml.slice(yml.indexOf('mkdir -p /tmp/opencode-out'), yml.indexOf('EZIL_REQUIRE_OPENCODE=1'));
  assert.ok(step.length > 0, 'the container job no longer installs OpenCode');
  assert.ok(yml.includes(`opencode_version=${OPENCODE_VERSION}`), 'ci.yml pins the same OpenCode release as the hosted suite');
  assert.ok(!/\|\s*bash/.test(step), 'never pipe an installer into bash');
  assert.match(step, /set -euo pipefail/);
  assert.match(step, /--version \$opencode_version/);
  assert.match(step, /opencode --version\)\\?"\s*=\s*\$opencode_version/);
});
