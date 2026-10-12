/**
 * Hosted STAGING acceptance: a user's HOME survives container replacement.
 *
 * Regression for the hosted bug where a Next.js project in ~/ pushed the system
 * layer over its snapshot limits (every later save skipped as `too_large`), so
 * a replaced container lost OpenCode (~/.opencode + its ~/.bashrc PATH line),
 * the project's `next` binary and the user's notes. On the explicitly isolated
 * E2E computer, through Code's ordinary terminal, this suite:
 *   1. installs OpenCode (pinned OPENCODE_VERSION) with its official installer, creates a real Next.js
 *      app (npm install -> package-lock.json), a note and a config file, all
 *      under per-run names, and records their sha256;
 *   2. waits at least 90 s after the last write, cuts power without a final
 *      checkpoint and proves the container was replaced (a /tmp sentinel, which
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
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
  // The result is also kept in a file, so the driver can show it again if the
  // line scrolled out of (or never rendered in) the terminal's visible rows.
  "emit() { printf 'EZQ:%s:%s:END\\n' \"$N\" \"$1\" | tee -a \"/tmp/ezq-result-$N\"; }",
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

/**
 * Longest line ever typed into the hosted terminal. Staging (2026-10-11) showed a
 * 605-char line verified and an 853-char one never did: xterm's accessibility rows
 * do not reliably expose the tail of a long wrapped input line. Every typed line
 * stays well under the proven length.
 */
export const MAX_TYPED_LINE = 480;
const STEP_CHUNK = 300;

/**
 * How one step reaches the shell. Short steps: one line. Long steps: each base64
 * chunk goes to its own file and the shell ACKNOWLEDGES it with the byte count it
 * wrote; the driver waits for that exact ack (retyping a chunk on a missing or
 * wrong ack) before the final short line decodes and runs the script. Nothing
 * depends on the terminal echoing typed input (staging 2026-10-11: echoes were
 * unreliable and a garbled chunk silently produced no result).
 */
export function stepPlan(nonce, body) {
  const single = stepCommand(nonce, body);
  if (single.length <= MAX_TYPED_LINE) return { chunks: [], run: single };
  const script = `${PRELUDE(nonce)}\n${body}\n`;
  const encoded = gzipSync(Buffer.from(script)).toString('base64');
  const base = `/tmp/ezq-step-${assertNonce(nonce)}`;
  const chunks = [];
  for (let i = 0, index = 0; i < encoded.length; i += STEP_CHUNK, index++) {
    const part = encoded.slice(i, i + STEP_CHUNK);
    const file = `${base}.${String(index).padStart(3, '0')}`;
    // The typed line contains "$(wc", never digits after the last colon, so its
    // echo can never satisfy the ack pattern.
    chunks.push({ index, bytes: part.length,
      line: `printf %s '${part}' > ${file} && echo "EZQC:${nonce}:${index}:$(wc -c < ${file})"` });
  }
  return { chunks, run: `bash -c "$(cat ${base}.* | base64 -d | gzip -dc)"; rm -f ${base}.*` };
}

/** True when the terminal text holds this chunk's ack with the exact byte count. */
export function chunkAcked(text, nonce, index, bytes) {
  const compact = String(text ?? '').replace(/\s/g, '');
  return new RegExp(`EZQC:${assertNonce(nonce)}:${index}:${bytes}(?![0-9])`).test(compact);
}

