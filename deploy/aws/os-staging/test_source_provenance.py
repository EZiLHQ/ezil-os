"""Real Git, fake Docker/AWS: label, checkout and branch-provenance regressions."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import unittest

from source_provenance import ci_receipt, git
from test_deploy_tooling import SandboxTestCase

BUILD_ENV = {'NEXT_PUBLIC_SUPABASE_URL': 'https://example.invalid',
             'NEXT_PUBLIC_SUPABASE_ANON_KEY': 'fixture',
             'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY': 'pk_test_fixture'}


class SourceProvenanceTests(SandboxTestCase):
    def commit(self, name='change'):
        root = self.box.root / 'repo'
        git(root, 'add', '.')
        git(root, '-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid',
            'commit', '-qm', name)
        self.box.sha = git(root, 'rev-parse', 'HEAD').decode().strip()
        return self.box.sha

    def build(self, tag='v1', **env):
        return self.box.deploy_sh('build', tag, **{**BUILD_ENV, **env})

    def no_build(self):
        self.assertFalse(any(c[0] in ('docker', 'aws') for c in self.box.calls()), self.box.calls())

    def test_false_existing_sha_refused_before_docker(self):
        before = self.box.sha
        (self.box.root / 'repo/app/provenance-fixture.txt').write_text('new\n')
        self.commit()
        result = self.build(GIT_SHA=before)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('GIT_SHA must equal checkout HEAD', result.stderr)
        self.no_build()

    def test_tracked_staged_and_untracked_changes_refused(self):
        root = self.box.root / 'repo'
        dockerfile = root / 'app/Dockerfile'
        before = dockerfile.read_bytes()
        for staged in (False, True):
            dockerfile.write_text('FROM scratch\n# dirty\n')
            if staged:
                git(root, 'add', 'app/Dockerfile')
            result = self.build()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('checkout is dirty', result.stderr)
            dockerfile.write_bytes(before)
            git(root, 'add', 'app/Dockerfile')
        (root / 'app/untracked.txt').write_text('untracked\n')
        self.assertNotEqual(self.build().returncode, 0)
        self.no_build()

    def test_clean_archive_excludes_ignored_files_and_survives_checkout_race(self):
        root = self.box.root / 'repo'
        (root / 'app/provenance-fixture.txt').write_text('committed\n')
        self.commit()
        (root / 'app/ignored.txt').write_text('must not enter build context\n')
        caddy = self.box.deploy / 'Caddyfile'
        expected_caddy = caddy.read_bytes()
        result = self.build(MUTATE_DURING_BUILD=str(caddy))
        self.assertEqual(result.returncode, 0, result.stderr)
        build, = [c for c in self.box.calls() if c[:2] == ['docker', 'build']]
        self.assertNotEqual(Path(build[-1]), root)
        self.assertEqual((self.box.state / 'built-fixture').read_text(), 'committed\n')
        self.assertEqual((self.box.state / 'built-ignored').read_text(), 'False')
        artifacts = self.box.deploy / 'artifacts'
        receipt = json.loads((artifacts / 'v1.source.json').read_text())
        self.assertEqual(receipt['source'], self.box.sha)
        self.assertEqual(receipt['tree'], git(root, 'rev-parse', 'HEAD^{tree}').decode().strip())
        self.assertEqual(receipt['environment'], 'staging')
        self.assertEqual(receipt['source_archive_sha256'], hashlib.sha256(git(root, 'archive', '--format=tar', self.box.sha)).hexdigest())
        with tarfile.open(artifacts / 'v1.runtime.tar.gz') as bundle:
            self.assertEqual(bundle.extractfile('Caddyfile').read(), expected_caddy)
        self.assertNotEqual(caddy.read_bytes(), expected_caddy)
        # The paired hashes bind the actual app and runtime bytes.
        for name, expected in receipt['artifacts'].items():
            self.assertEqual(hashlib.sha256((artifacts / name).read_bytes()).hexdigest(), expected)

    def test_upload_refuses_missing_wrong_target_and_changed_receipts(self):
        self.assertEqual(self.build().returncode, 0)
        artifacts = self.box.deploy / 'artifacts'
        path = artifacts / 'v1.source.json'
        before = path.read_text()
        for replacement in (None, before.replace('"staging"', '"production"'),
                            before.replace('ezil-os-staging:v1', 'ezil-os-staging:v2'),
                            before.replace('"artifacts": {', '"artifacts": {"extra": "bad",')):
            path.unlink() if replacement is None else path.write_text(replacement)
            result = self.box.deploy_sh('upload', 'v1', OS_STAGING_ARTIFACT_BUCKET='fixture-staging')
            self.assertNotEqual(result.returncode, 0)
            path.write_text(before)
        # Even a recomputed checksum file cannot hide bytes changed after build.
        (artifacts / 'v1.tar.gz').write_bytes(b'other artifact')
        checksum = subprocess.check_output(['sha256sum', 'v1.tar.gz', 'v1.runtime.tar.gz'], cwd=artifacts)
        (artifacts / 'v1.sha256').write_bytes(checksum)
        result = self.box.deploy_sh('upload', 'v1', OS_STAGING_ARTIFACT_BUCKET='fixture-staging')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Artifacts differ from source receipt', result.stderr)
        self.assertFalse(any('put-object' in c for c in self.box.calls()))

    def test_pr_head_base_and_tested_merge_are_distinct(self):
        root = self.box.root / 'repo'
        common = self.box.sha
        git(root, 'checkout', '-qb', 'feature')
        (root / 'feature').write_text('feature\n')
        head = self.commit()
        git(root, 'checkout', '-qb', 'integration', common)
        (root / 'base-only').write_text('base\n')
        base = self.commit()
        git(root, '-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid',
            'merge', '--no-ff', '-qm', 'test merge', head)
        merge = git(root, 'rev-parse', 'HEAD').decode().strip()
        event = {'pull_request': {'head': {'sha': head, 'ref': 'feature'},
                                  'base': {'sha': base, 'ref': 'integration'}}}
        receipt = ci_receipt(root, merge, event, 'pull_request', 'refs/pull/123/merge')
        self.assertEqual((receipt['source'], receipt['head'], receipt['base']), (merge, head, base))
        self.assertEqual(receipt['merge_base'], common)
        self.assertEqual(receipt['unique_commits'], [1, 1])
        self.assertEqual(receipt['head_delta_files'], ['feature'])
        self.assertEqual(receipt['composed_files'], ['feature'])
        self.assertFalse(receipt['deployment_authorized'])
        self.assertEqual(receipt['intended_staging']['app'], 'https://os-staging.ezil.work')
        wrong_event = {'pull_request': {**event['pull_request'],
                                       'head': {'sha': base, 'ref': 'feature'}}}
        with self.assertRaisesRegex(ValueError, 'not the merge'):
            ci_receipt(root, merge, wrong_event, 'pull_request', 'refs/pull/123/merge')
        git(root, 'checkout', '--detach', head)
        with self.assertRaisesRegex(ValueError, 'not the merge'):
            ci_receipt(root, head, event, 'pull_request', 'refs/pull/123/merge')

    def test_push_cannot_mislabel_checkout_or_authorize_deploy(self):
        root = self.box.root / 'repo'
        sha = self.box.sha
        event = {'after': sha, 'before': '0' * 40}
        for branch in ('preview', 'main', 'feature'):
            receipt = ci_receipt(root, sha, event, 'push', 'refs/heads/' + branch)
            self.assertFalse(receipt['deployment_authorized'])
            self.assertIsNone(receipt['base'])
        with self.assertRaisesRegex(ValueError, 'does not match'):
            ci_receipt(root, sha, {**event, 'after': 'f' * 40}, 'push', 'refs/heads/preview')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            ci_receipt(root, sha, event, 'push', 'refs/tags/v1')


if __name__ == '__main__':
    unittest.main()
