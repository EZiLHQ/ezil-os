#!/usr/bin/env python3
"""Focused offline E1/strict-receipt/collector adversarial tests."""
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import registry_gc as gc
import registry_gc_provenance as p
import registry_gc_evidence as collector

class FinalTests(unittest.TestCase):
    def test_fixed_extraction_raw_wrapped_duplicates_and_selectors(self):
        event={'eventName':'RunInstances','eventID':'event-one'}
        contents={
            'cloudtrail/raw.json':json.dumps(event),
            'cloudtrail/wrapped.json':json.dumps({'event':event,'resourceId':'i-test','query':'lookup'}),
            'cloudtrail/lookup.json':json.dumps({'Events':[{'CloudTrailEvent':json.dumps(event)}]}),
            'cloudtrail/records.json':json.dumps({'Records':[event,event]}),
            'exec1/one.describe.json':json.dumps({'executionArn':'arn:one','status':'RUNNING'}),
            'exec2/two.describe.json':json.dumps({'executionArn':'arn:one','status':'FAILED'}),
            'exec1/one.history.json':json.dumps({'events':[{'type':'ExecutionStarted'}]}),
            'sfn-lifecycle.json':json.dumps({'executions':[{'executionArn':'arn:one','status':'RUNNING'}]})}
        proof,bindings=p.reconstruct_proof(contents)
        self.assertEqual(len(proof['cloudTrail']),5)  # no deduplication
        self.assertEqual(proof['executions'],{})  # no last-write wins
        self.assertEqual(len(proof['executionObservations']),4)
        for key,b in bindings.items():
            self.assertEqual(p.sha(p.select(json.loads(contents[b['file']]),b['selector'])),
                             p.sha(p.proof_targets(proof)[key]))
        e=self.fixture()
        key=next(iter(e['collection']['proofFileBindings']))
        e['collection']['proofFileBindings'][key]['selector']=['unrelated']
        with self.assertRaisesRegex(ValueError,'fixed extraction selector mismatch'):
            p.validate(e,'123',datetime(2026,10,24,19,1,tzinfo=timezone.utc))

    def test_saved_aws_list_describe_shapes(self):
        pairs=json.loads((Path(__file__).parent/'saved-list-describe-shapes.json').read_text())
        self.assertEqual(len(pairs),2)
        for pair in pairs:
            self.assertNotIn('redriveStatus',pair['list'])
            self.assertEqual(pair['describe']['redriveStatus'],'NOT_REDRIVABLE')
            self.assertEqual(collector.compare_execution_observations(pair['list'],pair['describe']),[])
            bad=copy.deepcopy(pair['describe']);bad['status']='RUNNING'
            self.assertTrue(collector.compare_execution_observations(pair['list'],bad))
            bad=copy.deepcopy(pair['describe']);bad['redriveStatus']=True
            self.assertTrue(collector.compare_execution_observations(pair['list'],bad))

    def seal(self,e):
        from e1_test_files import contents
        rawfiles=contents(e['proof']); r=e['proof']['collectionReceipts']
        r['files']={name:dict(sha256=hashlib.sha256(raw.encode()).hexdigest(),capturedAt=e['capturedAt'],
                            complete=True,query='TEST ONLY') for name,raw in rawfiles.items()}
        for source in r['sources'].values():source['files']=list(rawfiles)
        e['collection']['filesSha256']={name:r['sha256'] for name,r in r['files'].items()}
        e['collection']['receiptManifestSha256']=p.sha(r)
        p.bind_proof_files(e,rawfiles)

    def fixture(self):
        raw = json.dumps({'databaseSystemIdentifier':'123'})
        e = dict(accountId='123456789012',region='ap-south-1',namespace='mum',planSha256=hashlib.sha256(raw.encode()).hexdigest(),capturedAt='2026-10-24T19:00:00Z')
        e['proof'] = dict(originalPlanJson=raw,fenceActivatedAt='2026-10-24T18:59:00Z')
        e['sources'] = {n:dict(rows=[],rowsSha256=p.sha([]),query='complete '+n) for n in gc.SOURCES}
        r = {k:e[k] for k in ('accountId','region','namespace','planSha256')}
        r.update(schemaVersion=1,databaseSystemIdentifier='123',fenceActivatedAt=e['proof']['fenceActivatedAt'],
                 files={'ec2.json':dict(sha256='a'*64,capturedAt=e['capturedAt'],complete=True,query='describe all pages')},
                 sources={n:dict(files=['db-evidence.json'],rowsSha256=p.sha([]),query=s['query']) for n,s in e['sources'].items()})
        e['proof']['collectionReceipts']=r
        e['collection']=dict(filesSha256={'ec2.json':'a'*64},receiptManifestSha256=p.sha(r))
        self.seal(e)
        return e

    def test_receipt_valid_historical_events_and_adversarial(self):
        e=self.fixture(); now=datetime(2026,10,24,19,1,tzinfo=timezone.utc)
        # Historical events are covered in the collector fixture; no unbound injection.
        p.validate(e,'123',now)
        mutations=[lambda e:e['proof'].pop('collectionReceipts'),
          lambda e:e['proof']['collectionReceipts']['files']['db-evidence.json'].update(capturedAt='2026-10-24T18:00:00Z'),
          lambda e:e['proof']['collectionReceipts']['files']['db-evidence.json'].update(capturedAt='2026-10-24T20:00:00Z'),
          lambda e:e['proof']['collectionReceipts'].update(accountId='foreign'),
          lambda e:e['proof']['collectionReceipts'].update(databaseSystemIdentifier='other'),
          lambda e:e['proof']['collectionReceipts'].update(fenceActivatedAt='2026-10-24T18:58:00Z'),
          lambda e:e['proof']['collectionReceipts']['files']['db-evidence.json'].update(complete=1),
          lambda e:e['collection']['filesSha256'].update({'db-evidence.json':'b'*64}),
          lambda e:e['sources']['instances']['rows'].append({'InstanceId':'i-unknown'}),
          lambda e:e['proof']['collectionReceipts']['sources'].pop('executions')]
        for mutate in mutations:
            bad=copy.deepcopy(e);mutate(bad)
            if 'collectionReceipts' in bad['proof']:bad['collection']['receiptManifestSha256']=p.sha(bad['proof']['collectionReceipts'])
            with self.assertRaises(ValueError):p.validate(bad,'123',now)

    def test_substituted_supplemental_proof_with_unchanged_receipts(self):
        for key,value in [('cloudTrail',[{'eventName':'RunInstances','eventID':'original'}]),('ec2Definitions',{'ec2-images.json':{'Images':[]}}),
                          ('executions',{'arn:test':{'history':{'events':[]}}})]:
            e=self.fixture(); e['proof'][key]=value
            # Bind the legitimate body first, then replace it without changing
            # original bytes, E1 receipts, or manifest hash.
            self.seal(e)
            if key=='cloudTrail': e['proof'][key][0]['eventID']='substituted'
            elif key=='ec2Definitions': e['proof'][key]['ec2-images.json']['Images']=[{'ImageId':'forged'}]
            else: e['proof'][key]['arn:test']['history']['events']=[{'type':'forged'}]
            before=copy.deepcopy(e['proof']['collectionReceipts'])
            with self.assertRaisesRegex(ValueError,'complete supplemental proof mismatch'):
                p.validate(e,'123',datetime(2026,10,24,19,1,tzinfo=timezone.utc))
            self.assertEqual(before,e['proof']['collectionReceipts'])

    def test_strict_runtime_receipt_missing_both_and_bool(self):
        doc=json.loads((Path(__file__).parent/'runtime-retirement-intent.json').read_text())
        raw=json.dumps(doc,separators=(',',':'))
        out=dict(schemaVersion=1,generation=doc['targetGeneration'],leaseEpoch=doc['leaseEpoch'],
                 poolGeneration=doc['poolGeneration'],jobId=doc['jobId'],computerId=doc['computerId'],
                 fenceToken=doc['fenceToken'],poolHostId=doc['poolHostId'],instanceId=doc['providerInstanceId'],
                 digest=hashlib.sha256(raw.encode()).hexdigest(),state='retired',volumeId=None)
        p.strict_retirement(doc,out)
        for left,right in [('computerId','computerId'),('targetGeneration','generation'),('leaseEpoch','leaseEpoch'),('fenceToken','fenceToken')]:
            d,o=copy.deepcopy(doc),copy.deepcopy(out);d.pop(left);o.pop(right)
            # Recomputed enclosing proof hashes cannot make missing fields valid.
            p.sha({'document':d,'receipt':o})
            with self.assertRaises(ValueError):p.strict_retirement(d,o)
        for left,right in [('targetGeneration','generation'),('leaseEpoch','leaseEpoch'),('poolGeneration','poolGeneration')]:
            d,o=copy.deepcopy(doc),copy.deepcopy(out);d[left]=o[right]=True
            p.sha({'document':d,'receipt':o})
            with self.assertRaises(ValueError):p.strict_retirement(d,o)
        out.pop('volumeId')
        with self.assertRaises(ValueError):p.strict_retirement(doc,out)

    def test_duplicate_describe_collector_before_assignment(self):
        # Execute actual collector over files; stop at provenance stage to inspect
        # all observations before attestation generation, without trusting stamps.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            def write(name,data):
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(data))
            record={'recipeVersion':'1.0.7','amiId':'ami-test'}
            write('registry-snapshot.json',[record])
            write('db-evidence.json',dict(meta={'captured_at':'2026-10-24T19:00:00Z','system_identifier':'123'},usage=[],placements=[],image_jobs=[],pool_hosts=[],writer_leases=[],migrations=[]))
            for n,k in [('instances','Reservations'),('volumes','Volumes'),('snapshots','Snapshots')]:write('ec2-'+n+'.json',{k:[]})
            d=dict(executionArn='arn:test',stateMachineArn='arn:machine',stateMachineVersionArn='arn:machine:1',name='test',status='RUNNING',startDate='2026-10-24T18:00:00Z',redriveCount=0)
            write('exec1/a.describe.json',d)
            write('exec2/z.describe.json',dict(d,status='FAILED',stopDate='2026-10-24T18:01:00Z'))
            write('sfn-lifecycle.json',{'executions':[dict(d,status='FAILED',stopDate='2026-10-24T18:01:00Z')]})
            write('E1/collection-receipts.json',{'files':{},'databaseSystemIdentifier':'123'})
            class Stop(Exception):pass
            def inspect(e,*args):
                gaps=e['sources']['executions']['uncertain']
                self.assertTrue(any('duplicate/ambiguous describe' in g for g in gaps))
                self.assertTrue(any('nonterminal describe' in g for g in gaps))
                self.assertNotIn('arn:test',e['proof']['executions'])
                raise Stop()
            with patch.object(p,'validate',side_effect=inspect),self.assertRaises(Stop):collector.collect(root,'1.0.7')
            write('E1/collection-receipts.json',{'files':{'ec2-instances.json':{'sha256':'0'*64}},'databaseSystemIdentifier':'123'})
            with self.assertRaisesRegex(ValueError,'actual file hash mismatch'):collector.collect(root,'1.0.7')
            changed=json.dumps({'Reservations':[], 'changed':True}).encode()
            write('E1/collection-receipts.json',{'files':{'ec2-instances.json':{'sha256':hashlib.sha256(changed).hexdigest()}},'databaseSystemIdentifier':'123'})
            original_read=Path.read_bytes; count=[0]
            def racing_read(path):
                if path == root/'ec2-instances.json':
                    count[0]+=1
                    if count[0]>1:return changed
                return original_read(path)
            with patch.object(Path,'read_bytes',racing_read),self.assertRaisesRegex(ValueError,'consumed file changed'):
                collector.collect(root,'1.0.7')


if __name__=='__main__':unittest.main()
