#!/usr/bin/env python3
"""Real production shell/client/registry paths with offline collaborators only."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rebase import TOOL, release_record, HERE
import namespaces
import rebase_computer as client
import rebase_namespace as context
import rebase_manifest as manifest


class ShellPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)/'case'

    def fixture(self, **scenario):
        subprocess.run([sys.executable, str(HERE/'fixture.py'), str(self.root),
                        json.dumps(dict(namespace='prd', prd_pins=True, **scenario))], check=True)
        self.env = dict(os.environ, PATH=str(self.root/'bin')+':'+os.environ['PATH'],
                        AWS_CONFIG_FILE='/dev/null', AWS_SHARED_CREDENTIALS_FILE='/dev/null', AWS_EC2_METADATA_DISABLED='true')

    def run_script(self, script, *args):
        result = subprocess.run(['bash',str(self.root/'checkout/deploy/aws/mum'/script),'--namespace','prd',
            '--release-dir',str(self.root/'release'),*args], env=self.env, capture_output=True, text=True)
        # Assertion failures print only the local fake command output.
        return result

    def test_bake_pins_both_lowers_and_source_without_target_authority(self):
        self.fixture()
        source = json.loads(namespaces.to_prd(json.dumps(release_record())))
        source.update(amiId='ami-'+'1'*17, launchTemplateVersion='1', stateMachineVersionArn=source['stateMachineVersionArn'].rsplit(':',1)[0]+':4',
                      lowerImageDigest='sha256:'+'a'*64, lowerImageRef=source['lowerImageRef'].split('@')[0]+'@sha256:'+'e'*64,
                      previousLowerImageDigest=None,previousLowerImageRef=None,preparationStateMachineVersionArn=None,recoveryStateMachineVersionArn=None)
        (self.root/'source.json').write_text(json.dumps(source))
        d = {k:v for k,v in source.items() if k not in manifest.TUPLE}; d['releases'] = [source]
        (self.root/'secret.json').write_text(json.dumps({'VersionId':'initial','SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:d}})}))
        result = self.run_script('rebuild-ami.sh','--desktop-image','desktop:test','--source-sha','aaaaaaaa','--recipe-version','1.0.6',
            '--config',str(self.root/'ami-config.json'),'--previous-desktop-image-ref',source['lowerImageRef'],
            '--previous-desktop-image-id',source['lowerImageDigest'],'--previous-release',str(self.root/'source.json'),
            '--deployed-release',str(self.root/'source.json'),'--apply')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        bake = manifest.read(self.root/'release/bake-inputs.json')
        self.assertEqual((bake['namespace'],bake['previousLowerImageDigest'],bake['previousLowerImageRef']),
                         ('prd',source['lowerImageDigest'],source['lowerImageRef']))
        self.assertEqual(bake['lowerImageDigest'],'sha256:'+'b'*64)
        self.assertFalse((self.root/'release/rebase-release.json').exists())
        calls = (self.root/'calls.jsonl').read_text()
        self.assertNotIn('ezil-mum-', calls); self.assertNotIn('ezil-os/billing-staging/app',calls)

    def test_plain_recovery_promote_and_rollback_readback_both_versions(self):
        self.fixture(recovery=True)
        result = self.run_script('promote-ami.sh','--ami','ami-'+'2'*17,'--config',str(self.root/'config.json'),'--apply')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        config = manifest.read(self.root/'config.json')
        self.assertTrue(config['recoveryVersionArn'].endswith('-recovery:2'))
        self.assertTrue(config['settings']['deployment']['stateMachineVersionArn'].endswith('-lifecycle:11'))
        result = self.run_script('promote-ami.sh','--rollback','--config',str(self.root/'config.json'),'--apply')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(manifest.read(self.root/'config.json'),manifest.read(self.root/'original-config.json'))

    def test_recovery_output_drift_leaves_secret_unchanged(self):
        self.fixture(recovery=True, wrong_recovery_output=True)
        original = (self.root/'secret.json').read_bytes()
        result = self.run_script('promote-ami.sh','--ami','ami-'+'2'*17,'--config',str(self.root/'config.json'),'--apply')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual((self.root/'secret.json').read_bytes(),original)
        self.assertIn('recovery stack output mismatch',result.stderr)

    def test_recovery_publication_race_refuses_before_lifecycle_execute(self):
        self.fixture(recovery=True, recovery_version_race=True)
        original = (self.root/'secret.json').read_bytes()
        result = self.run_script('promote-ami.sh','--ami','ami-'+'2'*17,'--config',str(self.root/'config.json'),'--apply')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual((self.root/'secret.json').read_bytes(),original)
        self.assertFalse((self.root/'executed').exists())


class ClientPaths(unittest.TestCase):
    def setUp(self):
        client.use_namespace('prd'); self.addCleanup(client.use_namespace,'mum')

    def test_existing_job_and_source_execution_are_pinned_on_launch_and_recovery(self):
        computer='11111111-1111-4111-8111-111111111111'; job='22222222-2222-4222-8222-222222222222'
        execution=client.json_tool.MACHINE.replace(':stateMachine:',':execution:')+':computer-'+computer
        calls=[]
        def sender(sent, secret):
            calls.append(copy.deepcopy(sent))
            return 200, client.response(dict(schemaVersion=1,computerId=computer,jobId=job,phase='snapshot_ready',eligible=True,failureCode=None),sent)
        with tempfile.TemporaryDirectory() as folder:
            journal=Path(folder)/'job.json'
            client.operate('prepare',computer,None,journal,True,'0'*64,sender,execution)
            client.operate('launch',computer,None,journal,True,'0'*64,sender)
            client.operate('recover',computer,job,journal,True,'0'*64,sender)
            self.assertEqual([v['jobId'] for v in calls],[None,job,job])
            self.assertEqual(calls[0]['sourceRetirementExecutionArn'],execution)
            client.use_namespace('mum')
            with self.assertRaisesRegex(ValueError,'journal namespace'): client.operate('launch',computer,job,journal,True,'0'*64,sender)
        client.use_namespace('prd')
        with self.assertRaises(ValueError): client.request('prepare',computer,None,execution.replace('prd','mum'))
        with self.assertRaises(ValueError): client.request('recover',computer,None)

    def test_foreign_paths_db_accounts_and_review_roles_are_refused(self):
        for path in ('/root/ezil-aws-mum/releases/test','/root/ezil-aws-mum/config/lifecycle.mum.json'):
            with self.assertRaises(ValueError): context.path(path)
        with self.assertRaises(ValueError): context.system_id('1234567890123456789')
        for role in ('arn:aws:iam::452630323510:role/ezil/mum/ezil-mum-recovery',
                     'arn:aws:iam::123456789012:role/ezil/prd/ezil-prd-recovery'):
            with self.assertRaises(ValueError): context.identities({'Role':role})


# Load the existing GC fixture under its own name (the production module has
# the same basename). Its synthetic collection receipts are test-only.
spec = importlib.util.spec_from_file_location('gc_fixture', HERE/'registry_gc.py')
gc_fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(gc_fixture)
gc = gc_fixture.gc


class RegistryPaths(unittest.TestCase):
    envelope = gc_fixture.RegistryGcTests.envelope
    transport = gc_fixture.RegistryGcTests.transport
    app_operation = gc_fixture.RegistryGcTests.app_operation
    context = gc_fixture.RegistryGcTests.context
    commit = gc_fixture.RegistryGcTests.commit

    def setUp(self):
        gc.release.use_namespace('mum'); TOOL.use_namespace('mum')
        gc_fixture.RegistryGcTests.setUp(self)
        self.addCleanup(self.tmp.cleanup)
        gc.release.use_namespace('prd'); self.addCleanup(gc.release.use_namespace, 'mum')
        # Retain the collection provenance, changing only the synthetic namespace.
        def convert(v):
            return json.loads(namespaces.to_prd(json.dumps(v)).replace(gc_fixture.SYSTEM_ID, context.PRODUCTION_SYSTEM_ID))
        for name in ('records','target','snapshot','roles','evidence','plan'):
            setattr(self,name,convert(getattr(self,name)))
        self.path.write_text(json.dumps(self.plan)); self.plan_sha = gc.release.digest(self.path)
        self.evidence.update(planSha256=self.plan_sha,registrySha256=gc.sha(self.records))
        self.sync()
        self.live = self.envelope()
        self.running = gc.release.rebase_app.public_deployment(self.snapshot['deployment'])
        initial = gc.release.ledger_entry(self.path,'apply-app',self.live,self.snapshot['deployment'],self.running_sha,1)
        gc.tool.write(self.ledger,{'schemaVersion':1,'entries':[initial]})

    def sync(self):
        from unittest.mock import patch
        with patch.object(gc_fixture,'SYSTEM_ID',context.PRODUCTION_SYSTEM_ID):
            gc_fixture.synthetic_e1(self.evidence,self.path.read_text())

    def prepare(self):
        return gc.prepare(self.snapshot,self.target,self.roles,self.evidence,self.drops,self.plan_sha,self.now,context.PRODUCTION_SYSTEM_ID)

    def test_prd_gc_cas_preserves_tuple_and_retained_records(self):
        gc.backup_registry(self.directory,self.snapshot)
        self.commit()
        _, d = gc.release.secret_deployment(self.live)
        self.assertEqual(gc.release.ledger_tuple(d),gc.release.ledger_tuple(self.snapshot['deployment']))
        self.assertEqual(d['releases'],self.records[:1]+self.records[2:])
        self.assertEqual(gc.release.load_ledger(self.ledger)['entries'][-1]['operation'],'registry-gc')

    def test_volume_snapshot_job_references_keep_source_and_identity(self):
        before = copy.deepcopy(self.snapshot)
        for name, row in (
            ('volumes',{'VolumeId':'vol-'+'1'*17,'source_release':self.records[1]}),
            ('snapshots',{'SnapshotId':'snap-'+'2'*17,'VolumeId':'vol-'+'1'*17,'source_release':self.records[1]}),
            ('imageJobs',{'id':'11111111-1111-4111-8111-111111111111','phase':'failed','source_release':self.records[1]})):
            source = self.evidence['sources'][name]
            source.update(rows=[row],rowsSha256=gc.sha([row])); self.sync()
            with self.assertRaises(ValueError): self.prepare()
            self.assertEqual(self.snapshot,before)
            source.update(rows=[],rowsSha256=gc.sha([]))

    def test_prd_gc_stale_and_foreign_evidence_refused(self):
        original = copy.deepcopy(self.evidence)
        for field, value in (('secretVersionId','stale'),('namespace','mum'),('accountId','123456789012')):
            self.evidence = copy.deepcopy(original); self.evidence[field] = value
            with self.assertRaises(ValueError): self.prepare()


if __name__ == '__main__': unittest.main(verbosity=2)
