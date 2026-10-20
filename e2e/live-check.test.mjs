import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateResults, isRealStop, parseTerminalMarker, redactEvidence, terminalProbeCommand } from './live-check.mjs';

const nonce = 'a1'.repeat(10);

test('marker parsing ignores echoed warm and cold commands, including soft wraps', () => {
  for (const cold of [false, true]) {
    const marker = `${cold ? 'C' : 'W'}${nonce}`;
    const command = terminalProbeCommand(nonce, cold);
    assert.equal(parseTerminalMarker(command, marker), null);
    assert.equal(parseTerminalMarker(command.match(/.{1,37}/g).join('\n'), marker), null);
    const expected = cold ? nonce : 'ok';
    const output = `${marker}[${expected}]`.match(/.{1,7}/g).join('\n');
    assert.equal(parseTerminalMarker(`root@computer:~# ${command}\n${output}\nroot@computer:~#`, marker), expected);
  }
});

test('marker parsing rejects absent, stale, and incomplete output', () => {
  const marker = `C${nonce}`;
  for (const text of ['', `C${'b2'.repeat(10)}[${nonce}]`, `${marker}[unfinished`]) {
    assert.equal(parseTerminalMarker(text, marker), null);
  }
  assert.equal(parseTerminalMarker(`${marker}[]`, marker), '');
  assert.equal(parseTerminalMarker(null, marker), null);
  assert.equal(parseTerminalMarker('[]', ''), null);
});

test('marker parsing handles ANSI formatting, literal markers, and latest output', () => {
  assert.equal(parseTerminalMarker('\x1b[32mPROBE.1[old]\x1b[0m\nPROBE.1[new]', 'PROBE.1'), 'new');
  assert.equal(parseTerminalMarker('PROBEx1[wrong]', 'PROBE.1'), null);
});

test('terminal probes require tmux and opencode success before emitting a marker', () => {
  const command = terminalProbeCommand(nonce);
  assert.match(command, /tmux new-session -d .* && tmux has-session -t /);
  assert.match(command, /&& opencode --version >\/dev\/null 2>&1 && printf/);
  assert.match(command, / > \/root\/\.ezil-live-mark && printf '%s\[%s\]\\n'/);
  assert.match(command, /; tmux kill-session -t /);
  assert.match(terminalProbeCommand(nonce, true), /cat \/root\/\.ezil-live-mark/);
  assert.throws(() => terminalProbeCommand('$(unsafe)'), /Invalid probe nonce/);
});

test('aggregation passes only nonempty successful checks and fails on any failure', () => {
  const passed = [{ check: 'sign-in', ok: true, ms: 2 }, { check: 'warm-browser-paint', ok: true, ms: 20 }];
  assert.equal(aggregateResults(passed).result, 'PASS');
  assert.equal(aggregateResults([]).result, 'FAIL');
  for (let index = 0; index < passed.length; index++) {
    assert.equal(aggregateResults(passed.map((check, i) => ({ ...check, ok: i !== index }))).result, 'FAIL');
  }
  for (const malformed of [null, {}, { check: 'stop', ok: 'true', ms: 0 }, { check: 'stop', ok: true, ms: NaN }]) {
    assert.equal(aggregateResults([...passed, malformed]).result, 'FAIL');
  }
});

test('evidence redaction drops credentials, cookies, token URLs, UUIDs, and arbitrary diagnostics', () => {
  const privateData = {
    email: 'private@example.test', password: 'private-password', cookie: 'session=private-cookie',
    headers: { authorization: 'Bearer private-token', 'x-vercel-protection-bypass': 'private-bypass' },
    url: 'https://frame.example.test/?token=private-token', computerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    error: new Error('private-password'), output: 'private terminal text',
  };
  const raw = { check: 'relay-read', ok: false, ms: 12.2, ...privateData };
  assert.deepEqual(redactEvidence(raw), { check: 'relay-read', ok: false, ms: 12 });
  assert.deepEqual(aggregateResults([raw]), { result: 'FAIL', checks: [{ check: 'relay-read', ok: false, ms: 12 }] });
  for (const check of [privateData.url, privateData.computerId, privateData.cookie, privateData.password]) {
    assert.deepEqual(redactEvidence({ check, ok: true, ms: privateData.password }), { check: 'unknown', ok: false, ms: 0 });
  }
  assert.equal(raw.password, privateData.password, 'redaction must not mutate the source');
});

test('real stop rejects already stopped, incomplete, failed, and non-200 responses', () => {
  const good = { status: 200, json: { ok: true, outcome: 'destroyed', terminated: true } };
  assert.equal(isRealStop(good), true);
  for (const response of [null, { ...good, status: 502 }, { status: 200, json: null },
    { ...good, json: { ...good.json, ok: false } },
    { ...good, json: { ...good.json, outcome: 'not_running', terminated: false } },
    { ...good, json: { ...good.json, terminated: false } },
    { ...good, json: { ok: true, terminated: true } }]) {
    assert.equal(isRealStop(response), false);
  }
});

test('CLI setup failure exits 1 and writes redacted JSON without loading a browser', () => {
  const out = mkdtempSync(join(tmpdir(), 'ezil-live-unit-'));
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./live-check.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 5000,
      env: { EZIL_E2E_APP: 'invalid-origin?token=private-token', EZIL_E2E_EMAIL: 'private@example.test',
        EZIL_E2E_PASSWORD: 'private-password', VERCEL_AUTOMATION_BYPASS_SECRET: 'private-bypass',
        PLAYWRIGHT_REQUIRE_DIR: out, EZIL_LIVE_OUT: out },
    });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    const lines = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].check, 'setup');
    assert.equal(lines[0].ok, false);
    assert.equal(lines[1].result, 'FAIL');
    assert.deepEqual(lines[1].checks, [lines[0]]);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'live-check.json'), 'utf8')), lines[1]);
    assert.doesNotMatch(child.stdout, /private|invalid-origin|token|cookie/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
