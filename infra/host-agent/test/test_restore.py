"""Offline restore tests. Workspace roundtrip runs the real TS-embedded Python codec
via node; hostile/system fixtures use the same documented stdlib PAX format.
"""
from concurrent.futures import Future, ThreadPoolExecutor
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'lib'))
from ezil_host import config, guard, restore
from ezil_host.fsops import Refused

GEN = '11111111-1111-4111-8111-111111111111'
GEN2 = '22222222-2222-4222-8222-222222222222'


def archive(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for name, kind, value, mode in entries:
            m = tarfile.TarInfo(name)
            m.type, m.mode = kind, mode
            if kind == tarfile.SYMTYPE:
                m.linkname = value
            if kind == tarfile.REGTYPE:
                m.size = len(value)
            tar.addfile(m, io.BytesIO(value) if kind == tarfile.REGTYPE else None)
    return out.getvalue()


def head(data, entries):
    chunks = [data[i:i + restore.CHUNK] for i in range(0, len(data), restore.CHUNK)]
    return {'version': 1, 'generation': GEN, 'sha256': hashlib.sha256(data).hexdigest(),
            'entries': entries, 'chunks': [{'size': len(c), 'sha256': hashlib.sha256(c).hexdigest()} for c in chunks]}


def file(name='hello', data=b'hello', mode=0o640):
    return name, tarfile.REGTYPE, data, mode


def directory(name, mode=0o750):
    return name, tarfile.DIRTYPE, b'', mode


def link(name, target):
    return name, tarfile.SYMTYPE, target, 0o777


class RestoreFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ezil-restore-test-')
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / 'data'
        self.data.mkdir()
        self.raw = {}
        self.spec = {'kind': 'cf-snapshot', 'system': None, 'fetchBase': 'https://export.test/snapshot'}
        self.set_archive([file()])

    def set_archive(self, entries, kind='workspace'):
        raw = archive(entries)
        self.raw[kind] = raw
        count = len(entries) - sum(e[0] == '.ezil-deleted.json' for e in entries) if kind == 'system' else len(entries)
        self.spec[kind] = head(raw, count)

    def fetch(self, kind, index):
        self.assertTrue((self.data / restore.STAGE).is_dir())
        return self.raw[kind][index * restore.CHUNK:(index + 1) * restore.CHUNK]

    def run_restore(self, fetch=None):
        return restore.run_restore(self.spec, str(self.data), fetch or self.fetch)

    def state(self):
        return json.loads((self.data / restore.STATE).read_text())



class RestoreTests(RestoreFixture, unittest.TestCase):
    def test_real_codec_roundtrip(self):
        src = Path(self.tmp.name) / 'source'
        src.mkdir()
        (src / 'dir').mkdir()
        (src / 'dir' / 'hello').write_bytes(b'hello\x00world' * 100000)
        (src / 'dir' / 'hello').chmod(0o751)
        (src / 'dir').chmod(0o750)
        (src / 'empty').mkdir()
        (src / 'link').symlink_to('dir/hello')
        (src / ('é' * 80)).write_text('unicode')
        marker = {'version': 1, 'prefix': 'test', 'mountPath': str(src), 'checkpoint': None}
        (src / '.ezil-hydrated.json').write_text(json.dumps(marker))
        source = HERE.parents[2] / 'worker/src/workspace-snapshot-script.ts'
        text = source.read_text()
        if shutil.which('node'):
            js = "const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');process.stdout.write(eval(s.slice(s.indexOf('String.raw`'),s.indexOf('`;')+1)));"
            codec = subprocess.check_output(['node', '-e', js, str(source)], text=True)
        else:
            codec = text.split('String.raw`', 1)[1].split('`;', 1)[0]
        # The real capture codec requires a /tmp/ezil-snapshot-* staging name.
        stage = tempfile.mkdtemp(prefix='ezil-snapshot-')
        os.rmdir(stage)
        self.addCleanup(shutil.rmtree, stage, True)
        result = subprocess.run([sys.executable, '-I', '-c', codec, json.dumps({
            'op': 'capture', 'root': str(src), 'work': stage, 'prefix': 'test', 'expected': None})],
            capture_output=True, text=True, check=True)
        self.spec['workspace'] = dict(json.loads(result.stdout), version=1, generation=GEN)
        self.raw['workspace'] = (Path(stage) / 'archive.tar').read_bytes()
        summary = self.run_restore()
        self.assertEqual(summary, {'files': 3, 'bytes': 1100007})
        dest = self.data / 'workspace'
        self.assertEqual((dest / 'dir/hello').read_bytes(), (src / 'dir/hello').read_bytes())
        self.assertEqual(stat.S_IMODE((dest / 'dir/hello').stat().st_mode), 0o751)
        self.assertEqual(stat.S_IMODE((dest / 'dir').stat().st_mode), 0o750)
        self.assertEqual(os.readlink(dest / 'link'), 'dir/hello')
        self.assertTrue((dest / 'empty').is_dir())
        self.assertEqual((dest / ('é' * 80)).read_text(), 'unicode')

    def test_chunk_hash(self):
        self.spec['workspace']['chunks'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(Refused, 'chunk_sha256'):
            self.run_restore()
        self.assertFalse((self.data / 'workspace').exists())

    def test_chunk_size(self):
        with self.assertRaisesRegex(Refused, 'chunk_size'):
            self.run_restore(lambda k, i: self.raw[k] + b'extra')

    def test_archive_hash(self):
        self.spec['workspace']['sha256'] = '0' * 64
        with self.assertRaisesRegex(Refused, 'archive_sha256'):
            self.run_restore()

    def test_paths(self):
        for name in ('../escape', '/absolute', 'a/../escape', 'a//b', './a', 'a\\b'):
            with self.subTest(name=name):
                self.set_archive([file(name)])
                with self.assertRaisesRegex(Refused, 'path_invalid'):
                    self.run_restore()
                (self.data / restore.STATE).unlink()

    def test_symlink_escapes(self):
        for target in ('../outside', '/etc/passwd', 'a/../../outside'):
            with self.subTest(target=target):
                self.set_archive([link('link', target)])
                with self.assertRaisesRegex(Refused, 'symlink_escape'):
                    self.run_restore()
                (self.data / restore.STATE).unlink()

    def test_symlink_chain(self):
        self.set_archive([directory('dir'), link('dir/up', '..'), link('escape', 'dir/up/../outside')])
        with self.assertRaisesRegex(Refused, 'symlink_escape'):
            self.run_restore()

    def test_write_through_archive_symlink(self):
        self.set_archive([directory('dir'), link('alias', 'dir'), file('alias/evil')])
        with self.assertRaisesRegex(Refused, 'non_directory_parent'):
            self.run_restore()

    def test_existing_parent_symlink(self):
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        (self.data / 'workspace').symlink_to(outside)
        with self.assertRaises(Refused):
            self.run_restore()
        self.assertEqual(list(outside.iterdir()), [])

    def test_existing_leaf_symlink(self):
        (self.data / 'workspace').mkdir()
        outside = Path(self.tmp.name) / 'outside'
        outside.write_text('keep')
        (self.data / 'workspace/hello').symlink_to(outside)
        with self.assertRaisesRegex(Refused, 'destination_conflict'):
            self.run_restore()
        self.assertEqual(outside.read_text(), 'keep')

    def test_existing_target_escape(self):
        (self.data / 'workspace').mkdir()
        (self.data / 'workspace/other').symlink_to('/etc')
        self.set_archive([link('alias', 'other/passwd')])
        with self.assertRaisesRegex(Refused, 'symlink_escape'):
            self.run_restore()

    def test_special_types(self):
        for kind in (tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE, tarfile.LNKTYPE):
            with self.subTest(kind=kind):
                self.set_archive([('special', kind, b'', 0o600)])
                with self.assertRaisesRegex(Refused, 'entry_type'):
                    self.run_restore()
                (self.data / restore.STATE).unlink()

    def test_privilege_bits(self):
        for mode in (0o4755, 0o2755):
            self.set_archive([file(mode=mode)])
            with self.assertRaisesRegex(Refused, 'entry_metadata'):
                self.run_restore()
            (self.data / restore.STATE).unlink()

    def test_duplicate_and_missing_parent(self):
        for entries, code in (([file(), file()], 'duplicate_path'), ([file('absent/file')], 'missing_parent')):
            self.set_archive(entries)
            with self.assertRaisesRegex(Refused, code):
                self.run_restore()
            (self.data / restore.STATE).unlink()

    def test_entry_count(self):
        for count in (0, 2):
            self.spec['workspace']['entries'] = count
            with self.assertRaisesRegex(Refused, 'entry_count'):
                self.run_restore()
            (self.data / restore.STATE).unlink()

    def test_head_limits(self):
        original = copy.deepcopy(self.spec)
        for key, value in (('version', True), ('generation', '../bad'), ('entries', 100001),
                           ('entries', -1), ('chunks', []), ('chunks', [{}] * 513),
                           ('chunks', [{'size': restore.CHUNK + 1, 'sha256': '0' * 64}])):
            self.spec = copy.deepcopy(original)
            self.spec['workspace'][key] = value
            with self.assertRaisesRegex(Refused, 'head_invalid'):
                self.run_restore()

    def test_system_filter_and_hash_variant(self):
        self.set_archive([directory('root'), directory('home'), file('root/.bashrc'),
                          file('home/alice/.profile'), link('root/current', '.bashrc'),
                          file('usr/bin/tool'), file('etc/config'), file('opt/app'),
                          file('var/lib/dpkg/status'), file('root/.cache/cache'),
                          file('root/.npm/_cacache/cache'), file('home/alice/node_modules/.cache/x'),
                          file('home/alice/.local/share/Trash/x'), file('root/.npm/npmrc'),
                          file('.ezil-deleted.json', b'["/root/keep"]')], 'system')
        self.spec['system']['archiveSha256'] = self.spec['system']['sha256']
        self.spec['system']['sha256'] = 'f' * 64  # real system heads have a logical hash here
        self.run_restore()
        upper = self.data / 'root/upper'
        self.assertEqual((upper / 'root/.bashrc').read_bytes(), b'hello')
        self.assertEqual((upper / 'home/alice/.profile').read_bytes(), b'hello')
        self.assertEqual(os.readlink(upper / 'root/current'), '.bashrc')
        self.assertTrue((upper / 'root/.npm/npmrc').is_file())
        for path in ('usr', 'etc', 'opt', 'var', 'root/.cache', 'root/.npm/_cacache',
                     'home/alice/node_modules', 'home/alice/.local', '.ezil-deleted.json'):
            self.assertFalse((upper / path).exists(), path)

    def test_system_archive_hash_is_verified(self):
        self.set_archive([file('root/file')], 'system')
        self.spec['system']['archiveSha256'] = '0' * 64
        with self.assertRaisesRegex(Refused, 'archive_sha256'):
            self.run_restore()

    def test_idempotent(self):
        self.run_restore()
        before = (self.data / 'workspace/hello').stat().st_ino
        self.assertEqual(self.run_restore(mock.Mock(side_effect=AssertionError('unexpected fetch'))), {'files': 0, 'bytes': 0})
        self.assertEqual(before, (self.data / 'workspace/hello').stat().st_ino)
        self.assertEqual(self.state()['state'], 'done')
        self.assertEqual(self.state()['generation'], GEN)

    def test_system_generation_is_part_of_identity(self):
        self.set_archive([file('root/file')], 'system')
        self.run_restore()
        self.spec['system']['generation'] = GEN2
        with self.assertRaisesRegex(Refused, 'state_mismatch'):
            self.run_restore()

    def test_resume_only_clears_staging(self):
        self.set_archive([file('root/file')], 'system')
        def fail(kind, index):
            if kind == 'system':
                raise TimeoutError('private path')
            return self.fetch(kind, index)
        with self.assertRaisesRegex(Refused, 'restore_io_failed'):
            self.run_restore(fail)
        self.assertEqual(self.state()['state'], 'started')
        (self.data / 'workspace/keep').write_text('keep')
        outside = Path(self.tmp.name) / 'outside'
        outside.write_text('keep')
        (self.data / restore.STAGE / 'planted').symlink_to(outside)
        self.run_restore()
        self.assertEqual((self.data / 'workspace/keep').read_text(), 'keep')
        self.assertEqual(outside.read_text(), 'keep')
        self.assertFalse((self.data / restore.STAGE).exists())

    def test_state_and_stage_symlinks_refused(self):
        for name in (restore.STATE, restore.STAGE):
            with self.subTest(name=name):
                path = self.data / name
                path.symlink_to(self.tmp.name)
                with self.assertRaises(Refused):
                    self.run_restore()
                path.unlink()
                state = self.data / restore.STATE
                if state.exists():
                    state.unlink()


class DownloadTests(RestoreFixture, unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(restore, 'CHUNK', 65536)
        patch.start()
        self.addCleanup(patch.stop)
        super().setUp()

    def test_out_of_order_completion_writes_in_order(self):
        data = b''.join(bytes([i]) * restore.CHUNK for i in range(10))
        self.set_archive([file('large', data)])
        later = threading.Event()
        lock, completed = threading.Lock(), []

        def fetch(kind, index):
            if index == 0:
                self.assertTrue(later.wait(5))
            chunk = self.fetch(kind, index)
            with lock:
                completed.append(index)
            if index == 7:
                later.set()
            return chunk

        self.assertEqual(self.run_restore(fetch), {'files': 1, 'bytes': len(data)})
        self.assertLess(completed.index(7), completed.index(0))
        self.assertEqual(sorted(completed), list(range(len(self.spec['workspace']['chunks']))))
        self.assertEqual((self.data / 'workspace/large').read_bytes(), data)
        self.assertEqual(self.state()['state'], 'done')
        self.assertFalse((self.data / restore.STAGE).exists())

    def test_middle_chunk_hash_refuses_before_extraction(self):
        self.set_archive([file('large', b'x' * (9 * restore.CHUNK))])
        self.spec['workspace']['chunks'][4]['sha256'] = '0' * 64
        with self.assertRaisesRegex(Refused, '^restore_chunk_sha256$'):
            self.run_restore()
        self.assertFalse((self.data / 'workspace').exists())
        self.assertFalse((self.data / 'root').exists())
        self.assertEqual(self.state()['state'], 'started')
        staged = self.data / restore.STAGE / 'workspace.tar'
        self.assertEqual(staged.read_bytes(), self.raw['workspace'][:4 * restore.CHUNK])

    def test_concurrency_and_reorder_window_are_bounded(self):
        self.assertEqual(restore.FETCH_CONCURRENCY, 8)
        self.set_archive([file('large', b'x' * (23 * restore.CHUNK))])
        self.assertEqual(len(self.spec['workspace']['chunks']), 24)
        barrier, lock = threading.Barrier(8), threading.Lock()
        active, peak, fetched, submitted = 0, 0, [], []

        def fetch(kind, index):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                fetched.append(index)
            try:
                barrier.wait(5)
                return self.fetch(kind, index)
            finally:
                with lock:
                    active -= 1

        class Pool(ThreadPoolExecutor):
            def submit(pool, fn, kind, index):
                written = (self.data / restore.STAGE / 'workspace.tar').stat().st_size
                self.assertLess(index, written // restore.CHUNK + 8)
                submitted.append(index)
                return super().submit(fn, kind, index)

        with mock.patch.object(restore, 'ThreadPoolExecutor', Pool):
            self.run_restore(fetch)
        self.assertEqual(peak, 8)
        self.assertEqual(active, 0)
        self.assertEqual(sorted(fetched), list(range(24)))
        self.assertEqual(submitted, list(range(24)))

    def test_refusals_cancel_queued_fetches(self):
        self.set_archive([file('large', b'x' * (9 * restore.CHUNK))])
        for response, reason in ((b'', 'chunk_size'), (b'x' * restore.CHUNK, 'chunk_sha256'),
                                 (Refused('restore_fetch_status'), 'fetch_status')):
            with self.subTest(reason=reason):
                futures = [Future() for _ in range(8)]
                if isinstance(response, Exception):
                    futures[0].set_exception(response)
                else:
                    futures[0].set_result(response)
                with mock.patch.object(restore, 'ThreadPoolExecutor') as executor:
                    pool = executor.return_value.__enter__.return_value
                    pool.submit.side_effect = futures
                    with self.assertRaisesRegex(Refused, '^restore_' + reason + '$'):
                        self.run_restore()
                executor.assert_called_once_with(max_workers=8)
                self.assertEqual(pool.submit.call_count, 8)
                self.assertTrue(all(f.cancelled() for f in futures[1:]))
                self.assertFalse((self.data / 'workspace').exists())
                self.assertEqual(self.state()['state'], 'started')

    def test_sequential_equivalence(self):
        self.set_archive([directory('dir'), directory('empty'),
                          file('dir/large', b'abc' * restore.CHUNK, 0o751),
                          file('é', b'unicode'), link('link', 'dir/large')])
        self.set_archive([directory('root'), file('root/.bashrc'), file('home/alice/.profile'),
                          link('root/current', '.bashrc'), file('root/.cache/skip'),
                          file('usr/bin/skip'), file('.ezil-deleted.json', b'[]')], 'system')
        self.spec['system']['archiveSha256'] = self.spec['system']['sha256']
        self.spec['system']['sha256'] = 'f' * 64
        sequential = Path(self.tmp.name) / 'sequential'
        sequential.mkdir()
        for root in (self.data, sequential):
            (root / 'workspace').mkdir()
            (root / 'workspace/keep').write_bytes(b'keep')

        def old_download(stage, kind, h, fetch):
            # The former sequential fetch/check order, using an in-memory archive.
            data = bytearray()
            for i, chunk in enumerate(h['chunks']):
                part = fetch(kind, i)
                if not isinstance(part, bytes) or len(part) != chunk['size']:
                    restore.refuse('chunk_size')
                if hashlib.sha256(part).hexdigest() != chunk['sha256']:
                    restore.refuse('chunk_sha256')
                data.extend(part)
            expected = h.get('archiveSha256', h['sha256']) if kind == 'system' else h['sha256']
            if hashlib.sha256(data).hexdigest() != expected:
                restore.refuse('archive_sha256')
            return io.BytesIO(data)

        def fetch(kind, index):
            return self.raw[kind][index * restore.CHUNK:(index + 1) * restore.CHUNK]

        def tree(root):
            return {str(p.relative_to(root)): (stat.S_IMODE(p.lstat().st_mode),
                    os.readlink(p) if p.is_symlink() else p.read_bytes() if p.is_file() else None)
                    for p in root.rglob('*')}

        with mock.patch.object(restore, '_download', old_download):
            expected = restore.run_restore(self.spec, str(sequential), fetch)
        self.assertEqual(self.run_restore(), expected)
        self.assertEqual(tree(self.data), tree(sequential))


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.spec = {'kind': 'cf-snapshot', 'workspace': head(archive([file()]), 1), 'system': None,
                     'fetchBase': 'https://export.test/base', 'identityToken': 'epoch-test-token'}
        self.client = restore.SnapshotClient({}, {'restore': self.spec})

    def test_url_auth_timeout_and_head_generation(self):
        self.spec['workspace']['chunkGeneration'] = GEN2
        with mock.patch.object(restore.http, 'request', return_value=(200, b'chunk')) as req:
            self.assertEqual(restore.http_fetch({}, self.client)('workspace', 0), b'chunk')
        args, kw = req.call_args
        self.assertEqual(args, ('GET', 'https://export.test/base/workspace/chunk/0?generation=' + GEN))
        self.assertEqual(kw['headers'], {'Authorization': 'Bearer epoch-test-token'})
        self.assertEqual(kw['timeout'], 20)
        self.assertEqual(kw['response_limit'], restore.CHUNK + 1)

    def test_retry_only_5xx_and_timeouts(self):
        with mock.patch.object(self.client, 'get', side_effect=[(503, b''), TimeoutError(), (502, b''), (200, b'ok')]) as req, mock.patch.object(restore.time, 'sleep') as sleep:
            self.assertEqual(restore.http_fetch({}, self.client)('workspace', 0), b'ok')
            self.assertEqual(req.call_count, 4)
            self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2), mock.call(4)])

    def test_concurrent_fetches_have_independent_connections(self):
        self.spec['workspace']['chunks'] *= 8
        barrier = threading.Barrier(8)
        connections, lock = [], threading.Lock()

        def connection(*args, **kwargs):
            conn = mock.Mock()
            conn.request.side_effect = lambda *a, **kw: barrier.wait(5)
            conn.getresponse.return_value.status = 200
            conn.getresponse.return_value.read.return_value = b'chunk'
            with lock:
                connections.append(conn)
            return conn

        with mock.patch.object(restore.http, 'tls_context', side_effect=lambda _: object()), \
             mock.patch.object(restore.http.http.client, 'HTTPSConnection', side_effect=connection):
            fetch = restore.http_fetch({}, self.client)
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(fetch, 'workspace', i) for i in range(8)]
                self.assertEqual([f.result() for f in futures], [b'chunk'] * 8)
        self.assertEqual(len(connections), 8)
        for conn in connections:
            conn.request.assert_called_once()
            self.assertEqual(conn.request.call_args.kwargs['headers'],
                             {'Authorization': 'Bearer epoch-test-token'})
            conn.getresponse.return_value.read.assert_called_once_with(restore.CHUNK + 1)
            conn.close.assert_called_once()

    def test_retry_exhaustion(self):
        with mock.patch.object(self.client, 'get', return_value=(503, b'')) as req, mock.patch.object(restore.time, 'sleep'):
            with self.assertRaisesRegex(Refused, 'fetch_exhausted'):
                restore.http_fetch({}, self.client)('workspace', 0)
            self.assertEqual(req.call_count, 4)

    def test_final_failures_no_retry(self):
        for result in ((403, b'private'), (404, b''), (429, b''), (302, b''), ConnectionResetError('/private')):
            with mock.patch.object(self.client, 'get', side_effect=[result]) as req, mock.patch.object(restore.time, 'sleep') as sleep:
                with self.assertRaises(Refused) as exc:
                    restore.http_fetch({}, self.client)('workspace', 0)
                self.assertNotIn('private', str(exc.exception))
                self.assertEqual(req.call_count, 1)
                sleep.assert_not_called()

    def test_https_only(self):
        for base in ('http://example.test', 'https://user:pass@example.test', 'https://example.test/?x=1', 'https://example.test/#x', 'https://example.test:bad', 'https://example.test/\n'):
            self.spec['fetchBase'] = base
            with self.assertRaisesRegex(Refused, 'fetch_url'):
                restore.http_fetch({}, self.client)

    def test_token_and_index_validation(self):
        fetch = restore.http_fetch({}, self.client)
        for kind, index in (('other', 0), ('system', 0), ('workspace', -1), ('workspace', True), ('workspace', 1)):
            with self.assertRaises(Refused):
                fetch(kind, index)
        self.client.token = None
        with self.assertRaisesRegex(Refused, 'identity_token_missing'):
            fetch('workspace', 0)


