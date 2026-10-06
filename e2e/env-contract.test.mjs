import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadContract, loadManifestProject, checkContract, checkJob, scanWorkflows, readWorkflows, parseWorkflow } from '../.github/scripts/env-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = 'ezil-os';
const { contract, sha256 } = loadContract(root);
const manifestProject = loadManifestProject(root);
const workflows = readWorkflows(root);

test('environment contract matches the shared Universe checksum', () => {
  assert.equal(sha256, 'e84392d3521d318373aa56991ced132c441057c3c136c5d97dc8fb850493cae8');
});

test('environment contract accepts the OS production migration manifest', () => {
  assert.deepEqual(checkContract(contract, manifestProject, repo), []);
});

test('preview refuses production credentials', () => {
  assert.deepEqual(checkJob(contract, repo, 'preview', {}), []);
  for (const name of contract.productionCredentialNames) {
    assert.deepEqual(checkJob(contract, repo, 'preview', { [name]: 'fixture-only' }), [
      `production credential ${name} is present in a preview job`,
    ]);
  }
});

test('production refuses pull requests even when the ref is main', () => {
  for (const event of ['pull_request', 'pull_request_target']) {
    assert.deepEqual(checkJob(contract, repo, 'production', { GITHUB_EVENT_NAME: event, GITHUB_REF: 'refs/heads/main' }), [
      'production job must not run for a pull request',
    ]);
  }
});

test('production accepts main and version tag pushes and refuses other branches', () => {
  for (const ref of ['refs/heads/main', 'refs/tags/v1.2.3']) {
    assert.deepEqual(checkJob(contract, repo, 'production', { GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref }), []);
  }
  assert.ok(checkJob(contract, repo, 'production', { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/preview' }).length);
});

test('post-cutover refuses a manifest still targeting legacy production', () => {
  const postCutover = structuredClone(contract);
  postCutover.phase = 'post-cutover';
  assert.deepEqual(checkContract(postCutover, manifestProject, repo), [
    `post-cutover: production-migrations.json project ${manifestProject} must equal projects.production ${postCutover.projects.production}`,
  ]);
});

test('every OS workflow passes the environment contract scan', () => {
  assert.deepEqual(scanWorkflows(contract, repo, workflows), []);
});

test('CI still runs the environment contract tests', () => {
  const job = parseWorkflow(workflows['ci.yml']).jobs.find(job => job.name === 'cloud-release-contract');
  assert.ok(job.steps.some(step => step.text.split('\n').includes('node --test e2e/env-contract.test.mjs')));
});

function replaceOnce(text, before, after) {
  assert.ok(text.includes(before), `Missing mutation anchor: ${before}`);
  return text.replace(before, () => after);
}

const assertionStep = environment =>
  `      - name: Assert ${environment} environment contract\n` +
  `        run: node .github/scripts/env-contract.mjs assert-job --repo ezil-os --environment ${environment}\n`;
const token = '${{ secrets.SUPABASE_ACCESS_TOKEN }}';
const mutations = [
  {
    name: 'token in workflow-level env on a PR workflow',
    file: 'preview.yml',
    edit: text => replaceOnce(text, '\njobs:\n', `\nenv:\n  SUPABASE_ACCESS_TOKEN: ${token}\n\njobs:\n`),
  },
  {
    name: 'bracket secret access in preview',
    file: 'preview.yml',
    edit: text => replaceOnce(text, '${{ secrets.CLOUDFLARE_API_TOKEN }}', "${{ secrets['SUPABASE_ACCESS_TOKEN'] }}"),
  },
  {
    name: 'toJSON(secrets) in a non-production job',
    file: 'preview.yml',
    edit: text => replaceOnce(text, '${{ secrets.CLOUDFLARE_API_TOKEN }}', '${{ toJSON(secrets) }}'),
  },
  {
    name: 'secret inheritance on a new job',
    file: 'preview.yml',
    edit: text => text + '\n  evil:\n    uses: ./.github/workflows/image.yml\n    secrets: inherit\n',
  },
  {
    name: 'service role key in a new PR workflow',
    file: 'evil.yml',
    edit: text => text + 'name: Evil\non: pull_request\njobs:\n  evil:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo fixture\n        env:\n          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}\n',
  },
  {
    name: 'preview assertion with if: false',
    file: 'preview.yml',
    edit: text => replaceOnce(text, assertionStep('preview'), assertionStep('preview') + '        if: false\n'),
  },
  {
    name: 'preview assertion with continue-on-error: true',
    file: 'preview.yml',
    edit: text => replaceOnce(text, assertionStep('preview'), assertionStep('preview') + '        continue-on-error: true\n'),
  },
  {
    name: 'preview assertion after the first secret-using step',
    file: 'preview.yml',
    edit: text => replaceOnce(replaceOnce(text, assertionStep('preview'), ''),
      '      - name: Install Worker dependencies\n', assertionStep('preview') + '      - name: Install Worker dependencies\n'),
  },
  {
    name: 'production assertion with if: false',
    file: 'preview.yml',
    edit: text => replaceOnce(text, assertionStep('production'), assertionStep('production') + '        if: false\n'),
  },
  {
    name: 'production token moved to job-level env',
    file: 'preview.yml',
    edit: text => replaceOnce(text.replaceAll(`          SUPABASE_ACCESS_TOKEN: ${token}\n`, ''),
      '      EZIL_DEPLOY_TARGET: production\n', `      EZIL_DEPLOY_TARGET: production\n      SUPABASE_ACCESS_TOKEN: ${token}\n`),
  },
  {
    name: 'deleted CI scan invocation',
    file: 'ci.yml',
    edit: text => replaceOnce(text, '          node .github/scripts/env-contract.mjs scan --repo ezil-os\n', ''),
  },
];

for (const { name, file, edit } of mutations) {
  test(`workflow scan refuses ${name}`, () => {
    const mutated = { ...workflows, [file]: edit(workflows[file] ?? '') };
    assert.notEqual(mutated[file], workflows[file], 'Mutation must change a workflow');
    assert.ok(scanWorkflows(contract, repo, mutated).length > 0, name);
  });
}
