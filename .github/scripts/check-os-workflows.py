"""Offline contracts plus YAML and embedded-shell parsing for OS release workflows."""
from pathlib import Path
import json
import ast
import re
import shlex
import subprocess
import yaml

root = Path(__file__).resolve().parents[2]
live_run_ms = int(subprocess.check_output([
    'node', '--input-type=module', '-e',
    "import { MAX_RUN_MS } from './e2e/live-check.mjs'; console.log(MAX_RUN_MS);",
], cwd=root, text=True))
contract = json.loads((root / '.github/environment-contract.json').read_text())
subprocess.run(['node', '.github/scripts/env-contract.mjs', 'check', '--repo', 'ezil-os'], cwd=root, check=True)
workflows = {}
for name in ('ci', 'preview', 'image', 'deploy', 'deploy-app', 'macos-internal', 'macos-e2e'):
    text = (root / f'.github/workflows/{name}.yml').read_text()
    workflow = yaml.safe_load(text)
    workflows[name] = workflow
    for job_name, job in workflow['jobs'].items():
        if f'{name}.yml#{job_name}' not in contract['repos']['ezil-os']['productionJobs']:
            job_text = yaml.safe_dump(job)
            for credential in contract['productionCredentialNames']:
                assert credential not in job_text, (name, job_name, f'Production credential {credential} outside production')
            assert not re.search(r'production-migrations\.mjs\s+(?:apply|rehearse)\b', job_text), (name, job_name)
        assert 'self-hosted' not in str(job.get('runs-on', '')), (name, job_name)
        assert not any('latest' == str(step.get('with', {}).get(key))
                       for step in job.get('steps', []) for key in ('bun-version', 'node-version'))
        for step in job.get('steps', []):
            if 'run' in step:
                result = subprocess.run(['bash', '-n'], input=re.sub(r'\$\{\{.*?\}\}', 'CI_VALUE', step['run']), text=True, capture_output=True)
                assert result.returncode == 0, (name, step.get('name'), result.stderr)
                for script in re.findall(r"<<'JS'\n(.*?)\nJS(?:\n|$)", step['run'], re.S):
                    result = subprocess.run(['node', '--input-type=module', '--check'], input=script, text=True, capture_output=True)
                    assert result.returncode == 0, (name, step.get('name'), result.stderr)
                for script in re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", step['run'], re.S):
                    ast.parse(script)
            if 'script' in step.get('with', {}):
                script = step['with']['script']
                result = subprocess.run(['node', '--input-type=module', '--check'], input='async function githubScript() {\n' + script + '\n}', text=True, capture_output=True)
                assert result.returncode == 0, (name, step.get('name'), result.stderr)

# OS is a web app; native packaging is opt-in and public CI stays on Ubuntu.
for job_name, job in workflows['ci']['jobs'].items():
    matrix = job.get('strategy', {}).get('matrix', {})
    runners = matrix.get('os', [job.get('runs-on', '')])
    assert all(runner.startswith('ubuntu-') for runner in runners), job_name
    assert not re.search(r'\b(?:macos|windows)-', yaml.safe_dump(job)), job_name
assert 'macos-native' not in workflows['ci']['jobs']
for name in ('macos-internal', 'macos-e2e'):
    assert set(workflows[name].get('on', workflows[name].get(True))) == {'workflow_dispatch'}, name

# Every discovered browser regression runs in CI, with identical local families.
runner = (root / 'shell/run-tests.sh').read_text()
shell_steps = workflows['ci']['jobs']['shell']['steps']
family_paths = set()
for family, step_name in (
    ('PORTABLE', 'Shell real-browser suites (portable)'),
    ('GEOMETRY', 'Shell real-browser suites (geometry — Linux only)'),
):
    local_family = set(re.findall(r'"(shell/[^"\n]+\.mjs)"', re.search(rf'{family}_SUITES=\(([\s\S]*?)\n\)', runner)[1]))
    step = next(step for step in shell_steps if step.get('name') == step_name)
    ci_family = set(re.findall(r'shell/[^\s;]+\.mjs', step['run']))
    assert local_family == ci_family, (family, local_family ^ ci_family)
    assert not family_paths.intersection(ci_family), family
    family_paths.update(ci_family)