class GuardTests(RestoreFixture, unittest.TestCase):
    def guard(self, runner=None, with_restore=True):
        cfg = config.Config(dict(config.DEFAULTS))
        cfg.update(dataMount=str(self.data), runDir=str(Path(self.tmp.name) / 'run'))
        lease = {'provision': True, 'volumeId': 'vol-test', 'fsUuid': 'test', 'computerId': 'test',
                 'generation': 1, 'leaseEpoch': 1, 'restore': self.spec}
        if not with_restore:
            lease.pop("restore")
            lease["leaseEpoch"] = 2
        with mock.patch.object(guard, 'mount_data'), mock.patch.object(guard, 'mount_opts', return_value='ro'), \
             mock.patch.object(guard, 'remount'), mock.patch.object(guard.cfgmod, 'host_digest', return_value='sha256:test'), \
             mock.patch.object(guard, 'current_instance_id', return_value=None), mock.patch.object(guard.canary, 'guard_result'), \
             mock.patch.object(guard.subprocess, 'run'), mock.patch.object(restore, 'http_fetch', return_value=self.fetch):
            return guard.run_guard(cfg, lease, restore_runner=runner)

    def test_guard_order(self):
        calls = []
        def runner(*args):
            calls.append(True)
            self.assertFalse((self.data / guard.MARKER).exists())
            return restore.run_restore(*args)
        self.assertEqual(self.guard(runner), 'init')
        self.assertEqual(calls, [True])
        self.assertEqual((self.data / 'workspace/hello').read_bytes(), b'hello')
        self.assertTrue((self.data / guard.MARKER).is_file())
        self.assertTrue((Path(self.tmp.name) / 'run/guard-ok').is_file())

    def test_guard_failure_and_retry(self):
        def fail(*args):
            raise RuntimeError('/secret/path')
        with self.assertRaises(RuntimeError):
            self.guard(fail)
        self.assertEqual(self.state()['state'], 'failed')
        self.assertNotIn('/secret', json.dumps(self.state()))
        self.assertFalse((self.data / guard.MARKER).exists())
        self.assertFalse((Path(self.tmp.name) / 'run/guard-ok').exists())
        self.assertEqual(self.guard(), 'init')

    def test_guard_chunk_failure_blocks_marker(self):
        self.spec['workspace']['chunks'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(Refused, 'chunk_sha256'):
            self.guard()
        self.assertFalse((self.data / guard.MARKER).exists())
        self.assertEqual(self.state()['state'], 'failed')

    def test_guard_unrelated_data_still_refused(self):
        (self.data / 'unrelated').write_text('keep')
        with self.assertRaisesRegex(Refused, 'marker_missing'):
            self.guard()
        self.assertEqual((self.data / 'unrelated').read_text(), 'keep')

    def test_done_state_allows_later_boot_without_restore(self):
        self.guard()
        self.assertEqual(self.guard(with_restore=False), 'ok')

    def test_partial_state_blocks_boot_without_restore(self):
        with self.assertRaises(RuntimeError):
            self.guard(mock.Mock(side_effect=RuntimeError('failed')))
        with self.assertRaisesRegex(Refused, 'restore_incomplete'):
            self.guard(with_restore=False)

    def test_done_before_marker_crash_resumes(self):
        self.run_restore()
        self.assertEqual(self.guard(), 'init')

    def test_malformed_restore_records_failure(self):
        self.spec['workspace']['version'] = 2
        with self.assertRaises(Refused):
            self.guard()
        self.assertEqual(self.state(), {'state': 'failed', 'reason': 'restore_failed'})
        self.assertFalse((self.data / guard.MARKER).exists())



class ReferenceTests(RestoreFixture, unittest.TestCase):
    def reference(self, system=False):
        self.set_archive([file()])
        if system:
            self.set_archive([file('root/file')], 'system')
        self.heads = {k: copy.deepcopy(self.spec.get(k)) for k in ('workspace', 'system')}
        self.spec = {'kind': 'cf-snapshot', 'migrationId': GEN2, 'generation': GEN,
                     'fetchBase': 'https://export.test/base', 'identityToken': 'restore-token', 'system': system}
        return restore.SnapshotClient({}, {'restore': self.spec})

    def response(self, method, url, **kwargs):
        self.assertEqual(method, 'GET')
        self.assertEqual(kwargs['headers'], {'Authorization': 'Bearer restore-token'})
        self.assertEqual(kwargs['timeout'], 20)
        self.assertTrue(url.endswith('?generation=' + GEN))
        kind = 'system' if '/system/' in url else 'workspace'
        if '/head?' in url:
            self.assertEqual(kwargs['response_limit'], restore.CHUNK)
            if self.heads[kind] is None:
                return 404, b''
            return 200, json.dumps(self.heads[kind]).encode()
        self.assertEqual(kwargs['response_limit'], restore.CHUNK + 1)
        return 200, self.raw[kind]

    def test_reference_roundtrip_with_both_heads_and_same_bearer(self):
        client = self.reference(system=True)
        with mock.patch.object(restore.http, 'request', side_effect=self.response) as req:
            fetch = restore.http_fetch({}, client)
            self.assertEqual(req.call_count, 2)
            restore.run_restore(self.spec, str(self.data), fetch)
        self.assertEqual(req.call_count, 4)
        self.assertEqual((self.data / 'workspace/hello').read_bytes(), b'hello')
        self.assertEqual((self.data / 'root/upper/root/file').read_bytes(), b'hello')
        self.assertEqual(self.state()['state'], 'done')

    def test_false_system_never_fetches_missing_404_system_head(self):
        client = self.reference()
        self.heads['system'] = None
        with mock.patch.object(restore.http, 'request', side_effect=self.response) as req:
            fetch = restore.http_fetch({}, client)
            restore.run_restore(self.spec, str(self.data), fetch)
        self.assertEqual(req.call_count, 2)
        self.assertTrue(all('/system/' not in args[0][1] for args in req.call_args_list))
        self.assertIsNone(self.spec['system'])

    def test_generation_mismatch_in_either_head(self):
        for kind in ('workspace', 'system'):
            with self.subTest(kind=kind):
                client = self.reference(system=True)
                self.heads[kind]['generation'] = GEN2
                with mock.patch.object(restore.http, 'request', side_effect=self.response):
                    with self.assertRaisesRegex(Refused, 'generation_mismatch'):
                        restore.http_fetch({}, client)
                self.assertNotIn('workspace', self.spec)
                self.assertFalse((self.data / restore.STATE).exists())

    def test_missing_or_invalid_token_prevents_head_fetch(self):
        for token in (None, '', 'bad\nvalue', 'bad\x7fvalue', 42):
            client = self.reference()
            client.token = token
            with mock.patch.object(restore.http, 'request') as req:
                with self.assertRaisesRegex(Refused, 'identity_token_missing'):
                    restore.http_fetch({}, client)
                req.assert_not_called()

    def test_missing_required_system_head_fails(self):
        client = self.reference(system=True)
        self.heads['system'] = None
        with mock.patch.object(restore.http, 'request', side_effect=self.response) as req:
            with self.assertRaisesRegex(Refused, 'fetch_status'):
                restore.http_fetch({}, client)
        self.assertEqual(req.call_count, 2)
        self.assertNotIn('workspace', self.spec)

    def test_reference_scope_guards_before_fetch(self):
        for key, value in (('generation', None), ('generation', '../bad'), ('system', None), ('system', 1), ('kind', 'other')):
            client = self.reference()
            self.spec[key] = value
            with mock.patch.object(restore.http, 'request') as req:
                with self.assertRaises(Refused):
                    restore.http_fetch({}, client)
                req.assert_not_called()

    def test_malformed_and_oversized_heads(self):
        for data, reason in ((b'not-json', 'head_invalid'), (b'null', 'head_invalid'),
                             (b'{}', 'head_invalid'), (b'x' * (restore.CHUNK + 1), 'fetch_size')):
            client = self.reference()
            with mock.patch.object(restore.http, 'request', return_value=(200, data)):
                with self.assertRaisesRegex(Refused, reason):
                    restore.http_fetch({}, client)

    def test_head_retry_policy_matches_chunks(self):
        client = self.reference()
        raw = json.dumps(self.heads['workspace']).encode()
        with mock.patch.object(restore.http, 'request', side_effect=[TimeoutError(), (503, b''), (200, raw)]) as req, mock.patch.object(restore.time, 'sleep') as sleep:
            restore.http_fetch({}, client)
        self.assertEqual(req.call_count, 3)
        self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2)])

    def test_reference_keeps_chunk_integrity_checks(self):
        client = self.reference()
        with mock.patch.object(restore.http, 'request', side_effect=self.response):
            fetch = restore.http_fetch({}, client)
            self.raw['workspace'] = b'x' * len(self.raw['workspace'])
            with self.assertRaisesRegex(Refused, 'chunk_sha256'):
                restore.run_restore(self.spec, str(self.data), fetch)
        self.assertFalse((self.data / 'workspace/hello').exists())


if __name__ == '__main__':
    unittest.main()
