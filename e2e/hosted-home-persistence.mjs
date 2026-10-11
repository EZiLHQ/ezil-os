/**
 * Hosted STAGING acceptance: a user's HOME survives container replacement.
 *
 * Regression for the hosted bug where a Next.js project in ~/ pushed the system
 * layer over its snapshot limits (every later save skipped as `too_large`), so
 * a replaced container lost OpenCode (~/.opencode + its ~/.bashrc PATH line),
 * the project's `next` binary and the user's notes. On the explicitly isolated
 * E2E computer, through Code's ordinary terminal, this suite:
 *   1. installs OpenCode with its official installer, creates a real Next.js
 *      app (npm install -> package-lock.json), a note and a config file, all
 *      under per-run names, and records their sha256;
 *   2. stops the computer through the real stop route (final checkpoint +
 *      teardown) and proves the container was replaced (a /tmp sentinel, which
 *      no snapshot captures, is gone);
 *   3. asserts identical checksums, a resolvable working `opencode`,
 *      `ezil-deps wait` success, and `npm run dev` serving the page marker;
 *   4. removes only what this run created, in the terminal, before the final
 *      stop persists that removal.
 *
 * Staging only. `assertStagingTarget` refuses production before any browser
 * launch. Evidence holds fixed fields only: no cookies, credentials, raw driver
 * errors or terminal text.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EVIDENCE_DIR = 'hosted-home-persistence-evidence';
export const EVIDENCE_FILE = `${EVIDENCE_DIR}/result.json`;

// ---------------------------------------------------------------------------
// Target guard
// ---------------------------------------------------------------------------

export const PRODUCTION_HOSTS = Object.freeze(['os.ezil.org', 'ezil-os.vercel.app', 'ezil-os-ezil.vercel.app']);

export class TargetRefused extends Error {
  constructor(code) {
    super(`Hosted HOME persistence is staging-only: ${code}`);
    this.name = 'TargetRefused';
    this.code = code;
  }
}

/**
 * Pure: returns the staging origin or throws TargetRefused. Never reads
 * anything but `env.EZIL_E2E_APP`, never touches the network.
 */
export function assertStagingTarget(env = process.env) {
  const raw = env?.EZIL_E2E_APP;
  if (typeof raw !== 'string' || !raw.trim()) throw new TargetRefused('missing_target');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new TargetRefused('invalid_target'); }
  // URL lowercases the hostname; a fully qualified name may still end in dots.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (PRODUCTION_HOSTS.includes(host) || host === 'ezil.org' || host.endsWith('.ezil.org')) {
    throw new TargetRefused('production_target');
  }
  if (url.protocol !== 'https:') throw new TargetRefused('https_required');
  if (url.username || url.password) throw new TargetRefused('invalid_target');
  return url.origin;
}

// ---------------------------------------------------------------------------
// Run identity and terminal step protocol
// ---------------------------------------------------------------------------

const RUN_ID = /^[a-f0-9]{12}$/;
const NONCE = /^[a-f0-9]{24}$/;
export const assertRunId = runId => { assert.ok(typeof runId === 'string' && RUN_ID.test(runId), 'Invalid run id'); return runId; };
const assertNonce = nonce => { assert.ok(typeof nonce === 'string' && NONCE.test(nonce), 'Invalid step nonce'); return nonce; };
export const newRunId = (bytes = randomBytes(6)) => assertRunId(Buffer.from(bytes).toString('hex'));
export const newNonce = (bytes = randomBytes(12)) => assertNonce(Buffer.from(bytes).toString('hex'));

/** Every per-run path, relative to $HOME, derived only from a validated run id. */
export function runPaths(runId) {
  assertRunId(runId);
  return {
    project: `ezq-home-${runId}`,
    note: `ezq-note-${runId}.md`,
    configDir: `.config/ezq-${runId}`,
    config: `.config/ezq-${runId}/settings.json`,
    scratch: `/tmp/ezq-${runId}`, // never snapshotted: per-container state only
    sentinel: `/tmp/ezq-alive-${runId}`,
    marker: `ezq-marker-${runId}`,
  };
}

/** Fixed labels -> paths under $HOME, in manifest order. */
export function checksumTargets(runId) {
  const p = runPaths(runId);
  return [
    ['opencode', '.opencode/bin/opencode'],
    ['bashrc', '.bashrc'],
    ['note', p.note],
    ['config', p.config],
    ['package', `${p.project}/package.json`],
    ['lock', `${p.project}/package-lock.json`],
    ['page', `${p.project}/app/page.js`],
  ];
}

/** Shell rc files an installer may edit; labels are fixed, never paths in evidence. */
export const RC_FILES = Object.freeze([
  ['bashrc', '.bashrc'], ['bash_profile', '.bash_profile'], ['bash_login', '.bash_login'],
  ['profile', '.profile'], ['zshrc', '.zshrc'], ['zshenv', '.zshenv'],
]);

const PRELUDE = (nonce) => [
  'set +e',
  `N=${assertNonce(nonce)}`,
  // The marker is assembled here, inside the encoded script, so the typed
  // command line can never match the result parser.
  "emit() { printf 'EZQ:%s:%s:END\\n' \"$N\" \"$1\"; }",
  'b64() { base64 -w0; }',
].join('\n');

/**
 * The single line typed into the terminal: gzip+base64 of the step script,
 * executed with the terminal (not the script) as stdin. Only base64 and fixed
 * shell syntax are typed, so the line never contains a result marker.
 */
