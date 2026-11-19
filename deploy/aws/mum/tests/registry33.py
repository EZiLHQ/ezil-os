#!/usr/bin/env python3
"""Stage registry capacity 37 over the normal apply-app -> promote order per namespace legacy limit
(mum 32, prd 26); retain older-reader proofs.

Offline only: temporary git repositories, this checkout's own reviewed Git objects (attestation and
standalone Git host deltas), the real Node probe with a fake fetch, and synthetic CLI results. No AWS, SSM or secret.
"""
import copy
import json
import os
import re
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
        self.repo, (self.cap41, self.cap40, self.cap39, self.cap38, self.cap37, self.cap36, self.cap35, self.cap34, self.cap33, self.cap32, self.cap27, self.cap26, self.twice, self.absent) = source_repo(
            Path(temporary.name),
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 41;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 40;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 39;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 38;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 37;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 36;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 35;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 34;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 33;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 32;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 27;',
            'export const REBASE_RELEASE_REGISTRY_CAPACITY = 26;',
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

    def test_this_checkout_declares_forty_one_and_ed7_thirty_two(self):
        text = (REPO / release.CAPACITY_SOURCE).read_text()
        self.assertEqual(release.CAPACITY_DECLARATION.findall(text), ['41'])
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

    def test_thirty_six_requires_a_matched_source_and_running_reader_and_refuses_thirty_seven(self):
        self.assertEqual(release.require_reader_capacity(36, self.cap36, self.repo)['capacity'], 36)
        release.require_runtime_capacity({'readerCapacity': 36}, 36)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(36, self.cap35, self.repo)
        with self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
            release.require_runtime_capacity({'readerCapacity': 35}, 36)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(37, self.cap36, self.repo)

    def test_thirty_seven_requires_a_matched_source_and_running_reader_and_refuses_thirty_eight(self):
        self.assertEqual(release.require_reader_capacity(37, self.cap37, self.repo)['capacity'], 37)
        release.require_runtime_capacity({'readerCapacity': 37}, 37)
        # A historical thirty-six reader (source or running) still refuses the thirty-seventh record.
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(37, self.cap36, self.repo)
        with self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
            release.require_runtime_capacity({'readerCapacity': 36}, 37)
        with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
            release.require_reader_capacity(38, self.cap37, self.repo)
        with self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
            release.require_runtime_capacity({'readerCapacity': 37}, 38)

    def test_forty_one_requires_a_matched_source_and_running_reader_and_refuses_forty_two(self):
        self.assertEqual(release.require_reader_capacity(41, self.cap41, self.repo)['capacity'], 41)
        release.require_runtime_capacity({'readerCapacity': 41}, 41)
        for count, source, running in ((39, self.cap38, 38), (40, self.cap39, 39), (41, self.cap40, 40), (42, self.cap41, 41)):
            with self.subTest(count=count):
                with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
                    release.require_reader_capacity(count, source, self.repo)
                with self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
                    release.require_runtime_capacity({'readerCapacity': running}, count)

    def test_production_namespace_proves_readers_past_its_own_legacy_twenty_six(self):
        try:
            release.json_tool.use_namespace('prd')
            self.assertEqual(release.json_tool.legacy_registry_capacity(), 26)
            # At or below twenty-six every prd app reads the registry: no proof, even for a legacy reader.
            for sha in (self.cap26, self.absent, 'f' * 40):
                self.assertIsNone(release.require_reader_capacity(26, sha, self.repo))
            release.require_runtime_capacity({'readerCapacity': None}, 26)
            # The twenty-seventh prd record needs a source and running reader of at least twenty-seven.
            self.assertEqual(release.require_reader_capacity(27, self.cap27, self.repo)['capacity'], 27)
            for sha, message in ((self.cap26, 'cannot read the live release registry'), (self.absent, 'capacity unknown')):
                with self.subTest(sha=sha), self.assertRaisesRegex(ValueError, message):
                    release.require_reader_capacity(27, sha, self.repo)
            for result in ({'readerCapacity': None}, {'readerCapacity': 26}, {}):
                with self.subTest(result=result), self.assertRaisesRegex(ValueError, 'running app reader capacity is below'):
                    release.require_runtime_capacity(result, 27)
            self.assertEqual(release.require_reader_capacity(40, self.cap40, self.repo)['capacity'], 40)
            self.assertEqual(release.require_reader_capacity(41, self.cap41, self.repo)['capacity'], 41)
            with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
                release.require_reader_capacity(39, self.cap38, self.repo)
            with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
                release.require_reader_capacity(40, self.cap39, self.repo)
            with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
                release.require_reader_capacity(41, self.cap40, self.repo)
            with self.assertRaisesRegex(ValueError, 'cannot read the live release registry'):
                release.require_reader_capacity(42, self.cap41, self.repo)
        finally:
            release.json_tool.use_namespace('mum')
        # Switching back restores the frozen mum thirty-two: a thirty-two-record registry needs no proof.
        self.assertIsNone(release.require_reader_capacity(32, self.cap26, self.repo))


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
    """The reviewed three-file attestation delta over real temporary commits rebuilt (git mktree --missing) from the
    exact 5127d85f, ed7da29a and c7a5af66 host trees in host-abi-predecessors.json; those stage commits are not public."""
    LEGACY = {'5127': 'ce761977561aa30699818f3922fa72ad60f1615e', 'ed7': '18fd016a606683e6f9a8eae581e0c7e946470fac',
              'reviewed': '8ddd43d0f95a5a633669f7b2ccb6ed7440591d52'}

    def setUp(self):
        # Reuse the directed tests' private repository, strict loader and reconstruction machinery.
        fixture = load_host_abi_fixture(HOST_ABI_FIXTURE.read_text())
        builder = DirectedHostAbiTests('test_fixture_rebuilds_every_reviewed_predecessor_tree_exactly')
        builder.setUp()
        self.addCleanup(builder.doCleanups)
        self.repo, commits = builder.repo, {}
        for name, tree in self.LEGACY.items():
            self.assertEqual(builder.tree(fixture[tree]), tree)
            commits[name] = builder.commit(fixture[tree])
            self.assertEqual(release.host_agent_tree_id(commits[name], self.repo), tree)
        self.agent_5127, self.agent_ed7, self.agent_reviewed = commits['5127'], commits['ed7'], commits['reviewed']

    def test_reviewed_attestation_delta_is_exactly_three_files(self):
        self.assertEqual(release.require_host_abi(self.agent_5127, self.agent_reviewed, self.repo), release.HOST_AGENT_EXCEPTION)
        self.assertEqual(release.require_host_abi(self.agent_reviewed, self.agent_reviewed, self.repo), {})
        self.assertEqual(release.require_host_abi(self.agent_5127, self.agent_5127, self.repo), {})
        # The earlier ed7da29a attestation bytes are no longer the reviewed delta.
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(self.agent_5127, self.agent_ed7, self.repo)

    def test_other_deltas_refused(self):
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(self.agent_reviewed, self.agent_5127, self.repo)  # removing the lane is not the reviewed delta
        for sha in ('f' * 40, 'not-a-sha'):
            with self.subTest(sha=sha), self.assertRaisesRegex(ValueError, 'host agent commit unavailable'):
                release.require_host_abi(self.agent_5127, sha, self.repo)

    def test_wider_or_different_blob_refused(self):
        tree = release.host_agent_tree(self.agent_reviewed, self.repo)
        old = release.host_agent_tree(self.agent_5127, self.repo)
        for mutate in (lambda t: t.update({'lib/ezil_host/extra.py': '100644 ' + '1' * 40}),
                       lambda t: t.update({'lib/ezil_host/attest.py': '100644 ' + '2' * 40}),
                       lambda t: t.update({'lib/ezil_host/cli.py': '100755 ' + t['lib/ezil_host/cli.py'].split(' ')[1]}),
                       lambda t: t.pop('test/test_attest.py')):
            changed = copy.deepcopy(tree)
            mutate(changed)
            with self.subTest(changed=sorted(set(changed.items()) ^ set(tree.items()))), \
                    patch.object(release, 'host_agent_tree', side_effect=[old, changed]), \
                    self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                release.require_host_abi(self.agent_5127, self.agent_reviewed, self.repo)


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
        # The checked-in HEAD host tree (b7700d49) is not a reviewed target from 5127: no delta admits it.
        with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
            release.require_host_abi(AGENT_5127, git(REPO, 'rev-parse', 'HEAD'), REPO)
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


HOST_ABI_FIXTURE = HERE / 'host-abi-predecessors.json'
HOST_ABI_FIXTURE_TREES = 7
HOST_ABI_FIXTURE_MAX_FILES = 256
HOST_ABI_PATH_PART = re.compile(r'[A-Za-z0-9._-]{1,128}')
HOST_ABI_ENTRY = re.compile(r'(100644|100755) ([0-9a-f]{40})')
HOST_ABI_ID = re.compile(r'[0-9a-f]{40}')


def load_host_abi_fixture(text):
    """Strictly parse the reviewed predecessor host trees: {tree id: {path: 'mode blob'}}. Reconstruction and the
    tree-id check are separate (DirectedHostAbiTests.tree); this only refuses malformed, unsafe or ambiguous manifests."""
    def pairs(items):
        keys = [key for key, _ in items]
        if len(keys) != len(set(keys)):
            raise ValueError('host ABI fixture has a duplicate key')
        return dict(items)
    value = json.loads(text, object_pairs_hook=pairs)
    if not isinstance(value, dict) or set(value) != {'schemaVersion', 'hostAgent', 'trees'} or value['schemaVersion'] != 1 \
            or value['hostAgent'] != release.HOST_AGENT:
        raise ValueError('invalid host ABI fixture shape')
    trees = value['trees']
    if not isinstance(trees, list) or len(trees) != HOST_ABI_FIXTURE_TREES:
        raise ValueError('invalid host ABI fixture tree count')
    result = {}
    for item in trees:
        if not isinstance(item, dict) or set(item) != {'tree', 'provenance', 'files'}:
            raise ValueError('invalid host ABI fixture tree shape')
        tree, provenance, files = item['tree'], item['provenance'], item['files']
        if not isinstance(tree, str) or not HOST_ABI_ID.fullmatch(tree) or tree in result:
            raise ValueError('invalid or duplicate host ABI fixture tree id')
        if not isinstance(provenance, str) or not 1 <= len(provenance) <= 200:
            raise ValueError('invalid host ABI fixture provenance')
        if not isinstance(files, dict) or not 1 <= len(files) <= HOST_ABI_FIXTURE_MAX_FILES:
            raise ValueError('invalid host ABI fixture file count')
        for path, entry in files.items():
            parts = path.split('/') if isinstance(path, str) else None
            if not parts or len(path) > 255 or any(part in ('.', '..') or not HOST_ABI_PATH_PART.fullmatch(part) for part in parts):
                raise ValueError('unsafe host ABI fixture path')
            if not isinstance(entry, str) or not HOST_ABI_ENTRY.fullmatch(entry):
                raise ValueError('invalid host ABI fixture mode or blob id')
        directories = {'/'.join(path.split('/')[:depth]) for path in files for depth in range(1, path.count('/') + 1)}
        if directories & files.keys():
            raise ValueError('host ABI fixture path is both a file and a directory')
        result[tree] = dict(files)
    return result


class DirectedHostAbiTests(unittest.TestCase):
    """The directed maps into host trees 96ff8e22 and b7700d49, exercised on Git commits rebuilt from reviewed trees.

    The predecessor host trees come from host-abi-predecessors.json (exact path/mode/blob manifests), rebuilt with
    `git mktree --missing` in a private bare repository and checked against their known tree ids, so no private
    commit history or blob payload is needed. The final tree is this checkout's actual HEAD host tree. The private
    repository borrows this checkout's objects through alternates (read-only) and writes its own fixture objects."""
    PREVIOUS = '96ff8e224443e0d684cb99e808a903235f2def11'
    TARGET = 'b7700d49c946157cd75c862bce867caf7fd08810'
    PREDECESSORS = {PREVIOUS: 'S 0c113cb4 standalone Git edge/history/resilience host',
                    'c87c304c42e1ce02164f5e3ea8d0e6f0eee24a9d': 'stage 1f4712c4 and 6a187841',
                    '7a35e4c5ec543abe83b9bccc8c6e5af815e02247': 'main 9ca8b3c0',
                    # The deployed staging predecessor (R151): the closed diagnostics without the full-marker host_ready.
                    'f3a5a1ba954c56ab31aa0c844cb5719c88905dfc': 'f27ddff7 deployed staging R151'}
    # The deployed predecessor's standalone_git.py (two-field guard stamp, 1024/4096 read limits).
    PEER_STANDALONE_GIT = '100644 e296b6166662e23e5c0df6c7a1209e81c5fb07d3'
    DIAGNOSTIC_PATHS = ('lib/ezil_host/edge.py', 'lib/ezil_host/standalone_git.py', 'lib/ezil_host/standalone_git_runtime.py',
                        'test/test_standalone_git.py', 'test/test_standalone_git_edge.py')

    @classmethod
    def setUpClass(cls):
        cls.fixture = load_host_abi_fixture(HOST_ABI_FIXTURE.read_text())

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name) / 'fixture.git'
        git(Path(temporary.name), 'init', '-q', '--bare', str(self.repo))
        objects = Path(git(REPO, 'rev-parse', '--git-common-dir'))
        objects = (objects if objects.is_absolute() else REPO / objects).resolve() / 'objects'
        (self.repo / 'objects/info/alternates').write_text(str(objects) + '\n')

    def run_git(self, *args, data=None):
        env = dict(os.environ, GIT_AUTHOR_NAME='Offline Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                   GIT_COMMITTER_NAME='Offline Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid',
                   GIT_AUTHOR_DATE='2026-11-16T00:00:00Z', GIT_COMMITTER_DATE='2026-11-16T00:00:00Z')
        return subprocess.run(['git', '-C', str(self.repo), *args], input=data, check=True, capture_output=True, env=env).stdout

    def head_files(self):
        """{path: 'mode blob'} for this checkout's actual HEAD host tree, which must be the final TARGET."""
        head = git(REPO, 'rev-parse', 'HEAD')
        self.assertEqual(release.host_agent_tree_id(head, REPO), self.TARGET)
        result = {}
        for entry in self.run_git('ls-tree', '-r', '-z', self.TARGET).decode().split('\0')[:-1]:
            meta, name = entry.split('\t', 1)
            mode, kind, blob = meta.split(' ')
            self.assertEqual(kind, 'blob')
            result[name] = mode + ' ' + blob
        return result

    def files(self, tree):
        """{path: 'mode blob'} for a reviewed host tree: its fixture manifest, or HEAD for the final TARGET."""
        if tree == self.TARGET:
            return self.head_files()
        self.assertIn(tree, self.fixture)
        return dict(self.fixture[tree])

    def tree(self, files):
        """Build the nested tree objects for a {path: 'mode blob'} map; returns the root tree id. Blob payloads may be
        absent (--missing): a tree id binds names, modes and blob ids, never blob bytes."""
        children, entries = {}, []
        for path, metadata in files.items():
            head, _, rest = path.partition('/')
            if rest:
                children.setdefault(head, {})[rest] = metadata
            else:
                mode, blob = metadata.split(' ')
                entries.append(f'{mode} blob {blob}\t{head}')
        entries += [f'040000 tree {self.tree(sub)}\t{name}' for name, sub in children.items()]
        return self.run_git('mktree', '-z', '--missing', data=''.join(e + '\0' for e in entries).encode()).decode().strip()

    def commit(self, host_files):
        """A commit whose infra/host-agent tree has exactly these files."""
        host = self.tree(host_files)
        root = self.tree({f'{release.HOST_AGENT}/{name}': metadata for name, metadata in host_files.items()})
        commit = self.run_git('commit-tree', root, '-m', 'fixture').decode().strip()
        self.assertEqual(release.host_agent_tree_id(commit, self.repo), host)
        return commit

    def blob(self, data):
        return self.run_git('hash-object', '-w', '--stdin', data=data).decode().strip()

    def maps(self):
        return [(source, target, delta) for source, target, delta in release.HOST_AGENT_DIRECTED_EXCEPTIONS]

    def test_fixture_rebuilds_every_reviewed_predecessor_tree_exactly(self):
        self.assertEqual(set(self.fixture), {*self.PREDECESSORS, *HostAbiTests.LEGACY.values()})
        for tree, files in self.fixture.items():
            with self.subTest(tree=tree):
                self.assertEqual(self.tree(files), tree)
        # Every directed map's source and target is a rebuilt predecessor or this checkout's actual HEAD tree.
        self.assertEqual({tree for source, target, _ in self.maps() for tree in (source, target)}, {*self.PREDECESSORS, self.TARGET})

    def test_reviewed_directed_maps_are_exact_from_the_rebuilt_trees(self):
        self.assertEqual([(source, target, len(delta)) for source, target, delta in self.maps()],
                         [('c87c304c42e1ce02164f5e3ea8d0e6f0eee24a9d', self.PREVIOUS, 8),
                          ('7a35e4c5ec543abe83b9bccc8c6e5af815e02247', self.PREVIOUS, 9),
                          (self.PREVIOUS, self.TARGET, 5),
                          ('c87c304c42e1ce02164f5e3ea8d0e6f0eee24a9d', self.TARGET, 11),
                          ('7a35e4c5ec543abe83b9bccc8c6e5af815e02247', self.TARGET, 9),
                          ('f3a5a1ba954c56ab31aa0c844cb5719c88905dfc', self.TARGET, 8)])
        for source, target, delta in self.maps():
            old, new = self.files(source), self.files(target)
            self.assertEqual({n: (old.get(n), new.get(n)) for n in old.keys() | new.keys() if old.get(n) != new.get(n)}, delta)
            # The source and target trees, as commits: exactly the directed map, and nothing in reverse.
            self.assertEqual(release.require_host_abi(self.commit(old), self.commit(new), self.repo), delta)
            with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                release.require_host_abi(self.commit(new), self.commit(old), self.repo)

    def test_missing_mutated_mode_changed_and_extra_target_files_refused(self):
        for source, target, delta in self.maps():
            old, new = self.files(source), self.files(target)
            deployed = self.commit(old)
            for name in delta:
                mode, blob = new[name].split(' ')
                for mutation, files in (('missing', {k: v for k, v in new.items() if k != name}),
                                        ('content', {**new, name: mode + ' ' + self.blob(b'unreviewed ' + name.encode())}),
                                        ('mode', {**new, name: ('100755' if mode == '100644' else '100644') + ' ' + blob})):
                    with self.subTest(source=source, path=name, mutation=mutation), \
                            self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                        release.require_host_abi(deployed, self.commit(files), self.repo)
            extra = {**new, 'lib/ezil_host/unreviewed.py': '100644 ' + self.blob(b'unreviewed = True\n')}
            with self.subTest(source=source, mutation='extra target file'), self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                release.require_host_abi(deployed, self.commit(extra), self.repo)

    def test_wrong_preimage_refused(self):
        for source, target, delta in self.maps():
            old, new = self.files(source), self.files(target)
            baked = self.commit(new)
            for name, (before, _after) in delta.items():
                if before is None:
                    # An added file already present (with other bytes) on the deployed side is a different preimage.
                    wrong = {**old, name: '100644 ' + self.blob(b'predecessor ' + name.encode())}
                else:
                    mode, _ = before.split(' ')
                    wrong = {**old, name: mode + ' ' + self.blob(b'different predecessor ' + name.encode())}
                with self.subTest(source=source, path=name), self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                    release.require_host_abi(self.commit(wrong), baked, self.repo)

    def test_unchanged_extra_file_on_both_sides_cannot_borrow_a_directed_map(self):
        for source, target, delta in self.maps():
            extra = {'lib/ezil_host/unreviewed.py': '100644 ' + self.blob(b'unreviewed but identical on both sides\n')}
            old, new = {**self.files(source), **extra}, {**self.files(target), **extra}
            # The file-level delta is still exactly the approved map; only the full tree binding refuses it.
            self.assertEqual({n: (old.get(n), new.get(n)) for n in old.keys() | new.keys() if old.get(n) != new.get(n)}, delta)
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                release.require_host_abi(self.commit(old), self.commit(new), self.repo)

    def test_only_listed_directions_between_reviewed_trees(self):
        # Every ordered pair of reviewed trees that is not a listed map is refused: reverse transitions, moves between
        # sources, and the deployed f3a5a1ba predecessor -> 96ff8e22 (which would drop the diagnostics).
        listed = {(source, target) for source, target, _ in self.maps()}
        trees = sorted({tree for source, target, _ in self.maps() for tree in (source, target)})
        commits = {tree: self.commit(self.files(tree)) for tree in trees}
        for old in trees:
            for new in trees:
                if old != new and (old, new) not in listed:
                    with self.subTest(old=old, new=new), self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                        release.require_host_abi(commits[old], commits[new], self.repo)

    def test_partial_and_regressed_diagnostics_targets_refused(self):
        target = self.files(self.TARGET)
        # Partial: the 6a/1f4712c4 tree with ONLY the five diagnostics files moved (no 96ff8e22 history/resilience).
        partial = {**self.files('c87c304c42e1ce02164f5e3ea8d0e6f0eee24a9d'), **{name: target[name] for name in self.DIAGNOSTIC_PATHS}}
        # Regressed: the final tree with the deployed predecessor's two-field, 1024/4096 host_ready.
        regressed = {**target, 'lib/ezil_host/standalone_git.py': self.PEER_STANDALONE_GIT}
        for name, files in (('partial', partial), ('regressed host_ready', regressed)):
            baked = self.commit(files)
            for source in self.PREDECESSORS:
                with self.subTest(target=name, source=source), self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                    release.require_host_abi(self.commit(self.files(source)), baked, self.repo)

    def test_checked_in_head_is_the_target_from_every_reviewed_predecessor(self):
        # The actual HEAD host tree, rebuilt from its own ls-tree, is the final TARGET and is reached from every
        # predecessor that has a map into it; the 96ff8e22 maps keep their own exact deltas.
        head = self.commit(self.head_files())
        self.assertEqual(release.host_agent_tree_id(head, self.repo), self.TARGET)
        anchors = {self.PREVIOUS: self.commit(self.files(self.PREVIOUS)), self.TARGET: head}
        for source, target, delta in self.maps():
            baked, deployed = anchors[target], self.commit(self.files(source))
            with self.subTest(source=source, target=target):
                self.assertEqual(release.require_host_abi(deployed, baked, self.repo), delta)
                with self.assertRaisesRegex(ValueError, 'beyond the reviewed delta'):
                    release.require_host_abi(baked, deployed, self.repo)

    def test_delta_only_exceptions_are_unchanged(self):
        # Historical behavior is untouched: the empty delta and both delta-only maps admit without any tree pin.
        self.assertEqual(len(release.HOST_AGENT_EXCEPTION), 3)
        self.assertEqual(len(release.HOST_AGENT_STANDALONE_EXCEPTION), 8)
        same = self.commit(self.files(self.TARGET))
        self.assertEqual(release.require_host_abi(same, same, self.repo), {})