browser_paths = {
    str(path.relative_to(root)) for path in (root / 'shell').rglob('*-test.mjs')
    if 'node_modules' not in path.parts
    and (path.name.endswith('-browser-test.mjs') or 'PLAYWRIGHT_REQUIRE_DIR' in path.read_text())
}
assert family_paths == browser_paths, family_paths ^ browser_paths
assert 'shell/ezil/boot-test.mjs' in next(step['run'] for step in shell_steps if step.get('name') == 'Shell unit suites')

# Push/dispatch deployment uses only the jobs designated by the shared contract.
# YAML 1.1 interprets "on" as True.
preview = workflows['preview']
triggers = preview.get('on', preview.get(True))
assert set(triggers) == {'push', 'workflow_dispatch'}
assert triggers['push'] == {'branches': ['preview', 'main'], 'tags': ['v*']}
assert preview['permissions'] == {'contents': 'read'}
assert preview['concurrency'] == {'group': 'os-live-${{ github.ref }}', 'cancel-in-progress': False}
assert set(preview['jobs']) == {'changes', 'images', 'preview', 'production'}
assert not (root / '.github/workflows/live.yml').exists()
assert 'live.yml' not in (root / '.github/workflows/ci.yml').read_text()

# Legacy entry points retain their designated job but direct operators to main.
for name in ('deploy', 'deploy-app'):
    fallback = workflows[name]
    assert set(fallback.get('on', fallback.get(True))) == {'workflow_dispatch'}, name
    assert fallback['permissions'] == {'contents': 'read'}, name
    assert set(fallback['jobs']) == {'gated-production'}, name
    job = fallback['jobs']['gated-production']
    assert 'uses' not in job and 'if' not in job and not job.get('continue-on-error', False), name
    assert job['runs-on'] == 'ubuntu-latest' and job['timeout-minutes'] == 1, name
    assert len(job['steps']) == 1, name
    step = job['steps'][0]
    assert set(step) <= {'name', 'run'}, name
    assert 'push/merge to main runs preview.yml#production' in step['run'], name
    assert step['run'].strip().endswith('exit 1'), name

# Keep the CI scan unconditional; deployment assertions must precede any work.
scan = 'node .github/scripts/env-contract.mjs scan --repo ezil-os'
scan_steps = [step for job in workflows['ci']['jobs'].values() for step in job.get('steps', [])
              if scan in step.get('run', '').splitlines()]
assert scan_steps and all(not {'if', 'continue-on-error', 'shell'} & set(step) for step in scan_steps)

changes = preview['jobs']['changes']
assert 'needs' not in changes and 'if' not in changes
assert changes['outputs']['image_changed'] == '${{ steps.image_changes.outputs.changed }}'
assert next(step for step in changes['steps'] if step.get('uses', '').startswith('actions/checkout@'))['with']['fetch-depth'] == 0
changed = next(step['run'] for step in changes['steps'] if step.get('id') == 'image_changes')
assert 'github.event.before' not in changed
assert 'deployed-evidence/live-evidence/image-source.json' in changed
assert "assert.equal(receipt.deployment, process.env.DEPLOYED_SHA)" in changed
assert "assert.equal(receipt.branch, process.env.GITHUB_REF_NAME)" in changed
assert "assert.equal(receipt.tested, true)" in changed
assert '[[ -z "$source" ]] || ! git cat-file -e "$source^{commit}"' in changed
assert 'git diff --name-only --no-renames "$source" "$GITHUB_SHA"' in changed
assert changes['permissions'] == {'contents': 'read', 'actions': 'read'}
assert changes['outputs']['image_source'] == '${{ steps.image_changes.outputs.source }}'
lookup = next(step for step in changes['steps'] if step.get('id') == 'deployed')
assert "status: 'success'" in lookup['with']['script']
assert "run.path === '.github/workflows/preview.yml'" in lookup['with']['script']
assert 'run.head_branch === branch' in lookup['with']['script']
assert "['push', 'workflow_dispatch'].includes(run.event)" in lookup['with']['script']
assert 'Date.parse(b.updated_at) - Date.parse(a.updated_at)' in lookup['with']['script']
evidence = next(step for step in changes['steps'] if step.get('id') == 'deployed_evidence')
assert evidence['continue-on-error'] is True
assert evidence['with']['run-id'] == '${{ steps.deployed.outputs.run }}'
assert evidence['with']['name'] == '${{ steps.deployed.outputs.artifact }}'
# One workflow path list drives both change detection and reused-image tag checks.
image_inputs = preview['env']['IMAGE_INPUTS'].split()
assert image_inputs and len(image_inputs) == len(set(image_inputs))
assert all(path and not path.startswith('/') and '..' not in path.split('/') for path in image_inputs)
assert 'mapfile -t image_inputs <<< "$IMAGE_INPUTS"' in changed
assert 'git diff --quiet --no-renames "$source" "$GITHUB_SHA" -- "${image_inputs[@]}"' in changed
assert '(( status == 1 )) || exit "$status"' in changed
assert '[[ "$GITHUB_REF" == refs/tags/* ]]' in changed
# COPY/ADD sources are relative to the worker build context; --from sources
# come from another stage. Handle shell/JSON forms and line continuations.
dockerfile = (root / 'worker/Dockerfile').read_text().replace('\\\n', ' ')
required_inputs = {'worker/Dockerfile', 'worker/.dockerignore', '.github/workflows/image.yml',
                   '.github/scripts/test-desktop.sh'}
