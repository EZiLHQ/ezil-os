"""Local archive and filesystem gates for ephemeral CLI delivery; no network."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name('stage.py')
spec = importlib.util.spec_from_file_location('ezil_cli_stage', SCRIPT)
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
VERSION = '0.3.0-standalone.20261110.0'
SOURCE = '9b8668c479179ec814b2a609c4bc4d7f10a8e3c1'
SUPERVISOR = b'#!/usr/bin/env python3\n# reviewed OS supervisor\n'
CLI = (b'#!/usr/bin/env node\n'
       + f'process.stdout.write("ezil {VERSION}\\n");\n'.encode())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fixture(extra=None):
    prefix = f'ezil-cli-{VERSION}/'
    files = {
        prefix + 'dist/ezil.js': CLI,
        prefix + 'package.json': json.dumps({'name': '@ezilhq/cli', 'version': VERSION}).encode(),
        prefix + 'SOURCE.json': json.dumps({'commit': SOURCE, 'version': VERSION}).encode(),
        prefix + 'README.md': b'reviewed public CLI fixture\n',
    }
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, data in files.items():
            item = tarfile.TarInfo(name)
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
        if extra is not None:
            archive.addfile(extra)
    data = output.getvalue()
    pin = {
        'url': f'https://github.com/EZiLHQ/ezil-cli/releases/download/standalone-20261110.0/ezil-cli-{VERSION}.tar.gz',
        'archiveSha256': sha(data), 'cliSha256': sha(CLI), 'supervisorSha256': sha(SUPERVISOR),
        'sourceCommit': SOURCE, 'version': VERSION,
    }
    return data, pin


class RuntimeStage(unittest.TestCase):
    def test_install_is_private_atomic_and_reverified_without_another_fetch(self):
        archive, pin = fixture()
        with tempfile.TemporaryDirectory(prefix='ezil-stage-') as directory:
            root = str(Path(directory) / 'run')
            calls = []
            def fetch(url):
                calls.append(url)
                return archive
            stage.stage(pin, SUPERVISOR, fetch=fetch, root=root, owner=os.geteuid())
            binary = Path(root) / 'bin' / 'ezil'
            self.assertEqual(binary.read_bytes(), CLI)
            self.assertEqual((Path(root) / 'bin' / 'supervise.py').read_bytes(), SUPERVISOR)
            self.assertEqual(binary.stat().st_mode & 0o777, 0o500)
            self.assertEqual((Path(root) / 'bin').stat().st_mode & 0o777, 0o700)
            self.assertEqual(len(calls), 1)
            stage.stage(pin, SUPERVISOR, fetch=fetch, root=root, owner=os.geteuid())
            self.assertEqual(len(calls), 1)
            os.chmod(binary, 0o700)
            binary.write_bytes(b'tampered')
            os.chmod(binary, 0o500)
            stage.stage(pin, SUPERVISOR, fetch=fetch, root=root, owner=os.geteuid())
            self.assertEqual(len(calls), 2)
            self.assertEqual(binary.read_bytes(), CLI)

    def test_wrong_archive_hash_never_installs_cli(self):
        archive, pin = fixture()
        pin['archiveSha256'] = '0' * 64
        with tempfile.TemporaryDirectory(prefix='ezil-stage-') as directory:
            root = str(Path(directory) / 'run')
            with self.assertRaises(stage.StageError):
                stage.stage(pin, SUPERVISOR, fetch=lambda _: archive, root=root, owner=os.geteuid())
            self.assertFalse((Path(root) / 'bin' / 'ezil').exists())

    def test_symlink_bin_and_archive_link_are_refused(self):
        archive, pin = fixture()
        with tempfile.TemporaryDirectory(prefix='ezil-stage-') as directory:
            root = Path(directory) / 'run'
            root.mkdir(mode=0o700)
            (root / 'bin').symlink_to(directory)
            with self.assertRaises(stage.StageError):
                stage.stage(pin, SUPERVISOR, fetch=lambda _: archive, root=str(root), owner=os.geteuid())
        link = tarfile.TarInfo(f'ezil-cli-{VERSION}/surprise')
        link.type = tarfile.SYMTYPE
        link.linkname = '/etc/passwd'
        poisoned, pin = fixture(link)
        with self.assertRaises(stage.StageError):
            stage.cli_from_archive(poisoned, pin)

    def test_duplicate_unselected_archive_member_is_refused(self):
        duplicate = tarfile.TarInfo(f'ezil-cli-{VERSION}/README.md')
        duplicate.size = 0
        poisoned, pin = fixture(duplicate)
        with self.assertRaises(stage.StageError):
            stage.cli_from_archive(poisoned, pin)

    def test_unapproved_url_and_old_node_are_refused(self):
        _, pin = fixture()
        pin['url'] = 'https://example.com/ezil-cli.tar.gz'
        with self.assertRaises(stage.StageError):
            stage.validate_pin(pin)
        with patch.object(stage, 'node_binary', return_value='/bin/sh'):
            with self.assertRaises(stage.StageError):
                stage.check_node()


if __name__ == '__main__':
    unittest.main()
