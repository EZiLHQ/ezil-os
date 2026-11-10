"""Fake-port tests only: no AWS, Docker, SSM or host side effects."""
import sys
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app_only_offline as m


def digest(c):
    return c * 64


def base_state():
    return m.Snapshot('a' * 40, digest('b'), digest('c'), digest('d'), digest('e'),
                      digest('f'), 'secret-version-1', digest('9'), True, True)


def candidate_state():
    return replace(base_state(), app_sha='b' * 40, image_id=digest('a'),
                   selector_sha256=digest('8'), bundle_sha256=digest('7'))


def artifact(state, version):
    return m.Artifact(state.app_sha, state.image_id, digest('1'), digest('2'), version,
                      'candidate' if version == 'new-version' else 'previous')


def swap(generation=4):
    before, after = base_state(), candidate_state()
    return m.Plan('app-swap', 'staging', 'scheduler', generation, before, after,
                  artifact(after, 'new-version'), artifact(before, 'old-version'),
                  digest('3'), digest('4'))


class FakePort:
    """A cooperative fake guard, not evidence of a real host or IAM fence."""
    def __init__(self):
        before = base_state()
        self._ledger = m.Ledger(m.Entry(4, digest('5'), 'apply-app', before, before))
        self._live = before
        self._lease = m.Lease('scheduler', 1800)
        self.verified = True
        self.actual_version = 'new-version'
        self.rollback_version = 'old-version'
        self.archive_tags = ('candidate',)
        self.existing_tags = {'previous': digest('b')}
        self.enforced = True
        self.fail_admit = False
        self.fail_mark = False
        self.lose_send_reply = False
        self.fail_journal = False
        self.fail_complete = False
        self.drift_on_complete = False
        self.send_count = 0
        self.legacy_count = 0
        self.status = 'InProgress'
        self.quiescent = True

    def ledger(self): return self._ledger
    def live(self): return self._live
    def lease(self): return self._lease
    def verify_artifacts(self, plan):
        if (not self.verified or self.actual_version != plan.artifact.object_version
                or self.rollback_version != plan.rollback.object_version):
            return False
        try:
            m.validate_archive_tags(self.archive_tags, plan.artifact.tag,
                                    plan.artifact.image_id, self.existing_tags,
                                    allow_existing_matching=plan.operation == 'app-restore')
        except m.Refused:
            return False
        return True
    def verify_enforcement(self, plan): return self.enforced

    def admit(self, expected, pending):
        if self.fail_admit: raise OSError('ledger write failed')
        if (self._ledger != expected or self._ledger.pending or self._live != pending.before
                or self._lease.owner != pending.owner or not self.enforced):
            raise m.Refused('ledger CAS')
        self._ledger = replace(self._ledger, pending=pending)

    def mark_attempt(self, expected):
        if self.fail_mark: raise OSError('journal write failed')
        if (self._ledger.pending != expected or self._live != expected.before
                or self._lease.owner != expected.owner or not self.enforced):
            raise m.Refused('attempt CAS')
        p = replace(expected, phase='dispatch-uncertain')
        self._ledger = replace(self._ledger, pending=p)
        return p

    def send(self, plan):
        self.send_count += 1
        if self.lose_send_reply: raise TimeoutError('response lost')
        return 'fake-command-1'

    def record_command(self, expected, command_id):
        if self.fail_journal: raise OSError('command journal failed')
        if self._ledger.pending != expected: raise m.Refused('command CAS')
        p = replace(expected, phase='sent', command_id=command_id)
        self._ledger = replace(self._ledger, pending=p)
        return p

    def command_status(self, command_id): return self.status
    def confirm_quiescent(self, command_id, plan): return self.quiescent

    def complete(self, expected):
        if self.fail_complete: raise OSError('completion write failed')
        if self.drift_on_complete: self._live = replace(self._live, timer_sha256=digest('0'))
        if (self._ledger.pending != expected or self._live != expected.after
                or self._lease.owner != expected.owner or not self.enforced):
            raise m.Refused('completion CAS')
        e = m.Entry(expected.generation, expected.plan_sha256, expected.operation,
                    expected.before, expected.after, 'completed')
        self._ledger = m.Ledger(e)

    def abort(self, expected):
        if (self._ledger.pending != expected or self._live != expected.before
                or self._lease.owner != expected.owner or not self.quiescent or not self.enforced):
            raise m.Refused('abort CAS')
        e = m.Entry(expected.generation, expected.plan_sha256, expected.operation,
                    expected.before, expected.before, 'aborted')
        self._ledger = m.Ledger(e)

    def stale_legacy_send(self):
        # A simulation of a compulsory transport policy. Actual deploy.sh and
        # generic root SSM currently do NOT call this check.
        if self.enforced and self._ledger.pending:
            raise PermissionError('simulated policy denied legacy mutation')
        self.legacy_count += 1