export function stepCommand(nonce, body) {
  const script = `${PRELUDE(nonce)}\n${body}\n`;
  const encoded = gzipSync(Buffer.from(script)).toString('base64');
  return `bash -c "$(echo ${encoded} | base64 -d | gzip -dc)"`;
}

const PAYLOAD = '[A-Za-z0-9=,._+/-]*';
/** Last complete marker for this nonce in terminal text; soft wraps are removed. */
export function readMarker(text, nonce) {
  assertNonce(nonce);
  const compact = String(text ?? '').replace(/\s/g, '');
  const matches = [...compact.matchAll(new RegExp(`EZQ:${nonce}:(${PAYLOAD}):END`, 'g'))];
  return matches.length ? matches.at(-1)[1] : null;
}

/** `k=v,k=v` -> object. Values may contain '=' (base64), never ','. */
export function parseFields(payload) {
  assert.equal(typeof payload, 'string', 'Missing step result');
  const fields = {};
  for (const part of payload.split(',')) {
    if (!part) continue;
    const at = part.indexOf('=');
    assert.ok(at > 0, 'Malformed step result');
    const key = part.slice(0, at);
    assert.match(key, /^[a-z][a-z0-9_]*$/, 'Malformed step result key');
    assert.ok(!(key in fields), 'Duplicate step result key');
    fields[key] = part.slice(at + 1);
  }
  return fields;
}

const intField = (fields, key) => {
  const value = fields[key];
  assert.ok(typeof value === 'string' && /^\d{1,5}$/.test(value), `Step result ${key} missing`);
  return Number(value);
};
const flagField = (fields, key) => {
  assert.ok(fields[key] === '0' || fields[key] === '1', `Step result ${key} missing`);
  return fields[key] === '1';
};
const decodeB64 = value => Buffer.from(value ?? '', 'base64').toString('utf8');

// ---------------------------------------------------------------------------
// Step scripts (bodies only; stepCommand adds the prelude)
// ---------------------------------------------------------------------------

/** Before any change: HOME, pre-existing OpenCode, fresh per-run names, rc snapshot. */
export function probeScript(runId) {
  const p = runPaths(runId);
  return [
    'H="$HOME"',
    `S=${p.scratch}`,
    'home=0; [ "$H" = /root ] && home=1',
    'oc=0; [ -e "$H/.opencode" ] && oc=1',
    `fresh=1; for x in "$H/${p.project}" "$H/${p.note}" "$H/${p.configDir}"; do [ -e "$x" ] && fresh=0; done`,
    'rm -rf "$S"; mkdir -p "$S/rc-before"',
    ...RC_FILES.map(([label, file]) => `[ -f "$H/${file}" ] && cp "$H/${file}" "$S/rc-before/${label}"`),
    'node=$(node -v 2>/dev/null | tr -cd \'A-Za-z0-9._-\')',
    'emit "home=$home,opencode=$oc,fresh=$fresh,node=$node"',
  ].join('\n');
}

export function parseProbe(fields) {
  return {
    homeIsRoot: flagField(fields, 'home'), opencodeExisted: flagField(fields, 'opencode'),
    fresh: flagField(fields, 'fresh'), node: /^[A-Za-z0-9._-]{0,32}$/.test(fields.node ?? '') ? fields.node : '',
  };
}

/**
 * Lines this run added to rc file <label> (written to <out>), read against the
 * probe's snapshot in the SAME container. Only lines naming opencode count as
 * the installer's. Without the snapshot directory (another container, or no
 * probe) nothing counts as added: an unknown origin is never removed.
 */
const rcAddedShell = (label, file, out) => [
  `if [ -d "$S/rc-before" ] && [ -f "$H/${file}" ]; then`,
  `  if [ -f "$S/rc-before/${label}" ]; then grep -vxF -f "$S/rc-before/${label}" "$H/${file}"; else cat "$H/${file}"; fi \\`,
  `    | grep -i opencode > "${out}"`,
  `else : > "${out}"; fi`,
].join('\n');

export function opencodeInstallScript(runId) {
  const p = runPaths(runId);
  return [
    'H="$HOME"',
    `S=${p.scratch}`,
    'mkdir -p "$S"',
    // The official installer, exactly as the user ran it. Its output stays in
    // the per-container scratch log; the terminal shows only the result.
    'timeout 600 bash -c "curl -fsSL https://opencode.ai/install | bash" > "$S/opencode-install.log" 2>&1 < /dev/null; rc=$?',
    'bin=0; [ -x "$H/.opencode/bin/opencode" ] && bin=1',
    ...RC_FILES.map(([label, file]) => rcAddedShell(label, file, `$S/rc-added-${label}`)),
    `out="rc=$rc,bin=$bin"`,
    ...RC_FILES.map(([label]) => `[ -s "$S/rc-added-${label}" ] && out="$out,rc_${label}=$(b64 < "$S/rc-added-${label}")"`),
    'emit "$out"',
  ].join('\n');
}

export function parseOpencodeInstall(fields) {
  const addedRcLines = {};
  for (const [label] of RC_FILES) {
    const value = fields[`rc_${label}`];
    if (value === undefined) continue;
    const lines = decodeB64(value).split('\n').filter(Boolean);
    assert.ok(lines.every(line => /opencode/i.test(line) && !/[\0\r]/.test(line)), 'Unexpected rc lines');
    if (lines.length) addedRcLines[label] = lines;
  }
  return { exitCode: intField(fields, 'rc'), binary: flagField(fields, 'bin'), addedRcLines };
}

