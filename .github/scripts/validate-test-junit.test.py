#!/usr/bin/env python3
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('validator', HERE / 'validate-test-junit.py')
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)

class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.report = self.root / 'report.xml'
        self.inventory = self.root / 'required.json'
        self.inventory.write_text(json.dumps({'worker/persistence.test.ts': ['restore files', 'restore OpenCode']}))
        self.tree = ET.Element('testsuites', tests='2', failures='0', skipped='0')
        suite = ET.SubElement(self.tree, 'testsuite', tests='2')
        for name in ['restore files', 'restore OpenCode']:
            ET.SubElement(suite, 'testcase', name=name, file='worker/persistence.test.ts')
    def write(self):
        ET.ElementTree(self.tree).write(self.report)
    def validate(self):
        self.write()
        return validator.validate(self.report, self.inventory)
    def test_complete(self):
        self.assertEqual(self.validate(), 2)
    def test_absolute_paths(self):
        for c in self.tree.iter('testcase'): c.set('file', '/home/runner/repo/worker/persistence.test.ts')
        self.assertEqual(self.validate(), 2)
    def test_partial_one_pass(self):
        self.tree[0].remove(self.tree[0][1]); self.tree.set('tests','1'); self.tree[0].set('tests','1')
        with self.assertRaises(ValueError): self.validate()
    def test_failure_error_skip_children(self):
        for tag in ['failure', 'error', 'skipped']:
            with self.subTest(tag=tag):
                child=ET.SubElement(self.tree[0][0], tag)
                with self.assertRaises(ValueError): self.validate()
                self.tree[0][0].remove(child)
    def test_aggregate_failure_error_skip(self):
        for key in ['failures','errors','skipped','disabled']:
            with self.subTest(key=key):
                self.tree.set(key,'1')
                with self.assertRaises(ValueError): self.validate()
                self.tree.set(key,'0')
    def test_wrong_identity(self):
        self.tree[0][1].set('name','unrelated test')
        with self.assertRaises(ValueError): self.validate()
    def test_wrong_file(self):
        self.tree[0][1].set('file','other/persistence.test.ts')
        with self.assertRaises(ValueError): self.validate()
    def test_duplicate_case(self):
        self.tree[0].append(copy.deepcopy(self.tree[0][0])); self.tree.set('tests','3'); self.tree[0].set('tests','3')
        with self.assertRaises(ValueError): self.validate()
    def test_inconsistent_count(self):
        self.tree.set('tests','100')
        with self.assertRaises(ValueError): self.validate()
    def test_empty_cases(self):
        self.tree.clear()
        with self.assertRaises(ValueError): self.validate()
    def test_missing_and_invalid_report(self):
        with self.assertRaises(OSError): validator.validate(self.report,self.inventory)
        self.report.write_text('not xml')
        with self.assertRaises(ET.ParseError): validator.validate(self.report,self.inventory)
    def run_wrapper(self, summary):
        self.write()
        env=dict(os.environ, EZIL_TEST_JUNIT=str(self.report),EZIL_TEST_REQUIRED=str(self.inventory))
        return subprocess.run(['bash',str(HERE/'run-checked-tests.sh'),str(self.root/'run.log'),'printf',summary],env=env,capture_output=True,text=True)
    def test_console_green_junit_red(self):
        ET.SubElement(self.tree[0][1],'failure')
        self.assertNotEqual(self.run_wrapper(' 2 pass\n 0 fail\n').returncode,0)
    def test_console_red_junit_green(self):
        self.assertNotEqual(self.run_wrapper(' 2 pass\n 1 fail\n').returncode,0)
    def test_both_green(self):
        self.assertEqual(self.run_wrapper(' 2 pass\n 0 fail\n').returncode,0)

if __name__ == '__main__': unittest.main(verbosity=2)