for instruction in re.finditer(r'^\s*(?:COPY|ADD)\s+(.+)$', dockerfile, re.M | re.I):
    sources = instruction[1]
    if re.search(r'(?:^|\s)--from(?:=|\s)', sources):
        continue
    sources = re.sub(r'^(?:--[\w-]+=\S+\s+)+', '', sources)
    parts = json.loads(sources) if sources.startswith('[') else shlex.split(sources)
    assert len(parts) >= 2, sources
    for source in parts[:-1]:
        assert not re.match(r'\w+://', source), ('Review remote ADD input', source)
        directory = source.removeprefix('./').split('/')[0]
        assert directory not in ('', '.', '..') and not re.search(r'[$*?\[]', directory), sources
        required_inputs.add(f'worker/{directory}')
required_inputs.update(re.findall(r"tree\(['\"]([^'\"]+)['\"]\)",
                                 (root / '.github/scripts/image-plan.mjs').read_text()))
for source in required_inputs:
    assert any(source == path or source.startswith(path + '/') for path in image_inputs), ('Uncovered image input', source)
cloud_tests = workflows['ci']['jobs']['cloud-release-contract']['steps']
assert any(not step.get('if') and 'node --test' in step.get('run', '') and
           all(test in step['run'].split() for test in ('e2e/cloud-ci.test.mjs', 'e2e/live-check.test.mjs'))
           for step in cloud_tests)
images = preview['jobs']['images']
assert images['needs'] == 'changes'
assert images['if'] == ("needs.changes.outputs.image_changed == 'true' && "
                        "(github.ref == 'refs/heads/preview' || github.ref == 'refs/heads/main')")
assert images['uses'] == './.github/workflows/image.yml'
assert images['with']['source'] == '${{ github.sha }}'
assert images['secrets'] == 'inherit'
image_steps = workflows['image']['jobs']['images']['steps']
image_runs = '\n'.join(step.get('run', '') for step in image_steps)
assert image_runs.index('image-plan.mjs') < image_runs.index('build-images.sh') < image_runs.index('test-desktop.sh') < image_runs.index('tested: true')
assert any(step.get('uses', '').startswith('actions/upload-artifact@') and
           step['with']['name'] == 'os-images-${{ inputs.source }}' and
           'tested-images.json' in step['with']['path'] for step in image_steps)

bypass = 'VERCEL_AUTOMATION_BYPASS_SECRET'
assert bypass not in yaml.safe_dump({key: value for key, value in preview.items() if key != 'jobs'})
for job_name, job in preview['jobs'].items():
    if job_name != 'preview':
        assert bypass not in yaml.safe_dump(job), job_name

