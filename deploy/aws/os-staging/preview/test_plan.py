"""Offline tests for the os-pr-preview planner and the workflow's isolation properties."""
import copy
import json
from pathlib import Path
import re
import sys
import unittest

import yaml

HERE = Path(__file__).parent
REPO = HERE.parents[3]
sys.path.insert(0, str(HERE))
import plan  # noqa: E402

SHA = '0123456789abcdef0123456789abcdef01234567'
REPOSITORY = 'EZiLHQ/ezil-os'
ACTIVE = {'schema': 1, 'enabled': True, 'role_arn': 'arn:aws:iam::000000000000:role/os-pr-preview',
          'label': 'preview:os', 'slots': dict(plan.SLOTS), 'ttl_hours': 48, 'computers': 'off'}


def event(action='synchronize', labels=('preview:os',), label=None, fork=False):
    body = {'action': action, 'pull_request': {
        'number': 291, 'labels': [{'name': n} for n in labels],
        'head': {'sha': SHA, 'repo': {'full_name': 'someone/ezil-os' if fork else REPOSITORY}}}}
    if label:
        body['label'] = {'name': label}
    return body


class Planner(unittest.TestCase):
    def decide(self, ev=None, activation=ACTIVE, files=('app/src/app/page.tsx',)):
        return plan.decide(ev or event(), activation, list(files), REPOSITORY)

    def test_deploys_a_labelled_app_change_with_exact_tag(self):
        result = self.decide()
        self.assertEqual((result['action'], result['tag'], result['sha']), ('deploy', f'pr291-{SHA[:12]}', SHA))
        self.assertEqual((result['ttl_hours'], result['computers']), ('48', 'off'))

    def test_checked_in_activation_is_inert(self):
        checked_in = json.loads((HERE / 'activation.json').read_text())
        self.assertIs(checked_in['enabled'], False)
        self.assertIsNone(checked_in['role_arn'])
        self.assertEqual(self.decide(activation=checked_in)['action'], 'skip')

    def test_forks_never_get_previews_even_when_active(self):
        result = self.decide(event(fork=True))
        self.assertEqual(result['action'], 'skip')
        self.assertNotIn('role_arn', result)

    def test_teardown_on_close_or_preview_label_removal(self):
        self.assertEqual(self.decide(event('closed', labels=()))['action'], 'teardown')
        self.assertEqual(self.decide(event('unlabeled', labels=(), label='preview:os'))['action'], 'teardown')
        self.assertEqual(self.decide(event('unlabeled', label='size/S'))['action'], 'skip')
        self.assertEqual(self.decide(event('labeled', label='size/S'))['action'], 'skip')

    def test_unlabelled_prs_are_skipped(self):
        self.assertEqual(self.decide(event(labels=('size/S',)))['action'], 'skip')

    def test_schema_changes_are_refused_because_data_is_shared(self):
        for path in ('app/drizzle/0042_x.sql', 'app/drizzle/meta/_journal.json', 'app/scripts/migrate-things.mjs'):
            with self.subTest(path=path):
                result = self.decide(files=('app/src/a.ts', path))
                self.assertEqual(result['action'], 'skip')
                self.assertIn('shares the staging PREVIEW database', result['reason'])
        self.assertEqual(self.decide(files=('app/src/server/migration-status.test.ts',))['action'], 'deploy')

    def test_editor_only_changes_are_not_called_previews(self):
        result = self.decide(files=('worker/ezil-models/src/extension.ts', 'docs/x.md'))
        self.assertEqual(result['action'], 'skip')
        self.assertIn('editor/computer image', result['reason'])
        self.assertEqual(self.decide(files=('native/src/contract.ts',))['action'], 'deploy')

    def test_invalid_activation_fails_closed(self):
        for change in ({'role_arn': 'arn:aws:iam::*:role/x'}, {'role_arn': None}, {'ttl_hours': 73},
                       {'computers': 'all'}, {'slots': {'1': 'https://os-staging.ezil.work'}}, {'label': ''},
                       {'schema': 2}):
            broken = {**copy.deepcopy(ACTIVE), **change}
            with self.subTest(change=change), self.assertRaises(SystemExit):
                self.decide(activation=broken)

    def test_slots_match_the_host_and_the_app(self):
        sys.path.insert(0, str(HERE))
        import preview_host
        self.assertEqual({str(s): preview_host.origin(s) for s in preview_host.SLOTS}, plan.SLOTS)
        forwarded = (REPO / 'app/src/utils/forwarded.ts').read_text()
        pattern = re.search(r"PR_PREVIEW_SLOT_ORIGIN = /\^(.+)\$/;", forwarded).group(1).replace('\\/', '/')
        for url in plan.SLOTS.values():
            self.assertRegex(url, '^' + pattern + '$')
        caddy = (HERE.parent / 'Caddyfile').read_text()
        for slot, port in preview_host.SLOTS.items():
            self.assertIn(f'os-pv{slot}.ezil.work {{\n    import pr_preview {port}\n}}', caddy)


class Workflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (REPO / '.github/workflows/os-pr-preview.yml').read_text()
        cls.flow = yaml.safe_load(cls.text)
        cls.jobs = cls.flow['jobs']

    def test_only_pull_request_events_and_no_dispatch(self):
        self.assertEqual(list(self.flow[True]), ['pull_request'])  # YAML 1.1 reads `on` as True

    def test_never_touches_the_staging_lease_or_staging_deploy_groups(self):
        self.assertNotIn('staging-lock.py', self.text)
        self.assertNotIn('install-verified', self.text)
        self.assertNotIn('deploy.sh install', self.text)
        self.assertNotIn('deploy-staging', self.text)
        self.assertEqual(self.flow['concurrency']['group'], 'os-pr-preview-${{ github.event.pull_request.number }}')
        for job in self.jobs.values():
            self.assertNotIn('concurrency', job)
            env = job.get('environment')
            self.assertIn((env or {}).get('name', env) if isinstance(env, dict) else env, (None, 'os-pr-preview'))

    def test_only_deploy_and_teardown_get_a_cloud_identity(self):
        with_identity = {name for name, job in self.jobs.items() if job.get('permissions', {}).get('id-token') == 'write'}
        self.assertEqual(with_identity, {'deploy', 'teardown'})
        self.assertEqual(self.flow['permissions'], {'contents': 'read'})

    def test_identity_jobs_run_base_tooling_not_pr_code(self):
        for name in ('plan', 'deploy', 'browser', 'teardown'):
            checkout = next(s for s in self.jobs[name]['steps'] if s.get('uses', '').startswith('actions/checkout'))
            self.assertEqual(checkout['with']['ref'], '${{ github.event.pull_request.base.sha }}', name)
            self.assertIs(checkout['with']['persist-credentials'], False)
        build = next(s for s in self.jobs['build']['steps'] if s.get('uses', '').startswith('actions/checkout'))
        self.assertEqual(build['with']['ref'], '${{ needs.plan.outputs.sha }}')

    def test_run_blocks_take_values_through_env_not_interpolation(self):
        for name, job in self.jobs.items():
            for step in job['steps']:
                if 'run' in step:
                    self.assertNotIn('${{', step['run'], f'{name}: {step.get("name")}')


if __name__ == '__main__':
    unittest.main()
