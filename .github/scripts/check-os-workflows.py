"""Offline contracts plus YAML and embedded-shell parsing for OS release workflows."""
from pathlib import Path
import json
import re
import subprocess
import yaml

root = Path(__file__).resolve().parents[2]
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
assert triggers['push'] == {'branches': ['preview', 'main']}
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
assert "before='${{ github.event.before }}'" in changed
assert '[[ -z "$before" || "$before" =~ ^0+$ ]]' in changed
assert 'git diff --name-only --no-renames "$before" "$GITHUB_SHA"' in changed
assert '^worker/(Dockerfile$|neko/|assets/neko-branding/|scripts/)' in changed
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
    assert job['runs-on'] == 'ubuntu-latest' and job['timeout-minutes'] == 25
    assert job['needs'] == ['changes', 'images']
    assert ' '.join(job['if'].split()) == (
        "${{ !cancelled() && github.ref == 'refs/heads/" + branch + "' && "
        "needs.changes.result == 'success' && "
        "(needs.images.result == 'success' || needs.images.result == 'skipped') }}")
    assert job['concurrency'] == {'group': f'deploy-{environment}', 'cancel-in-progress': False}
    assert job['permissions'] == {'contents': 'read', 'packages': 'read'}
    assert job['env']['EZIL_DEPLOY_SHA'] == '${{ github.sha }}'
    assert job['env']['EZIL_DEPLOY_TARGET'] == job_name
    assert bypass not in yaml.safe_dump({key: value for key, value in job.items() if key != 'steps'})
    steps = job['steps']
    by_name = {step.get('name'): step for step in steps}
    by_id = {step['id']: step for step in steps if 'id' in step}
    position = lambda step: steps.index(step)
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
    for step in (download, prepare, by_name['Setup image builder'], by_name['Log in to the image registry']):
        assert step['if'] == "needs.changes.outputs.image_changed == 'true'"
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
    assert '5 * 60' in worker['run'] and 'timeout --kill-after=10s' in worker['run']
    deploy = by_name[deploy_name]
    check = by_id[check_id]
    assert deploy['working-directory'] == 'app' and 'vercel deploy .. --yes' in deploy['run']
    assert 'node e2e/live-check.mjs' in check['run']
    assert check['env']['EZIL_E2E_APP'] == url
    assert check['env']['EZIL_LIVE_OUT'] == 'live-evidence'
    for key in ('EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD'):
        assert check['env'][key] == '${{ secrets.' + key + ' }}'
    assert position(worker) < position(deploy) < position(check)
    assert 'if' not in deploy and 'if' not in check
    for step in steps:
        if bypass in yaml.safe_dump(step):
            assert job_name == 'preview' and step.get('id') == 'live_preview'
    upload = by_name['Upload live evidence']
    assert upload['if'] == 'always()' and upload['uses'].startswith('actions/upload-artifact@')
    assert upload['with']['path'] == 'live-evidence' and steps[-1] == upload
    if job_name == 'preview':
        assert '--prod' not in deploy['run']
        assert 'vercel alias set "$url" ezil-os-preview.vercel.app' in deploy['run']
        assert check['env'][bypass] == '${{ secrets.' + bypass + ' }}'
        assert not check.get('continue-on-error', False)
        assert not re.search(r'ci-migrate|--apply|migrations apply|drizzle.*push',
                             '\n'.join(step.get('run', '') for step in steps))
        continue

    assert '--prod' in deploy['run'] and check['continue-on-error'] is True
    assert 'wrangler deployments list --json' in by_id['previous_worker']['run']
    assert '/deployments/os.ezil.work?teamId=' in by_id['previous_app']['run']
    assert 'if' not in by_id['previous_worker'] and 'if' not in by_id['previous_app']
    assert position(by_id['previous_worker']) < position(by_id['previous_app']) < position(worker)
    assert '5 * 60' in deploy['run'] and 'timeout --kill-after=10s' in deploy['run']
    assert '4 * 60' in check['run'] and 'timeout --kill-after=10s' in check['run']
    # Attempt both restorations independently and never mask a failed check.
    rollback_condition = "always() && steps.previous_worker.outcome == 'success' && steps.previous_app.outcome == 'success' && (steps.worker.outcome == 'failure' || steps.production_app.outcome == 'failure' || steps.live_production.outcome == 'failure')"
    rollback_worker = by_name['Roll back production Worker']
    rollback_app = by_name['Restore previous Vercel production deployment']
    fail = by_name['Fail after production recovery']
    for step in (rollback_worker, rollback_app, fail):
        assert step['if'] == rollback_condition
        assert position(step) > position(check)
    assert "wrangler rollback '${{ steps.previous_worker.outputs.version }}' -y" in rollback_worker['run']
    assert "vercel promote '${{ steps.previous_app.outputs.deployment }}'" in rollback_app['run']
    assert '--scope "$VERCEL_ORG_ID"' in rollback_app['run']
    assert rollback_worker['timeout-minutes'] == rollback_app['timeout-minutes'] == 2
    assert position(fail) > max(position(rollback_worker), position(rollback_app))
    assert 'exit 1' in fail['run'] and not fail.get('continue-on-error', False)

# The port requires only the existing environment-scoped secrets and variable.
preview_text = (root / '.github/workflows/preview.yml').read_text()
assert set(re.findall(r'secrets\.([A-Z0-9_]+)', preview_text)) == {
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'VERCEL_TOKEN',
    'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'VERCEL_AUTOMATION_BYPASS_SECRET',
    'EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD',
}
assert set(re.findall(r'vars\.([A-Z_]+)', preview_text)) == {'OS_WORKER_URL'}
print('OS workflows: YAML, shell, JavaScript and release contracts passed')