export function projectScript(runId) {
  const p = runPaths(runId);
  const pkg = JSON.stringify({ name: p.project, private: true, scripts: { dev: 'next dev' } }, null, 2);
  return [
    'H="$HOME"',
    `S=${p.scratch}`,
    `P="$H/${p.project}"`,
    'mkdir -p "$S" "$P/app"',
    `cat > "$P/package.json" <<'EZQ_EOF'\n${pkg}\nEZQ_EOF`,
    `cat > "$P/app/layout.js" <<'EZQ_EOF'
export const metadata = { title: 'ezq home persistence' };
export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
EZQ_EOF`,
    `cat > "$P/app/page.js" <<'EZQ_EOF'
export default function Page() {
  return <main>${p.marker}</main>;
}
EZQ_EOF`,
    `printf '# EZiL HOME persistence note\\n\\n${p.marker}\\n' > "$H/${p.note}"`,
    `mkdir -p "$H/${p.configDir}"`,
    `printf '{"marker":"${p.marker}","persist":true}\\n' > "$H/${p.config}"`,
    'cd "$P"',
    'NEXT_TELEMETRY_DISABLED=1 timeout 900 npm install --no-audit --no-fund next react react-dom > "$S/npm-install.log" 2>&1 < /dev/null; rc=$?',
    // A real Next.js 16 node_modules is ~350 MiB / ~11k entries: under the 512 MiB system-snapshot
    // limit on its own (measured 2026-10-10). Pad it past the limit, inside node_modules, so a build
    // WITHOUT the HOME-project exclusion deterministically freezes (too_large) and this suite fails.
    '[ "$rc" = 0 ] && mkdir -p "$P/node_modules/.ezq-filler" && head -c 209715200 /dev/urandom > "$P/node_modules/.ezq-filler/blob"',
    'lock=0; [ -f "$P/package-lock.json" ] && lock=1',
    'nextbin=0; [ -x "$P/node_modules/.bin/next" ] && nextbin=1',
    'next=$(node -p "require(\'./node_modules/next/package.json\').version" 2>/dev/null | tr -cd \'A-Za-z0-9._-\')',
    'emit "rc=$rc,lock=$lock,nextbin=$nextbin,next=$next"',
  ].join('\n');
}

export function parseProject(fields) {
  return {
    exitCode: intField(fields, 'rc'), lockfile: flagField(fields, 'lock'), nextBinary: flagField(fields, 'nextbin'),
    nextVersion: /^[A-Za-z0-9._-]{0,40}$/.test(fields.next ?? '') ? fields.next : '',
  };
}

/**
 * sha256 of every target (MISSING when absent), as a manifest digest plus a
 * 16-hex prefix per label. The digest decides equality; prefixes name the
 * differing file while keeping the terminal line short enough to stay in the
 * visible rows the accessibility tree exposes.
 */
export function checksumScript(runId, { sentinel = 'none' } = {}) {
  const p = runPaths(runId);
  assert.ok(['none', 'write', 'check'].includes(sentinel));
  const targets = checksumTargets(runId);
  return [
    'H="$HOME"',
    `S=${p.scratch}`,
    'mkdir -p "$S"',
    'M="$S/manifest.$$"; : > "$M"',
    'out=""',
    'sum() { if [ -f "$H/$2" ]; then v=$(sha256sum < "$H/$2" | cut -c1-64); else v=MISSING; fi; printf \'%s %s\\n\' "$1" "$v" >> "$M"; out="$out,s_$1=$(printf %s "$v" | cut -c1-16)"; }',
    ...targets.map(([label, file]) => `sum ${label} '${file}'`),
    'digest=$(sha256sum < "$M" | cut -c1-64); rm -f "$M"',
    'boot=$(sha256sum < /proc/sys/kernel/random/boot_id 2>/dev/null | cut -c1-16)',
    sentinel === 'write' ? `date +%s > ${p.sentinel}; alive=1` : '',
    sentinel === 'check' ? `alive=0; [ -e ${p.sentinel} ] && alive=1` : '',
    sentinel === 'none' ? 'alive=0' : '',
    'emit "digest=$digest,boot=$boot,alive=$alive$out"',
  ].filter(Boolean).join('\n');
}

export function parseChecksums(fields, runId) {
  assert.match(fields.digest ?? '', /^[a-f0-9]{64}$/, 'Checksum digest missing');
  const prefixes = {};
  for (const [label] of checksumTargets(runId)) {
    const value = fields[`s_${label}`];
    assert.ok(typeof value === 'string' && (/^[a-f0-9]{16}$/.test(value) || value === 'MISSING'), `Checksum ${label} missing`);
    prefixes[label] = value;
  }
  return {
    digest: fields.digest, prefixes,
    bootHash: /^[a-f0-9]{16}$/.test(fields.boot ?? '') ? fields.boot : null,
    sentinelPresent: flagField(fields, 'alive'),
  };
}

/** Equal digests and no missing file; otherwise the labels that differ or are missing. */
export function compareChecksums(before, after) {
  const labels = Object.keys(before.prefixes);
  const missingBefore = labels.filter(l => before.prefixes[l] === 'MISSING');
  const missingAfter = labels.filter(l => after.prefixes[l] === 'MISSING');
  const differing = labels.filter(l => before.prefixes[l] !== after.prefixes[l]);
  const identical = before.digest === after.digest && differing.length === 0;
  return { identical: identical && !missingBefore.length && !missingAfter.length, digestEqual: before.digest === after.digest,
    differing, missingBefore, missingAfter };
}

