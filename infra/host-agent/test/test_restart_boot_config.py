"""Restart bootstrap regression: real host config expiry and OCI spec, no runc/network.

Worker restart must push fresh config before queuing the unit. Relay renewal in
Neko does not replace this file. The broken path below is intentionally retained
as evidence; the Worker regression asserts that restart now performs the push.
"""
import unittest

from test_ice import scratch, relay_config, spec_env, NEKO
from ezil_host import cli, desktop


class RestartBootConfig(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.cfg.update(iceMode='relay')
        self.now = 1_800_000_000.0
        self.lease = {'generation': 1, 'leaseEpoch': 2}

    def start(self):
        def sleep(seconds):
            self.now += seconds

        return cli.desktop_relay(self.cfg, self.lease, wait=lambda cfg, timeout:
            desktop.wait_desktop_config(cfg, timeout, clock=lambda: self.now, sleep=sleep))

    def test_expired_boot_config_reproduces_90_second_wait_and_unreadable_login(self):
        desktop.write_desktop_config(self.cfg, relay_config(int(self.now * 1000) - 1_200_000))
        before = self.now
        self.assertIn('missing', self.start())
        self.assertEqual(self.now - before, 90)
        env, _ = spec_env(self.cfg)
        self.assertNotEqual(env['NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD'], NEKO['admin'])
        self.assertNotIn('EZIL_RELAY_EXPIRES_AT', env)

    def test_pre_restart_push_rebuilds_oci_spec_with_same_logins_and_chat_without_wait(self):
        old = relay_config(int(self.now * 1000) - 1_200_000)
        desktop.write_desktop_config(self.cfg, old)
        fresh = relay_config(int(self.now * 1000), ai={
            'baseUrl': 'https://aws-8443-guac-test-computer-aws.preview.example/ai/v1',
            'proxyToken': 'c' * 64,
        })
        # Same validated GW-5 storage path used by Agent._accept_relay.
        desktop.write_desktop_config(self.cfg, desktop.validate_desktop_config(fresh, int(self.now * 1000)))
        before = self.now
        self.assertEqual(self.start(), 'applied')
        self.assertEqual(self.now, before)
        env, _ = spec_env(self.cfg)
        self.assertEqual(env['NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD'], NEKO['admin'])
        self.assertEqual(env['NEKO_PASSWORD_ADMIN'], NEKO['admin'])
        self.assertEqual(env['EZIL_RELAY_EXPIRES_AT'], str(fresh['expiresAt']))
        self.assertEqual(env['EZIL_AI_PROXY_TOKEN'], fresh['ai']['proxyToken'])
        self.assertEqual(env['EZIL_AI_BASE_URL'], fresh['ai']['baseUrl'])


if __name__ == '__main__':
    unittest.main()
