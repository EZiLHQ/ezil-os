import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { checkpointReady } from '../bootstrap/checkpoint-ready.mjs';
const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
it('uses the confirmed Worker checkpoint without replaying legacy hydration over edited files', async () => {
  const root = await mkdtemp('/tmp/ezil-bootstrap-test-'); roots.push(root);
  const marker = { version: 1, prefix: 'p/branches/main', mountPath: root, checkpoint: crypto.randomUUID(), hydratedAt: 'today' };
  await writeFile(`${root}/.ezil-hydrated.json`, JSON.stringify(marker)); await writeFile(`${root}/edited`, 'uncommitted');
  expect(await checkpointReady({ EZIL_WORKSPACE_ROOT: root, EZIL_WORKSPACE_READY_MARKER: `${root}/ready.json` })).toBe(root);
  expect(await readFile(`${root}/edited`, 'utf8')).toBe('uncommitted');
  expect(JSON.parse(await readFile(`${root}/ready.json`, 'utf8')).checkpoint).toBe(marker.checkpoint);
});
it('fails readiness for an incomplete or malformed local checkpoint', async () => {
  const root = await mkdtemp('/tmp/ezil-bootstrap-test-'); roots.push(root);
  await writeFile(`${root}/.ezil-hydrated.json`, JSON.stringify({ version: 1, mountPath: root, prefix: 'p' }));
  await expect(checkpointReady({ EZIL_WORKSPACE_ROOT: root, EZIL_WORKSPACE_READY_MARKER: `${root}/ready.json` })).rejects.toThrow();
  await writeFile(`${root}/.ezil-hydrated.json`, '{');
  await expect(checkpointReady({ EZIL_WORKSPACE_ROOT: root, EZIL_WORKSPACE_READY_MARKER: `${root}/ready.json` })).rejects.toThrow();
});
it('removes stale readiness and refuses a missing marker without a legacy fallback', async () => {
  const root = await mkdtemp('/tmp/ezil-bootstrap-test-'); roots.push(root);
  const ready = `${root}/ready.json`;
  await writeFile(ready, '{"ready":true}');
  await expect(checkpointReady({ EZIL_WORKSPACE_ROOT: root, EZIL_WORKSPACE_READY_MARKER: ready,
    EZIL_WORKSPACE_STARTUP_DELIVERY: 'private invalid delivery' })).rejects.toThrow('workspace checkpoint is not confirmed');
  await expect(readFile(ready)).rejects.toThrow();
});
it('reports malformed checkpoint data without including the contents', async () => {
  const root = await mkdtemp('/tmp/ezil-bootstrap-test-'); roots.push(root);
  await writeFile(`${root}/.ezil-hydrated.json`, 'PRIVATE_CHECKPOINT_BYTES');
  try { await checkpointReady({ EZIL_WORKSPACE_ROOT: root, EZIL_WORKSPACE_READY_MARKER: `${root}/ready.json` }); }
  catch (error) { expect(String(error)).not.toContain('PRIVATE_CHECKPOINT_BYTES'); return; }
  throw new Error('expected fail-closed');
});
