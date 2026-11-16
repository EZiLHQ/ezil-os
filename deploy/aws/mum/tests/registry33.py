#!/usr/bin/env python3
"""Stage registry capacity 36 over the normal apply-app -> promote order; retain older-reader proofs.

Offline only: temporary git repositories, this checkout's own reviewed Git objects (attestation and
standalone Git host deltas), the real Node probe with a fake fetch, and synthetic CLI results. No AWS, SSM or secret.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from rebase import TOOL, release_record
import rebase_app
import rebase_app_swap as swap_ops
import rebase_release as release
import registry_gc as gc

REPO = HERE.parents[3]
AGENT_5127 = '5127d85f71af309dc7c47537a6be276a7de1eb9d'
AGENT_ED7 = 'ed7da29a279915af36f5c3cfdb63c5627b269049'
# The reviewed host agent the map describes: 5127d85f plus the lower-attestation lane as reviewed at c7a5af66 (attest.py and its test).
AGENT_REVIEWED = 'c7a5af6667b6ddba5605b4fceaa5caaccbce91cc'
AGENT_COMBINED = '68dfb30aba6907b2c6813acc2a6a89281827c900'
AGENT_SOURCE_C = '1f4712c4e0cbc4898439b4eb475a40a690cc6769'
AGENT_ADAPTIVE = '6a187841856db9baaec2bacfe2c26a5c73eff045'
AGENT_REPO_DIAGNOSTICS = '5f51b75d9996f4f4a4885a60f749dd0651ba5b15'
SHA = '9' * 40
TAG = 'stage-cap33'
IMAGE = 'sha256:' + 'a' * 64


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def source_repo(root, *declarations):
    """One commit per declaration text (None: the file is absent). Returns the commit SHAs."""
    repo = root / 'repo'
    git(root, 'init', '-q', str(repo))
    git(repo, 'config', 'user.email', 'test@example.invalid')
    git(repo, 'config', 'user.name', 'test')
    path = repo / release.CAPACITY_SOURCE
    shas = []
    for text in declarations:
        path.parent.mkdir(parents=True, exist_ok=True)
        if text is None:
            path.unlink(missing_ok=True)
            (repo / 'other.txt').write_text(str(len(shas)))
        else:
            path.write_text("import { z } from 'zod';\n" + text + '\n')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-qm', str(len(shas)))
        shas.append(git(repo, 'rev-parse', 'HEAD'))
    return repo, shas


class SourceCapacityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo, (self.cap35, self.cap34, self.cap33, self.cap32, self.twice, self.absent) = source_repo(
            Path(temporary.name),
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 35;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 34;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 33;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 32;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 33;\nexport const REBASE_RELEASE_REGISTRY_CAPACITY = 34;',
            None)

    def test_source_constant_and_blob(self):
        capacity, blob = release.source_reader_capacity(self.cap33, self.repo)
        self.assertEqual(capacity, 33)
        self.assertEqual(blob, git(self.repo, 'rev-parse', self.cap33 + ':' + release.CAPACITY_SOURCE))
        self.assertEqual(release.source_reader_capacity(self.cap32, self.repo)[0], 32)

    def test_unknown_capacity_refused(self):
        for sha in (self.twice, self.absent, 'f' * 40, 'not-a-sha'):
            with self.subTest(sha=sha), self.assertRaisesRegex(ValueError, '^target app reader capacity unknown$'):
                release.source_reader_capacity(sha, self.repo)

    def test_thirty_two_reader_allowed_until_thirty_three_records_exist(self):
        # Before the append, rolling back to a thirty-two-record reader (or an unknown one) stays allowed.
        for sha in (self.cap32, self.absent, 'f' * 40):
            self.assertIsNone(release.require_reader_capacity(32, sha, self.repo))
        self.assertEqual(release.require_reader_capacity(33, self.cap33, self.repo)['capacity'], 33)
        for sha, message in ((self.cap32, 'cannot read the live release registry'), (self.absent, 'capacity unknown'),
                             (self.twice, 'capacity unknown')):
            with self.subTest(sha=sha), self.assertRaisesRegex(ValueError, message):
                release.require_reader_capacity(33, sha, self.repo)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(34, self.cap33, self.repo)

    def test_this_checkout_declares_thirty_six_and_ed7_thirty_two(self):
        text = (REPO / release.CAPACITY_SOURCE).read_text()
        self.assertEqual(release.CAPACITY_DECLARATION.findall(text), ['36'])
        self.assertEqual(release.source_reader_capacity(AGENT_ED7, REPO)[0], 32)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(33, AGENT_ED7, REPO)

    def test_thirty_four_requires_a_matched_source_and_running_reader_and_refuses_thirty_five(self):
        self.assertEqual(release.require_reader_capacity(34, self.cap34, self.repo)['capacity'], 34)
        release.require_runtime_capacity({'readerCapacity': 34}, 34)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(34, self.cap33, self.repo)
        with self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
            release.require_runtime_capacity({'readerCapacity': 33}, 34)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(35, self.cap34, self.repo)

    def test_thirty_five_requires_a_matched_source_and_running_reader_and_refuses_thirty_six(self):
        self.assertEqual(release.require_reader_capacity(35, self.cap35, self.repo)['capacity'], 35)
        release.require_runtime_capacity({'readerCapacity': 35}, 35)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(35, self.cap34, self.repo)
        with self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
            release.require_runtime_capacity({'readerCapacity': 34}, 35)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(36, self.cap35, self.repo)


class RuntimeCapacityTests(unittest.TestCase):
    def test_runtime_capacity_only_binds_past_the_legacy_limit(self):
        for legacy in ({}, {'readerCapacity': None}, {'readerCapacity': 32}, None):
            release.require_runtime_capacity(legacy, 32)
        release.require_runtime_capacity({'readerCapacity': 33}, 33)
        for bad in ({}, {'readerCapacity': None}, {'readerCapacity': 32}, {'readerCapacity': '33'}, {'readerCapacity': True},
                    {'readerCapacity': 33.0}, None):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
                release.require_runtime_capacity(bad, 33)
        with self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
            release.require_runtime_capacity({'readerCapacity': 33}, 34)

    def test_prospective_count_counts_only_new_identities(self):
        record = release_record()
        d = {'releases': [record]}
        self.assertEqual(release.prospective_count(d, [record]), 1)
        self.assertEqual(release.prospective_count(d, [record, dict(record, amiId='ami-' + 'f' * 17)]), 2)


class HostAbiTests(unittest.TestCase):
    def test_reviewed_attestation_delta_is_exactly_three_files(self):
        self.assertEqual(release.require_host_abi(AGENT_5127, AGENT_REVIEWED, REPO), release.HOST_AGENT_EXCEPTION)
        self.assertEqual(release.require_host_abi(AGENT_REVIEWED, AGENT_REVIEWED, REPO), {})
        self.assertEqual(release.require_host_abi(AGENT_5127, AGENT_5127, REPO), {})
        # The earlier ed7da29a attestation bytes are no longer the reviewed delta.
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(AGENT_5127, AGENT_ED7, REPO)

    def test_other_deltas_refused(self):
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(AGENT_REVIEWED, AGENT_5127, REPO)  # removing the lane is not the reviewed delta
        for sha in ('f' * 40, 'not-a-sha'):
            with self.subTest(sha=sha), self.assertRaisesRegex(ValueError, 'host agent commit unavailable'):
                release.require_host_abi(AGENT_5127, sha, REPO)

    def test_wider_or_different_blob_refused(self):
        tree = release.host_agent_tree(AGENT_REVIEWED, REPO)
        old = release.host_agent_tree(AGENT_5127, REPO)
        for mutate in (lambda t: t.update({'lib/ezil_host/extra.py': '100644 ' + '1' * 40}),
                       lambda t: t.update({'lib/ezil_host/attest.py': '100644 ' + '2' * 40}),
                       lambda t: t.update({'lib/ezil_host/cli.py': '100755 ' + t['lib/ezil_host/cli.py'].split(' ')[1]}),
                       lambda t: t.pop('test/test_attest.py')):
            changed = copy.deepcopy(tree)
            mutate(changed)
            with self.subTest(changed=sorted(set(changed.items()) ^ set(tree.items()))), \
                    patch.object(release, 'host_agent_tree', side_effect=[old, changed]), \
                    self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                release.require_host_abi(AGENT_5127, AGENT_REVIEWED, REPO)


class StandaloneHostAbiTests(unittest.TestCase):
    """Real Git fixtures copy the reviewed blobs; mutations become actual commits."""
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name) / 'repo'
        git(Path(temporary.name), 'init', '-q', str(self.repo))
        git(self.repo, 'config', 'user.name', 'Offline Fixture')
        git(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        self.commits = []
        for side in (0, 1):
            if side == 1:
                for name, pair in release.HOST_AGENT_EXCEPTION.items():
                    self.install_blob(name, pair[1])
                self.intermediate = self.commit('reviewed attestation')
            for name, pair in release.HOST_AGENT_STANDALONE_EXCEPTION.items():
                self.install_blob(name, pair[side])
            self.commits.append(self.commit(str(side)))
        self.old, self.new = self.commits

    def install_blob(self, name, metadata):
        path = self.repo / release.HOST_AGENT / name
        if metadata is None:
            path.unlink(missing_ok=True)
            return
        mode, blob = metadata.split(' ')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subprocess.check_output(['git', '-C', str(REPO), 'cat-file', 'blob', blob]))
        path.chmod(int(mode, 8) & 0o777)

    def commit(self, message):
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-qm', message)
        return git(self.repo, 'rev-parse', 'HEAD')

    def test_exact_eight_file_fixture_and_checked_in_host_delta(self):
        expected = release.HOST_AGENT_STANDALONE_EXCEPTION
        self.assertEqual(len(expected), 8)
        self.assertEqual(release.require_host_abi(self.old, self.new, self.repo), expected)
        self.assertEqual(release.require_host_abi(self.old, self.intermediate, self.repo), release.HOST_AGENT_EXCEPTION)
        self.assertEqual(release.require_host_abi(AGENT_5127, AGENT_COMBINED, REPO), expected)
        self.assertEqual(release.require_host_abi(AGENT_5127, AGENT_SOURCE_C, REPO), expected)
        self.assertEqual(release.require_host_abi(AGENT_COMBINED, AGENT_COMBINED, REPO), {})

    def test_every_missing_mutated_or_mode_changed_reviewed_file_refused(self):
        for name in release.HOST_AGENT_STANDALONE_EXCEPTION:
            for mutation in ('missing', 'content', 'mode'):
                with self.subTest(path=name, mutation=mutation):
                    git(self.repo, 'reset', '--hard', self.new)
                    path = self.repo / release.HOST_AGENT / name
                    if mutation == 'missing':
                        path.unlink()
                    elif mutation == 'content':
                        path.write_bytes(path.read_bytes() + b'\n# unreviewed change\n')
                    else:
                        path.chmod(0o755)
                    changed = self.commit(mutation)
                    with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                        release.require_host_abi(self.old, changed, self.repo)

    def test_extra_file_wrong_preimage_and_reverse_refused(self):
        extra = self.repo / release.HOST_AGENT / 'lib/ezil_host/unreviewed.py'
        extra.write_text('unreviewed = True\n')
        changed = self.commit('extra file')
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(self.old, changed, self.repo)
        git(self.repo, 'reset', '--hard', self.old)
        path = self.repo / release.HOST_AGENT / 'lib/ezil_host/standalone_git.py'
        path.write_bytes(path.read_bytes() + b'\n# different predecessor\n')
        predecessor = self.commit('wrong preimage')
        for old, new, repo in ((predecessor, self.new, self.repo), (self.new, self.old, self.repo),
                              (self.intermediate, self.new, self.repo), (AGENT_COMBINED, AGENT_5127, REPO)):
            with self.subTest(old=old, new=new), self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                release.require_host_abi(old, new, repo)


    def diagnostics_fixture(self):
        """Extend the reviewed standalone baseline, so CI runs all transition proofs."""
        baseline = release.host_agent_tree(self.new, self.repo)
        for name, pair in release.HOST_AGENT_REPO_DIAGNOSTICS_EXCEPTION.items():
            if name in baseline:
                self.assertEqual(baseline[name], pair[0])
            self.install_blob(name, pair[0])
        self.old = self.commit('reviewed diagnostics predecessor')
        for name, pair in release.HOST_AGENT_REPO_DIAGNOSTICS_EXCEPTION.items():
            self.install_blob(name, pair[1])
        self.new = self.commit('reviewed repository diagnostics')

    def test_exact_five_file_delta_from_both_deployed_predecessors(self):
        self.diagnostics_fixture()
        expected = release.HOST_AGENT_REPO_DIAGNOSTICS_EXCEPTION
        self.assertEqual(set(expected), {'lib/ezil_host/edge.py', 'lib/ezil_host/standalone_git.py',
            'lib/ezil_host/standalone_git_runtime.py', 'test/test_standalone_git.py',
            'test/test_standalone_git_edge.py'})
        self.assertEqual(release.host_agent_tree(AGENT_SOURCE_C, REPO),
                         release.host_agent_tree(AGENT_ADAPTIVE, REPO))
        self.assertEqual(release.require_host_abi(self.old, self.new, self.repo), expected)
        for predecessor in (AGENT_SOURCE_C, AGENT_ADAPTIVE):
            self.assertEqual(release.require_host_abi(predecessor, AGENT_REPO_DIAGNOSTICS, REPO), expected)
            self.assertEqual(release.require_host_abi(predecessor, git(REPO, 'rev-parse', 'HEAD'), REPO), expected)
        self.assertEqual(release.require_host_abi(self.new, self.new, self.repo), {})

    def test_each_missing_changed_byte_or_mode_is_refused(self):
        self.diagnostics_fixture()
        for name in release.HOST_AGENT_REPO_DIAGNOSTICS_EXCEPTION:
            for mutation in ('missing', 'content', 'mode'):
                with self.subTest(path=name, mutation=mutation):
                    git(self.repo, 'reset', '--hard', self.new)
                    path = self.repo / release.HOST_AGENT / name
                    if mutation == 'missing':
                        path.unlink()
                    elif mutation == 'content':
                        path.write_bytes(path.read_bytes() + b'\n# unreviewed byte change\n')
                    else:
                        path.chmod(0o755)
                    changed = self.commit(mutation)
                    with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                        release.require_host_abi(self.old, changed, self.repo)

    def test_every_nonempty_partial_delta_is_refused(self):
        self.diagnostics_fixture()
        import itertools
        names = tuple(release.HOST_AGENT_REPO_DIAGNOSTICS_EXCEPTION)
        for count in range(1, len(names)):
            for selected in itertools.combinations(names, count):
                with self.subTest(selected=selected):
                    git(self.repo, 'reset', '--hard', self.old)
                    for name in selected:
                        self.install_blob(name, release.HOST_AGENT_REPO_DIAGNOSTICS_EXCEPTION[name][1])
                    changed = self.commit('partial diagnostics')
                    with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                        release.require_host_abi(self.old, changed, self.repo)

    def test_added_path_wrong_preimages_reverse_and_composed_delta_are_refused(self):
        self.diagnostics_fixture()
        extra = self.repo / release.HOST_AGENT / 'lib/ezil_host/unreviewed.py'
        extra.write_text('unreviewed = True\n')
        changed = self.commit('extra path')
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(self.old, changed, self.repo)
        for name in release.HOST_AGENT_REPO_DIAGNOSTICS_EXCEPTION:
            git(self.repo, 'reset', '--hard', self.old)
            path = self.repo / release.HOST_AGENT / name
            path.write_bytes(path.read_bytes() + b'\n# different predecessor\n')
            predecessor = self.commit('wrong preimage')
            with self.subTest(path=name), self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                release.require_host_abi(predecessor, self.new, self.repo)
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(self.new, self.old, self.repo)
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(AGENT_5127, AGENT_REPO_DIAGNOSTICS, REPO)


class PromotionGuardTests(unittest.TestCase):
    def setUp(self):
        self.plan = {'rollout': {'app': {'tag': TAG, 'gitSha': SHA, 'checksumSha256': '0' * 64}}, 'bake': {'agentCommit': SHA}}
        self.receipt = {'gitSha': SHA, 'killSwitch': '1', 'deployment': {}, 'readerCapacity': 33, 'imageId': IMAGE}
        self.observed = {'gitSha': SHA, 'servedSha': SHA, 'killSwitch': '1', 'composeTag': TAG, 'imageId': IMAGE,
                         'tagImageId': IMAGE, 'composeImageId': IMAGE, 'lockFree': True, 'readerCapacity': 33}
        self.calls = []

    def run_guard(self, count=33, apply=True, receipt=None, observed=None, capacity=33, abi=None):
        def ssm(directory, operation, body, run_apply, aws, write, fresh=False):
            self.calls.append((operation, fresh))
            self.assertEqual(body, rebase_app.probe_body(TAG))
            return observed if observed is not None else copy.deepcopy(self.observed)
        with patch.object(release, 'require_receipt', return_value=receipt if receipt is not None else copy.deepcopy(self.receipt)), \
                patch.object(release, 'source_reader_capacity', return_value=(capacity, 'b' * 40)), \
                patch.object(release, 'require_host_abi', side_effect=abi or (lambda old, new: {})), \
                patch.object(release.rebase_ssm, 'run', side_effect=ssm):
            return release.require_reader_promotion(Path('/nonexistent/plan.json'), self.plan, count, apply, 7, AGENT_5127)

    def test_legacy_count_needs_nothing(self):
        self.plan['bake']['agentCommit'] = 'e' * 40
        self.assertIsNone(self.run_guard(count=32, receipt={}, observed={}, capacity=1,
                                         abi=lambda *a: (_ for _ in ()).throw(ValueError('abi'))))
        self.assertEqual(self.calls, [])

    def test_proven_reader_passes_with_one_fresh_protected_probe(self):
        self.run_guard()
        self.assertEqual(self.calls, [('promote-reader-probe-g7', True)])

    def test_dry_run_checks_receipt_source_and_abi_without_probe(self):
        self.run_guard(apply=False)
        self.assertEqual(self.calls, [])
        with self.assertRaisesRegex(ValueError, 'apply-app receipt does not prove'):
            self.run_guard(apply=False, receipt=dict(self.receipt, readerCapacity=None))

    def test_refusals(self):
        cases = [
            (dict(receipt={k: v for k, v in self.receipt.items() if k != 'readerCapacity'}), 'apply-app receipt does not prove'),
            (dict(receipt=dict(self.receipt, readerCapacity=32)), 'apply-app receipt does not prove'),
            (dict(receipt={k: v for k, v in self.receipt.items() if k != 'imageId'}), 'apply-app receipt does not prove'),
            (dict(receipt=dict(self.receipt, imageId='unavailable')), 'apply-app receipt does not prove'),
            (dict(observed=dict(self.observed, imageId='sha256:' + 'c' * 64, tagImageId='sha256:' + 'c' * 64,
                                composeImageId='sha256:' + 'c' * 64)), 'running image is not the image apply-app installed'),
            (dict(capacity=32), 'target app cannot read the live release registry'),
            (dict(count=34), 'target app cannot read the live release registry'),
            (dict(abi=lambda *a: (_ for _ in ()).throw(ValueError('host agent differs from the deployed agent beyond the reviewed delta'))),
             'beyond the reviewed delta'),
            (dict(observed=dict(self.observed, gitSha='e' * 40)), 'not the plan-bound apply-app build'),
            (dict(observed=dict(self.observed, servedSha='e' * 40)), 'not the plan-bound apply-app build'),
            (dict(observed=dict(self.observed, composeTag='old-app')), 'not the plan-bound apply-app build'),
            (dict(observed=dict(self.observed, composeImageId='sha256:' + 'b' * 64)), 'not the plan-bound apply-app build'),
            (dict(observed=dict(self.observed, tagImageId='sha256:' + 'b' * 64)), 'not the plan-bound apply-app build'),
            (dict(observed=dict(self.observed, imageId='unavailable', tagImageId='unavailable', composeImageId='unavailable')),
             'not the plan-bound apply-app build'),
            (dict(observed=dict(self.observed, killSwitch='0')), 'not the plan-bound apply-app build'),
            (dict(observed=dict(self.observed, lockFree=False)), 'not the plan-bound apply-app build'),
            (dict(observed=dict(self.observed, readerCapacity=None)), 'running app reader capacity is below'),
            (dict(observed=dict(self.observed, readerCapacity=32)), 'running app reader capacity is below'),
        ]
        for kwargs, message in cases:
            self.calls.clear()
            with self.subTest(message=message, kwargs=sorted(kwargs)), self.assertRaisesRegex(ValueError, message):
                self.run_guard(**kwargs)

    def test_app_and_bake_must_be_one_commit(self):
        self.plan['bake']['agentCommit'] = 'e' * 40
        with self.assertRaisesRegex(ValueError, 'same reviewed integrated source commit'):
            self.run_guard()
        self.assertEqual(self.calls, [])


class ProbeTests(unittest.TestCase):
    """The real NODE program under Node with fetch replaced; production bytes are unchanged."""
    PRELOAD = r"""
