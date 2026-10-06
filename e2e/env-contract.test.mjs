import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadContract, loadManifestProject, checkContract, checkJob } from '../.github/scripts/env-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { contract, sha256 } = loadContract(root);
const manifestProject = loadManifestProject(root);

test('environment contract matches the shared Universe checksum', () => {
  assert.equal(sha256, '28e1d2b965ef000c1b37e68803929328da9c02fca139b3ac039646815c7cc50b');
});

test('environment contract accepts the OS production migration manifest', () => {
  assert.deepEqual(checkContract(contract, manifestProject), []);
});

test('preview refuses production credentials', () => {
  assert.deepEqual(checkJob(contract, 'preview', {}), []);
  for (const name of contract.productionCredentialNames) {
    assert.deepEqual(checkJob(contract, 'preview', { [name]: 'fixture-only' }), [
      `production credential ${name} is present in a preview job`,
    ]);
  }
});

test('production refuses pull requests even when the ref is main', () => {
  for (const event of ['pull_request', 'pull_request_target']) {
    assert.deepEqual(checkJob(contract, 'production', { GITHUB_EVENT_NAME: event, GITHUB_REF: 'refs/heads/main' }), [
      'production job must not run for a pull request',
    ]);
  }
});

test('production accepts main and version tag pushes and refuses other branches', () => {
  for (const ref of ['refs/heads/main', 'refs/tags/v1.2.3']) {
    assert.deepEqual(checkJob(contract, 'production', { GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref }), []);
  }
  assert.ok(checkJob(contract, 'production', { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/preview' }).length);
});

test('post-cutover refuses a manifest still targeting legacy production', () => {
  const postCutover = structuredClone(contract);
  postCutover.phase = 'post-cutover';
  assert.deepEqual(checkContract(postCutover, manifestProject), [
    `post-cutover: production-migrations.json project ${manifestProject} must equal projects.production ${postCutover.projects.production}`,
  ]);
});