class HostAbiFixtureTests(unittest.TestCase):
    """The predecessor manifest itself is strict: bounded shape and count, safe POSIX paths, exact modes and ids."""
    def setUp(self):
        self.value = json.loads(HOST_ABI_FIXTURE.read_text())

    def load(self, value):
        return load_host_abi_fixture(json.dumps(value))

    def files(self, value=None):
        return (value or self.value)['trees'][0]['files']

    def test_checked_in_fixture_parses(self):
        parsed = self.load(self.value)
        self.assertEqual(set(parsed), {*DirectedHostAbiTests.PREDECESSORS, *HostAbiTests.LEGACY.values()})
        self.assertEqual(load_host_abi_fixture(HOST_ABI_FIXTURE.read_text()), parsed)

    def test_duplicate_keys_refused(self):
        text = HOST_ABI_FIXTURE.read_text()
        first = next(iter(self.files()))
        entry = self.files()[first]
        duplicated = text.replace(f'"{first}": "{entry}"', f'"{first}": "{entry}",\n    "{first}": "{entry}"', 1)
        self.assertNotEqual(duplicated, text)
        with self.assertRaisesRegex(ValueError, 'duplicate key'):
            load_host_abi_fixture(duplicated)
        twice = copy.deepcopy(self.value)
        twice['trees'][1]['tree'] = twice['trees'][0]['tree']
        with self.assertRaisesRegex(ValueError, 'duplicate host ABI fixture tree id'):
            self.load(twice)

    def test_shape_and_bounds_refused(self):
        cases = [{**copy.deepcopy(self.value), **change} for change in ({'schemaVersion': 2}, {'hostAgent': 'infra/other'}, {'extra': True})]
        cases.append({k: v for k, v in copy.deepcopy(self.value).items() if k != 'trees'})
        for count in (HOST_ABI_FIXTURE_TREES - 1, HOST_ABI_FIXTURE_TREES + 1):
            value = copy.deepcopy(self.value)
            value['trees'] = (value['trees'] * 2)[:count]
            cases.append(value)
        value = copy.deepcopy(self.value); value['trees'][0]['extra'] = 1; cases.append(value)
        value = copy.deepcopy(self.value); value['trees'][0]['provenance'] = ''; cases.append(value)
        value = copy.deepcopy(self.value); value['trees'][0]['files'] = {}; cases.append(value)
        value = copy.deepcopy(self.value)
        value['trees'][0]['files'] = {f'f{n}': '100644 ' + 'a' * 40 for n in range(HOST_ABI_FIXTURE_MAX_FILES + 1)}
        cases.append(value)
        for tree in ('A' * 40, 'a' * 39, 'g' * 40, None):
            value = copy.deepcopy(self.value); value['trees'][0]['tree'] = tree; cases.append(value)
        for value in cases:
            with self.subTest(value=str(value)[:120]), self.assertRaises(ValueError):
                self.load(value)

    def test_unsafe_paths_and_prefix_collisions_refused(self):
        for path in ('', '/abs', 'a//b', 'a/./b', 'a/../b', '..', '.', 'a/', 'a\\b', 'a b', 'x' * 256, 'lib/' + 'x' * 129):
            value = copy.deepcopy(self.value)
            self.files(value)[path] = '100644 ' + 'a' * 40
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'unsafe host ABI fixture path'):
                self.load(value)
        value = copy.deepcopy(self.value)
        self.files(value)['lib'] = '100644 ' + 'a' * 40  # 'lib' is also the directory of lib/... files
        with self.assertRaisesRegex(ValueError, 'both a file and a directory'):
            self.load(value)

    def test_invalid_modes_and_blob_ids_refused(self):
        name = next(iter(self.files()))
        for entry in ('100664 ' + 'a' * 40, '120000 ' + 'a' * 40, '040000 ' + 'a' * 40, '160000 ' + 'a' * 40,
                      '100644 ' + 'a' * 39, '100644 ' + 'A' * 40, '100644 ' + 'g' * 40, '100644  ' + 'a' * 40,
                      '100644 ' + 'a' * 40 + ' ', 100644, None):
            value = copy.deepcopy(self.value)
            self.files(value)[name] = entry
            with self.subTest(entry=entry), self.assertRaisesRegex(ValueError, 'invalid host ABI fixture mode or blob id'):
                self.load(value)

    def test_a_mutated_manifest_cannot_claim_a_reviewed_tree_id(self):
        # Shape-valid but wrong entries: the rebuilt tree no longer has the declared id, so the directed tests fail closed.
        case = DirectedHostAbiTests('test_fixture_rebuilds_every_reviewed_predecessor_tree_exactly')
        case.setUp()
        self.addCleanup(case.doCleanups)
        for mutation in ('blob', 'mode', 'rename', 'drop', 'add'):
            value = copy.deepcopy(self.value)
            files = self.files(value)
            name = sorted(files)[0]
            mode, blob = files[name].split(' ')
            if mutation == 'blob':
                files[name] = mode + ' ' + 'f' * 40
            elif mutation == 'mode':
                files[name] = ('100755' if mode == '100644' else '100644') + ' ' + blob
            elif mutation == 'rename':
                files['renamed-' + name.replace('/', '-')] = files.pop(name)
            elif mutation == 'drop':
                files.pop(name)
            else:
                files['lib/ezil_host/unreviewed.py'] = '100644 ' + 'a' * 40
            tree = value['trees'][0]['tree']
            with self.subTest(mutation=mutation):
                self.assertNotEqual(case.tree(self.load(value)[tree]), tree)


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
        self.assertEqual((TOOL.RELEASE_REGISTRY_CAPACITY, TOOL.ACTIVE_REGISTRY_CAPACITY), (32, 41))
        self.assertEqual(TOOL.LEGACY_REGISTRY_CAPACITY, {'mum': 32, 'prd': 26})
        self.assertEqual(gc.tool.legacy_registry_capacity(), 32)
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
