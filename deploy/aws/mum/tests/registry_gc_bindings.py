#!/usr/bin/env python3
"""Synthetic offline bindings regressions; no external evidence or transports."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import registry_gc as gc
import registry_gc_bindings as b
sys.path.insert(0, str(HERE))
from rebase import release_record


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.keep = release_record()
        self.candidate = copy.deepcopy(self.keep)
        self.candidate.update(amiId='ami-' + '7' * 17, recipeVersion='1.0.7', launchTemplateVersion='107')
        for k in ('stateMachineVersionArn', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'):
            self.candidate[k] = self.candidate[k].rsplit(':', 1)[0] + ':107'
        self.e = {k: self.keep[k] for k in ('accountId', 'region', 'namespace')}
        self.e.update(proof={'cloudTrail': []}, sources={k: {'rows': []} for k in gc.SOURCES})
        self.row = {'provider': 'aws-ec2', 'region': self.keep['region'], 'instance_id': 'i-' + '1' * 17,
                    'lower_image_digest': self.keep['lowerImageDigest']}
        self.e['sources']['instances']['rows'] = [{'InstanceId': self.row['instance_id'], 'ImageId': self.keep['amiId']}]
        self.e['sources']['placements']['rows'] = [self.row]
        self.bind('placement_image', 'placements', self.row)

    def bind(self, kind, source, row):
        self.e['referenceBindings'] = [{'kind': kind, 'source': source, 'rowSha256': b.sha(row), 'proofSha256': b.sha(self.e['proof'])}]

    def run_analysis(self, target=None):
        return b.analyze(self.e, [self.keep, self.candidate], self.candidate, gc.references, target)

    def test_exact_inventory_and_original_unchanged(self):
        before = copy.deepcopy(self.e)
        self.assertTrue(self.run_analysis())
        self.assertEqual(before, self.e)

    def test_cross_instance_unknown_and_candidate(self):
        for image in ('ami-unknown', self.candidate['amiId']):
            with self.subTest(image=image):
                self.e['sources']['instances']['rows'][0]['ImageId'] = image
                with self.assertRaises(ValueError): self.run_analysis()
        self.e['sources']['instances']['rows'][0]['InstanceId'] = 'i-other'
        with self.assertRaises(ValueError): self.run_analysis()

    def test_hash_duplicate_spare_and_unknown_field(self):
        original = copy.deepcopy(self.e)
        for mutate in (lambda: self.e['referenceBindings'].append(copy.deepcopy(self.e['referenceBindings'][0])),
                       lambda: self.e['referenceBindings'][0].update(rowSha256='0'*64),
                       lambda: self.e['proof'].update(forged=True),
                       lambda: self.e['sources']['placements']['rows'].append(copy.deepcopy(self.row))):
            self.e = copy.deepcopy(original); mutate()
            with self.assertRaises(ValueError): self.run_analysis()
        self.e = copy.deepcopy(original)
        row = self.e['sources']['placements']['rows'][0]
        row['unknownRecovery'] = self.candidate['amiId']
        self.bind('placement_image', 'placements', row)
        with self.assertRaises(ValueError): self.run_analysis()
        row['unknownRecovery'] = self.candidate['lowerImageDigest']
        self.bind('placement_image', 'placements', row)
        with self.assertRaises(ValueError): self.run_analysis()

    def event(self):
        return {'eventName': 'RunInstances', 'eventSource': 'ec2.amazonaws.com',
                'awsRegion': self.e['region'], 'recipientAccountId': self.e['accountId'],
                'responseElements': {'instancesSet': {'items': [{'instanceId': self.row['instance_id'], 'imageId': self.keep['amiId']}]}}}

    def test_cloudtrail_scope_success_and_conflict(self):
        self.e['sources']['instances']['rows'] = []
        event = self.event(); self.e['proof']['cloudTrail'] = [{'event': event}]
        self.bind('placement_image', 'placements', self.row)
        self.assertTrue(self.run_analysis())
        for key, value in (('awsRegion','other'), ('recipientAccountId','other'), ('errorCode','failure'), ('responseElements',{})):
            original = copy.deepcopy(event); event[key] = value
            self.bind('placement_image', 'placements', self.row)
            with self.assertRaises(ValueError): self.run_analysis()
            event.clear(); event.update(original)
        self.e['sources']['instances']['rows'] = [{'InstanceId': self.row['instance_id'], 'ImageId': self.candidate['amiId']}]
        self.bind('placement_image', 'placements', self.row)
        with self.assertRaises(ValueError): self.run_analysis()

    def test_plan_original_hash_and_target(self):
        plan = {'amiId': self.keep['amiId'], 'bake': {'lowerImageDigest': self.keep['lowerImageDigest'], 'lowerImageRef': self.keep['lowerImageRef']}}
        raw = json.dumps(plan, indent=2)
        self.e['proof']['originalPlanJson'] = raw
        self.e['planSha256'] = b.hashlib.sha256(raw.encode()).hexdigest()
        self.e['sources']['releasePlans']['rows'] = [plan]
        self.bind('original_plan_target', 'releasePlans', plan)
        self.assertTrue(self.run_analysis(self.keep))
        with self.assertRaises(ValueError): self.run_analysis(self.candidate)
        self.e['planSha256'] = '0'*64
        with self.assertRaises(ValueError): self.run_analysis(self.keep)

    def test_job_exact_source_consumer_and_unknown_fields(self):
        row = {'source_release': self.keep, 'target_release': self.keep,
               'from_digest': self.keep['lowerImageDigest'], 'to_digest': self.keep['lowerImageDigest']}
        pairs = {'jobId': 'job_id', 'computerId': 'computer_id', 'sourceInstanceId': 'source_instance_id',
                 'sourceVolumeId': 'source_volume_id', 'fsUuid': 'fs_uuid',
                 'sourceGeneration': 'source_generation', 'sourceLeaseEpoch': 'source_lease_epoch',
                 'sourceFenceToken': 'source_fence_token', 'fromDigest': 'from_digest', 'toDigest': 'to_digest'}
        for k in pairs.values(): row.setdefault(k, 'fixture-' + k)
        prep = {k: row[v] for k, v in pairs.items()}
        # Deployment objects do not include manifest-only lowerImageRef.
        deployment = {k:v for k,v in self.keep.items() if k != 'lowerImageRef'}
        prep.update(sourceDeployment=deployment, deployment=deployment)
        row['preparation_document'] = json.dumps(prep)
        row['preparation_digest'] = b.hashlib.sha256(row['preparation_document'].encode()).hexdigest()
        self.e['sources']['imageJobs']['rows'] = [row]
        self.bind('image_job_releases','imageJobs',row)
        self.assertTrue(self.run_analysis())
        before = copy.deepcopy(row)
        for key,value in (('to_digest','sha256:'+'0'*64), ('preparation_digest','0'*64),
                          ('unknown', self.candidate['lowerImageDigest']), ('target_release',self.candidate)):
            row.clear(); row.update(copy.deepcopy(before)); row[key] = value
            self.bind('image_job_releases','imageJobs',row)
            with self.assertRaises(ValueError): self.run_analysis()

    def coverage(self):
        self.e['proof']['snapshotChildCoverage'] = {
            'complete':True, 'uncertain':[], 'definitionsSha256':b.sha(self.e['proof']['ec2Definitions']),
            'executionsSha256':b.sha(self.e['proof'].get('executions', {})),
            'scope':'all-account-region-images-templates-and-all-version-history'}

    def test_historical_snapshot_and_child(self):
        sid = 'snap-'+'3'*17
        tags = [{'Key':'CreatedBy','Value':'EC2 Image Builder'}, {'Key':'Ec2ImageBuilderArn','Value':f"arn:aws:imagebuilder:{self.e['region']}:{self.e['accountId']}:image/ezil-host-mum/1.0.7/1"}]
        row = {'SnapshotId':sid, 'State':'completed','OwnerId':self.e['accountId'], 'Tags':tags,
               'Description':f"Created by CreateImage(i-{'4'*17}) for {self.candidate['amiId']}"}
        image = {'ImageId':self.candidate['amiId'], 'OwnerId':self.e['accountId'], 'Tags':copy.deepcopy(tags),
                 'RootDeviceName':'/dev/sda1', 'RootDeviceType':'ebs',
                 'BlockDeviceMappings':[{'DeviceName':'/dev/sda1','Ebs':{'SnapshotId':sid}}]}
        self.e['proof']['ec2Definitions'] = {'ec2-images.json':{'Images':[image]},
            'ec2-lt.json':{'LaunchTemplates':[]}, 'ec2-lt-versions.json':{'LaunchTemplateVersions':[]}}
        self.coverage()
        self.e['sources']['snapshots']['rows'] = [row]
        self.bind('historical_imagebuilder_root','snapshots',row)
        self.assertTrue(self.run_analysis())
        for source in ('volumes','instances','imageJobs','placements','releasePlans','executions'):
            self.e['sources'][source]['rows'].append({'child':sid})
            with self.assertRaises(ValueError): self.run_analysis()
            self.e['sources'][source]['rows'].pop()
        for mutation in ('nonroot', 'different-build', 'default-lt', 'history', 'missing-coverage'):
            saved = copy.deepcopy(self.e)
            definitions = self.e['proof']['ec2Definitions']
            parent = definitions['ec2-images.json']['Images'][0]
            if mutation == 'nonroot': parent['RootDeviceName'] = '/dev/sdz'
            if mutation == 'different-build': parent['Tags'][1]['Value'] += '2'
            if mutation == 'default-lt':
                definitions['ec2-lt-versions.json']['LaunchTemplateVersions'].append(
                    {'DefaultVersion':True, 'LaunchTemplateData':{'BlockDeviceMappings':[{'Ebs':{'SnapshotId':sid}}]}})
            if mutation == 'history': self.e['proof']['executions'] = {'history':{'SnapshotId':sid}}
            self.coverage()
            if mutation == 'missing-coverage': del self.e['proof']['snapshotChildCoverage']
            self.bind('historical_imagebuilder_root','snapshots',row)
            reason = {'nonroot':'root mapping', 'different-build':'different ImageBuilder builds',
                      'default-lt':'supplemental dependent child', 'history':'supplemental dependent child',
                      'missing-coverage':'incomplete snapshot child coverage'}[mutation]
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, reason): self.run_analysis()
            self.e = saved
        row = self.e['sources']['snapshots']['rows'][0]
        row['State'] = 'pending'; self.bind('historical_imagebuilder_root','snapshots',row)
        with self.assertRaises(ValueError): self.run_analysis()


if __name__ == '__main__': unittest.main()
