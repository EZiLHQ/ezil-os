import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import zlib

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('parity-schema-preflight.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


class ReadOnlyTransport(unittest.TestCase):
    def host(self, mismatch=False, database_exit=0):
        calls = []
        source = transport.TARGETS['production'][1]
        def run(args, **options):
            calls.append(args)
            if args[:3] == ('docker', 'ps', '-q'):
                out = 'synthetic-container\n'
            elif args[:3] == ('docker', 'inspect', '--format'):
                out = 'ezil-os-production web\n'
            elif args[:2] == ('docker', 'inspect'):
                out = json.dumps([{'State': {'Status': 'running'}, 'Config': {'Env': [
                    'EZIL_GIT_SHA=' + ('0' * 40 if mismatch else source), 'PRIVATE_KEY=never-output-this']}}])
            elif args[:2] == ('systemctl', 'show'):
                out = 'ActiveState=active\nUnitFileState=enabled\nFragmentPath=/etc/systemd/system/' + args[2] + '\nDropInPaths=\n'
            elif list(args[:3]) == ['docker', 'exec', '-i']:
                self.assertEqual(args[-1], 'production')
                self.assertEqual(options['input'], 'synthetic node source')
                return subprocess.CompletedProcess(args, database_exit, json.dumps({'status': 'incomplete' if database_exit else 'observed'}), 'private DB error never emitted')
            else:
                raise AssertionError(args)
            return subprocess.CompletedProcess(args, 0, out, '')
        namespace = {'mode': 'production', 'expected': source,
                     'services': transport.TARGETS['production'][2], 'prefix': 'ezil-os-production-',
                     'jobs': transport.JOBS, 'db_source': 'synthetic node source'}
        stdout = io.StringIO()
        with patch('subprocess.run', side_effect=run), patch('pathlib.Path.read_bytes', return_value=b'exact timer bytes'), contextlib.redirect_stdout(stdout):
            try:
                exec(transport.HOST, namespace)
            except SystemExit as error:
                self.assertEqual(error.code, 1)
        raw = stdout.getvalue()
        self.assertNotIn('never-output-this', raw)
        self.assertNotIn('private DB error', raw)
        result = json.loads(raw)
        if result.get('encoding') == 'zlib-base64':
            result = json.loads(zlib.decompress(base64.b64decode(result['payload'])))
        self.assertNotIn('never-output-this', json.dumps(result))
        return result, calls

    def test_reads_twelve_exact_units_and_retains_database_refusal(self):
        result, calls = self.host(database_exit=2)
        self.assertEqual(len(result['timers']), 12)
        self.assertEqual(result['database'], {'status': 'incomplete'})
        self.assertEqual(result['database_exit_code'], 2)
        self.assertEqual(next(iter(result['timers'].values()))['sha256'], hashlib.sha256(b'exact timer bytes').hexdigest())
        self.assertTrue(all(args[0] == 'docker' or args[:2] == ('systemctl', 'show') for args in calls))

    def test_source_mismatch_refuses_before_database_and_timer_access(self):
        result, calls = self.host(mismatch=True)
        self.assertEqual(result['status'], 'refused')
        self.assertFalse(any(args[0] == 'systemctl' or args[:2] == ['docker', 'exec'] for args in calls))


if __name__ == '__main__':
    unittest.main()
