import { describe, expect, it, mock } from 'bun:test';

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
