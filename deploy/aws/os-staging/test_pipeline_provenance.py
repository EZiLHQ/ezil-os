import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from staging_candidate import PINNED, prepare
from source_provenance import git


class StagingPipelineTests(unittest.TestCase):
    def setUp(self):
        self.contract = {'schema': 1, 'enabled': True, 'release_ref': 'refs/heads/fixture-only',
                         'delivery_role_arn': 'arn:aws:iam::452630323510:role/fixture-only', **PINNED}
        # This role/ref exist only in unit fixtures. No real authorization is asserted.
        self.request = {**PINNED, 'ref': 'refs/heads/fixture-only', 'source': 'a' * 40,
                        'base': 'b' * 40, 'previous_app_source': 'c' * 40, 'worker_source': 'd' * 40,
                        'tag': 'candidate', 'previous_app_tag': 'previous',
                        'worker_action': 'retain', 'worker_version': '11111111-1111-1111-1111-111111111111',
                        'desktop_digest': 'sha256:' + 'f' * 64, 'rollback_format': 'legacy-two-archive',
                        'rollback_reviewed': True,
                        **{k: 'e' * 64 for k in ('receipt_sha256', 'previous_app_archive_sha256',
                                                'previous_runtime_archive_sha256', 'worker_bundle_sha256')}}

    def test_checked_in_pipeline_is_disabled_with_no_invented_branch_or_role(self):
        contract = json.loads(Path(__file__).with_name('pipeline.json').read_text())
        self.assertFalse(contract['enabled'])
        self.assertIsNone(contract['release_ref'])
        self.assertIsNone(contract['delivery_role_arn'])
        with self.assertRaisesRegex(ValueError, 'disabled'):
            prepare(contract, self.request)

    def test_target_branch_identity_and_rollback_refusals(self):
        for key, value in [('app_origin', 'https://ezil-os-staging.vercel.app'),
                           ('instance_id', 'i-00000000000000000'), ('artifact_prefix', 'os/images/'),
                           ('worker_name', 'ezil-os-worker'), ('ref', 'refs/heads/other'),
                           ('desktop_digest', 'latest'), ('worker_action', 'deploy'),
                           ('rollback_reviewed', False), ('receipt_sha256', '')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                prepare(self.contract, {**self.request, key: value})
        for key, value in [('release_ref', None), ('delivery_role_arn', None),
                           ('delivery_role_arn', PINNED['lease_role_arn'])]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                prepare({**self.contract, key: value}, self.request)

    def test_valid_handoff_remains_review_only_and_uses_verified_install(self):
        result = prepare(self.contract, self.request)
        self.assertFalse(result['deployment_authorized'])
        self.assertEqual(result['install_argv'][2:], ['install-verified', 'candidate', 'a' * 40, 'e' * 64])
        self.assertEqual(result['rollback_argv'][2:], ['install', 'previous'])
        self.assertEqual(result['candidate']['worker_action'], 'retain')

    def test_cli_binds_event_checkout_and_base_ancestry(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            root = directory / 'repo'
            root.mkdir()
            git(root, 'init', '-q', '-b', 'fixture-only')
            git(root, 'config', 'user.name', 'Offline Fixture')
            git(root, 'config', 'user.email', 'fixture@example.invalid')
            git(root, 'commit', '--allow-empty', '-qm', 'base')
            base = git(root, 'rev-parse', 'HEAD').decode().strip()
            git(root, 'commit', '--allow-empty', '-qm', 'candidate')
            sha = git(root, 'rev-parse', 'HEAD').decode().strip()
            # A real, unrelated commit must not be accepted as the candidate base.
            git(root, 'checkout', '--orphan', 'unrelated')
            git(root, 'commit', '--allow-empty', '-qm', 'unrelated')
            unrelated = git(root, 'rev-parse', 'HEAD').decode().strip()
            git(root, 'checkout', '--detach', sha)
            contract, request = directory / 'contract.json', directory / 'request.json'
            contract.write_text(json.dumps(self.contract))
            candidate = {**self.request, 'source': sha, 'base': base}

            def run(*, event_sha=sha, event_ref=self.request['ref'], base_sha=base):
                request.write_text(json.dumps({**candidate, 'base': base_sha}))
                return subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('staging_candidate.py')),
                                       str(request), '--contract', str(contract)], cwd=root, text=True,
                                      capture_output=True, env={**os.environ, 'GITHUB_SHA': event_sha,
                                                                'GITHUB_REF': event_ref})

            result = run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)['deployment_authorized'])
            for change in ({'event_sha': base}, {'event_ref': 'refs/pull/267/merge'},
                           {'base_sha': unrelated}):
                with self.subTest(change=change):
                    self.assertNotEqual(run(**change).returncode, 0)
            (root / 'untracked').write_text('not reviewed')
            self.assertIn('checkout is dirty', run().stderr)
            (root / 'untracked').unlink()
            git(root, 'checkout', '--detach', base)
            self.assertIn('GIT_SHA must equal checkout HEAD', run().stderr)


if __name__ == '__main__':
    unittest.main()