export function opencodeCheckScript() {
  return [
    'H="$HOME"',
    // An interactive bash reads ~/.bashrc, exactly as a new terminal would.
    "p=$(timeout 60 bash -ic 'command -v opencode' 2>/dev/null < /dev/null | tail -n 1)",
    'resolved=0; [ -n "$p" ] && resolved=1',
    'inhome=0; [ "$p" = "$H/.opencode/bin/opencode" ] && inhome=1',
    "timeout 120 bash -ic 'opencode --version' > /dev/null 2>&1 < /dev/null; vrc=$?",
    'emit "resolved=$resolved,inhome=$inhome,vrc=$vrc"',
  ].join('\n');
}

export function parseOpencodeCheck(fields) {
  return { resolved: flagField(fields, 'resolved'), inHome: flagField(fields, 'inhome'), versionExit: intField(fields, 'vrc') };
}

export const DEPS_BIN = '/usr/local/bin/ezil-deps';
export const DEPS_WAIT_OUTCOMES = Object.freeze({ 0: 'ready', 1: 'failed', 2: 'timeout', 3: 'untracked', 4: 'missing' });
export const DEPS_STATES = Object.freeze(['pending', 'restoring', 'ready', 'failed', 'missing']);
export const depsWaitOutcome = code => DEPS_WAIT_OUTCOMES[code] ?? (code === 124 ? 'harness_timeout' : code === 127 ? 'not_installed' : 'unexpected_exit');

export function depsWaitScript(runId, timeoutSeconds = 600) {
  const p = runPaths(runId);
  assert.ok(Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 3600, 'Invalid deps timeout');
  return [
    'H="$HOME"',
    `S=${p.scratch}`,
    `P="$H/${p.project}"`,
    `D=${DEPS_BIN}`,
    'mkdir -p "$S"',
    'present=0; [ -x "$D" ] && present=1',
    'nm=0; [ -d "$P/node_modules" ] && nm=1',
    'before=$("$D" status "$P" 2>/dev/null | b64)',
    `timeout ${timeoutSeconds + 60} "$D" wait "$P" --timeout ${timeoutSeconds} > "$S/deps-wait.log" 2>&1 < /dev/null; rc=$?`,
    'after=$("$D" status "$P" 2>/dev/null | b64)',
    'nextbin=0; [ -x "$P/node_modules/.bin/next" ] && nextbin=1',
    'emit "present=$present,nm=$nm,rc=$rc,nextbin=$nextbin,before=$before,after=$after"',
  ].join('\n');
}

/** `ezil-deps status` output -> { scanning, entries: [{state, dir}] }; unknown lines are rejected. */
export function parseDepsStatus(text) {
  const result = { scanning: false, entries: [] };
  for (const line of String(text ?? '').split('\n').map(l => l.replace(/\r$/, ''))) {
    if (!line.trim()) continue;
    if (line.trim() === 'scanning') { result.scanning = true; continue; }
    const tab = line.indexOf('\t');
    assert.ok(tab > 0, 'Malformed ezil-deps status line');
    const state = line.slice(0, tab), dir = line.slice(tab + 1);
    assert.ok(DEPS_STATES.includes(state), 'Unknown ezil-deps state');
    assert.ok(dir.startsWith('/'), 'Malformed ezil-deps status directory');
    result.entries.push({ state, dir });
  }
  return result;
}

/** State of exactly this project, or null. Never reports other users' paths. */
export const projectDepsState = (status, projectDir) => status.entries.find(e => e.dir.replace(/\/+$/, '') === projectDir)?.state ?? null;

/**
 * Status is captured, not gated on: output outside the pinned states is
 * recorded as `unrecognized` so the asserted exit code still decides.
 */
const capturedStatus = (encoded, projectDir) => {
  try {
    const status = parseDepsStatus(decodeB64(encoded));
    return { scanning: status.scanning, state: projectDepsState(status, projectDir) };
  } catch { return { scanning: null, state: 'unrecognized' }; }
};

export function parseDepsWait(fields, projectDir) {
  const exitCode = intField(fields, 'rc');
  return {
    installed: flagField(fields, 'present'), nodeModulesAtReopen: flagField(fields, 'nm'), nextBinary: flagField(fields, 'nextbin'),
    exitCode, outcome: depsWaitOutcome(exitCode),
    statusBefore: capturedStatus(fields.before, projectDir),
    statusAfter: capturedStatus(fields.after, projectDir),
  };
}

export function devServerScript(runId, deadlineSeconds = 300) {
  const p = runPaths(runId);
  assert.ok(Number.isInteger(deadlineSeconds) && deadlineSeconds > 0 && deadlineSeconds <= 1800);
  return [
    'H="$HOME"',
    `S=${p.scratch}`,
    `P="$H/${p.project}"`,
    'mkdir -p "$S"',
    // A free loopback port, chosen in the container that will bind it.
    'port=$(node -e "const s=require(\'net\').createServer();s.listen(0,\'127.0.0.1\',()=>{console.log(s.address().port);s.close()})" 2>/dev/null | tr -cd 0-9)',
    '[ -n "$port" ] || port=0',
    'cd "$P" || { emit "port=0,http=000,marker=0,notfound=0,restoring=0,ready=0,exited=1"; exit 0; }',
    // setsid: npm and next share one process group, killed as a unit below.
    'NEXT_TELEMETRY_DISABLED=1 setsid npm run dev -- --port "$port" > "$S/dev.log" 2>&1 < /dev/null &',
    'pid=$!; echo "$pid" > "$S/dev.pid"',
    `http=000; marker=0; exited=0; end=$((SECONDS + ${deadlineSeconds}))`,
    'while [ "$SECONDS" -lt "$end" ]; do',
    '  http=$(curl -s -m 120 -o "$S/body.html" -w "%{http_code}" "http://127.0.0.1:$port/" 2>/dev/null)',
    `  if [ "$http" = 200 ]; then grep -qF '${p.marker}' "$S/body.html" && marker=1; break; fi`,
    '  kill -0 "$pid" 2>/dev/null || { exited=1; break; }',
    '  sleep 2',
    'done',
    "notfound=0; grep -q 'next: not found' \"$S/dev.log\" && notfound=1",
    "restoring=0; grep -q '^EZiL: restoring dependencies for ' \"$S/dev.log\" && restoring=1",
    "ready=0; grep -q '^EZiL: dependencies for .* are ready\\.' \"$S/dev.log\" && ready=1",
    'kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
    'sleep 1; kill -KILL -- "-$pid" 2>/dev/null; rm -f "$S/dev.pid"',
    'emit "port=$port,http=$http,marker=$marker,notfound=$notfound,restoring=$restoring,ready=$ready,exited=$exited"',
  ].join('\n');
}

