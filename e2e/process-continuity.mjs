import assert from 'node:assert/strict';

// Run through Code's ordinary terminal on the explicitly isolated computer.
// Read only supervisor PID files and Linux process start times. No argv,
// environment, addresses, workspace paths, or credentials enter evidence.
const probe = `import json, os, pathlib, time
def identity(pid):
    raw = pathlib.Path('/proc/%d/stat' % pid).read_text()
    fields = raw[raw.rindex(')') + 2:].split()
    if fields[0] == 'Z':
        raise RuntimeError('process unavailable')
    return {'pid': pid, 'startTicks': int(fields[19])}
sequence = 0
while True:
    try:
        data = {'sequence': sequence, 'terminal': identity(os.getpid()), 'shell': identity(os.getppid())}
        for key, app in [('chrome', 'chromium'), ('code', 'codeserver')]:
            pid = int(pathlib.Path('/tmp/neko-app-pgid/' + app + '.pgid').read_text())
            data[key] = identity(pid)
    except Exception:
        data = {'failure': True}
    print('EZILPROC:' + NONCE + ':' + json.dumps(data, separators=(',', ':')) + ':END', flush=True)
    sequence += 1
    time.sleep(5)
`;

const validateNonce = nonce => assert.match(nonce, /^[a-f0-9]{24}$/);
export function terminalContinuityCommand(nonce) {
  validateNonce(nonce);
  const encoded = Buffer.from(`NONCE = '${nonce}'\n${probe}`).toString('base64');
  return `python3 -u -c "import base64;exec(base64.b64decode('${encoded}'))"`;
}

export function readProcessSample(text, nonce) {
  validateNonce(nonce);
  // Terminal soft wraps split output into accessible rows. The fixed format
  // contains no spaces; joining rows reconstructs a complete fresh report.
  const compact = String(text).replace(/\s/g, '');
  const matches = [...compact.matchAll(new RegExp(`EZILPROC:${nonce}:(\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\}):END`, 'g'))];
  if (!matches.length) return null;
  const value = JSON.parse(matches.at(-1)[1]);
  assert.equal(value.failure, undefined, 'Hosted process observation failed');
  assert.deepEqual(Object.keys(value).sort(), ['chrome', 'code', 'sequence', 'shell', 'terminal'], 'Unexpected process report fields');
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence >= 0, 'Invalid process heartbeat');
  for (const key of ['terminal', 'shell', 'chrome', 'code']) {
    assert.deepEqual(Object.keys(value[key] || {}).sort(), ['pid', 'startTicks'], `Missing ${key} process identity`);
    assert.ok(Number.isSafeInteger(value[key]?.pid) && value[key].pid > 0
      && Number.isSafeInteger(value[key]?.startTicks) && value[key].startTicks > 0,
    `Missing ${key} process identity`);
  }
  return value;
}

export function assertProcessContinuity(before, after) {
  assert.ok(before && after, 'Missing hosted process observation');
  assert.ok(after.sequence > before.sequence, 'Terminal heartbeat did not advance');
  for (const key of ['terminal', 'shell', 'chrome', 'code']) {
    assert.deepEqual(after[key], before[key], `${key} process was replaced during relay renewal`);
  }
}

export async function waitForProcessSample({ observe, nonce, afterSequence = -1, timeoutMs = 20000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let stopped = false, timer, baseline;
  const poll = async () => {
    while (!stopped) {
      const sample = readProcessSample(await observe(), nonce);
      if (stopped) return;
      if (sample) {
        if (baseline && sample.sequence > Math.max(afterSequence, baseline.sequence)) {
          assertProcessContinuity(baseline, sample);
          return sample;
        }
        // The first report can be buffered terminal output. Require another
        // heartbeat printed after this observation, retaining process identity.
        baseline ||= sample;
      }
      await sleep(100);
    }
  };
  try {
    return await Promise.race([poll(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Hosted process heartbeat timed out')), timeoutMs);
    })]);
  } finally { stopped = true; clearTimeout(timer); }
}
