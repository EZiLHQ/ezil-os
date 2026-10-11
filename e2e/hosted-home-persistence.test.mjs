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
  stepCommand, stepLines, MAX_TYPED_LINE, readMarker, parseFields, probeScript, parseProbe, checksumScript, parseChecksums, compareChecksums,
  opencodeInstallScript, parseOpencodeInstall, projectScript, depsWaitScript, parseDepsStatus, parseDepsWait,
  depsWaitOutcome, projectDepsState, devServerScript, parseDevServer, cleanupPlan, cleanupScript, parseCleanup,
  EVIDENCE_FILE, clampWait, RUN_BUDGET_MS, CLEANUP_RESERVE_MS, POWER_CUT_RPO_MS, powerCutAfterRpo,
  AcceptanceFailure, FAILURE_CODES,
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

test('runStep retries terminal read errors during both typed and result checks', async () => {
  const source = readFileSync(script, 'utf8');
  const runStepSource = source.match(/  const runStep = async \(name, body, timeoutMs\) => \{[\s\S]*?\n  \};/)[0];
  let line, reads = 0, enters = 0;
  const nonce = 'a'.repeat(24);
  const context = { evidence: {}, stepInFlight: false, newNonce: () => nonce, stepCommand, stepLines, readMarker, parseFields, wait: async () => {},
    terminalInput: () => ({ pressSequentially: async value => { line = value; }, press: async key => { assert.equal(key, 'Enter'); enters++; } }),
    terminalText: async () => {
      reads++;
      if (reads === 1 || reads === 3) throw new Error('transient detached terminal');
      return reads === 2 ? line : `EZQ:${nonce}:x=1:END`;
    },
    bounded: async (_name, action) => {
      assert.equal(await action(), _name.endsWith('typed') ? false : null);
      return action();
    },
  };
  const runStep = runInNewContext(`${runStepSource}\nrunStep`, context);
  assert.deepEqual(await runStep('probe', 'emit "x=1"', 1000), { x: '1' });
  assert.equal(reads, 4);
  assert.equal(enters, 1);
  assert.equal(context.stepInFlight, false);
});

test('failure evidence retains the fixed failing operation when cleanup overwrites operation', () => {
  const source = readFileSync(script, 'utf8');
  const catchBody = source.match(/  \} catch \(error\) \{\n    \/\/ Driver messages[\s\S]*?\n  \} finally \{/)[0]
    .replace(/^  \} catch \(error\) \{/, '').replace(/\n  \} finally \{$/, '');
  const evidence = { operation: 'step next project typed', phases: [{ name: 'Code terminal ready' }] };
  runInNewContext(catchBody, { evidence, error: new Error('private driver details'), AcceptanceFailure, FAILURE_CODES,
    console: { error() {} }, process: {} });
  evidence.operation = 'step cleanup result';
  assert.equal(evidence.failedOperation, 'step next project typed');
  assert.equal(evidence.failedPhase, 'Code terminal ready');
  assert.ok(!JSON.stringify(evidence).includes('private driver details'));
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
  assert.ok(opencodeInstallScript(id).includes('curl -fsSL https://opencode.ai/install | bash'));
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
  const parsed = parseOpencodeInstall({ rc: '0', bin: '1', rc_bashrc: b64('\n# opencode\nexport PATH=/root/.opencode/bin:$PATH\n') });
  assert.deepEqual(parsed, { exitCode: 0, binary: true, addedRcLines: { bashrc: ['# opencode', 'export PATH=/root/.opencode/bin:$PATH'] } });
  assert.throws(() => parseOpencodeInstall({ rc: '0', bin: '1', rc_bashrc: b64('alias ls=rm\n') }), /Unexpected rc lines/);
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

test('an unverified typing echo is advisory: the result marker decides', async () => {
  const source = readFileSync(script, 'utf8');
  const runStepSource = source.match(/  const runStep = async \(name, body, timeoutMs\) => \{[\s\S]*?\n  \};/)[0];
  const nonce = 'd'.repeat(24);
  let enters = 0;
  const context = { evidence: {}, stepInFlight: false, newNonce: () => nonce, stepCommand, stepLines, readMarker, parseFields, wait: async () => {},
    terminalInput: () => ({ pressSequentially: async () => {}, press: async () => { enters++; } }),
    terminalText: async () => (enters ? `EZQ:${nonce}:x=1:END` : ''),
    bounded: async (name, action) => { const r = await action(); if (r) return r; throw new Error(`${name}: deadline exceeded`); },
  };
  const runStep = runInNewContext(`${runStepSource}\nrunStep`, context);
  assert.deepEqual(await runStep('probe', 'emit "x=1"', 1000), { x: '1' });
  assert.equal(context.evidence.typedUnverified, 1);
});
