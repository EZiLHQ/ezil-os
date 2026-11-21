/**
 * Packaged desktop acceptance. This driver uses Docker exec only for the offline
 * OS fixture. No browser connects to Code from outside the container.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const container = process.env.EZIL_E2E_CONTAINER;
const out = process.env.EZIL_E2E_OUT;
assert.ok(container && out, 'run via EZIL_E2E_SUITE=unattended e2e/chat-bridge-workbench.sh IMAGE');
function fixture(path, body) {
  const args = ['exec', container, 'curl', '-fsS'];
  if (body) args.push('-H', 'content-type: application/json', '--data', JSON.stringify(body));
  args.push('http://127.0.0.1:4142/' + path);
  return JSON.parse(execFileSync('docker', args, { encoding: 'utf8' }));
}
const final = new Set(['rejected', 'failed', 'expired', 'uncertain', 'cancelled', 'completed', 'applied']);
async function waitFor(label, select, timeout) {
  const deadline = Date.now() + timeout;
  do {
    const state = fixture('bridge-state');
    const result = select(state);
    if (result) return result;
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}
const ownedOperations = (state, operations) => operations.map(op => state.ops.find(row => row.id === op.id));
const finalOperations = (state, operations) => {
  const rows = ownedOperations(state, operations);
  return rows.every(row => final.has(row?.status)) && rows;
};
const receipts = [];
// Only the synthetic User/settings.json created by the parent driver is edited.
function setFixtureConsent(allowed) {
  const script = `const fs=require('fs'), f='/tmp/code-server-data/User/settings.json';
    const settings=JSON.parse(fs.readFileSync(f,'utf8')); settings['ezil.chatBridge.unattended']=process.argv[1]==='true';
    fs.writeFileSync(f+'.qa', JSON.stringify(settings)); fs.renameSync(f+'.qa', f);`;
  execFileSync('docker', ['exec', container, 'node', '-e', script, String(allowed)]);
}
try {
  const first = await waitFor('an authenticated protocol-2 workbench and both model choices',
    state => state.catalog?.models?.filter(model => model.availability === 'available').length >= 2 &&
      state.protocols['2'] > 0 && state, Number(process.env.EZIL_UNATTENDED_READY_MS || 120000));
  assert.equal(first.refused.length, 0);
  assert.match(first.owner, /^unattended\.[a-f0-9-]{36}$/, 'the executing workbench must be the private loopback client');
  assert.equal(first.upstream.filter(request => request.path.endsWith('/messages')).length, 0,
    'cold-start readiness must not generate a synthetic user turn');
  const markers = ['ALPHA', 'BRAVO'];
  const models = ['Qwen3 Coder Next', 'Kimi K3 (no streaming)'].map(label => {
    const model = first.catalog.models.find(row => row.label === label && row.availability === 'available');
    assert.ok(model, 'missing allowed model ' + label);
    return model.id;
  });
  const createRequests = markers.map((id, i) => fixture('enqueue', { role: id, kind: 'create', model: models[i] }));
  const created = await waitFor('two Code sessions', state => finalOperations(state, createRequests), 75000);
  assert.ok(created.every(row => row.status === 'applied' && row.requestCount === 0));
  assert.equal(new Set(created.map(row => row.sessionResource)).size, 2);
  const sends = markers.map((id,i) => fixture('enqueue', { role: 'send' + id, kind: 'send', sessionRole: id,
    sessionResource: created[i].sessionResource, text: 'EZIL_E2E_PAIR_' + id + ' return the designated fixture reply' }));
  const done = await waitFor('both hosted replies', state => finalOperations(state, sends) && state, 150000);
  markers.forEach((id, i) => {
    const op = done.ops.find(row => row.id === sends[i].id);
    assert.equal(op.status, 'completed');
    assert.equal(op.responseText?.trim(), 'EZIL_PAIR_REPLY_' + id);
    const completed = done.reports.filter(row => row.operationId === op.id && row.status === 'completed' && row.applied);
    assert.equal(completed.length, 1);
    assert.ok(completed[0].requestId);
    const foreground = done.upstream.filter(row => row.pair?.kind === 'foreground' &&
      row.pair.markers.includes('EZIL_E2E_PAIR_' + id));
    assert.equal(foreground.length, 1);
    assert.deepEqual(foreground[0].pair.markers, ['EZIL_E2E_PAIR_' + id]);
    assert.ok(Number.isFinite(foreground[0].forwarded) && Number.isFinite(foreground[0].end));
    receipts.push({ session: created[i].sessionResource, instruction: op.id, request: completed[0].requestId,
      result: op.responseText.trim(), from: foreground[0].forwarded, until: foreground[0].end });
  });
  assert.notEqual(receipts[0].request, receipts[1].request);
  assert.ok(Math.max(...receipts.map(row => row.from)) < Math.min(...receipts.map(row => row.until)),
    'two distinct foreground inference requests must overlap');
  const priorOwner = done.owner;
  setFixtureConsent(false);
  const expired = await waitFor('withdrawn consent to end private editor-bridge syncs', state => {
    const last = state.syncs.at(-1);
    return last && state.now - last.at > 35000 && state;
  }, 75000);
  assert.equal(expired.owner, priorOwner);
  execFileSync('docker', ['exec', container, 'curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:8443/healthz']);
  setFixtureConsent(true);
  const rejoined = await waitFor('a new private lease and both saved conversations after regrant', state =>
    state.owner !== priorOwner && state.owner?.startsWith('unattended.') && state.epoch > done.epoch &&
    state.sessionsAt > state.owners.at(-1).at && receipts.every(receipt =>
      state.sessions.some(row => row.resource === receipt.session)) && state, 120000);
  assert.equal(rejoined.ops.filter(op => op.kind === 'send' && op.status === 'completed').length, 2);
  // Read only the two synthetic workspace journals. Each must still contain
  // its own terminal assistant reply after the original window is gone.
  for (const receipt of receipts) {
    const id = Buffer.from(new URL(receipt.session).pathname.slice(1), 'base64url').toString('utf8');
    assert.match(id, /^[0-9a-f-]{36}$/);
    const check = `const fs=require('fs'); const [id, request, result]=process.argv.slice(1);
      const journal=fs.readFileSync('/home/neko/project/.ezil/chat/'+id+'.jsonl','utf8');
      if (!journal.includes(request) || !journal.includes(result)) process.exit(1);`;
    execFileSync('docker', ['exec', container, 'node', '-e', check, id, receipt.request, receipt.result]);
  }
  console.log(JSON.stringify({ status: 'passed', fixture: 'offline', externalCodeWorkbenches: 0, receipts }));
} finally {
  const state = fixture('bridge-state');
  const summary = { protocols: state.protocols, ownerCount: state.owners.length,
    operations: state.ops.map(({role, status, reason, attempts}) => ({role, status, reason, attempts})), receipts };
  writeFileSync(join(out, 'unattended-code-results.json'), JSON.stringify(summary, null, 2));
}
