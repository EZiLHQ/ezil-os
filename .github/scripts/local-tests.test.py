#!/usr/bin/env python3
"""Exercise the real runner with a local Bun stub: no Docker or browser calls."""
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNNER = Path(__file__).with_name("local-tests.py")
spec = importlib.util.spec_from_file_location("runner", RUNNER)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
ROOT = RUNNER.resolve().parents[2]

STUB = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
paths = [path.removeprefix('./') for path in sys.argv[2:]]
with open('calls.jsonl', 'a') as log:
    log.write(json.dumps({'pid': os.getpid(), 'argv': sys.argv[1:], 'files': paths}) + '\n')
group = 'smoke' if len(paths) == 1 else 'rest'
mode = os.environ.get('STUB_MODE') if os.environ.get('STUB_GROUP') == group else 'ok'
if mode == 'omission': paths = paths[:-1]
if mode == 'duplicate': paths += paths[:1]
if mode == 'foreign': paths += ['local/foreign.test.ts']
for path in paths:
    print(os.environ.get('STUB_GROUPED', '') + path + ':')
    if os.environ.get('STUB_GROUPED'): print('::endgroup::')
if mode == 'summary_missing': sys.exit(0)
print(f' {len(paths)} pass')
print(' 1 fail' if mode == 'reported_failure' else ' 0 fail')
if mode == 'skip': print(' 2 skip')
if mode == 'todo': print(' 1 todo')
if mode == 'duplicate_summary': print(f' {len(paths)} pass')
print(f'Ran {len(paths)} tests across {len(paths)} files. [1.00ms]')
sys.exit(7 if mode == 'exit_failure' else 0)
'''


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="local-runner-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = runner.inventory(ROOT)
        for path in self.files:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        binary = self.root / "bin" / "bun"
        binary.parent.mkdir()
        binary.write_text(STUB)
        binary.chmod(0o755)

    def run_stub(self, mode="ok", group="smoke", grouped=""):
        result = subprocess.run([sys.executable, str(RUNNER.resolve())], cwd=self.root,
                                env={**os.environ, "PATH": str(self.root / "bin") + os.pathsep + os.environ["PATH"],
                                     "TMPDIR": str(self.root), "STUB_MODE": mode, "STUB_GROUP": group,
                                     "STUB_GROUPED": grouped},
                                capture_output=True, text=True, timeout=10)
        receipt = self.root / "calls.jsonl"
        calls = [json.loads(line) for line in receipt.read_text().splitlines()] if receipt.exists() else []
        return result, calls

    def assert_exact_calls(self, calls):
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0]["pid"], calls[1]["pid"])
        self.assertEqual(calls[0]["files"], [runner.SMOKE])
        self.assertEqual(Counter(path for call in calls for path in call["files"]), Counter(self.files))
        for call in calls:
            self.assertEqual(call["argv"], ["test", *["./" + path for path in call["files"]]])

    def test_actual_inventory_is_partitioned_into_one_and_fourteen(self):
        self.assertEqual(len(self.files), 15)
        result, calls = self.run_stub()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_exact_calls(calls)

    def test_missing_smoke_refuses_before_any_process(self):
        (self.root / runner.SMOKE).unlink()
        result, calls = self.run_stub()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])

    def test_github_grouped_inventory_passes_with_same_exact_partition(self):
        for grouped in ["::group::", "##[group]"]:
            with self.subTest(grouped=grouped):
                (self.root / "calls.jsonl").unlink(missing_ok=True)
                result, calls = self.run_stub(grouped=grouped)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_exact_calls(calls)

    def test_partition_rejects_omission_duplicate_and_shared_smoke(self):
        rest = [path for path in self.files if path != runner.SMOKE]
        for groups in [[[runner.SMOKE], rest[:-1]], [[runner.SMOKE], rest + rest[:1]],
                       [[runner.SMOKE], rest + [runner.SMOKE]], [[runner.SMOKE], rest[:1], rest[1:]]]:
            with self.subTest(groups=groups), self.assertRaises(ValueError):
                runner.validate_partition(self.files, groups)

    def test_each_failure_rejects_but_still_executes_both_groups_once(self):
        for grouped in ["", "::group::", "##[group]"]:
            for group in ["smoke", "rest"]:
                for mode in ["exit_failure", "reported_failure", "skip", "todo", "summary_missing",
                             "duplicate_summary", "omission", "duplicate", "foreign"]:
                    with self.subTest(grouped=grouped, group=group, mode=mode):
                        (self.root / "calls.jsonl").unlink(missing_ok=True)
                        result, calls = self.run_stub(mode, group, grouped)
                        self.assertNotEqual(result.returncode, 0, result.stdout)
                        self.assert_exact_calls(calls)

    def test_discovery_includes_new_test_and_spec_suffixes_but_not_dependencies(self):
        additions = ["local/nested/new_test.ts", "local/nested/new.spec.tsx"]
        for path in additions + ["local/node_modules/dep/ignored.test.ts"]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        self.files = sorted(self.files + additions)
        result, calls = self.run_stub()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assert_exact_calls(calls)


if __name__ == "__main__":
    unittest.main()