for job_name, branch, environment, url, deploy_name, check_id in (
    ('preview', 'preview', 'staging', 'https://ezil-os-preview.vercel.app',
     'Deploy Vercel preview and set stable alias', 'live_preview'),
    ('production', 'main', 'production', 'https://os.ezil.work',
     'Deploy Vercel production', 'live_production'),
):
    job = preview['jobs'][job_name]
    assert job['environment'] == environment
    assert job['runs-on'] == 'ubuntu-latest' and job['timeout-minutes'] == (42 if job_name == 'preview' else 71)
    assert job['needs'] == ['changes', 'images']
    ref_condition = ("github.ref == 'refs/heads/preview'" if job_name == 'preview' else
                     "(github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))")
    assert ' '.join(job['if'].split()) == (
        "${{ !cancelled() && " + ref_condition + " && "
        "needs.changes.result == 'success' && "
        "(needs.images.result == 'success' || needs.images.result == 'skipped') }}")
    assert job['concurrency'] == {'group': f'deploy-{environment}', 'cancel-in-progress': False}
    assert job['permissions'] == ({'contents': 'read', 'packages': 'read', 'id-token': 'write'} if job_name == 'preview' else
                                  {'contents': 'write', 'packages': 'write', 'actions': 'read', 'id-token': 'write'})
    assert job['env']['EZIL_DEPLOY_SHA'] == '${{ github.sha }}'
    assert job['env']['EZIL_DEPLOY_TARGET'] == job_name
    assert job['env']['EZIL_WORKER_NAME'] == ('ezil-os-worker-staging' if job_name == 'preview' else 'ezil-os-worker')
    assert bypass not in yaml.safe_dump({key: value for key, value in job.items() if key != 'steps'})
    steps = job['steps']
    by_name = {step.get('name'): step for step in steps}
    by_id = {step['id']: step for step in steps if 'id' in step}
    position = lambda step: steps.index(step)
    # Repository-scoped concurrency cannot serialize other repositories' deploys
    # or acceptance. Keep the original shared lease through evidence and recovery.
    lease_id = 'lease' if job_name == 'preview' else 'production_lease'
    scope = '' if job_name == 'preview' else '--scope shared-production '
    ttl = 10800 if job_name == 'preview' else 7200
    owner = ('os-' if job_name == 'preview' else 'os-prod-') + '${{ github.run_id }}-${{ github.run_attempt }}'
    acquire = by_id[lease_id]
    credentials = [step for step in steps if step.get('uses', '').startswith('aws-actions/configure-aws-credentials@')]
    assert len(credentials) == 1
    credentials = credentials[0]
    assert credentials['uses'] == 'aws-actions/configure-aws-credentials@v4'
    assert credentials['with'] == {
        'role-to-assume': 'arn:aws:iam::452630323510:role/ezil-os-staging-lease',
        'aws-region': 'us-east-1', 'role-duration-seconds': 7200,
    }
    # No branch/image condition: main and version-tag checks both acquire; any
    # acquisition failure must retain GitHub's default success() gating.
    for step in (credentials, acquire):
        assert not {'if', 'continue-on-error', 'shell'} & set(step), (job_name, step)
    assert not job.get('continue-on-error', False)
    assert acquire['run'] == f'python3 .github/scripts/staging-lock.py acquire {scope}--owner "$LEASE_OWNER" --ttl {ttl} --wait 1200'
    release = by_name[f'Release shared {environment} lease']
    assert release['if'] == f"always() && steps.{lease_id}.outcome == 'success'"
    assert release['run'] == f'python3 .github/scripts/staging-lock.py release {scope}--owner "$LEASE_OWNER"'
    assert acquire['env'] == release['env'] == {'LEASE_OWNER': owner}
    assert not release.get('continue-on-error', False)
    assert position(credentials) < position(acquire) and steps[-1] == release
    protected = [by_id[key] for key in ('container_before', 'worker', check_id)]
    if job_name == 'production':
        protected += [by_id[key] for key in ('previous_worker', 'previous_app', 'previous_container', 'rollback_guard')]
        protected += [by_name['Verify or apply reviewed production migrations'],
                      by_name['Fail after production recovery']]
    assert all(position(acquire) < position(step) < position(release) for step in protected), job_name
    command = f'node .github/scripts/env-contract.mjs assert-job --repo ezil-os --environment {job_name}'
    checks = [step for step in steps if step.get('run') == command]
    assert len(checks) == 1 and set(checks[0]) <= {'name', 'id', 'run'}
    assert position(checks[0]) == next(
        i for i, step in enumerate(steps) if step.get('uses', '').startswith('actions/setup-node@')) + 1
    for directory in ('worker', 'app'):
        assert any(step.get('working-directory') == directory and
                   step.get('run') == 'bun install --frozen-lockfile' for step in steps)
    assert any(step.get('uses') == './.github/actions/setup-playwright' for step in steps)
    download = by_name['Download tested candidate image identities']
    prepare = by_name['Prepare Dockerfile.release from the tested image']
    main = "github.ref == 'refs/heads/main'"
    tag = "startsWith(github.ref, 'refs/tags/v')"
    image_condition = ('' if job_name == 'preview' else main + ' && ') + "needs.changes.outputs.image_changed == 'true'"
    for step in (download, prepare, by_name['Setup image builder'], by_name['Log in to the image registry']):
        expected = image_condition
        if job_name == 'production' and step in (by_name['Setup image builder'], by_name['Log in to the image registry']):
            expected += ' || ' + tag
        assert step['if'] == expected
    assert download['with']['name'] == 'os-images-${{ github.sha }}'
    assert 'node .github/scripts/release-state.mjs prepare' in prepare['run']
    assert "replace('image = \"./Dockerfile\"', 'image = \"./Dockerfile.release\"')" in prepare['run']
    worker = by_id['worker']
    assert position(download) < position(prepare) < position(worker)
    assert worker['working-directory'] == 'worker'
    assert 'rollout=none' in worker['run'] and 'rollout=immediate' in worker['run']
    assert "if [[ '${{ needs.changes.outputs.image_changed }}' == true ]]" in worker['run']
    assert './node_modules/.bin/wrangler deploy "${args[@]}" --containers-rollout "$rollout" --message "git:$EZIL_DEPLOY_SHA"' in worker['run']
    assert ('args=(--env staging)' if job_name == 'preview' else 'args=()') in worker['run']
    assert '16 * 60' in worker['run'] and 'timeout --kill-after=10s' in worker['run']
    deploy = by_name[deploy_name]
    check = by_id[check_id]
    rollout = by_id['rollout']
    identity = by_id['identity']
    assert rollout['if'] == image_condition and rollout['timeout-minutes'] == 11
    assert 'node e2e/await-container-rollout.mjs' in rollout['run']
    capture_version = by_id['container_before']
    assert capture_version['if'] == image_condition
    assert capture_version['run'] == 'node .github/scripts/release-state.mjs container-version'
    assert position(prepare) < position(capture_version) < position(worker)
    assert rollout['env']['EZIL_PREVIOUS_CONTAINER_VERSION'] == '${{ steps.container_before.outputs.version }}'
    assert rollout['env']['EZIL_CONTAINER_APPLICATION_ID'] == '${{ steps.container_before.outputs.id }}'
    assert 'release-state.mjs rollout-target)' in rollout['run']
    assert 'export EZIL_EXPECTED_CONTAINER_DIGEST' in rollout['run']
    assert rollout['run'].index('release-state.mjs rollout-target') < rollout['run'].index('node e2e/await-container-rollout.mjs')
    assert 'node e2e/verify-cloud-deployment.mjs' in identity['run']
    assert identity['timeout-minutes'] == 3
    assert not rollout.get('continue-on-error', False) and not identity.get('continue-on-error', False)
    assert position(worker) < position(deploy) < position(rollout) < position(identity) < position(check)
    assert ('if' not in identity) if job_name == 'preview' else identity['if'] == main
    assert identity['env']['EZIL_E2E_APP'] == '${{ steps.' + deploy['id'] + '.outputs.url }}'
    assert 'echo "url=$url" >> "$GITHUB_OUTPUT"' in deploy['run']
    for key in ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'):
        assert rollout['env'][key] == identity['env'][key] == '${{ secrets.' + key + ' }}'
    for key in ('VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'):
        assert identity['env'][key] == '${{ secrets.' + key + ' }}'
    assert deploy['working-directory'] == 'app' and 'vercel deploy .. --yes' in deploy['run']
    assert 'node e2e/live-check.mjs' in check['run']
    assert check['timeout-minutes'] == 14
    assert live_run_ms + 20_000 < check['timeout-minutes'] * 60_000 < job['timeout-minutes'] * 60_000
    assert "import { MAX_RUN_MS } from './e2e/live-check.mjs'" in check['run']
    assert '(( remaining >= live_seconds + 10 ))' in check['run']
    assert 'timeout --kill-after=10s "$((live_seconds + 10))s" node e2e/live-check.mjs' in check['run']
    assert check['env']['EZIL_E2E_APP'] == url
    assert check['env']['EZIL_LIVE_OUT'] == 'live-evidence'
    for key in ('EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD', 'EZIL_E2E_COMPUTER_ID'):
        assert check['env'][key] == '${{ secrets.' + key + ' }}'
    assert check['env']['EZIL_E2E_REQUIRE_TARGET'] == '1'
    assert position(worker) < position(deploy) < position(check)
    assert 'if' not in check
    assert ('if' not in deploy) if job_name == 'preview' else deploy['if'] == worker['if'] == main
    for step in steps:
        if bypass in yaml.safe_dump(step):
            assert job_name == 'preview' and step.get('id') == 'live_preview'
    upload = by_name['Upload live evidence']
    assert upload['if'] == 'always()' and upload['uses'].startswith('actions/upload-artifact@')
    assert 'live-evidence' in upload['with']['path'].splitlines()
    assert position(check) < position(upload) < position(release)
    assert 'hosted-continuity-evidence/container-rollout.json' in upload['with']['path'].splitlines()
    receipt = by_name['Record successfully deployed image source']
    assert receipt['if'] == ('' if job_name == 'preview' else main + ' && ') + f"steps.{check_id}.outcome == 'success'"
    assert position(check) < position(receipt) < position(upload)
    assert "'live-evidence/image-source.json'" in receipt['run']
    assert receipt['env']['REUSED_IMAGE_SOURCE'] == '${{ needs.changes.outputs.image_source }}'
    assert "assert.equal(images.tested, true)" in receipt['run']
    if job_name == 'preview':
        assert '+ 41 * 60' in by_id['deadline']['run']
        routes = by_name['Validate staging Worker hostname and routes']
        assert 'if' not in routes and not routes.get('continue-on-error', False)
        assert position(checks[0]) < position(routes) < position(worker)
        for assertion in ('OS_WORKER_URL must be an HTTPS origin', 'Staging must use its named Worker',
                          'Staging must use separate routes and zones', 'Staging requires a custom desktop domain',
                          'Staging cannot use production ezil.org routing', 'Staging routes must cover OS_WORKER_URL'):
            assert assertion in routes['run']
        assert '--prod' not in deploy['run']
        assert 'vercel alias set "$url" ezil-os-preview.vercel.app' in deploy['run']
        assert check['env'][bypass] == '${{ secrets.' + bypass + ' }}'
        assert '/deployments/ezil-os-preview.vercel.app?teamId=' in identity['run']
        assert 'assertVercelDeployment(await response.json()' in identity['run']
        assert 'assert.equal(id, identity.vercel_deployment' in identity['run']
        assert not check.get('continue-on-error', False)
        assert not re.search(r'ci-migrate|--apply|migrations apply|drizzle.*push',
                             '\n'.join(step.get('run', '') for step in steps))
        continue

    assert '--prod' in deploy['run'] and check['continue-on-error'] is True
    for step in (worker, deploy):
        assert 'set -euo pipefail' in step['run']
        assert 'gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq \'.object.sha\'' in step['run']
        assert '[[ "$current_main" == "$EZIL_DEPLOY_SHA" ]] ||' in step['run']
        assert step['run'].index('gh api ') < step['run'].index('[[ "$current_main"') < step['run'].index('timeout --kill-after=10s')
    assert 'wrangler deployments list --json' in by_id['previous_worker']['run']
    assert '/deployments/os.ezil.work?teamId=' in by_id['previous_app']['run']
    assert by_id['previous_worker']['if'] == by_id['previous_app']['if'] == main
    assert position(by_id['previous_worker']) < position(by_id['previous_app']) < position(worker)
    assert '16 * 60' in deploy['run'] and 'timeout --kill-after=10s' in deploy['run']
    assert '16 * 60' in rollout['run'] and 'timeout --kill-after=10s' in rollout['run']
    for step in (identity, check):
        assert '15 * 60' in step['run'] and 'timeout --kill-after=10s' in step['run']
    # Admit recovery before any mutation; attempt each restoration after admission.
    rollback_condition = "always() && github.ref == 'refs/heads/main' && steps.previous_worker.outcome == 'success' && steps.previous_app.outcome == 'success' && (steps.worker.outcome == 'failure' || steps.production_app.outcome == 'failure' || steps.rollout.outcome == 'failure' || steps.identity.outcome == 'failure' || steps.live_production.outcome == 'failure')"
    rollback_worker = by_name['Roll back production Worker']
    rollback_app = by_name['Restore previous Vercel production deployment']
    rollback_check = by_name['Verify production recovery identities']
    fail = by_name['Fail after production recovery']
    guard = by_id['rollback_guard']
    assert guard['if'] == rollback_condition + " && steps.previous_container.outcome == 'success'"
    assert 'node .github/scripts/release-state.mjs rollback-guard' in guard['run']
    assert 'no rollback mutations will run' in guard['run'] and 'exit 1' in guard['run']
    assert guard['timeout-minutes'] == 1 and not guard.get('continue-on-error', False)
    assert position(check) < position(guard) < position(rollback_worker)
    guarded_condition = rollback_condition + " && steps.rollback_guard.outcome == 'success'"
    assert fail['if'] == rollback_condition
    assert 'rollback mutations were skipped' in fail['run']
    for step in (rollback_worker, rollback_app, rollback_check):
        assert step['if'] == guarded_condition
        assert position(step) > position(check)
    assert "wrangler rollback '${{ steps.previous_worker.outputs.version }}' -y" in rollback_worker['run']
    assert "vercel promote '${{ steps.previous_app.outputs.deployment }}'" in rollback_app['run']
    assert '--scope "$VERCEL_ORG_ID"' in rollback_app['run']
    assert rollback_worker['timeout-minutes'] == rollback_app['timeout-minutes'] == 2
    capture = by_id['previous_container']
    archive = by_name['Preserve recovery identities before production mutation']
    migrations = by_name['Verify or apply reviewed production migrations']
    container = by_name['Restore previous container image and await rollback rollout']
    assert capture['if'] == archive['if'] == main
    assert capture['run'] == 'node .github/scripts/release-state.mjs capture'
    assert archive['with']['path'] == 'previous-release.json' and archive['with']['if-no-files-found'] == 'error'
    assert position(capture) < position(archive) < position(migrations) < position(prepare) < position(worker)
    assert migrations['if'] == main and not migrations.get('continue-on-error', False)
    assert migrations['run'] == 'node .github/scripts/production-migrations.mjs apply'
    assert migrations['env'] == {'SUPABASE_ACCESS_TOKEN': '${{ secrets.SUPABASE_ACCESS_TOKEN }}',
                                 'GITHUB_TOKEN': '${{ github.token }}'}
    current_main = by_id['current_main']
    assert current_main['if'] == main and not current_main.get('continue-on-error', False)
    assert current_main['uses'] == 'actions/github-script@v8'
    assert position(archive) < position(current_main) == position(migrations) - 1
    assert "github.rest.git.getRef({ ...context.repo, ref: 'heads/main' })" in current_main['with']['script']
    assert "if (ref.object.sha !== process.env.EZIL_DEPLOY_SHA) core.setFailed(" in current_main['with']['script']
    assert container['if'] == guarded_condition + " && needs.changes.outputs.image_changed == 'true' && steps.previous_container.outcome == 'success'"
    assert container['run'] == 'node .github/scripts/release-state.mjs container-rollback'
    assert container['timeout-minutes'] == 7 and not container.get('continue-on-error', False)
    for key in ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'):
        assert capture['env'][key] == guard['env'][key] == container['env'][key] == rollback_check['env'][key] == '${{ secrets.' + key + ' }}'
    assert position(rollback_worker) < position(container) < position(rollback_app) < position(rollback_check) < position(fail)
    assert rollback_check['timeout-minutes'] == 3 and not rollback_check.get('continue-on-error', False)
    assert rollback_check['run'] == ('for attempt in {1..12}; do\n'
                                    '  if node .github/scripts/release-state.mjs rollback-check; then exit 0; fi\n'
                                    '  sleep 5\ndone\nexit 1\n')
    assert {'previous-release.json', 'container-rollback.json', 'rollback-state.json', 'production-release.json'} <= set(upload['with']['path'].splitlines())
    assert '+ 53 * 60' in by_id['deadline']['run']
    # Tags only verify existing production, then use the original signed-native
    # release publication and verified semantic alias commands.
    tag_names = ('Identify the deployed image for tag verification',
                 'Locate tested image evidence from a successful branch run',
                 'Download the deployed image test receipt',
                 'Record verified tag production identities and image layers',
                 'Verify release evidence and wait for signed installer',
                 'Attach semantic image alias to the verified digest',
                 'Publish release with verified cloud identities')
    previous = check
    for name in tag_names:
        step = by_name[name]
        assert step['if'] == tag + " && steps.live_production.outcome == 'success'"
        assert not step.get('continue-on-error', False)
        assert position(previous) < position(step)
        previous = step
    identify = by_name[tag_names[0]]['run']
    assert "process.env.IMAGE_INPUTS.trim().split(/\\s+/)" in identify
    assert "['merge-base', '--is-ancestor', source, process.env.EZIL_DEPLOY_SHA]" in identify
    assert 'assert.equal(state.worker_source, process.env.EZIL_DEPLOY_SHA)' in identify
    assert 'assert.equal(state.vercel_source, process.env.EZIL_DEPLOY_SHA)' in identify
    receipt = by_name[tag_names[1]]['with']['script']
    assert "run.path !== '.github/workflows/preview.yml'" in receipt and "run.conclusion !== 'success'" in receipt
    record = by_name[tag_names[3]]['run']
    assert 'assert.equal(images.tested, true)' in record
    assert 'assert.deepEqual(deployed.RootFS.Layers, tested.RootFS.Layers' in record
    assert 'Production changed during tag verification' in record
    assert "ghcr_layers_verified = true" in record and "'production-release.json'" in record
    release_verify = by_name[tag_names[4]]['run']
    assert '.source == $sha and .worker_source == $sha and .vercel_source == $sha and .cloudflare_container.ghcr_layers_verified == true' in release_verify
    assert 'EZiL-OS-${version}-AppleSilicon.dmg' in release_verify and 'for attempt in {1..180}' in release_verify
    assert 'docker buildx imagetools create --prefer-index=false --tag "ghcr.io/ezilhq/ezil-os-desktop:${GITHUB_REF_NAME#v}" "ghcr.io/ezilhq/ezil-os-desktop@$digest"' in by_name[tag_names[5]]['run']
    assert 'gh release edit "$GITHUB_REF_NAME" --notes-file "$notes" --draft=false' in by_name[tag_names[6]]['run']
    assert by_name['Fail unverified tag']['if'] == 'always() && ' + tag + " && steps.live_production.outcome == 'failure'"
    assert by_name['Fail unverified tag']['run'] == 'exit 1'
    # No deployment, rollback, or migration can execute on a tag.
    for step in steps:
        if re.search(r'wrangler (?:deploy|rollback)|vercel (?:deploy|promote)|release-state.mjs (?:prepare|capture|container-rollback|rollback-check|rollback-guard|container-version|rollout-target)|production-migrations.mjs apply', step.get('run', '')):
            assert main in step.get('if', ''), step.get('name')
    assert 'exit 1' in fail['run'] and not fail.get('continue-on-error', False)

# The port requires only the existing environment-scoped secrets and variable.
preview_text = (root / '.github/workflows/preview.yml').read_text()
assert set(re.findall(r'secrets\.([A-Z0-9_]+)', preview_text)) == {
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'VERCEL_TOKEN',
    'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'VERCEL_AUTOMATION_BYPASS_SECRET',
    'EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD', 'EZIL_E2E_COMPUTER_ID', 'SUPABASE_ACCESS_TOKEN',
}
assert set(re.findall(r'vars\.([A-Z_]+)', preview_text)) == {'OS_WORKER_URL'}
print('OS workflows: YAML, shell, JavaScript and release contracts passed')
