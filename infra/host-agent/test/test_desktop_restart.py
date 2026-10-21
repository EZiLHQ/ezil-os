"""Signed AWS restart, with an in-memory transport and synthetic key only."""
import hashlib
import hmac
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from ezil_host import agent, desktop, edge
from test_ice import scratch

KEY = b'k' * 32
LEASE = {'computerId': '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', 'generation': 1, 'leaseEpoch': 2}
RID = 'a' * 64
PATH = '/__ezil/control/restart-desktop/' + RID


class DesktopRestart(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.now = 1700000000
        self.a = agent.Agent(self.cfg, LEASE, clock=lambda: self.now, log=lambda _: None)
        self.seq = edge.Sequencer(self.cfg, LEASE, KEY, clock=lambda: self.now)
        self.seq._send_once = self.deliver
        self.edge = edge.Edge(self.cfg, LEASE, KEY, sequencer=self.seq, clock=lambda: self.now)
        p = mock.patch.object(self.a, '_desktop_unit', return_value='active')
        self.unit = p.start()
        self.addCleanup(p.stop)

    def deliver(self, msg):
        msg['mac'] = agent.sign(KEY, msg)
        return self.a.handle(json.dumps(msg))

    def request(self, path=PATH, method='POST', signed=True, extra='', body=b'', binding=LEASE):
        bare = path.split('?', 1)[0]
        payload = edge.gateway_payload(binding, self.now, method, bare)
        sig = hmac.new(KEY, payload.encode(), hashlib.sha256).hexdigest()
        header = f'x-ezil-gw: gw1.{self.now}.{sig}\r\n' if signed else ''
        sock = mock.Mock()
        sock.recv.return_value = f'{method} {path} HTTP/1.1\r\nHost: test\r\n{header}{extra}\r\n'.encode() + body
        self.edge.handle(sock)
        raw = b''.join(c.args[0] for c in sock.sendall.call_args_list)
        head, data = raw.split(b'\r\n\r\n', 1)
        return int(head.split()[1]), json.loads(data)

    def test_double_request_before_and_after_tick_runs_only_desktop_unit_once(self):
        file = os.path.join(self.cfg.dataMount, 'sentinel')
        with open(file, 'w') as f:
            f.write('persistent')
        with mock.patch.object(agent.subprocess, 'run') as run, mock.patch.object(self.a, 'flush') as flush, mock.patch.object(self.a, 'shutdown') as shutdown:
            for _ in range(2):
                self.assertEqual(self.request(), (200, {'ok': True, 'state': 'restart_requested'}))
            self.assertEqual(self.a.tick(), 'restarting')
            self.assertEqual(self.request()[0], 200)
            self.assertEqual(self.a.tick(), 'active')
            self.assertEqual([c.args[0] for c in run.call_args_list], [self.cfg.desktopResetCmd, self.cfg.desktopRestartCmd])
            flush.assert_not_called()
            shutdown.assert_not_called()
        with open(file) as f:
            self.assertEqual(f.read(), 'persistent')
        self.assertEqual(self.cfg.desktopRestartCmd, ['/usr/bin/systemctl', 'restart', '--no-block', 'ezil-desktop.service'])

    def test_unsigned_foreign_action_and_foreign_epoch_refused(self):
        self.assertEqual(self.request(signed=False)[0], 401)
        self.assertEqual(self.request(path='/__ezil/control/exec')[0], 404)
        self.assertEqual(self.request(binding={**LEASE, 'leaseEpoch': 3})[0], 401)
        self.assertFalse(self.a.restart_request)

    def test_agent_unsigned_foreign_action_and_bad_id_refused(self):
        self.assertEqual(self.a.handle(json.dumps({'op': 'restart-desktop'}))['error'], 'bad_mac')
        self.assertEqual(self.seq.send('exec')['error'], 'unknown_op')
        for rid in (None, '../stop', 'a' * 63, 'A' * 64, True):
            self.assertFalse(self.seq.send('restart-desktop', requestId=rid)['ok'])
        self.assertFalse(self.a.restart_request)

    def test_method_query_body_and_framing_refused(self):
        for args in ({'method': 'GET'}, {'path': PATH + '?action=exec'}, {'extra': 'Content-Length: 1\r\n', 'body': b'x'},
                     {'extra': 'Transfer-Encoding: chunked\r\n'}, {'extra': 'Content-Length: 0\r\nContent-Length: 0\r\n'}):
            self.assertEqual(self.request(**args)[0], 400)
        self.assertFalse(self.a.restart_request)

    def test_stop_pending_or_shutdown_marker_refuses(self):
        self.a.stop_request = {'kind': 'stop'}
        self.assertEqual(self.request()[0], 409)
        self.a.stop_request = None
        for marker in (desktop.STOPPING, agent.SHUTDOWN_PENDING):
            self.a._set_marker(marker)
            self.assertEqual(self.request()[0], 409)
            self.a._clear_marker(marker)

    def test_exhausted_budget_and_busy_unit_refuse(self):
        self.a.desktop_restarts = [self.now] * self.cfg.desktopRestartMax
        self.assertEqual(self.request()[0], 409)
        self.a.desktop_restarts = []
        for state in ('activating', 'deactivating', 'pending', 'unknown'):
            self.unit.return_value = state
            self.assertEqual(self.request()[0], 409)

    def test_durable_ack_survives_agent_restart_and_pending_work_resumes(self):
        self.assertEqual(self.request()[0], 200)
        a = agent.Agent(self.cfg, LEASE, clock=lambda: self.now, log=lambda _: None)
        self.assertTrue(a.restart_request)
        with mock.patch.object(a, 'restart_desktop') as restart:
            a.tick()
            restart.assert_called_once()
        a = agent.Agent(self.cfg, LEASE, clock=lambda: self.now, log=lambda _: None)
        self.assertFalse(a.restart_request)
        with a.lock:
            self.assertEqual(a._accept_restart(RID, self.now), {'ok': True, 'state': 'restart_requested'})
        self.assertFalse(a.restart_request)

    def test_journal_full_and_write_failure_refuse_without_queueing(self):
        self.a.restart_ids = [f'{i:064x}' for i in range(128)]
        self.assertEqual(self.request()[0], 409)
        self.a.restart_ids = []
        with mock.patch.object(self.a, '_save_restart_requests', side_effect=OSError('full')):
            self.assertEqual(self.request()[0], 409)
        self.assertFalse(self.a.restart_request)

    def test_corrupt_journal_fails_closed_and_other_epoch_is_ignored(self):
        with open(self.a._restart_path(), 'w') as f:
            json.dump({'leaseEpoch': 2, 'ids': ['bad']}, f)
        with self.assertRaises(ValueError):
            agent.Agent(self.cfg, LEASE)
        with open(self.a._restart_path(), 'w') as f:
            json.dump({'leaseEpoch': 1, 'ids': [RID], 'pending': True}, f)
        self.assertFalse(agent.Agent(self.cfg, LEASE).restart_request)

    def test_new_ids_coalesce_while_restart_is_pending_or_in_progress(self):
        self.request()
        self.assertEqual(self.seq.send('restart-desktop', requestId='b' * 64)['state'], 'restart_requested')
        with mock.patch.object(self.a, 'restart_desktop') as restart:
            def during_restart():
                self.assertTrue(self.a.restart_in_progress)
                self.assertEqual(self.seq.send('restart-desktop', requestId='c' * 64)['state'], 'restart_requested')
            restart.side_effect = during_restart
            self.a.tick()
            restart.assert_called_once()
        self.assertFalse(self.a.restart_request)

    def test_recovered_pending_restart_cannot_override_committed_shutdown(self):
        self.request()
        self.a._set_marker(desktop.STOPPING)
        with mock.patch.object(self.a, 'restart_desktop') as restart:
            self.a.tick()
            restart.assert_not_called()
