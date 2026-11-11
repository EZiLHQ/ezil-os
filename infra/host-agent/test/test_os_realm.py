"""Closed OS realm config/status/provisioning. Offline, synthetic host state only."""
import json, os, time, unittest
from unittest import mock
from test_ice import scratch, relay_config, spec_env
from ezil_host import desktop, agent, edge
CID='11111111-1111-4111-8111-111111111111'
LEASE={'computerId':CID,'generation':1,'leaseEpoch':2}
AI={'baseUrl':'https://aws-8443-guac-abcdef0123456789-fedcba9876543210-aws.ezil.work/ai/v1','proxyToken':'ab'*32}
class Realm(unittest.TestCase):
    def setUp(self): self.d,self.cfg=scratch(self)
    def test_closed_enum_optional_editor_and_unknown_keys(self):
        now=int(time.time()*1000)
        for realm in ('staging','production'):
            for extra in ({},{'editorToken':'cd'*32}):
                c=desktop.validate_desktop_config(relay_config(now,ai={**AI,**extra,'osRealm':realm}),now)
                self.assertEqual(c['ai']['osRealm'],realm)
        for realm in (None,True,1,'','STAGING','ezil.work','https://os.ezil.work',{},[]):
            with self.assertRaisesRegex(ValueError,'^ice_config_invalid$'):
                desktop.validate_desktop_config(relay_config(now,ai={**AI,'osRealm':realm}),now)
        with self.assertRaises(ValueError):desktop.validate_desktop_config(relay_config(now,ai={**AI,'osRealm':'staging','origin':'https://evil.test'}),now)
    def test_real_spec_maps_and_clears_image_default_without_changing_ai_or_parent(self):
        with open(self.cfg.imageConfigFile,'w') as f:json.dump({'Env':['EZIL_OS_ORIGIN=https://evil.test','EZIL_AI_BASE_URL=https://evil.test','UNRELATED=keep']},f)
        for realm,expected in [('staging','https://os-staging.ezil.work'),('production','https://os.ezil.work'),(None,'')]:
            ai={**AI,**({'osRealm':realm} if realm else {})}
            desktop.build_spec(self.cfg,LEASE,desktop_config=relay_config(ai=ai))
            env,keys=spec_env(self.cfg)
            self.assertEqual(env['EZIL_OS_ORIGIN'],expected);self.assertEqual(keys.count('EZIL_OS_ORIGIN'),1)
            self.assertEqual(env['EZIL_AI_BASE_URL'],AI['baseUrl']);self.assertEqual(env['UNRELATED'],'keep')
            self.assertEqual(desktop.applied_os_realm(self.cfg),realm)
        desktop.build_spec(self.cfg,LEASE)
        self.assertEqual(spec_env(self.cfg)[0]['EZIL_OS_ORIGIN'],'')
    def test_status_bound_to_real_lease_boot_and_edge_closed_projection(self):
        a=agent.Agent(self.cfg,LEASE,log=lambda _:None)
        with mock.patch.object(a,'_desktop_state',return_value='running'),mock.patch.object(a,'_desktop_unit',return_value='active'):
            status=a._desktop_status(123456.0)
        self.assertIs(status['osRealmConfigV1'],True)
        self.assertEqual(status['osRealmEpoch'],{**LEASE,'bootId':status['bootId'],'observedAtMs':123456000})
        e=object.__new__(edge.Edge);e.seq=mock.Mock();e.seq.send.return_value={**status,'config':{'ai':AI},'evil':True}
        with mock.patch.object(edge,'_reply') as reply:e._agent(None,'desktop_status')
        result=reply.call_args.args[2]
        self.assertEqual(result['osRealmEpoch'],status['osRealmEpoch']);self.assertNotIn('evil',result);self.assertNotIn('config',result)
        self.assertNotIn(AI['proxyToken'],json.dumps(result))
    def test_realm_is_covered_by_existing_signed_body_digest(self):
        e=object.__new__(edge.Edge);e._agent=mock.Mock()
        body=json.dumps(relay_config(ai={**AI,'osRealm':'staging'})).encode()
        head=edge._Head('POST','/unused','HTTP/1.1',[('content-length',str(len(body)))],body)
        with mock.patch.object(edge,'_reply') as reply:e._ice(None,head,'0'*64,'')
        self.assertEqual(reply.call_args.args[2]['error'],'ice_digest_mismatch');e._agent.assert_not_called()
        e._ice(None,head,__import__('hashlib').sha256(body).hexdigest(),'')
        self.assertEqual(e._agent.call_args.kwargs['config']['ai']['osRealm'],'staging')
    def test_running_realm_change_restart_bound_and_same_realm_no_restart(self):
        desktop.build_spec(self.cfg,LEASE,desktop_config=relay_config(ai={**AI,'osRealm':'staging'}))
        a=agent.Agent(self.cfg,LEASE,log=lambda _:None)
        with mock.patch.object(a,'_desktop_state',return_value='running'),mock.patch.object(desktop,'read_ice_state',return_value='applied'):
            self.assertEqual(a._accept_relay(relay_config(ai={**AI,'osRealm':'staging'}))['state'],'already_running')
            with mock.patch.object(a,'_restarts_exhausted',return_value=True):
                self.assertEqual(a._accept_relay(relay_config(ai={**AI,'osRealm':'production'}))['error'],'desktop_restart_exhausted')
            self.assertEqual(a._accept_relay(relay_config(ai=AI))['state'],'restart_scheduled')
if __name__=='__main__':unittest.main()