const mode = process.env.TEST_HEALTH_MODE;
globalThis.fetch = async (url, init) => {
  if (url !== 'http://127.0.0.1:3000/api/health' || init.redirect !== 'error' || !(init.signal instanceof AbortSignal)) throw new Error('bad request');
  if (mode === 'throw') throw new Error('refused');
  const body = mode === 'nocap' ? { ok: true, sha: process.env.EZIL_GIT_SHA }
    : mode === 'othersha' ? { ok: true, sha: 'e'.repeat(40), registryCapacity: 33 }
    : mode === 'string' ? { ok: true, sha: process.env.EZIL_GIT_SHA, registryCapacity: '33' }
    : { ok: true, sha: process.env.EZIL_GIT_SHA, registryCapacity: 33 };
  return { status: mode === 'status' ? 503 : 200, json: async () => body };
};
"""

    def probe(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            preload = Path(directory) / 'preload.cjs'
            preload.write_text(self.PRELOAD)
            environment = {'PATH': os.environ['PATH'], 'EZIL_GIT_SHA': SHA, 'EZIL_AWS_KILL_SWITCH': '1', 'TEST_HEALTH_MODE': mode,
                           'EZIL_AWS_LIFECYCLE_DEPLOYMENTS': json.dumps({TOOL.REGION: dict(release_record(), releases=[release_record()])})}
            result = subprocess.run(['node', '--require', str(preload), '-e', rebase_app.NODE], env=environment,
                                    capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_capacity_only_from_own_health_with_matching_sha(self):
        out = self.probe('ok')
        self.assertEqual(out['readerCapacity'], 33)
        self.assertEqual(set(out), {'gitSha', 'killSwitch', 'deployment', 'readerCapacity'})
        for mode in ('nocap', 'othersha', 'string', 'status', 'throw'):
            with self.subTest(mode=mode):
                self.assertIsNone(self.probe(mode)['readerCapacity'])

    def test_probe_is_bounded_and_fixed(self):
        self.assertIn("fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(5000),redirect:'error'})", rebase_app.NODE)
        self.assertEqual(rebase_app.NODE.count('fetch('), 1)
        self.assertNotIn('cache:', rebase_app.NODE)
        self.assertIn('readerCapacity', swap_ops.PROBE_KEYS)


class RealHttpProbeTests(unittest.TestCase):
    """The production NODE with only its port swapped, against a real HTTP server: real fetch, real redirect handling."""

    def serve(self, status, body, location=None):
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.server.paths.append(self.path)
                self.send_response(status)
                if location:
                    self.send_header('Location', location)
                payload = json.dumps(body).encode()
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        server.paths = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def probe(self, server):
        port = server.server_address[1]
        node = rebase_app.NODE.replace('http://127.0.0.1:3000/api/health', f'http://127.0.0.1:{port}/api/health')
        self.assertEqual(node.count(f'127.0.0.1:{port}'), 1)
        environment = {'PATH': os.environ['PATH'], 'EZIL_GIT_SHA': SHA, 'EZIL_AWS_KILL_SWITCH': '1',
                       'EZIL_AWS_LIFECYCLE_DEPLOYMENTS': json.dumps({TOOL.REGION: dict(release_record(), releases=[release_record()])})}
        result = subprocess.run(['node', '-e', node], env=environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)['readerCapacity']

    def test_real_fetch_reads_capacity_only_from_matching_health(self):
        version = subprocess.run(['node', '--version'], capture_output=True, text=True, check=True).stdout.strip()
        print(f'node {version}', file=sys.stderr)
        ok = self.serve(200, {'ok': True, 'sha': SHA, 'registryCapacity': 33})
        self.assertEqual(self.probe(ok), 33)
        self.assertEqual(ok.paths, ['/api/health'])
        for status, body, location in ((302, {'ok': True, 'sha': SHA, 'registryCapacity': 33}, '/elsewhere'),
                                       (503, {'ok': True, 'sha': SHA, 'registryCapacity': 33}, None),
                                       (200, {'ok': True, 'sha': 'e' * 40, 'registryCapacity': 33}, None),
                                       (200, {'ok': True, 'sha': SHA}, None)):
            with self.subTest(status=status, body=body):
                server = self.serve(status, body, location)
                self.assertIsNone(self.probe(server))
                self.assertEqual(server.paths, ['/api/health'])  # never followed the redirect


class LegacyGcParityTests(unittest.TestCase):
    def test_frozen_gc_stays_a_thirty_two_record_tool(self):
        self.assertEqual((TOOL.RELEASE_REGISTRY_CAPACITY, TOOL.ACTIVE_REGISTRY_CAPACITY), (32, 36))
        self.assertEqual(gc.tool.RELEASE_REGISTRY_CAPACITY, 32)
        target = release_record()
        records = [dict(target, amiId='ami-' + format(n, '017x'), recipeVersion='1.0.' + str(n)) for n in range(100, 133)]
        self.assertEqual(len(records), 33)
        snapshot = {'VersionId': 'v1', 'deployment': dict(target, releases=records)}
        drops = [{'lowerImageDigest': records[0]['lowerImageDigest'], 'amiId': records[0]['amiId']}]
        with self.assertRaisesRegex(ValueError, '^GC invalid registry$'):
            gc.prepare(snapshot, target, [], {}, drops, '0' * 64, None)


class AppSwapGuardTests(unittest.TestCase):
    def test_swap_checks_reader_before_ledger_or_install(self):
        source = Path(swap_ops.__file__).read_text()
        swap = source[source.index('def swap('):source.index('def reconcile(')]
        guard = swap.index('release.require_reader_capacity(count, dst')
        self.assertLess(guard, swap.index('release.write_ledger_append'))
        self.assertLess(guard, swap.index('rebase_ssm.run'))
        self.assertLess(swap.index("need(at(after, dst"), swap.index('release.require_runtime_capacity(after, count)'))
        reconcile = source[source.index('def reconcile('):source.index('def cli(')]
        self.assertLess(reconcile.index('release.require_runtime_capacity(second'), reconcile.index('terminal(ledger_path'))


if __name__ == '__main__':
    unittest.main()
