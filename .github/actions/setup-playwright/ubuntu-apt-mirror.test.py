import datetime as dt
import importlib.util
from pathlib import Path
import stat
import tempfile
import subprocess
import os
from types import SimpleNamespace
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('apt_mirror', Path(__file__).with_name('ubuntu-apt-mirror.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = dt.datetime(2026, 11, 11, 16, 0, tzinfo=dt.timezone.utc)
SOURCE = b"""# Preserve this comment and formatting.

Types: deb deb-src
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Architectures: amd64
PDiffs: yes

Types: deb
URIs: https://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
By-Hash: yes
"""
MIRRORS = b'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n'

def release(pocket, **patch):
    fields = dict(Origin='Ubuntu', Label='Ubuntu', Suite=pocket, Codename='noble',
        Date='Wed, 11 Nov 2026 12:00:00 UTC', Architectures='amd64 arm64',
        Components='main restricted universe multiverse')
    if pocket == 'noble':
        fields['Date'] = 'Thu, 25 Apr 2024 15:10:33 UTC'
    fields.update(patch)
    return (''.join(key + ': ' + value + '\n' for key, value in fields.items()) + 'SHA256:\n ' + 'a' * 64 + ' 123 main/binary-amd64/Packages.xz\n').encode()

def recover(source=SOURCE, resolve=lambda _: False, fetch=None, verify=lambda b: b):
    fetch = fetch or (lambda url: release(url.split('/')[-2]))
    return m.recover(source, MIRRORS, resolve, fetch, verify, NOW)

class AptMirrorTests(unittest.TestCase):
    def test_actual_mirror_file_and_every_source_byte_except_uri_are_preserved(self):
        urls = []
        def fetch(url):
            urls.append(url)
            return release(url.split('/')[-2])
        result = recover(fetch=fetch)
        expected = SOURCE.replace(m.LIST_URI.encode(), m.MIRROR.encode()).replace(
            b'https://security.ubuntu.com/ubuntu/', m.MIRROR.encode()).replace(
            str(m.KEYRING).encode(), m.SIGNED_BY.encode())
        self.assertEqual(result, expected)
        self.assertEqual({u.split('/')[-2] for u in urls}, m.POCKETS)
        self.assertTrue(all(u.startswith(m.MIRROR) for u in urls))
        self.assertEqual(MIRRORS.splitlines()[0], b'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1')

    def test_working_primary_dns_has_no_download_verification_or_rewrite(self):
        fetch, verify = mock.Mock(), mock.Mock()
        self.assertIsNone(recover(resolve=lambda _: True, fetch=fetch, verify=verify))
        fetch.assert_not_called()
        verify.assert_not_called()

    def test_unknown_uri_mirror_path_priority_and_missing_keyring_fail_closed(self):
        variants = [
            SOURCE.replace(m.LIST_URI.encode(), b'mirror+file:/tmp/arbitrary'),
            SOURCE.replace(m.LIST_URI.encode(), b'https://untrusted.example/ubuntu/'),
            SOURCE.replace(b'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n', b''),
            SOURCE.replace(b'Suites: noble-security', b'Suites: jammy-security'),
            SOURCE.replace(b'Types: deb\n', b'Types: deb\nTrusted: yes\n'),
            SOURCE.replace(b'Components: main restricted universe multiverse', b'Components: main\n main'),
        ]
        for value in variants:
            with self.subTest(value=value), self.assertRaises(m.Refused):
                recover(source=value)
        for value in [MIRRORS.replace(b'priority:1', b'priority:9'), MIRRORS + b'https://evil.example/ubuntu/\tpriority:4\n']:
            with self.assertRaises(m.Refused):
                m.recover(SOURCE, value, lambda _: False, mock.Mock(), mock.Mock(), NOW)

    def test_tampered_signature_download_failure_and_oversize_prevent_returned_rewrite(self):
        def rejected(_):
            raise m.Refused('release_signature')
        with self.assertRaises(m.Refused):
            recover(verify=rejected)
        with self.assertRaises(m.Refused):
            recover(fetch=lambda _: b'x' * (m.LIMIT + 1))
        with mock.patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=1)):
            with self.assertRaises(m.Refused):
                m.verify(b'tampered-clearsigned-payload', b'fixture-keyring')

    def test_release_identity_expiry_and_date_guards(self):
        patches = [
            {'Codename': 'jammy'}, {'Suite': 'noble'}, {'Origin': 'Other'}, {'Label': 'Other'},
            {'Valid-Until': 'Wed, 11 Nov 2026 15:59:00 UTC'},
            {'Date': 'Wed, 11 Nov 2026 16:06:00 UTC'},
            {'Date': 'Sun, 01 Nov 2026 12:00:00 UTC'},
            {'Date': 'not-a-date'}, {'Architectures': 'arm64'}, {'Components': 'main'},
        ]
        for patch in patches:
            with self.subTest(patch=patch), self.assertRaises((m.Refused, ValueError)):
                m.validate_release(release('noble-updates', **patch), 'noble-updates',
                    {'main', 'universe'}, NOW)
        m.validate_release(release('noble'), 'noble', {'main', 'universe'}, NOW)
        m.validate_release(release('noble-security', **{'Valid-Until': 'Thu, 12 Nov 2026 12:00:00 UTC'}),
            'noble-security', {'main'}, NOW)

    def test_fixed_file_symlink_owner_mode_and_link_count_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'ubuntu.sources'
            file.write_bytes(SOURCE)
            link = Path(folder) / 'link'
            link.symlink_to(file)
            with mock.patch.object(m, 'SOURCES', link), self.assertRaisesRegex(m.Refused, '^source_symlink$'):
                m.read_owned(link, 65536)
            for patch in [{'st_uid': 1000}, {'st_mode': stat.S_IFREG | 0o664}, {'st_nlink': 2}]:
                info = dict(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_nlink=1, st_size=len(SOURCE))
                info.update(patch)
                with mock.patch.object(m, 'SOURCES', file), mock.patch.object(m.os, 'fstat', return_value=SimpleNamespace(**info)):
                    with self.assertRaises(m.Refused):
                        m.read_owned(file, 65536)
        with self.assertRaises(m.Refused):
            m.read_owned(Path('/tmp/arbitrary'), 65536)

    def test_other_distros_are_unchanged_and_failed_preflight_never_writes_config(self):
        with mock.patch.object(Path, 'read_text', return_value='ID=ubuntu\nVERSION_ID="26.04"\nVERSION_CODENAME=resolute\n'), \
             mock.patch.object(m, 'read_owned') as read, mock.patch.object(m, 'write_sources') as write:
            m.main()
            read.assert_not_called()
            write.assert_not_called()
        with mock.patch.object(Path, 'read_text', return_value='ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n'), \
             mock.patch.object(m.os, 'geteuid', return_value=0), \
             mock.patch.object(m, 'read_owned', return_value=(SOURCE, SimpleNamespace(st_mode=0o644))), \
             mock.patch.object(m, 'recover', side_effect=m.Refused('release_signature')), \
             mock.patch.object(m, 'write_sources') as write:
            with self.assertRaises(m.Refused):
                m.main()
            write.assert_not_called()

    def test_diagnostics_are_closed_codes_and_never_echo_exception_content(self):
        for error in [m.Refused('private-sentinel'), ValueError('private-sentinel'),
                      OSError('private-sentinel'), RuntimeError('private-sentinel')]:
            self.assertNotIn('private-sentinel', m.public_failure(error))
        self.assertIn('reason=source_not_root_owned', m.public_failure(m.Refused('source_not_root_owned')))
        self.assertNotIn('private-phase-sentinel', self._unknown_phase_message())

    def _unknown_phase_message(self):
        with mock.patch.object(m, 'PHASE', 'private-phase-sentinel'):
            return m.public_failure(RuntimeError('private-error-sentinel'))

    def test_writable_keyring_with_working_dns_still_pins_apt_without_changing_uris(self):
        urls = []
        result = m.recover(SOURCE, MIRRORS, lambda _: True,
            lambda url: (urls.append(url) or release(url.split('/')[-2])), lambda b: b, NOW, pin_required=True)
        self.assertEqual(result, SOURCE.replace(str(m.KEYRING).encode(), m.SIGNED_BY.encode()))
        self.assertEqual(len(urls), 4)
        self.assertIn((m.FINGERPRINT + '!').encode(), result)

    def test_signer_and_primary_must_both_be_exact_and_single(self):
        def run_for(status):
            def run(args, **kwargs):
                Path(args[args.index('--output') + 1]).write_bytes(release('noble'))
                return SimpleNamespace(returncode=0, stdout=status.encode())
            return run
        valid = '[GNUPG:] VALIDSIG ' + m.FINGERPRINT + ' 2024-04-25 1714057881 0 4 0 1 10 01 ' + m.FINGERPRINT + '\n'
        variants = [valid.replace(m.FINGERPRINT, 'A' * 40, 1),
            valid.rsplit(m.FINGERPRINT, 1)[0] + 'B' * 40 + '\n', valid + valid, '']
        for status in variants:
            with mock.patch.object(m.subprocess, 'run', side_effect=run_for(status)), self.assertRaisesRegex(m.Refused, 'release_signer'):
                m.verify(b'signed', b'keyring')
        with mock.patch.object(m.subprocess, 'run', side_effect=run_for(valid)):
            self.assertEqual(m.verify(b'signed', b'keyring'), release('noble'))

    def test_snapshot_install_does_not_overwrite_foreign_file_or_follow_symlink(self):
        real_fstat, real_lstat = os.fstat, Path.lstat
        def owned(info):
            return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_nlink=info.st_nlink, st_size=info.st_size)
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder) / 'keyrings'
            dest = parent / 'ezil-ci-ubuntu-archive.gpg'
            with mock.patch.object(m, 'PROTECTED_KEYRING', dest), \
                 mock.patch.object(m.os, 'fstat', side_effect=lambda fd: owned(real_fstat(fd))), \
                 mock.patch.object(Path, 'lstat', lambda path: owned(real_lstat(path))):
                m.install_keyring(b'public-keyring')
                self.assertEqual(dest.read_bytes(), b'public-keyring')
                self.assertEqual(stat.S_IMODE(real_lstat(parent).st_mode), 0o755)
                self.assertEqual(stat.S_IMODE(real_lstat(dest).st_mode), 0o644)
                m.install_keyring(b'public-keyring')
                with self.assertRaisesRegex(m.Refused, 'protected_keyring_mismatch'):
                    m.install_keyring(b'foreign-keyring')
                self.assertEqual(dest.read_bytes(), b'public-keyring')
                dest.unlink()
                dest.symlink_to(Path(folder) / 'foreign')
                with self.assertRaisesRegex(m.Refused, 'protected_keyring_symlink'):
                    m.install_keyring(b'public-keyring')
                dest.unlink()
                parent.chmod(0o777)
                with self.assertRaisesRegex(m.Refused, 'protected_keyring_parent'):
                    m.install_keyring(b'public-keyring')
                self.assertFalse(dest.exists())

    def test_install_failure_never_flips_sources_and_install_precedes_source_write(self):
        order = []
        def read(path, limit):
            if path == m.KEYRING:
                return b'fixture-keyring', SimpleNamespace(st_mode=0o777)
            return (MIRRORS if path == m.MIRROR_LIST else SOURCE), SimpleNamespace(st_mode=0o644)
        with mock.patch.object(Path, 'read_text', return_value='ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n'), \
             mock.patch.object(m.os, 'geteuid', return_value=0), mock.patch.object(m, 'read_owned', side_effect=read), \
             mock.patch.object(m, 'recover', return_value=b'changed'), \
             mock.patch.object(m, 'install_keyring', side_effect=lambda _: order.append('key')), \
             mock.patch.object(m, 'write_sources', side_effect=lambda *args: order.append('source')):
            m.main()
            self.assertEqual(order, ['key', 'source'])
            order.clear()
            with mock.patch.object(m, 'install_keyring', side_effect=m.Refused('protected_keyring_parent')):
                with self.assertRaises(m.Refused):
                    m.main()
            self.assertEqual(order, [])

    def test_real_gpgv_rejects_extra_attacker_key_and_accepts_only_pinned_signature(self):
        with tempfile.TemporaryDirectory() as folder:
            os.chmod(folder, 0o700)
            def gpg(*args):
                return subprocess.run(['gpg', '--homedir', folder, '--batch', '--yes', '--pinentry-mode',
                    'loopback', '--passphrase', '', *args], capture_output=True, check=True, timeout=15).stdout
            try:
                for name in ['CI Archive Test', 'CI Attacker Test']:
                    gpg('--quick-gen-key', name, 'ed25519', 'sign', '0')
                listed = gpg('--with-colons', '--list-keys').decode()
                fingerprints = [line.split(':')[9] for line in listed.splitlines() if line.startswith('fpr:')]
                self.assertEqual(len(fingerprints), 2)
                keys = gpg('--export')
                payload = Path(folder) / 'payload'
                payload.write_bytes(release('noble'))
                signed = Path(folder) / 'InRelease'
                with mock.patch.object(m, 'FINGERPRINT', fingerprints[0]):
                    gpg('--local-user', fingerprints[1], '--output', str(signed), '--clearsign', str(payload))
                    with self.assertRaisesRegex(m.Refused, 'release_signer'):
                        m.verify(signed.read_bytes(), keys)
                    gpg('--local-user', fingerprints[0], '--output', str(signed), '--clearsign', str(payload))
                    self.assertEqual(m.verify(signed.read_bytes(), keys), payload.read_bytes())
            finally:
                subprocess.run(['gpgconf', '--homedir', folder, '--kill', 'gpg-agent'], capture_output=True, timeout=5)

    def test_normal_apt_accepts_exact_protected_signed_by_syntax_offline(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sources = root / 'ubuntu.sources'
            sources.write_bytes(SOURCE.replace(m.LIST_URI.encode(), m.MIRROR.encode()).replace(
                str(m.KEYRING).encode(), m.SIGNED_BY.encode()))
            lists = root / 'lists'
            lists.mkdir()
            (lists / 'partial').mkdir()
            result = subprocess.run(['apt-get', 'indextargets',
                '-o', 'Dir::Etc::sourcelist=' + str(sources), '-o', 'Dir::Etc::sourceparts=-',
                '-o', 'Dir::State::lists=' + str(lists), '-o', 'Dir::Cache=' + str(root)],
                capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_download_uses_bounded_verified_https_and_no_signature_bypass(self):
        with mock.patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'signed')) as run:
            self.assertEqual(m.fetch(m.MIRROR + 'dists/noble/InRelease'), b'signed')
            args = run.call_args.args[0]
            self.assertIn('--max-time', args)
            self.assertIn('--max-filesize', args)
            self.assertEqual(args[args.index('--proto') + 1], '=https')
            self.assertNotIn('--insecure', args)

if __name__ == '__main__':
    unittest.main()

