import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SYSTEM_SNAPSHOT_SCRIPT, WORKSPACE_PREDICATE_PY } from './system-snapshot-script';

// PR195 review r4241774149, restore side: the system layer leaves out a HOME workspace
// member's node_modules/.next because the locked ROOT's install rebuilds them. So
// restore-deps must install that root once, never inside the member, and must never
// call the member unrestorable ("missing") or leave it untracked while the root's
// install is still running (the npm script-shell gate would not wait).
const SCRIPT = new URL('../scripts/ezil-restore-deps.sh', import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(files: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), 'ezil-restore-deps-ws-'));
  dirs.push(base);
  const ws = join(base, 'ws'), bin = join(base, 'bin'), state = join(base, 'state');
  for (const d of [ws, bin, state]) mkdirSync(d);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), text);
  }
  // Stub package managers: record where they ran and what the status said meanwhile,
  // then build node_modules for the dir and every member a real workspace install would.
  for (const pm of ['npm', 'pnpm', 'yarn', 'bun']) {
    writeFileSync(join(bin, pm), `#!/bin/bash
echo "${pm} $PWD $*" >> "${base}/installs.log"
cp "${state}/status" "${base}/status-during-install" 2>/dev/null
[ -f "$PWD/.fail" ] && exit 1
mkdir -p "$PWD/node_modules"
for m in $(cat "$PWD/.members" 2>/dev/null); do mkdir -p "$PWD/$m/node_modules"; done
exit 0
`);
    chmodSync(join(bin, pm), 0o755);
  }
  const run = () => spawnSync('bash', [SCRIPT, ws], {
    // The stubs shadow the real package managers; everything else (node, which restore-deps
    // uses to read dependencies) comes from the runner's own PATH. CI's node is not in /usr/bin.
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, EZIL_DEPS_STATE_DIR: state, EZIL_DEPS_LOG: join(base, 'restore.log') }, encoding: 'utf8',
  });
  const status = () => Object.fromEntries((existsSync(join(state, 'status')) ? readFileSync(join(state, 'status'), 'utf8') : '')
    .split('\n').filter(Boolean).map((line) => { const [s, d] = line.split('\t'); return [d!.slice(ws.length), s]; }));
  const during = () => existsSync(join(base, 'status-during-install')) ? readFileSync(join(base, 'status-during-install'), 'utf8') : '';
  const installs = () => (existsSync(join(base, 'installs.log')) ? readFileSync(join(base, 'installs.log'), 'utf8') : '')
    .split('\n').filter(Boolean).map((l) => l.replace(ws, ''));
  return { ws, run, status, installs, during };
}

/** Why the script-executing cases may not run here. `null` means they CAN. Same idiom as
 *  `./neko-teardown-orphans.test.ts`. */
const LINUX_ONLY_REASON = process.platform === 'linux'
  ? null
  : `executes scripts/ezil-restore-deps.sh for real (flock and the GNU userland of the Linux `
  + `desktop image, the only place it runs) - not meaningful on ${process.platform}`;
if (LINUX_ONLY_REASON) console.warn(`SKIPPING the restore-deps workspace cases: ${LINUX_ONLY_REASON}.`);
const describeIf = LINUX_ONLY_REASON ? describe.skip : describe;

const WS = (...patterns: string[]) => JSON.stringify({ name: 'root', private: true, workspaces: patterns });
const DEP = JSON.stringify({ name: 'member', dependencies: { react: '19' } });

describeIf('restore-deps: workspace members are restored by their root', () => {
  it('npm: installs the root once and tracks each member with the root, never inside a member', () => {
    const f = fixture({
      'repo/package.json': WS('apps/*'), 'repo/package-lock.json': '{}', 'repo/.members': 'apps/web apps/docs',
      'repo/apps/web/package.json': DEP, 'repo/apps/docs/package.json': DEP,
    });
    const r = f.run();
    expect(r.status).toBe(0);
    expect(f.installs()).toEqual(['npm /repo ci --no-audit --no-fund']);
    expect(f.status()).toEqual({ '/repo': 'ready', '/repo/apps/web': 'ready', '/repo/apps/docs': 'ready' });
    // While the root installed, the members were already tracked as restoring, not missing/untracked.
    expect(f.during()).toContain(`restoring\t${f.ws}/repo/apps/web\t`);
    expect(f.during()).toContain(`restoring\t${f.ws}/repo/apps/docs\t`);
    expect(r.stdout).not.toContain('no lockfile was saved');
  });

  it('a failed root install marks its members failed too', () => {
    const f = fixture({
      'repo/package.json': WS('apps/*'), 'repo/package-lock.json': '{}', 'repo/.fail': '',
      'repo/apps/web/package.json': DEP,
    });
    f.run();
    expect(f.status()).toEqual({ '/repo': 'failed', '/repo/apps/web': 'failed' });
  });

  it('pnpm reads pnpm-workspace.yaml; a member the root does not declare keeps today\'s "missing" report', () => {
    const f = fixture({
      'mono/package.json': '{"name":"mono"}', 'mono/pnpm-lock.yaml': 'lockfileVersion: 9', 'mono/.members': 'apps/site',
      'mono/pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n",
      'mono/apps/site/package.json': DEP, 'mono/apps/legacy/package.json': DEP,
    });
    f.run();
    expect(f.installs()).toEqual(['pnpm /mono install --prefer-frozen-lockfile']);
    expect(f.status()).toEqual({ '/mono': 'ready', '/mono/apps/site': 'ready', '/mono/apps/legacy': 'missing' });
  });

  it('a member whose root already has node_modules is left alone; a member with its own lockfile installs itself', () => {
    const f = fixture({
      'repo/package.json': WS('apps/*'), 'repo/package-lock.json': '{}', 'repo/node_modules/.keep': '',
      'repo/apps/web/package.json': DEP,
      'repo/apps/own/package.json': DEP, 'repo/apps/own/yarn.lock': '',
    });
    f.run();
    expect(f.installs()).toEqual(['yarn /repo/apps/own install --frozen-lockfile']);
    expect(f.status()).toEqual({ '/repo/apps/own': 'ready' });
  });

});

describe('restore-deps: the embedded workspace predicate', () => {
  it('restore-deps embeds the system layer\'s workspace predicate byte for byte', () => {
    // A Windows checkout may turn LF into CRLF; the image always gets LF.
    const script = readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
    const begin = '# --- WORKSPACE_PREDICATE_PY ---\n', end = '# --- end WORKSPACE_PREDICATE_PY ---\n';
    expect(script.slice(script.indexOf(begin) + begin.length, script.indexOf(end))).toBe(WORKSPACE_PREDICATE_PY);
    expect(SYSTEM_SNAPSHOT_SCRIPT).toContain(WORKSPACE_PREDICATE_PY);
    expect(WORKSPACE_PREDICATE_PY).toContain('def workspace_root_within(home, project, exists, read):');
  });
});
