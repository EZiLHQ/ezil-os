#!/usr/bin/env node
/**
 * Cloudflare computer: does a live tmux job survive the browser going away?
 *
 * Runs against a LOCAL `wrangler dev` of worker/ with the real container image
 * (local-dev mode, no secrets, no network beyond 127.0.0.1). The Worker, its
 * Durable Object, the flush alarm and the idle-stop decision all run for real;
 * the "terminal" is `docker exec` into the computer's container, which is what
 * a Code terminal is from the container's point of view.
 *
 * Sequence (one computer, nothing deleted):
 *   1. POST /sandbox/preview boots the computer (the server-observed open).
 *   2. A uniquely named tmux session runs a foreground, memory-only counter
 *      (the TT70.1 producer from e2e/aws-universal-deployed.mjs, with a longer
 *      fuse). A first client captures the initial snapshot.
 *   3. POST /sandbox/:id/activity {lastInputAgoMs: 30 min}: exactly what
 *      `session.js#releaseDesktop` sends when the desktop window closes.
 *   4. No more browser traffic. The container is watched until open + 10 min
 *      (IDLE_STOP_MS) + margin, sampling `docker inspect` every 15 s.
 *   5a. Container stopped (live behaviour before SIGNAL C): report the time
 *       and that the job is gone. --expect stopped passes.
 *   5b. Container up: set a fresh challenge and attach a NEW client to the
 *       exact session (no new-session fallback). Session, pane, tmux server
 *       PID + start ticks, Python PID + start ticks, boot ID must be
 *       unchanged, the client new, and the counter must have advanced by at
 *       least 80% of the elapsed seconds (it ran the whole time). Then the
 *       session is killed and the container must idle-stop again within
 *       --resume-stop-s. --expect held passes.
 *
 * Usage:
 *   node e2e/cf-tmux-continuity-local.mjs --worker http://127.0.0.1:8799 \
 *     --expect held --receipt /path/receipt.json [--scope <id>] [--user <id>]
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const IDLE_STOP_MS = 10 * 60_000;
const RELEASE_AGO_MS = 30 * 60_000;
const MARGIN_MS = 100_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const worker = arg('worker');
const expectOutcome = arg('expect');
const receiptPath = arg('receipt');
const resumeStopS = Number(arg('resume-stop-s', '150'));
// Docker does not namespace /proc/loadavg, so on a busy dev host the Worker's
// busy probe reads the HOST's load and never authorizes a stop. This puts a
// /usr/local/bin/cat shim in the throwaway local container that answers only
// `cat /proc/loadavg` with 0.00, i.e. a quiet production container. Recorded
// in the receipt; never used against a deployment.
const simulateQuietLoad = process.argv.includes('--simulate-quiet-load');
const scope = arg('scope', `tmux${randomBytes(6).toString('hex')}`);
const user = arg('user', `u${randomBytes(8).toString('hex')}`);
assert.match(worker ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, '--worker must be a loopback wrangler dev origin');
assert.ok(['held', 'stopped'].includes(expectOutcome), '--expect held|stopped');
assert.ok(receiptPath, '--receipt is required');

const receipt = { worker, scope, user, expect: expectOutcome, simulateQuietLoad, events: [] };
const now = () => new Date().toISOString();
const note = (event, data = {}) => {
  const row = { at: now(), event, ...data };
  receipt.events.push(row);
  console.log(JSON.stringify(row));
};
const save = () => writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── TT70.1 producer and assertions (copied, fuse widened for the idle window) ──
const tmuxIdentityFields = ['session', 'sessionId', 'sessionCreated', 'paneId', 'panePid',
  'serverPid', 'serverStartTicks', 'processId', 'processStartTicks', 'bootId', 'runId'];

export function continuingJobPython({ session, runId, challenge, fuseSeconds }) {
  return `import base64,json,os,pathlib,subprocess,time\n`
    + `SESSION=${JSON.stringify(session)}; RUN=${JSON.stringify(runId)}; INITIAL=${JSON.stringify(challenge)}\n`
    + `def tmux(*args):\n return subprocess.check_output(['tmux',*args],text=True,timeout=5).strip()\n`
    + `def start_ticks(pid):\n return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]\n`
    + `pid=os.getpid(); born=start_ticks(pid); boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()\n`
    + `started=time.monotonic(); counter=0; initial_client=None\n`
    + `while time.monotonic()-started < ${Number(fuseSeconds)}:\n`
    + ` counter+=1\n`
    + ` fields=tmux('display-message','-p','-t',os.environ['TMUX_PANE'],`
    + `'#{session_name}|#{session_id}|#{session_created}|#{pane_id}|#{pane_pid}|#{pid}').split('|')\n`
    + ` clients=tmux('list-clients','-t','='+SESSION,'-F','#{client_pid}|#{session_id}').splitlines()\n`
    // tmux 3.2a (this image, Ubuntu 22.04): an option target of '=name' silently
    // reads nothing and set-option refuses it; '=name:' works on every version.
    + ` challenge=tmux('show-options','-qv','-t','='+SESSION+':','@ezil_reconnect_challenge') or INITIAL\n`
    + ` if len(clients)==1:\n`
    + `  client,client_session=clients[0].split('|')\n`
    + `  if initial_client is None: initial_client=client\n`
    + `  if challenge==INITIAL or client!=initial_client:\n`
    + `   out=dict(session=fields[0],sessionId=fields[1],sessionCreated=fields[2],paneId=fields[3],panePid=int(fields[4]),`
    + `serverPid=int(fields[5]),serverStartTicks=start_ticks(fields[5]),processId=pid,processStartTicks=born,`
    + `bootId=boot,runId=RUN,challenge=challenge,counter=counter,clientPid=int(client),clientSessionId=client_session)\n`
    + `   print('EZILTMUX:'+challenge+':'+base64.b64encode(json.dumps(out,separators=(',',':')).encode()).decode()+':END',flush=True)\n`
    + ` time.sleep(1)\n`;
}

function assertSnapshot(value, expected) {
  assert.ok(value && typeof value === 'object', 'Live tmux snapshot missing');
  for (const field of ['session', 'runId', 'challenge']) assert.equal(value[field], expected[field], `tmux ${field} differs`);
  for (const field of ['panePid', 'serverPid', 'processId', 'clientPid', 'counter']) {
    assert.ok(Number.isSafeInteger(value[field]) && value[field] > 0, `tmux ${field} invalid`);
  }
  for (const field of ['sessionCreated', 'serverStartTicks', 'processStartTicks']) {
    assert.match(value[field] ?? '', /^[1-9][0-9]*$/, `tmux ${field} missing`);
  }
  assert.match(value.bootId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, 'boot ID missing');
  assert.equal(value.panePid, value.processId, 'pane is not the continuing process');
  assert.equal(value.clientSessionId, value.sessionId, 'client attached to another session');
}

// ── container helpers ──────────────────────────────────────────────────────
function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 30_000, input: opts.input });
}

function containerState(id) {
  const res = docker(['inspect', '-f', '{{.State.Running}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.State.Status}}', id]);
  if (res.status !== 0) return { exists: false };
  const [running, startedAt, finishedAt, status] = res.stdout.trim().split('|');
  return { exists: true, running: running === 'true', startedAt, finishedAt, status };
}

/** Running computer containers (not their proxies) created inside [fromMs, toMs]. */
function containersCreatedBetween(fromMs, toMs) {
  const names = docker(['ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}']).stdout.trim().split('\n')
    .map((line) => line.split(' ')).filter(([, name]) => /^workerd-ezil-os-worker-Sandbox-[0-9a-f]+$/.test(name ?? ''));
  return names.map(([id]) => id).filter((id) => {
    const created = Date.parse(docker(['inspect', '-f', '{{.Created}}', id]).stdout.trim());
    return created >= fromMs && created <= toMs;
  });
}