class AppOnlyOfflineTests(unittest.TestCase):
    def setUp(self):
        self.port = FakePort()
        self.plan = swap()

    def admit(self):
        return m.prepare(self.port, self.plan, 1200)

    def sent(self):
        self.admit()
        self.assertEqual(m.dispatch(self.port, self.plan, 1200), 'fake-command-1')
        return self.port.ledger().pending

    def test_success_completes_technical_readback_with_gate_closed(self):
        self.sent()
        self.port.status = 'Success'
        self.port._live = self.plan.after
        m.finish(self.port, self.plan)
        self.assertIsNone(self.port.ledger().pending)
        self.assertEqual(self.port.ledger().latest.after, self.plan.after)
        self.assertTrue(self.port.ledger().latest.after.kill_switch)
        self.assertEqual(self.port.send_count, 1)

    def test_admission_checks_guard_source_version_tag_and_live_state(self):
        for problem in ('fence', 'version', 'tag', 'drift', 'lease', 'artifact'):
            with self.subTest(problem=problem):
                self.setUp()
                if problem == 'fence': self.port.enforced = False
                if problem == 'version': self.port.actual_version = 'substituted-version'
                if problem == 'tag': self.port.archive_tags = ('previous',)
                if problem == 'drift': self.port._live = replace(self.plan.before, timer_sha256=digest('6'))
                if problem == 'lease': self.port._lease = m.Lease('scheduler', 1199)
                if problem == 'artifact': self.port.verified = False
                with self.assertRaises(m.Refused): self.admit()
                self.assertIsNone(self.port.ledger().pending)
                self.assertEqual(self.port.send_count, 0)

    def test_tag_collision_denied_before_load_even_if_tag_is_expected(self):
        self.port.existing_tags['candidate'] = digest('0')
        with self.assertRaises(m.Refused): self.admit()
        self.assertEqual(self.port.send_count, 0)
        self.assertEqual(self.port.existing_tags['candidate'], digest('0'))

    def test_existing_matching_candidate_tag_and_rollback_version_are_rejected(self):
        self.port.existing_tags['candidate'] = self.plan.artifact.image_id
        with self.assertRaises(m.Refused): self.admit()
        del self.port.existing_tags['candidate']
        self.port.rollback_version = 'substituted-old-version'
        with self.assertRaises(m.Refused): self.admit()
        self.assertEqual(self.port.send_count, 0)
        self.assertIsNone(self.port.ledger().pending)

    def test_completion_compare_and_swap_refuses_racing_timer_change(self):
        self.sent()
        self.port.status = 'Success'
        self.port._live = self.plan.after
        self.port.drift_on_complete = True
        with self.assertRaises(m.Refused): m.finish(self.port, self.plan)
        self.assertIsNotNone(self.port.ledger().pending)
        self.assertEqual(self.port.send_count, 1)

    def test_competing_plan_and_simulated_legacy_are_fenced(self):
        self.admit()
        with self.assertRaises(m.Refused): self.admit()
        with self.assertRaises(PermissionError): self.port.stale_legacy_send()
        self.assertEqual(self.port.legacy_count, 0)
        self.assertEqual(self.port.send_count, 0)

    def test_pending_or_attempt_write_failure_never_sends(self):
        self.port.fail_admit = True
        with self.assertRaises(OSError): self.admit()
        self.assertEqual(self.port.send_count, 0)
        self.port.fail_admit = False
        self.admit()
        self.port.fail_mark = True
        with self.assertRaises(OSError): m.dispatch(self.port, self.plan, 1200)
        self.assertEqual(self.port.send_count, 0)
        self.assertEqual(self.port.ledger().pending.phase, 'admitted')

    def test_lost_send_reply_never_automatically_resends(self):
        self.admit()
        self.port.lose_send_reply = True
        with self.assertRaises(m.OutcomeUnknown): m.dispatch(self.port, self.plan, 1200)
        self.assertEqual(self.port.ledger().pending.phase, 'dispatch-uncertain')
        self.port.lose_send_reply = False
        with self.assertRaises(m.OutcomeUnknown): m.dispatch(self.port, self.plan, 1200)
        with self.assertRaises(m.Refused): m.finish(self.port, self.plan)
        self.assertEqual(self.port.send_count, 1)

    def test_lost_command_journal_never_automatically_resends(self):
        self.admit()
        self.port.fail_journal = True
        with self.assertRaises(m.OutcomeUnknown): m.dispatch(self.port, self.plan, 1200)
        self.port.fail_journal = False
        with self.assertRaises(m.OutcomeUnknown): m.dispatch(self.port, self.plan, 1200)
        self.assertEqual(self.port.send_count, 1)
        self.assertEqual(self.port.ledger().pending.phase, 'dispatch-uncertain')

    def test_terminal_failure_requires_quiescence_and_new_generation(self):
        self.sent()
        self.port.status = 'Failed'
        with self.assertRaises(m.OutcomeUnknown): m.dispatch(self.port, self.plan, 1200)
        self.port.quiescent = False
        with self.assertRaises(m.Refused): m.abort_confirmed_failure(self.port, self.plan)
        self.port.quiescent = True
        self.port._live = replace(self.plan.before, selector_sha256=digest('6'))
        with self.assertRaises(m.Refused): m.abort_confirmed_failure(self.port, self.plan)
        self.port._live = self.plan.before
        m.abort_confirmed_failure(self.port, self.plan)
        self.assertEqual(self.port.ledger().latest.state, 'aborted')
        with self.assertRaises(m.Refused): self.admit()
        self.assertEqual(self.port.send_count, 1)

    def test_success_with_bad_live_readback_retains_pending(self):
        self.sent()
        self.port.status = 'Success'
        for bad in (replace(self.plan.after, healthy=False),
                    replace(self.plan.after, kill_switch=False),
                    replace(self.plan.after, registry_sha256=digest('0')),
                    replace(self.plan.after, timer_sha256=digest('0')),
                    replace(self.plan.after, secret_version='changed')):
            self.port._live = bad
            with self.assertRaises(m.Refused): m.finish(self.port, self.plan)
            self.assertIsNotNone(self.port.ledger().pending)
        self.assertEqual(self.port.send_count, 1)

    def test_failed_completion_append_can_reconcile_without_resend(self):
        self.sent()
        self.port.status = 'Success'
        self.port._live = self.plan.after
        self.port.fail_complete = True
        with self.assertRaises(OSError): m.finish(self.port, self.plan)
        with self.assertRaises(m.OutcomeUnknown): m.dispatch(self.port, self.plan, 1200)
        self.port.fail_complete = False
        m.finish(self.port, self.plan)
        self.assertEqual(self.port.send_count, 1)
        self.assertIsNone(self.port.ledger().pending)

    def test_restore_requires_exact_latest_swap_and_old_artifact(self):
        self.sent()
        self.port.status = 'Success'
        self.port._live = self.plan.after
        m.finish(self.port, self.plan)
        restore = m.Plan('app-restore', 'staging', 'scheduler', 5, self.plan.after,
                         self.plan.before, self.plan.rollback, self.plan.artifact,
                         digest('3'), digest('4'), self.plan.digest())
        self.port.actual_version = 'old-version'
        self.port.rollback_version = 'new-version'
        self.port.archive_tags = ('previous',)
        with self.assertRaises(m.Refused):
            m.prepare(self.port, replace(restore, undoes_plan=digest('0')), 1200)
        m.prepare(self.port, restore, 1200)
        m.dispatch(self.port, restore, 1200)
        self.port.status = 'Success'
        self.port._live = restore.after
        m.finish(self.port, restore)
        self.assertEqual(self.port.ledger().latest.after, base_state())
        self.assertEqual(self.port.ledger().latest.generation, 6)
        self.assertEqual(self.port.send_count, 2)
        with self.assertRaises(m.Refused): m.prepare(self.port, restore, 1200)

    def test_expired_lease_or_disabled_guard_refuses_dispatch(self):
        self.admit()
        self.port._lease = m.Lease('other-owner', 1800)
        with self.assertRaises(m.Refused): m.dispatch(self.port, self.plan, 1200)
        self.port._lease = m.Lease('scheduler', 1800)
        self.port.enforced = False
        with self.assertRaises(m.Refused): m.dispatch(self.port, self.plan, 1200)
        self.assertEqual(self.port.send_count, 0)
        self.assertEqual(self.port.ledger().pending.phase, 'admitted')


if __name__ == '__main__':
    unittest.main(verbosity=2)
