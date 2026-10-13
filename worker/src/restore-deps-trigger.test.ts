import { describe, expect, it, mock } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// index.ts imports @cloudflare/sandbox, which imports the workerd-only
// 'cloudflare:workers'; stub it exactly as index.test.ts does.
mock.module('cloudflare:workers', () => ({
  DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {},
}));
const { restoreDepsCommand } = await import('./index');

describe('restore-deps after a fresh restore', () => {
  it('starts the boot restore for the workspace and every home, with the readiness marker', () => {
    const cmd = restoreDepsCommand('/workspace');
    expect(cmd).toContain(': > /run/ezil-deps/boot-restore');
    expect(cmd).toContain('rm -f /run/ezil-deps/scanned');
    expect(cmd).toContain('/usr/local/bin/ezil-restore-deps.sh --boot /workspace');
    expect(cmd).toContain('>> /tmp/ezil-restore-deps.log 2>&1');
  });
  // Review r4254722070: the system restore may put the user's own /etc/bash.bashrc or global
  // npmrc over the image's, and a Guacamole-mode container never runs start-neko.sh. So the
  // Worker's trigger re-appends the readiness wiring itself, BEFORE the restore starts (and after
  // the boot-restore marker, so a gated npm run waits), and a
  // failing or absent ezil-deps must never stop the restore.
  for (const mode of ['ok', 'fails', 'absent'] as const) {
    it(`marks the boot restore, re-installs the readiness hooks, then restores (ezil-deps ${mode})`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'ezil-trigger-'));
      try {
        const bin = join(dir, 'bin'), run = join(dir, 'run'), calls = join(dir, 'calls');
        mkdirSync(bin);
        if (mode !== 'absent') {
          writeFileSync(join(bin, 'ezil-deps'), `#!/bin/bash\necho "hooks $* marker=$([ -e ${run}/boot-restore ] && echo yes || echo no)" >> ${calls}\necho noise; echo noise >&2\n${mode === 'fails' ? 'exit 1' : 'exit 0'}\n`);
          chmodSync(join(bin, 'ezil-deps'), 0o755);
        }
        writeFileSync(join(bin, 'ezil-restore-deps.sh'),
          `#!/bin/bash\necho "restore $* marker=$([ -e ${run}/boot-restore ] && echo yes || echo no)" >> ${calls}\n`);
        chmodSync(join(bin, 'ezil-restore-deps.sh'), 0o755);
        const cmd = restoreDepsCommand('/workspace')
          .replaceAll('/usr/local/bin/', `${bin}/`).replaceAll('/run/ezil-deps', run).replaceAll('/tmp/ezil-restore-deps.log', join(dir, 'log'));
        const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
        expect(r.status).toBe(0);
        const lines = readFileSync(calls, 'utf8').trim().split('\n');
        // The marker exists before the hooks are wired, so a gated `npm run` waits ("scanning").
        expect(lines).toEqual([...(mode === 'absent' ? [] : ['hooks install-hooks marker=yes']), 'restore --boot /workspace marker=yes']);
        expect(existsSync(join(run, 'boot-restore'))).toBe(true);
        expect(r.stdout + r.stderr).toBe('');                                     // hook output never leaks
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
  it('refuses a path that could break out of the command', () => {
    for (const bad of ["/work'space", '/workspace; rm -rf /', 'relative', '/a/../b', '/w s', '/$(id)']) {
      expect(() => restoreDepsCommand(bad)).toThrow();
    }
  });
  it('is wired right after the system-layer restore on a fresh container', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    const restore = src.indexOf("await this.observePersistence({ kind: 'restore', layer: 'system'");
    const trigger = src.indexOf('await this.startProcess(restoreDepsCommand(params.mountPath))');
    const desktop = src.indexOf('const checkpoint = await this.runWorkspaceFlush(\'explicit\');', restore);
    expect(restore).toBeGreaterThan(0);
    expect(trigger).toBeGreaterThan(restore);
    expect(trigger).toBeLessThan(desktop);
  });
});
