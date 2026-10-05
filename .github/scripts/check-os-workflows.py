"""Offline contracts plus YAML and embedded-shell parsing for OS release workflows."""
from pathlib import Path
import re
import subprocess
import yaml

root = Path(__file__).resolve().parents[2]
workflows = {}
for name in ('ci', 'preview', 'image', 'deploy', 'deploy-app', 'macos-internal', 'macos-e2e'):
    text = (root / f'.github/workflows/{name}.yml').read_text()
    workflow = yaml.safe_load(text)
    workflows[name] = workflow
    for job_name, job in workflow['jobs'].items():
        assert 'self-hosted' not in str(job.get('runs-on', '')), (name, job_name)
        assert not any('latest' == str(step.get('with', {}).get(key))
                       for step in job.get('steps', []) for key in ('bun-version', 'node-version'))
        for step in job.get('steps', []):
            if 'run' in step:
                result = subprocess.run(['bash', '-n'], input=re.sub(r'\$\{\{.*?\}\}', 'CI_VALUE', step['run']), text=True, capture_output=True)
                assert result.returncode == 0, (name, step.get('name'), result.stderr)
            if 'script' in step.get('with', {}):
                script = step['with']['script']
                result = subprocess.run(['node', '--input-type=module', '--check'], input='async function githubScript() {\n' + script + '\n}', text=True, capture_output=True)
                assert result.returncode == 0, (name, step.get('name'), result.stderr)

# Retired hosted images must not return through another workflow or matrix.
for path in (root / '.github/workflows').glob('*.yml'):
    assert not re.search(r'\bmacos-14(?:-(?:large|xlarge|arm64))?\b', path.read_text()), path
assert workflows['ci']['jobs']['macos-native']['strategy']['matrix']['os'] == ['ubuntu-latest', 'macos-15']
assert workflows['macos-internal']['jobs']['dmg']['runs-on'] == 'macos-15'
assert workflows['macos-e2e']['jobs']['physical-mac']['runs-on'] == 'macos-15'
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
internal_triggers = workflows['macos-internal'].get('on', workflows['macos-internal'].get(True))
assert '.github/workflows/ci.yml' in internal_triggers['pull_request']['paths']

jobs = workflows['preview']['jobs']
for job in ('preview', 'production'):
    assert jobs[job]['env']['EZIL_E2E_COMPUTER_ID'] == '${{ secrets.EZIL_E2E_COMPUTER_ID }}'
for name in ('prod', 'prod-responsiveness', 'prod-window-stacking', 'prod-reconcile', 'prod-lifecycle'):
    source = (root / f'e2e/{name}.mjs').read_text()
    assert 'verifySelectedComputer(p' in source, f'{name} must verify isolated compute before launch'
    assert source.index('verifySelectedComputer(p') > source.index('await p.goto(`${APP}/os`')
assert set(jobs['production']['needs']) == {'trust', 'preview', 'images'}
assert jobs['images']['with']['source'] == '${{ needs.trust.outputs.sha }}'
assert jobs['production']['concurrency']['group'] == 'deploy-production'
assert jobs['production']['concurrency']['cancel-in-progress'] is False
assert workflows['image']['concurrency']['group'] == 'os-image-publisher'
# YAML 1.1 interprets "on" as True; account for it without rewriting workflow syntax.
triggers = workflows['image'].get('on', workflows['image'].get(True))
assert set(triggers) == {'workflow_call'}, 'No independent path-filtered image publisher'
for name in ('deploy', 'deploy-app'):
    assert workflows[name]['jobs']['gated-production']['uses'] == './.github/workflows/preview.yml'
preview = '\n'.join(s.get('run', '') for s in jobs['preview']['steps'])
assert not re.search(r'ci-migrate|--apply|migrations apply|drizzle.*push', preview)
production = jobs['production']['steps']
positions = {s.get('name'): i for i, s in enumerate(production)}
for job_name, lease_name in (('preview', 'lease'), ('production', 'production_lease')):
    steps = jobs[job_name]['steps']
    cleanup = next(step for step in steps if step.get('name') == f'Stop isolated {"staging" if job_name == "preview" else "production"} test computer')
    suffix = " && needs.trust.outputs.manual_preview != 'true'" if job_name == 'preview' else ''
    assert cleanup['if'] == f"always() && steps.{lease_name}.outcome == 'success'" + suffix
    assert cleanup['run'] == 'node e2e/cleanup-hosted-computer.mjs'
    assert cleanup['timeout-minutes'] == 7
    assert steps.index(cleanup) < next(i for i, step in enumerate(steps) if step.get('name', '').startswith('Release shared'))
    assert steps.index(cleanup) < next(i for i, step in enumerate(steps) if step.get('name', '').startswith('Upload') and 'evidence' in step.get('name', ''))
