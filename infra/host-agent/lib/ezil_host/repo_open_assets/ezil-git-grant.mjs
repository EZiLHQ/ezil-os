// EZiL Git credential helper (contract universe-repo-open-v1 §9.6). Git runs it through the
// fixed wrapper /run/ezil/bin/ezil-git-grant, named by the repository's own .git/config:
//
//   get         answer from /run/ezil/git/grants/<handle>__<name>.json when that file is a
//               regular, uid-0, mode-0600 file whose protocol, host and path equal the
//               request's and whose grant has more than 30 s left; otherwise `quit=1`
//               plus one fixed stderr line, so git stops and never prompts.
//   anything else (store, erase, capability, …) exits 0 silently.
//
// Reads no environment variable. Never echoes its input.
import fs from 'node:fs';

const GRANTS_DIR = '/run/ezil/git/grants';
const STDIN_MAX_BYTES = 4096;
const GRANT_MAX_BYTES = 4096;
const MIN_REMAINING_MS = 30000;
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
const GRANT_RE = /^egg_[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const GRANT_KEYS = ['v', 'protocol', 'host', 'path', 'username', 'password', 'expiresAt', 'scope'];
export const HINT_NOT_CONNECTED = 'EZiL: Git access for this repository is not connected. Reopen it from EZiL OS.';
export const hintExpired = (handle, name) => `EZiL: Git access for ${handle}/${name} expired. Reopen it from EZiL OS (Code renews it while open).`;

/** `<handle>/<name>.git` → {handle, name}, or null. */
export function parseRoute(path) {
  const m = typeof path === 'string' ? /^([^/]+)\/([^/]+)\.git$/.exec(path) : null;
  if (!m) return null;
  const [, handle, name] = m;
  if (!HANDLE_RE.test(handle) || !NAME_RE.test(name) || name.includes('..') || name.endsWith('.git')) return null;
  return { handle, name };
}

/** git credential attributes (`key=value` lines up to a blank line); later keys win, as in git. */
export function parseAttributes(text) {
  const attrs = Object.create(null);
  for (const line of text.split('\n')) {
    if (line === '') break;
    const eq = line.indexOf('=');
    if (eq <= 0) return null;
    attrs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return attrs;
}

/** Decide a `get`: the stdout lines to print, or null to refuse. Pure apart from reading the grant file. */
export function answer(input, now = Date.now()) {
  if (input === null) return null;
  const attrs = parseAttributes(input);
  if (!attrs || attrs.protocol !== 'https' || !attrs.host || !attrs.path) return null;
  const route = parseRoute(attrs.path);
  if (!route) return null;
  const file = `${GRANTS_DIR}/${route.handle}__${route.name}.json`;
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile() || st.uid !== 0 || (st.mode & 0o777) !== 0o600 || st.size > GRANT_MAX_BYTES) return null;
  let grant;
  try { grant = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!grant || typeof grant !== 'object' || Array.isArray(grant) || Object.keys(grant).length !== GRANT_KEYS.length
    || !GRANT_KEYS.every((k) => Object.prototype.hasOwnProperty.call(grant, k))) return null;
  if (grant.v !== 1 || grant.protocol !== attrs.protocol || grant.host !== attrs.host || grant.path !== attrs.path
    || grant.username !== 'ezil' || typeof grant.password !== 'string' || !GRANT_RE.test(grant.password)) return null;
  const expiresAt = typeof grant.expiresAt === 'string' && ISO_RE.test(grant.expiresAt) ? Date.parse(grant.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt - now <= MIN_REMAINING_MS) return null;
  return [`username=${grant.username}`, `password=${grant.password}`, `password_expiry_utc=${Math.floor(expiresAt / 1000)}`];
}

/** stdin as text, or null when it exceeds the cap (read to EOF either way, so git never sees EPIPE). */
function readStdin(limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    process.stdin.on('data', (chunk) => {
      total += chunk.length;
      if (total <= limit) chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(total > limit ? null : Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(null));
  });
}

async function main(operation) {
  const input = await readStdin(STDIN_MAX_BYTES);
  if (operation !== 'get') return;
  const lines = answer(input);
  if (lines) {
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  const attrs = input === null ? null : parseAttributes(input);
  const route = attrs ? parseRoute(attrs.path) : null;
  process.stderr.write(`${route ? hintExpired(route.handle, route.name) : HINT_NOT_CONNECTED}\n`);
  process.stdout.write('quit=1\n');
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}
if (invokedDirectly()) await main(process.argv[2]);
