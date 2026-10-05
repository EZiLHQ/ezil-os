#!/usr/bin/env python3
"""Credential-free tests; AWS CLI is replaced by an in-memory conditional store."""
import importlib.util
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("lease", Path(__file__).with_name("staging-lock.py"))
lease = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease)


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.items = {}
        def aws(*args):
            def flag(name): return json.loads(args[args.index(name) + 1])
            op = args[0]
            if op == 'put-item':
                item = flag('--item'); scope = item['scope']['S']; old = self.items.get(scope)
                if old and old['owner'] != item['owner'] and int(old['expires_at']['N']) >= 1000:
                    return SimpleNamespace(returncode=1, stderr='ConditionalCheckFailedException')
                self.items[scope] = item
            elif op == 'delete-item':
                scope = flag('--key')['scope']['S']; owner = flag('--expression-attribute-values')[':owner']
                if self.items.get(scope, {}).get('owner') != owner:
                    return SimpleNamespace(returncode=1, stderr='ConditionalCheckFailedException')
                del self.items[scope]
            elif op == 'get-item':
                self.assertIn('--consistent-read', args)
                return SimpleNamespace(returncode=0, stdout=json.dumps({'Item': self.items.get(flag('--key')['scope']['S'], {})}))
            return SimpleNamespace(returncode=0, stdout='{}')
        self.addCleanup(patch.stopall)
        patch.object(lease, 'aws', aws).start()
        patch.object(lease.time, 'time', lambda: 1000).start()

    def test_scopes_and_exclusion(self):
        self.assertEqual(lease.acquire('works-1', 600, 0, 'shared-production'), 0)
        self.assertEqual(lease.acquire('gateway-1', 600, 0, 'shared-production'), 2)
        self.assertEqual(lease.acquire('gateway-1', 600, 0, 'shared-staging'), 0)
        self.assertEqual(lease.assert_owner('works-1', 'shared-production'), 0)
        self.assertEqual(lease.assert_owner('gateway-1', 'shared-production'), 2)

    def test_release_cannot_delete_other_owner(self):
        lease.acquire('works-1', 600, 0, 'shared-production')
        self.assertEqual(lease.release('works-2', 'shared-production'), 2)
        self.assertIn('shared-production', self.items)
        self.assertEqual(lease.release('works-1', 'shared-production'), 0)

    def test_expired_lease_and_same_owner_retry(self):
        lease.acquire('works-1', 1, 0, 'shared-production')
        self.assertEqual(lease.assert_owner('works-1', 'shared-production'), 2)
        self.assertEqual(lease.acquire('works-1', 600, 0, 'shared-production'), 0)
        self.items['shared-production']['expires_at']['N'] = '999'
        self.assertEqual(lease.acquire('works-2', 600, 0, 'shared-production'), 0)

    def test_workflow_lease_lifetimes_are_accepted_by_the_real_cli(self):
        workflow = Path(__file__).parents[1] / 'workflows' / 'preview.yml'
        durations = re.findall(r'staging-lock\.py acquire[^\n]+--ttl (\d+)', workflow.read_text())
        self.assertTrue(durations, 'No workflow lease commands checked')
        self.assertIn('10800', durations)
        for duration in durations:
            with self.subTest(ttl=duration), patch.object(sys, 'argv', [
                'staging-lock.py', 'acquire', '--owner', 'os-test',
                '--ttl', duration, '--wait', '0',
            ]):
                self.assertEqual(lease.main(), 0)
                self.assertEqual(int(self.items['shared-staging']['expires_at']['N']), 1000 + int(duration))

    def test_cli_rejects_unbounded_lease_before_any_write(self):
        with patch.object(sys, 'argv', [
            'staging-lock.py', 'acquire', '--owner', 'os-test',
            '--ttl', str(lease.MAX_LEASE_TTL_SECONDS + 1), '--wait', '0',
        ]), self.assertRaises(SystemExit) as error:
            lease.main()
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.items, {})


if __name__ == '__main__': unittest.main()