assert positions['Verify or apply reviewed production migrations'] < positions['Deploy production Worker']
assert positions['Capture previous production identities'] < positions['Deploy production Worker']
assert positions['Test the returned production URL'] < positions['Test the canonical production URL']
assert positions['Test the canonical production URL'] < positions['Record canonical identity and distinct Cloudflare container digest']
assert positions['Restore previous Worker version (never reverse SQL)'] < positions['Verify rollback and report container restoration limitations']
assert workflows['deploy']['jobs']['release']['needs'] == 'gated-production'
assert positions['Acquire shared production lease'] < positions['Capture previous production identities']
assert positions['Release shared production lease'] > positions['Upload production release and recovery evidence']
# Hosted continuity is an explicit cloud gate; missing isolated IDs are failures.
preview_steps = jobs['preview']['steps']
continuity = next(step for step in preview_steps if step.get('name') == 'Hosted continuity release gate')
assert continuity['timeout-minutes'] == 90
assert continuity['env']['EZIL_E2E_COMPUTER_ID'] == '${{ secrets.EZIL_E2E_COMPUTER_ID }}'
assert 'full' in continuity['env']['EZIL_CONTINUITY_MODE'] and 'short' in continuity['env']['EZIL_CONTINUITY_MODE']
assert jobs['preview']['timeout-minutes'] >= 150
assert jobs['preview']['needs'] == ['trust', 'images']
assert jobs['images']['if'] == "needs.trust.outputs.allowed == 'true'"
assert workflows['preview'].get('on', workflows['preview'].get(True))['workflow_run']['branches'] == ['main']
assert 'Hosted continuity PR gate' in jobs['summary']['name']
assert any(step.get('name') == 'Download tested candidate image identities' for step in preview_steps)
assert 'SANDBOX_NEKO_TURN_TTL_SECONDS:$ttl' in preview and 'ttl=1800' in preview
assert 'EZIL_ACCEPTANCE_SANDBOX' in continuity['env'] or 'EZIL_ACCEPTANCE_HMAC_SECRET' in continuity['env']
assert '--ttl 10800' in preview
lease_credentials = [step for step in preview_steps if step.get('uses') == 'aws-actions/configure-aws-credentials@v4']
assert len(lease_credentials) == 2
assert all(step['with']['role-duration-seconds'] == 7200 for step in lease_credentials)
renew_index = next(i for i, step in enumerate(preview_steps) if step.get('name') == 'Renew staging lease credentials before long acceptance')
assert preview_steps[renew_index + 1]['name'] == 'Hosted continuity release gate'
assert 'SANDBOX_NEKO_TURN_TTL_SECONDS' in preview
assert continuity['if'] == "needs.trust.outputs.manual_preview != 'true'"
assert next(step for step in preview_steps if step.get('name') == 'Test the returned preview URL')['if'] == continuity['if']
assert next(step for step in preview_steps if step.get('name') == 'Verify and record manual preview')['run'].endswith('node .github/scripts/record-manual-preview.mjs\n')
assert any('test-editor-state-linux.sh' in step.get('run', '') for step in workflows['ci']['jobs']['worker']['steps'])
for name in ('Test the returned production URL', 'Test the canonical production URL'):
    assert 'prod-lifecycle' in production[positions[name]]['run']
assert 'Hosted production persistence verification' in positions
assert production[positions['Hosted production persistence verification']]['env']['EZIL_E2E_APP'] == 'https://os.ezil.org'
assert production[positions['Hosted production persistence verification']]['env']['EZIL_CONTINUITY_IDENTITY_APP'] == '${{ steps.app.outputs.url }}'
production_config = production[positions['Validate production configuration']]
for key in ('EZIL_E2E_COMPUTER_ID', 'EZIL_E2E_WORKSPACE_PATH', 'EZIL_E2E_R2_BUCKET', 'EZIL_E2E_R2_PREFIX'):
    assert key in production_config['env'] and key in production_config['run']
suite = (root / 'e2e/hosted-continuity.mjs').read_text()
assert 'SKIP' not in suite
assert "required('EZIL_E2E_COMPUTER_ID')" in suite
assert "36 * 60000" in suite and "30 * 60000" in suite
assert "'/api/shell/stop'" in suite and 'stopped.ok && stopped.terminated' in suite
assert 'framesDecoded' in suite and 'bytesReceived' in suite and 'waitForViewerProgress' in suite
assert 'waitForDesktopResize(page, resizeObserver)' in suite
assert 'assertProcessContinuity(initialProcesses, current)' in suite
assert 'terminalContinuityCommand(processNonce)' in suite
assert suite.index('cold Browser open before Code') < suite.index('let f = await openCode()')
assert 'Failed checkpoint changed the durable committed head' in suite
assert 'TURN failure Retry state' in suite
assert 'verifyCloudDeployment(identityEnv)' in suite
print('OS workflows: YAML, shell, JavaScript and release contracts passed')