/** Every line a step may type (chunks, then the run line). */
export function stepLines(nonce, body) {
  const plan = stepPlan(nonce, body);
  return [...plan.chunks.map(c => c.line), plan.run];
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

/**
 * The OpenCode release the suite installs, with the official installer. Pinned
 * because the installer's latest-version lookup is an unauthenticated
 * api.github.com call (60/h per IP; Cloudflare egress is shared) made BEFORE it
 * checks an existing install: rate-limited, it exits 1 even with OpenCode
 * installed. `--version V` skips that lookup (opencode.ai/install, read
 * 2026-10-12): it HEADs github.com/anomalyco/opencode/releases/tag/vV (fails
 * only on 404), exits 0 when `opencode --version` on PATH already prints V, and
 * otherwise downloads releases/download/vV/opencode-linux-x64*.tar.gz.
 * 1.18.35 (2026-10-06) is the newest patch of the previous minor line; 1.19.0
 * was one day old. `opencode --version` prints the bare version.
 */
export const OPENCODE_VERSION = '1.18.35';
export const OPENCODE_INSTALLER_URL = 'https://opencode.ai/install';
/** The only install failure detail that leaves the container, found by grep. */
export const OPENCODE_INSTALL_FAILURES = Object.freeze([
  'none', 'timeout', 'installer_fetch', 'version_fetch', 'release_missing', 'download', 'extract', 'version_mismatch', 'other',
]);

export function opencodeInstallScript(runId, { installerUrl = OPENCODE_INSTALLER_URL, version = OPENCODE_VERSION,
  timeoutSeconds = 600, retryDelaySeconds = 5 } = {}) {
  const p = runPaths(runId);
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Invalid OpenCode version');
  assert.ok(installerUrl === OPENCODE_INSTALLER_URL || /^file:\/\/\/[A-Za-z0-9._/-]+$/.test(installerUrl), 'Invalid installer URL');
  assert.ok(Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 600, 'Invalid install timeout');
  assert.ok(Number.isInteger(retryDelaySeconds) && retryDelaySeconds >= 0 && retryDelaySeconds <= 30, 'Invalid retry delay');
  return [
    'H="$HOME"',
    `S=${p.scratch}`,
    'mkdir -p "$S"',
    'set -o pipefail',
    `V=${version}`,
    'before=0; [ -x "$H/.opencode/bin/opencode" ] && before=1',
    // The official installer, saved to a file first: `curl | bash` exits 0 when
    // the fetch fails, so a pre-existing binary passed without any install.
    'I="$S/opencode-install.sh"; L="$S/opencode-install.log"; rm -f "$I"; : > "$L"; fetched=0',
    `for a in 1 2 3; do curl -fsSL --connect-timeout 20 --max-time 120 -o "$I" '${installerUrl}' >> "$S/opencode-fetch.log" 2>&1 && [ -s "$I" ] && { fetched=1; break; }; [ "$a" -lt 3 ] && sleep ${retryDelaySeconds}; done`,
    // Its output stays in the per-container scratch log; the terminal shows only the result.
    `rc=1; [ "$fetched" = 1 ] && { timeout ${timeoutSeconds} bash "$I" --version "$V" > "$L" 2>&1 < /dev/null; rc=$?; }`,
    'bin=0; [ -x "$H/.opencode/bin/opencode" ] && bin=1',
    // Pass only on the pinned version at the installer's own location: an existing binary alone proves nothing.
    'got=""; [ "$bin" = 1 ] && got=$(timeout 60 "$H/.opencode/bin/opencode" --version 2>/dev/null < /dev/null | head -n 1 | tr -cd "A-Za-z0-9._-")',
    'ver=0; [ -n "$got" ] && [ "$got" = "$V" ] && ver=1',
    'if [ "$fetched" != 1 ]; then fail=installer_fetch',
    'elif [ "$rc" = 124 ] || [ "$rc" = 137 ]; then fail=timeout',
    'elif [ "$rc" != 0 ] && grep -q "Failed to fetch version information" "$L"; then fail=version_fetch',
    'elif [ "$rc" != 0 ] && grep -qE "Release v[^ ]* not found" "$L"; then fail=release_missing',
    'elif [ "$rc" != 0 ] && grep -qE "^(tar|gzip): |not in gzip format" "$L"; then fail=extract',
    'elif [ "$rc" != 0 ] && grep -qE "curl: \\([0-9]+\\)" "$L"; then fail=download',
    'elif [ "$rc" != 0 ]; then fail=other',
    'elif [ "$ver" != 1 ]; then fail=version_mismatch',
    'else fail=none; fi',
    ...RC_FILES.map(([label, file]) => rcAddedShell(label, file, `$S/rc-added-${label}`)),
    'out="rc=$rc,bin=$bin,ver=$ver,fail=$fail,before=$before"',
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
  assert.ok(OPENCODE_INSTALL_FAILURES.includes(fields.fail), 'Step result fail missing');
  return {
    exitCode: intField(fields, 'rc'), binary: flagField(fields, 'bin'), versionMatches: flagField(fields, 'ver'),
    failure: fields.fail, before: flagField(fields, 'before'), addedRcLines,
  };
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

/** Fixed-vocabulary process snapshot for a step that never returned (no paths, no args). */
export function hangDiagnosticScript(stuckNonce) {
  assertNonce(stuckNonce);
  return [
    "procs=$(ps -eo stat=,comm= 2>/dev/null | awk '{print $2\"_\"substr($1,1,1)}' | grep -E '^(sha256sum|cat|base64|gzip|tee|npm|node|python3|tar|sleep|bash|sh|ezil-deps|ezil-restore-d)_' | sort | uniq -c | awk '{printf \"%s-%s.\", $2, $1}')",
    "load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)",
    `result=0; [ -f /tmp/ezq-result-${stuckNonce} ] && result=1`,
    `chunks=$(ls /tmp/ezq-step-${stuckNonce}.* 2>/dev/null | wc -l)`,
    'emit "procs=${procs:-none},load=${load:-0},result=$result,chunks=$chunks"',
  ].join('\n');
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
    // An interactive bash reads ~/.bashrc, exactly as a new terminal would. setsid gives it
    // its own session: run inside the hosted terminal, a bare 'bash -ic' takes over the
    // terminal's foreground group and the rest of this step is stopped (SIGTTOU/SIGTTIN)
    // before it can print its marker (reproduced locally on code-server).
    "p=$(timeout 60 setsid -w bash -ic 'command -v opencode' 2>/dev/null < /dev/null | tail -n 1)",
    'resolved=0; [ -n "$p" ] && resolved=1',
    'inhome=0; [ "$p" = "$H/.opencode/bin/opencode" ] && inhome=1',
    "timeout 120 setsid -w bash -ic 'opencode --version' > /dev/null 2>&1 < /dev/null; vrc=$?",
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

/**
 * Fixed facts right after the switch-on (counts and 0/1 only, no paths or contents):
 * was the container really replaced, which saved files came back, did the system
 * layer restore, and did the dependency restore start, log or finish anything.
 */
export function restoreFactsScript(runId) {
  const p = runPaths(runId);
  const f = (name, test) => `${name}=0; ${test} && ${name}=1`;
  return [
    'H="$HOME"',
    `replaced=1; [ -e ${p.sentinel} ] && replaced=0`,
    f('pkg', `[ -f "$H/${p.project}/package.json" ]`),
    f('lock', `[ -f "$H/${p.project}/package-lock.json" ]`),
    f('nm', `[ -e "$H/${p.project}/node_modules" ]`),
    f('opencode', '[ -x "$H/.opencode/bin/opencode" ]'),
    f('sysmanifest', '[ -f /var/lib/ezil-system/manifest.json ]'),
    f('syshydrated', '[ -f /var/lib/ezil-system/hydrated ]'),
    'sysage=-1; [ -f /var/lib/ezil-system/manifest.json ] && sysage=$(( $(date +%s) - $(stat -c %Y /var/lib/ezil-system/manifest.json) ))',
    f('log', '[ -f /tmp/ezil-restore-deps.log ]'),
    'installing=$(grep -c ": installing" /tmp/ezil-restore-deps.log 2>/dev/null); done_=$(grep -c ": done" /tmp/ezil-restore-deps.log 2>/dev/null); failed=$(grep -c ": FAILED" /tmp/ezil-restore-deps.log 2>/dev/null)',
    'tracked=$(wc -l < /run/ezil-deps/status 2>/dev/null)',
    f('bootmarker', '[ -e /run/ezil-deps/boot-restore ]'),
    f('scanned', '[ -e /run/ezil-deps/scanned ]'),
    'running=$(pgrep -fc ezil-restore-deps 2>/dev/null)',
    f('script', '[ -x /usr/local/bin/ezil-restore-deps.sh ]'),
    'emit "replaced=$replaced,pkg=$pkg,lock=$lock,nm=$nm,opencode=$opencode,sysmanifest=$sysmanifest,syshydrated=$syshydrated,sysage=$sysage,log=$log,installing=${installing:-0},done=${done_:-0},failed=${failed:-0},tracked=${tracked:-0},bootmarker=$bootmarker,scanned=$scanned,running=${running:-0},script=$script"',
  ].join('\n');
}

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
export const POWER_CUT_RPO_MS = 90000;

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
  'power_cut_unconfirmed', 'container_not_replaced', 'checksums_changed', 'opencode_not_resolved', 'opencode_not_in_home',
  'opencode_version_failed', 'deps_tool_missing', 'deps_wait_failed', 'checksums_changed_after_restore',
  'dev_server_not_200', 'dev_marker_missing', 'cleanup_incomplete',
]);
const check = (condition, code) => { if (!condition) throw new AcceptanceFailure(code); };

// Phase and operation names are code literals; anything else (a URL, typed text) prints as `unlisted`.
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,79}$/;
const publicName = value => value === undefined || value === null ? 'none' : (NAME.test(value) && !value.includes('//') ? value : 'unlisted');
const ERROR_TYPES = ['AssertionError', 'TimeoutError', 'TargetRefused', 'AcceptanceFailure', 'Error'];

/** One stdout line for the public job log: allow-listed codes and literal names only, never raw errors. */
export function publicFailureLine({ failureCode, failedPhase, failedOperation, errorType, install, missingPrerequisite } = {}) {
  const fields = [
    ['code', FAILURE_CODES.includes(failureCode) ? failureCode : 'none'],
    ['phase', publicName(failedPhase)],
    ['operation', publicName(failedOperation)],
    ['error', ERROR_TYPES.includes(errorType) ? errorType : 'none'],
    ['install_fail', OPENCODE_INSTALL_FAILURES.includes(install?.failure) ? install.failure : 'none'],
    ['install_before', typeof install?.before === 'boolean' ? (install.before ? '1' : '0') : 'none'],
    ['missing', /^[A-Z][A-Z0-9_]{0,63}$/.test(missingPrerequisite ?? '') ? missingPrerequisite : 'none'],
  ];
  return `FAIL-DETAIL hosted HOME persistence: ${fields.map(([k, v]) => `${k}=${v}`).join('; ')}`;
}

/** Same signed control request as hosted-continuity; no final-save endpoint. */
export async function powerCutAfterRpo({ sandboxId, worker, secret, lastWriteFinishedAt, evidence,
  wait, now = Date.now, fetchImpl = fetch }) {
  assert.ok(Number.isFinite(lastWriteFinishedAt), 'Missing last write completion time');
  assert.match(sandboxId, /^guac-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/);
  evidence.operation = 'power cut RPO wait';
  let remaining;
  while ((remaining = lastWriteFinishedAt + POWER_CUT_RPO_MS - now()) > 0) {
    await wait(Math.min(1000, remaining));
  }
  evidence.operation = 'power cut';
  const timestamp = now();
  const signature = createHmac('sha256', secret).update(`${timestamp}.POST./sandbox/preview.`).digest('hex');
  evidence.powerCut = { writeAgeMs: timestamp - lastWriteFinishedAt };
  const response = await fetchImpl(`${worker.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxId)}/acceptance-fault`, {
    method: 'POST', headers: { authorization: `Bearer t=${timestamp},v1=${signature}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fault: 'power_cut' }), signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  evidence.powerCut.httpStatus = response.status;
  check(response.status === 200, 'power_cut_unconfirmed');
  evidence.powerCut.ok = (await response.json()).ok === true;
  check(evidence.powerCut.ok, 'power_cut_unconfirmed');
}


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
  // Frames of a Code window from a container that no longer exists (power cut):
  // never reused, even while the closed window's iframe is still attached.
  // Fixed observations from the app (session cookies, same routes the shell uses):
  // the runtime id changes whenever the container is replaced; persistence codes
  // are the Worker's own restore/save outcomes. Hashes and codes only.
  const runtimeHash = async () => {
    try {
      const r = await page.evaluate(async id => { const res = await fetch(`/api/shell/relay-refresh?computerId=${encodeURIComponent(id)}`, { cache: 'no-store' }); return { status: res.status, json: await res.json().catch(() => ({})) }; }, computerId);
      return r.json?.ok && typeof r.json.runtimeId === 'string' ? hash(r.json.runtimeId).slice(0, 16) : `http_${r.status}`;
    } catch { return 'unavailable'; }
  };
  const persistenceCodes = async () => {
    try {
      const r = await page.evaluate(async id => { const res = await fetch(`/api/trpc/cloudflareGuacamole.persistenceState?input=${encodeURIComponent(JSON.stringify({ json: { computerId: id } }))}`, { cache: 'no-store' }); return res.json().catch(() => null); }, computerId);
      const st = r?.result?.data?.json?.status;
      return st ? { system: st.system?.code, workspace: st.workspace?.code, paused: st.savingPaused, lastStopDiscarded: st.lastStopDiscardedUnsaved } : { unavailable: true };
    } catch { return { unavailable: true }; }
  };
  const retiredFrames = new Set();
  let commandReadyMs = 30000;
  let lastStepNonce = null;
  // Only a Code window's own frame: VS Code's webview iframes live on the same
  // -code host INSIDE it and hold no workbench (picking one hung staging run
  // 38196982158 at 'Code workbench' for 6 min).
  const isCode = frame => /-code\./.test(frame?.url() ?? '');
  const codeFrame = () => page.frames().filter(frame => isCode(frame) && !isCode(frame.parentFrame())
    && !frame.isDetached() && !retiredFrames.has(frame)).at(-1);
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
    let attempt = 0;
    await bounded('Code command ready', async () => {
      try {
        // A cold workbench may not have its title-bar search yet: alternate with F1.
        if (!await quick.count()) {
          if (attempt++ % 2 === 0) await f.locator('.command-center').click({ timeout: 2000 });
          else await f.locator('.monaco-workbench').press('F1', { timeout: 2000 });
        }
        await quick.waitFor({ state: 'visible', timeout: 1000 }); await quick.fill('>' + text); await row.waitFor({ state: 'visible', timeout: 2000 }); return true;
      } catch { return false; }
    }, commandReadyMs);
    await row.click();
    await row.waitFor({ state: 'hidden', timeout: 15000 });
    await wait(1000);
  };
  // The terminal itself, never its sticky-scroll overlay: VS Code adds a second
  // xterm (.terminal-sticky-scroll) once output scrolls, it takes focus, and a
  // bare '.last()' then types into the overlay (reproduced locally on code-server,
  // the cause of staging's silent 'step probe result').
  const MAIN_XTERM = '.terminal-wrapper.active > .terminal-xterm-host > .xterm';
  const terminalInput = () => f.locator(`${MAIN_XTERM} .xterm-helper-textarea`).first();
  // Every terminal's accessibility rows, not just the last: Code may restore an earlier
  // terminal beside the new one (2026-10-11 staging: 'step probe typed' never matched).
  const terminalText = async () => (await f.locator(`${MAIN_XTERM} .xterm-accessibility-tree`).allInnerTexts()).join('\n');
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
    await f.locator(`${MAIN_XTERM} .xterm-screen`).first().click();
    await bounded('terminal keyboard focus', () => terminalInput().evaluate(el => document.activeElement === el), 10000);
    await wait(1000);
    terminalReady = true;
  };
  const runStep = async (name, body, timeoutMs) => {
    evidence.operation = `step ${name}`;
    const nonce = newNonce();
    lastStepNonce = nonce;
    stepInFlight = true;
    // Ordinary keyboard input, as hosted-continuity types into xterm, in lines
    // short enough for the terminal's accessibility rows to show in full.
    const plan = stepPlan(nonce, body);
    const type = async line => {
      await terminalInput().pressSequentially(line, { delay: 10, timeout: 120000 });
      await wait(200);
      await terminalInput().press('Enter');
    };
    for (const chunk of plan.chunks) {
      let acked = false;
      for (let attempt = 1; attempt <= 3 && !acked; attempt++) {
        if (attempt > 1) { evidence.chunkRetries = (evidence.chunkRetries ?? 0) + 1; await terminalInput().press('Control+C'); await wait(500); }
        await type(chunk.line);
        acked = await bounded(`step ${name} chunk`, async () => {
          try { return chunkAcked(await terminalText(), nonce, chunk.index, chunk.bytes); } catch { return false; }
        }, 20000).catch(() => false);
      }
      if (!acked) throw new Error(`step ${name} chunk: deadline exceeded`);
    }
    evidence.operation = `step ${name}`;
    await type(plan.run);
    // If the marker is not on screen, re-show the persisted result with a short
    // line every 20 s; a missing file means the script itself has not finished.
    let lastReshow = Date.now();
    const payload = await bounded(`step ${name} result`, async () => {
      let found = null;
      try { found = readMarker(await terminalText(), nonce); } catch {}
      if (found) return found;
      if (Date.now() - lastReshow >= 20000) {
        lastReshow = Date.now();
        evidence.resultReshows = (evidence.resultReshows ?? 0) + 1;
        try { await type(`cat /tmp/ezq-result-${nonce} 2>/dev/null || echo "EZQS:${nonce}:pending:$(ls /tmp/ezq-step-${nonce}.* 2>/dev/null | wc -l)"`); } catch {}
      }
      return null;
    }, timeoutMs).catch(async error => {
      // Fixed diagnostics only: did the script ever finish, and are its chunks still there?
      try {
        const text = (await terminalText()).replace(/\s/g, '');
        const status = text.match(new RegExp(`EZQS:${nonce}:pending:([0-9]+)`, 'g'));
        evidence.resultDiagnostic = status ? { resultFile: false, chunkFiles: Number(status.at(-1).split(':').at(-1)) } : { resultFile: 'unknown' };
      } catch {}
      throw error;
    });
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
    const worker = required('EZIL_E2E_WORKER'), secret = required('EZIL_ACCEPTANCE_HMAC_SECRET');
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
    const sandboxId = await page.evaluate(() => {
      const payload = window.ezil.session.payload();
      const compact = id => id.replace(/[^a-z0-9]/gi, '').slice(0, 16);
      return `guac-${compact(payload.user.id)}-${compact(payload.computer.id)}`;
    });
    phase('signed in to the isolated computer');

    await openTerminal();
    phase('Code terminal ready');

    probe = parseProbe(await runStep('probe', probeScript(runId), 60000));
    evidence.steps.probe = probe;
    check(probe.homeIsRoot, 'home_not_root');
    check(probe.fresh, 'run_names_not_fresh');
    setupStarted = true;

    install = parseOpencodeInstall(await runStep('opencode install', opencodeInstallScript(runId), 660000));
    evidence.steps.opencodeInstall = { exitCode: install.exitCode, binary: install.binary, versionMatches: install.versionMatches,
      failure: install.failure, before: install.before, pinnedVersion: OPENCODE_VERSION, rcFilesEdited: Object.keys(install.addedRcLines) };
    check(install.exitCode === 0 && install.binary && install.versionMatches && install.failure === 'none', 'opencode_install_failed');
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
    const lastWriteFinishedAt = Date.now();
    evidence.steps.checksumsBefore = before;
    check(before.sentinelPresent && Object.values(before.prefixes).every(v => v !== 'MISSING'), 'setup_files_missing');
    phase('checksums recorded');

    // Keep Code open during the RPO window, then pull power without saving.
    await powerCutAfterRpo({ sandboxId, worker, secret, lastWriteFinishedAt, evidence,
      wait: async ms => {
        if (clampWait(ms, { now: Date.now(), started }) < ms) {
          evidence.budgetExhausted = true;
          throw new Error('power cut RPO wait: deadline exceeded');
        }
        await wait(ms);
      },
    });
    terminalReady = false;
    phase('computer power cut without a final checkpoint');
    if (f) retiredFrames.add(f);
    await close('desktop'); await close('code');
    // The replacement container cold-boots: restore, system layer, desktop, Code.
    commandReadyMs = 120000;
    await openTerminal();
    phase('computer reopened');
    evidence.runtimeAtReopen = await runtimeHash();

    // Right after a replacement the computer is busiest: the boot restore is
    // reinstalling the HOME project's dependencies. Wait for that first (what a
    // user would see), then compare; the first comparison still gets 10 min.
    // Observation only: what the replacement container holds right after the switch-on.
    try { evidence.restoreFacts = parseFields(await runStep('restore facts', restoreFactsScript(runId), 60000)); }
    catch { evidence.restoreFacts = { unavailable: '1' }; }
    const deps = parseDepsWait(await runStep('ezil-deps wait', depsWaitScript(runId, 600), 780000), `/root/${paths.project}`);
    evidence.steps.depsWait = deps;
    check(deps.installed, 'deps_tool_missing');
    check(deps.exitCode === 0, 'deps_wait_failed');
    phase('project dependencies restored');

    const after = parseChecksums(await runStep('checksums after', checksumScript(runId, { sentinel: 'check' }), 600000), runId);
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
    evidence.failedOperation = evidence.operation;
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
    // The job log must explain a failure without the artifact: fixed fields only.
    if (!evidence.refused) console.log(publicFailureLine({ ...evidence, install: evidence.steps?.opencodeInstall }));
    process.exitCode = 1;
  } finally {
    // A step that never returned: from a NEW terminal, record which known processes
    // are alive and in what state (R run, S sleep, D disk wait, T stopped), the load,
    // and whether the stuck step ever wrote its result. Fixed names, no paths.
    if (!evidence.ok && page && evidence.runtimeAtReopen) {
      evidence.runtimeAtFailure = await runtimeHash();
      evidence.containerReplacedAgain = evidence.runtimeAtFailure !== evidence.runtimeAtReopen;
      evidence.persistenceAtFailure = await persistenceCodes();
    }
    if (!evidence.ok && stepInFlight && lastStepNonce && page) {
      try {
        const stuck = lastStepNonce;
        stepInFlight = false; await openTerminal();
        evidence.hangDiagnostic = parseFields(await runStep('hang diagnostic', hangDiagnosticScript(stuck), 60000));
      } catch { evidence.hangDiagnostic = { unavailable: '1' }; }
    }
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