export function parseDevServer(fields) {
  assert.match(fields.http ?? '', /^\d{3}$/, 'Step result http missing');
  return {
    port: intField(fields, 'port'), httpStatus: Number(fields.http), marker: flagField(fields, 'marker'),
    nextNotFound: flagField(fields, 'notfound'), restoringNotice: flagField(fields, 'restoring'),
    readyNotice: flagField(fields, 'ready'), exitedEarly: flagField(fields, 'exited'),
  };
}

// ---------------------------------------------------------------------------
// Cleanup plan
// ---------------------------------------------------------------------------

/**
 * What this run may remove. ~/.opencode only when the probe proved it absent
 * before this run; rc lines only when this run added them (their exact text,
 * held by the harness so it survives container replacement). Unknown state
 * removes nothing that could predate the run.
 */
export function cleanupPlan({ runId, probe = null, install = null } = {}) {
  const p = runPaths(runId);
  const rcLines = {};
  for (const [label, lines] of Object.entries(install?.addedRcLines ?? {})) {
    assert.ok(RC_FILES.some(([known]) => known === label), 'Unknown rc label');
    const kept = lines.filter(line => typeof line === 'string' && line && /opencode/i.test(line) && !/[\n\r\0]/.test(line));
    if (kept.length) rcLines[label] = kept;
  }
  return {
    runId,
    removePaths: [p.project, p.note, p.configDir],
    removeScratch: [p.scratch, p.sentinel],
    removeOpencode: probe?.opencodeExisted === false,
    rcLines,
    // Same-container fallback when the harness never read the install result.
    rcFromSnapshot: !install,
  };
}

