"""Offline contracts plus YAML and embedded-shell parsing for OS release workflows."""
from pathlib import Path
import re
import subprocess
import yaml

root = Path(__file__).resolve().parents[2]
workflows = {}
for name in ('ci', 'preview', 'image', 'deploy', 'deploy-app'):
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

jobs = workflows['preview']['jobs']
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
assert positions['Verify or apply reviewed production migrations'] < positions['Deploy production Worker']
assert positions['Capture previous production identities'] < positions['Deploy production Worker']
assert positions['Test the returned production URL'] < positions['Test the canonical production URL']
assert positions['Test the canonical production URL'] < positions['Record canonical identity and distinct Cloudflare container digest']
assert positions['Restore previous Worker version (never reverse SQL)'] < positions['Verify rollback and report container restoration limitations']
assert workflows['deploy']['jobs']['release']['needs'] == 'gated-production'
assert positions['Acquire shared production lease'] < positions['Capture previous production identities']
assert positions['Release shared production lease'] > positions['Upload production release and recovery evidence']
print('OS workflows: YAML, shell, JavaScript and release contracts passed')