function captureSnapshot(container, session, challenge) {
  // A real client needs a tty; `script` gives it one. `timeout` ends this
  // client, which detaches it and leaves the session running.
  const attach = challenge.reattach
    ? `tmux set-option -t =${session}: @ezil_reconnect_challenge ${challenge.value} && timeout 6 script -qfc 'tmux attach-session -d -t =${session}' /dev/null`
    : `timeout 6 script -qfc 'tmux attach-session -t =${session}' /dev/null`;
  const res = docker(['exec', '-e', 'TERM=xterm', container, 'bash', '-lc', attach], { timeout: 30_000 });
  const text = (res.stdout ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const re = new RegExp(`EZILTMUX:${challenge.value}:([A-Za-z0-9+/=]+):END`, 'g');
  let last = null;
  for (const m of text.matchAll(re)) last = m[1];
  assert.ok(last, `no snapshot with challenge ${challenge.value} (exit ${res.status})`);
  return JSON.parse(Buffer.from(last, 'base64').toString('utf8'));
}

async function postJson(path, body, timeoutMs = 420_000) {
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${worker}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (err) {
      // A connection-level failure (wrangler dev dropping a keep-alive socket).
      note('post_network_error', { path: path.replace(/\/sandbox\/[^/]+\//, '/sandbox/:id/'), attempt, error: String(err?.cause?.code ?? err?.message ?? err) });
      if (attempt >= 3) throw err;
      await sleep(3_000);
    }
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, data, text: text.slice(0, 300) };
}

async function main() {
  note('preview_start');
  const previewStartedAt = Date.now();
  let preview = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    preview = await postJson('/sandbox/preview', { token: 'local-dev', projectId: scope, userId: user });
    if (preview.data?.ok === true) break;
    note('preview_retry', { attempt, status: preview.status, error: preview.data?.error ?? preview.text });
    await sleep(10_000);
  }
  assert.equal(preview.data?.ok, true, `preview failed: ${preview.text}`);
  const openedAt = Date.now();
  const sandboxId = preview.data.sandboxId;
  receipt.sandboxId = sandboxId;
  note('preview_ok', { sandboxId, mode: preview.data.mode });

  // The computer's container is the one created during THIS preview. Runs
  // against two dev Workers on one Docker host must not overlap that window.
  const found = containersCreatedBetween(previewStartedAt - 5_000, openedAt + 5_000);
  assert.equal(found.length, 1, `expected one container created during the preview, found ${found.length}`);
  const container = found[0];
  const initialState = containerState(container);
  receipt.container = { id: container.slice(0, 12), startedAt: initialState.startedAt };
  note('container', receipt.container);
  if (simulateQuietLoad) {
    const shim = '#!/bin/sh\n# EZIL LOCAL TEST SHIM: quiet-load simulation for the idle-stop busy probe.\n'
      + 'if [ "$#" -eq 1 ] && [ "$1" = /proc/loadavg ]; then echo "0.00 0.00 0.00 1/100 100"; exit 0; fi\nexec /bin/cat "$@"\n';
    const put = docker(['exec', '-i', container, 'sh', '-c', 'cat > /usr/local/bin/cat.new && chmod 755 /usr/local/bin/cat.new && mv /usr/local/bin/cat.new /usr/local/bin/cat'], { input: shim });
    assert.equal(put.status, 0, 'shim install failed');
    const check = docker(['exec', container, 'sh', '-c', 'command -v cat; cat /proc/loadavg']);
    assert.match(check.stdout, /\/usr\/local\/bin\/cat\n0\.00 /, 'shim not active');
    note('quiet_load_shim_installed');
  }

  const session = `ezilcftmux${randomBytes(6).toString('hex')}`;
  const runId = randomBytes(12).toString('hex');
  const initial = randomBytes(8).toString('hex');
  const fuseSeconds = 1800;
  const encoded = Buffer.from(continuingJobPython({ session, runId, challenge: initial, fuseSeconds })).toString('base64');
  const job = `exec python3 -u -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  const start = docker(['exec', container, 'tmux', '-f', '/dev/null', 'new-session', '-d', '-s', session, job]);
  assert.equal(start.status, 0, `tmux new-session failed: ${start.stderr}`);
  const before = captureSnapshot(container, session, { value: initial });
  assertSnapshot(before, { session, runId, challenge: initial });
  const beforeAt = Date.now();
  receipt.before = before;
  note('tmux_started', { session, counter: before.counter, processId: before.processId, serverPid: before.serverPid });

  const release = await postJson(`/sandbox/${sandboxId}/activity`, { lastInputAgoMs: RELEASE_AGO_MS }, 30_000);
  assert.equal(release.data?.ok, true, `release failed: ${release.text}`);
  note('release_sent', { lastInputAgoMs: RELEASE_AGO_MS });

  const deadline = openedAt + IDLE_STOP_MS + MARGIN_MS;
  let stoppedAt = null;
  while (Date.now() < deadline) {
    await sleep(15_000);
    const state = containerState(container);
    if (!state.running) {
      stoppedAt = Date.now();
      note('container_stopped', { status: state.status, finishedAt: state.finishedAt, sinceOpenS: Math.round((stoppedAt - openedAt) / 1000) });
      break;
    }
  }

  if (stoppedAt !== null) {
    receipt.outcome = 'stopped';
    const gone = docker(['exec', container, 'tmux', 'has-session', '-t', `=${session}`]);
    receipt.jobGone = gone.status !== 0;
    note('job_gone', { tmuxReachable: gone.status === 0 });
  } else {
    receipt.outcome = 'held';
    const state = containerState(container);
    assert.equal(state.startedAt, initialState.startedAt, 'container restarted');
    const reconnect = randomBytes(8).toString('hex');
    const after = captureSnapshot(container, session, { value: reconnect, reattach: true });
    assertSnapshot(after, { session, runId, challenge: reconnect });
    for (const field of tmuxIdentityFields) assert.equal(after[field], before[field], `tmux ${field} changed`);
    assert.notEqual(after.clientPid, before.clientPid, 'reattach did not use a new client');
    const elapsedS = (Date.now() - beforeAt) / 1000;
    assert.ok(after.counter - before.counter >= 0.8 * elapsedS,
      `counter advanced ${after.counter - before.counter} in ${Math.round(elapsedS)} s: the job did not run continuously`);
    receipt.after = after;
    note('reattached_same_process', {
      sinceOpenS: Math.round((Date.now() - openedAt) / 1000), counterDelta: after.counter - before.counter,
      elapsedS: Math.round(elapsedS), processId: after.processId, newClientPid: after.clientPid,
    });

    // Idle stop must come back once nothing is left to keep alive.
    docker(['exec', container, 'tmux', 'kill-server']);
    const killedAt = Date.now();
    note('tmux_killed');
    let resumed = null;
    while (Date.now() - killedAt < resumeStopS * 1000) {
      await sleep(10_000);
      if (!containerState(container).running) { resumed = Date.now(); break; }
    }
    receipt.idleStopResumedS = resumed === null ? null : Math.round((resumed - killedAt) / 1000);
    note('idle_stop_after_tmux_exit', { stoppedWithinS: receipt.idleStopResumedS });
    assert.ok(resumed !== null, `container still running ${resumeStopS} s after the last tmux session ended`);
  }

  assert.equal(receipt.outcome, expectOutcome, `expected ${expectOutcome}, observed ${receipt.outcome}`);
  receipt.pass = true;
}

main().then(() => { save(); console.log(`PASS ${expectOutcome}`); }, (err) => {
  receipt.pass = false;
  receipt.error = String(err?.message ?? err);
  save();
  console.error(`FAIL ${receipt.error}`);
  process.exitCode = 1;
});