export function cleanupScript(plan) {
  const p = runPaths(plan.runId);
  const lines = [
    'H="$HOME"',
    `S=${p.scratch}`,
    `P="$H/${p.project}"`,
    // A dev server or npm install left by an interrupted step: every process
    // whose working directory is inside this run's project.
    '[ -f "$S/dev.pid" ] && { pid=$(tr -cd 0-9 < "$S/dev.pid"); [ -n "$pid" ] && kill -KILL -- "-$pid" 2>/dev/null; }',
    'for d in /proc/[0-9]*; do c=$(readlink "$d/cwd" 2>/dev/null) || continue; case "$c" in "$P"|"$P"/*) kill -KILL "${d#/proc/}" 2>/dev/null;; esac; done',
  ];
  // awk with an empty first file would treat the rc file as the drop list, so
  // removal only runs when the drop list is non-empty (-s).
  const dropLines = (file, list) => [
    `if [ -s "${list}" ] && [ -f "$H/${file}" ]; then`,
    `  awk 'NR==FNR{drop[$0]=1;next} !($0 in drop)' "${list}" "$H/${file}" > "$S/rc.tmp" && cat "$S/rc.tmp" > "$H/${file}"; rm -f "$S/rc.tmp"`,
    'fi',
  ];
  for (const [label, file] of RC_FILES) {
    const known = plan.rcLines[label];
    if (known?.length) {
      const encoded = Buffer.from(known.join('\n') + '\n').toString('base64');
      lines.push(`mkdir -p "$S"; echo ${encoded} | base64 -d > "$S/drop-${label}"`, ...dropLines(file, `$S/drop-${label}`));
    } else if (plan.rcFromSnapshot) {
      lines.push(rcAddedShell(label, file, `$S/drop-${label}`), ...dropLines(file, `$S/drop-${label}`));
    }
  }
  if (plan.removeOpencode) lines.push('rm -rf "$H/.opencode"');
  for (const path of plan.removePaths) lines.push(`rm -rf "$H/${path}"`);
  lines.push(`rm -rf ${plan.removeScratch.join(' ')}`);
  const checks = plan.removePaths.map(path => `[ -e "$H/${path}" ] && left=1`);
  if (plan.removeOpencode) checks.push('[ -e "$H/.opencode" ] && left=1');
  lines.push('left=0', ...checks);
  lines.push('rcleft=0', ...RC_FILES.map(([label, file]) => (plan.rcLines[label]?.length
    ? plan.rcLines[label].map(line => `grep -qxF '${line.replace(/'/g, `'\\''`)}' "$H/${file}" 2>/dev/null && rcleft=1`).join('\n') : '')).filter(Boolean));
  lines.push('emit "left=$left,rcleft=$rcleft"');
  return lines.join('\n');
}

export function parseCleanup(fields) {
  return { pathsLeft: flagField(fields, 'left'), rcLinesLeft: flagField(fields, 'rcleft') };
}

// ---------------------------------------------------------------------------
// Time budget
// ---------------------------------------------------------------------------

// The CI step allows 45 minutes. A step killed by the runner never reaches
// `finally`: no cleanup, no evidence, and the leftovers get checkpointed by
// the job's final stop. Every wait before cleanup ends by RUN_BUDGET_MS minus
// CLEANUP_RESERVE_MS (cleanup step + ~290 s final stop + evidence).
export const RUN_BUDGET_MS = 38 * 60000;
export const CLEANUP_RESERVE_MS = 7 * 60000;

/** A wait capped at the work deadline; 0 means the budget is spent. Cleanup is never capped. */
export function clampWait(requestedMs, { now, started, cleanup = false, budgetMs = RUN_BUDGET_MS, reserveMs = CLEANUP_RESERVE_MS }) {
  if (cleanup) return requestedMs;
  return Math.max(0, Math.min(requestedMs, started + budgetMs - reserveMs - now));
}

// ---------------------------------------------------------------------------
// Failure codes (the only failure detail that reaches public CI evidence)
// ---------------------------------------------------------------------------

export class AcceptanceFailure extends Error {
  constructor(code) { super(code); this.name = 'AcceptanceFailure'; this.code = code; }
}
export const FAILURE_CODES = Object.freeze([
  'home_not_root', 'run_names_not_fresh', 'opencode_install_failed', 'opencode_unusable_before_stop',
  'project_install_failed', 'setup_files_missing',
  'stop_unconfirmed', 'container_not_replaced', 'checksums_changed', 'opencode_not_resolved', 'opencode_not_in_home',
  'opencode_version_failed', 'deps_tool_missing', 'deps_wait_failed', 'checksums_changed_after_restore',
  'dev_server_not_200', 'dev_marker_missing', 'cleanup_incomplete',
]);
const check = (condition, code) => { if (!condition) throw new AcceptanceFailure(code); };


// ---------------------------------------------------------------------------
// Hosted flow
// ---------------------------------------------------------------------------

async function main() {
  const evidence = { suite: 'hosted-home-persistence', ok: false, phases: [], steps: {} };
  const started = Date.now();
  const phase = name => evidence.phases.push({ name, elapsedMs: Date.now() - started });
  const hash = value => createHash('sha256').update(String(value)).digest('hex');
  let browser, context, page, f, computerId, verifiedComputer = false;
  let runId, probe = null, install = null, setupStarted = false, terminalReady = false, stepInFlight = false, cleanupMode = false;
  let APP, appHeaders, APP_STOP_FETCH_TIMEOUT_MS, stopIsolatedComputer;

  // Page helpers. They read `page`/`f` at call time.
  const wait = ms => page.waitForTimeout(ms);
  const bounded = async (name, action, timeout = 240000) => {
    evidence.operation = name;
    const limit = clampWait(timeout, { now: Date.now(), started, cleanup: cleanupMode });
    if (!limit) { evidence.budgetExhausted = true; throw new Error(`${name}: deadline exceeded`); }
    const end = Date.now() + limit;
    while (Date.now() < end) { const result = await action(); if (result) return result; await wait(1000); }
    throw new Error(`${name}: deadline exceeded`);
  };
  const launch = app => page.evaluate(async app => {
    const payload = window.ezil.session.payload();
    await window.ezil.registry.launch(app, { payload, computer: payload.computer, desktopState: payload.desktopState });
  }, app);
  const close = app => page.evaluate(app => { try { window.$(`.window[data-app="${app}"]`).close(); } catch {} }, app).catch(() => {});
  const codeFrame = () => page.frames().find(frame => /-code\./.test(frame.url()));
  const openCode = async () => {
    await launch('code');
    // A cold computer boots here: hydrate, system layer restore, desktop start.
    return bounded('Code workbench', async () => { const frame = codeFrame(); return frame && await frame.locator('.monaco-workbench').count() ? frame : null; }, 360000);
  };
  const closeModal = async () => {
    const modal = f.locator('.monaco-modal-editor-block:visible');
    if (await modal.count()) {
      await modal.locator('.codicon-close').last().click();
      await bounded('Code modal closed', async () => {
        const save = f.getByRole('button', { name: 'Save', exact: true });
        if (await save.isVisible()) await save.click();
        return !await modal.count();
      }, 15000);
    }
  };
  // Verified workbench identities only; row text includes shortcut labels.
  const commandIds = {
    'Terminal: Create New Terminal': 'workbench.action.terminal.new',
    'Terminal: Focus Terminal': 'workbench.action.terminal.focus',
    'Toggle Screen Reader Accessibility Mode': 'editor.action.toggleScreenReaderAccessibilityMode',
  };
  const command = async text => {
    await closeModal();
    const quick = f.locator('.quick-input-widget input:visible');
    const row = f.locator(`.quick-input-list .monaco-list-row:visible [data-quick-input-id="${commandIds[text]}"]`);
    await bounded('Code command ready', async () => {
      if (!await quick.count()) await f.locator('.command-center').click();
      try { await quick.waitFor({ state: 'visible', timeout: 1000 }); await quick.fill('>' + text); await row.waitFor({ state: 'visible', timeout: 2000 }); return true; } catch { return false; }
    }, 30000);
    await row.click();
    await row.waitFor({ state: 'hidden', timeout: 15000 });
    await wait(1000);
  };
  const terminalInput = () => f.locator('.xterm-helper-textarea').last();
  const terminalText = () => f.locator('.xterm-accessibility-tree').last().innerText({ timeout: 5000 });
  const openTerminal = async () => {
    terminalReady = false;
    f = await openCode();
    await command('Terminal: Create New Terminal');
    // Shell integration decorates the prompt only once the shell accepts input.
    await bounded('terminal prompt', () => f.locator('.xterm-decoration.terminal-command-decoration').count(), 60000);
    // Output is read from xterm's accessibility rows, which exist only in
    // screen reader mode (hosted-continuity turns it on through settings).
    if (!await f.locator('.xterm-accessibility-tree').count()) {
      await command('Toggle Screen Reader Accessibility Mode');
      evidence.screenReaderModeEnabled = true;
      await bounded('terminal accessibility rows', () => f.locator('.xterm-accessibility-tree').count(), 15000);
    }
    await command('Terminal: Focus Terminal');
    await f.locator('.xterm-screen').last().click();
    await bounded('terminal keyboard focus', () => terminalInput().evaluate(el => document.activeElement === el), 10000);
    await wait(1000);
    terminalReady = true;
  };
  const runStep = async (name, body, timeoutMs) => {
    evidence.operation = `step ${name}`;
    const nonce = newNonce();
    const line = stepCommand(nonce, body);
    stepInFlight = true;
    // Ordinary keyboard input, as hosted-continuity types into xterm.
    await terminalInput().pressSequentially(line, { delay: 10, timeout: 120000 });
    await bounded(`step ${name} typed`, async () => (await terminalText()).replace(/\s/g, '').includes(line.slice(-80).replace(/\s/g, '')), 15000);
    await terminalInput().press('Enter');
    const payload = await bounded(`step ${name} result`, async () => {
      try { return readMarker(await terminalText(), nonce); } catch { return null; }
    }, timeoutMs);
    stepInFlight = false;
    return parseFields(payload);
  };

  try {
    // Staging only: refused before any import that reads the target, any
    // credential read and any browser launch.
    try { assertStagingTarget(process.env); } catch (error) {
      evidence.refused = error instanceof TargetRefused ? error.code : 'invalid_target';
      throw error;
    }
    const required = key => { assert.ok(process.env[key], `Missing prerequisite: ${key}`); return process.env[key]; };
    computerId = required('EZIL_E2E_COMPUTER_ID');
    assert.match(computerId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, 'Explicit isolated computer UUID required');
    const email = required('EZIL_E2E_EMAIL'), password = required('EZIL_E2E_PASSWORD');
    const playwrightDir = required('PLAYWRIGHT_REQUIRE_DIR');
    const target = await import('./deployed-target.mjs');
    ({ APP, appHeaders, APP_STOP_FETCH_TIMEOUT_MS } = target);
    const isolated = await import('./isolated-computer.mjs');
    stopIsolatedComputer = isolated.stopIsolatedComputer;
    const { signIn } = await import('./sign-in.mjs');
    // deployedTarget() validated the same variable at import; both must agree.
    assert.equal(APP, assertStagingTarget(process.env), 'Target mismatch');
    runId = newRunId();
    const paths = runPaths(runId);
    evidence.runId = runId;
    evidence.computerHash = hash(computerId);
    const { chromium } = createRequire(playwrightDir + '/test.js')('playwright');

    browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await target.configureAppContext(context);
    page = await context.newPage();
    await page.goto(`${APP}/login?method=email`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await signIn(page, { email, password });
    await page.goto(`${APP}/os`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await isolated.verifySelectedComputer(page, { computerId, required: true });
    verifiedComputer = true;
    phase('signed in to the isolated computer');

    await openTerminal();
    phase('Code terminal ready');

    probe = parseProbe(await runStep('probe', probeScript(runId), 60000));
    evidence.steps.probe = probe;
    check(probe.homeIsRoot, 'home_not_root');
    check(probe.fresh, 'run_names_not_fresh');
    setupStarted = true;

    install = parseOpencodeInstall(await runStep('opencode install', opencodeInstallScript(runId), 660000));
    evidence.steps.opencodeInstall = { exitCode: install.exitCode, binary: install.binary, rcFilesEdited: Object.keys(install.addedRcLines) };
    check(install.exitCode === 0 && install.binary, 'opencode_install_failed');
    phase('OpenCode installed by its official installer');

    const project = parseProject(await runStep('next project', projectScript(runId), 960000));
    evidence.steps.project = project;
    check(project.exitCode === 0 && project.lockfile && project.nextBinary, 'project_install_failed');
    phase('Next.js project installed in HOME');

    // Attribution: a PATH the installer never configured is not a persistence failure.
    const opencodeBefore = parseOpencodeCheck(await runStep('opencode check before stop', opencodeCheckScript(), 240000));
    evidence.steps.opencodeCheckBeforeStop = opencodeBefore;
    check(opencodeBefore.resolved && opencodeBefore.inHome && opencodeBefore.versionExit === 0, 'opencode_unusable_before_stop');

    const before = parseChecksums(await runStep('checksums before', checksumScript(runId, { sentinel: 'write' }), 120000), runId);
    evidence.steps.checksumsBefore = before;
    check(before.sentinelPresent && Object.values(before.prefixes).every(v => v !== 'MISSING'), 'setup_files_missing');
    phase('checksums recorded');

    // The real stop path: final workspace + system checkpoint, then teardown.
    await close('desktop'); await close('code');
    terminalReady = false;
    const stopped = await page.evaluate(async computerId => {
      const response = await fetch('/api/shell/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ computerId }), cache: 'no-store' });
      let json = null; try { json = await response.json(); } catch {}
      return { status: response.status, ok: json?.ok === true, outcome: json?.outcome, terminated: json?.terminated === true };
    }, computerId);
    evidence.stop = { httpStatus: stopped.status, ok: stopped.ok, terminated: stopped.terminated,
      outcome: ['destroyed', 'not_running', 'flush_failed'].includes(stopped.outcome) ? stopped.outcome : 'other' };
    check(stopped.status === 200 && stopped.ok && stopped.outcome === 'destroyed' && stopped.terminated, 'stop_unconfirmed');
    phase('computer stopped through the real stop route');

    await openTerminal();
    phase('computer reopened');

    const after = parseChecksums(await runStep('checksums after', checksumScript(runId, { sentinel: 'check' }), 120000), runId);
    evidence.steps.checksumsAfter = after;
    // Recorded, not asserted: whether a VM boot id changes is a runtime detail.
    evidence.bootIdChanged = before.bootHash && after.bootHash ? before.bootHash !== after.bootHash : null;
    check(!after.sentinelPresent, 'container_not_replaced');
    const comparison = compareChecksums(before, after);
    evidence.checksumComparison = comparison;
    check(comparison.identical, 'checksums_changed');
    phase('HOME files identical after replacement');

    const opencode = parseOpencodeCheck(await runStep('opencode check', opencodeCheckScript(), 240000));
    evidence.steps.opencodeCheck = opencode;
    check(opencode.resolved, 'opencode_not_resolved');
    check(opencode.inHome, 'opencode_not_in_home');
    check(opencode.versionExit === 0, 'opencode_version_failed');
    phase('opencode resolves and runs');

    const deps = parseDepsWait(await runStep('ezil-deps wait', depsWaitScript(runId, 600), 780000), `/root/${paths.project}`);
    evidence.steps.depsWait = deps;
    check(deps.installed, 'deps_tool_missing');
    check(deps.exitCode === 0, 'deps_wait_failed');
    phase('project dependencies restored');

    // A restore must not rewrite the user's manifest or lockfile.
    const settled = parseChecksums(await runStep('checksums after restore', checksumScript(runId), 120000), runId);
    evidence.steps.checksumsAfterRestore = settled;
    check(compareChecksums(before, settled).identical, 'checksums_changed_after_restore');

    const dev = parseDevServer(await runStep('npm run dev', devServerScript(runId, 300), 420000));
    evidence.steps.devServer = dev;
    check(dev.httpStatus === 200, 'dev_server_not_200');
    check(dev.marker, 'dev_marker_missing');
    phase('npm run dev serves the project');

    evidence.ok = true;
  } catch (error) {
    // Driver messages may carry URLs, headers or typed text: publish fixed codes only.
    evidence.ok = false;
    evidence.failure = 'hosted_home_persistence_failed';
    evidence.errorType = ['AssertionError', 'TimeoutError', 'TargetRefused', 'AcceptanceFailure'].includes(error?.name) ? error.name : 'Error';
    if (error instanceof AcceptanceFailure && FAILURE_CODES.includes(error.code)) evidence.failureCode = error.code;
    const missing = String(error?.message).match(/^Missing prerequisite: ([A-Z0-9_]+)$/);
    if (missing) evidence.missingPrerequisite = missing[1];
    evidence.failedPhase = evidence.phases.at(-1)?.name || 'setup';
    console.error(evidence.refused
      ? `REFUSED hosted HOME persistence: ${evidence.refused} (staging only)`
      : 'FAIL hosted HOME persistence: prerequisite or assertion failed');
    process.exitCode = 1;
  } finally {
    // Remove what this run created, in the terminal, BEFORE the final stop:
    // that stop's checkpoint is what makes the removal durable.
    cleanupMode = true;
    if (setupStarted && page) {
      const plan = cleanupPlan({ runId, probe, install });
      evidence.cleanup = { removeOpencode: plan.removeOpencode, rcFiles: Object.keys(plan.rcLines), done: false };
      for (let attempt = 0; attempt < 2 && !evidence.cleanup.done; attempt++) {
        try {
          // A step still running would swallow the typed cleanup: use a new terminal.
          if (!terminalReady || stepInFlight) { stepInFlight = false; await openTerminal(); }
          const result = parseCleanup(await runStep('cleanup', cleanupScript(plan), 120000));
          Object.assign(evidence.cleanup, result, { done: true });
          if (result.pathsLeft || result.rcLinesLeft) {
            evidence.ok = false; evidence.failure ??= 'hosted_home_persistence_failed'; evidence.failureCode ??= 'cleanup_incomplete';
            process.exitCode = 1;
          }
        } catch { terminalReady = false; }
      }
      if (!evidence.cleanup.done) { evidence.ok = false; evidence.failure ??= 'cleanup_failed'; process.exitCode = 1; }
    }
    if (context && verifiedComputer && stopIsolatedComputer) {
      try {
        // Independent of a working page; persists the cleanup above.
        await stopIsolatedComputer(context, computerId, APP, appHeaders, APP_STOP_FETCH_TIMEOUT_MS);
        evidence.cleanupStopped = true;
      } catch { evidence.cleanupStopped = false; evidence.ok = false; evidence.failure ??= 'cleanup_stop_failed'; process.exitCode = 1; }
    }
    try { await browser?.close(); } catch { evidence.ok = false; evidence.failure ??= 'browser_cleanup_failed'; process.exitCode = 1; }
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
    if (evidence.ok) console.log('PASS hosted HOME persistence');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
