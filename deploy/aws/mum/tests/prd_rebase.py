#!/usr/bin/env python3
"""Production bootstrap through promotion using the shared offline cloud/SSM harness.

Generated app Python and Node guards execute; AWS, secrets, installs and DB are
local doubles. No real command may escape the harness.
"""
import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rollout as shared
from rollout import RELEASE, TOOL, manifest, cfn, ssm, execute_app_payload
import prd_namespace as profiles
import rebase_source as admission
import rebase_namespace as context
import rebase_computer as client


class ProductionFixture(unittest.TestCase):
    def setUp(self):
        RELEASE.use_namespace('mum'); TOOL.use_namespace('mum')
        shared.IntegrationTests.setUp(self)
        # The existing harness creates a mum example. Discard only that fixture's
        # plan/ledger; production starts with neither. No fake promotion journal.
        self.path.unlink(); self.ledger.unlink()
        old_repo, old_lt = TOOL.REPOSITORY, TOOL.LAUNCH_TEMPLATE
        RELEASE.use_namespace('prd'); TOOL.use_namespace('prd'); client.use_namespace('prd')
        RELEASE.json_tool.APP_SECRET_LOCK = str(self.root/'app-secret.lock')
        RELEASE.LEDGER_PATH = self.ledger
        self.addCleanup(self.reset_namespace)
        def convert(value):
            return json.loads(json.dumps(value).replace(old_repo, TOOL.REPOSITORY).replace(old_lt, TOOL.LAUNCH_TEMPLATE)
                              .replace('ezil-mum-', 'ezil-prd-').replace('ezil-host-mum', 'ezil-host-prd')
                              .replace('ezil-identity-mum', 'ezil-identity-prd').replace('/ezil/mum/', '/ezil/prd/')
                              .replace('"mum"', '"prd"').replace('os-staging.ezil.work', 'os-prod.ezil.work'))
        for name in ('source', 'value', 'evidence', 'specs', 'templates'):
            setattr(self, name, convert(getattr(self, name)))
        self.source.update(recipeVersion='1.0.0', preparationStateMachineVersionArn=None,
                           recoveryStateMachineVersionArn=TOOL.MACHINE.replace('-lifecycle', '-recovery') + ':1')
        self.lower_raw = json.dumps({'schemaVersion': 2, 'config': {'digest': self.source['lowerImageDigest']}, 'layers': []})
        self.source['lowerImageRef'] = TOOL.REPOSITORY + '@sha256:' + hashlib.sha256(self.lower_raw.encode()).hexdigest()
        self.value['previousLowerImageRef'] = self.source['lowerImageRef']
        self.source_config = copy.deepcopy(profiles.LIFECYCLE)
        self.source_config['settings']['deployment'].update({k: self.source[k] for k in (*manifest.PROMOTION[:3], 'launchTemplateId')})
        self.deployment = copy.deepcopy(self.source_config['settings']['deployment'])
        self.current_config = self.root / 'legacy-config.json'; TOOL.write(self.current_config, self.source_config)
        self.source_path = self.root / 'legacy-source.json'; TOOL.write(self.source_path, self.source)
        self.app = {'tag': 'current-app', 'gitSha': 'e'*40, 'checksumSha256': 'f'*64}
        self.app_path = self.root / 'current-app.json'; TOOL.write(self.app_path, self.app)
        self.source_build = self.build(self.source)
        self.evidence['build']['image'] = self.build(self.value)
        desired = copy.deepcopy(self.source_config)
        desired['settings']['deployment'].update({k: self.value[k] for k in manifest.PROMOTION})
        desired['recoveryVersionArn'] = self.value['recoveryStateMachineVersionArn']
        TOOL.write(self.config, desired)
        TOOL.write(self.identity, {**profiles.IDENTITY, 'imageJobDeployment': desired['settings']['deployment']})
        for phase, (before, after, review) in self.templates.items():
            for key, value in (('beforeTemplate', before), ('candidateTemplate', after), ('review', review)):
                TOOL.write(self.specs[phase][key+'Path'], value)
        TOOL.write(self.rollout, {'schemaVersion': 1, 'stacks': self.specs, 'app': self.app})
        for name, value in [('bake-inputs.json', {k:self.value[k] for k in RELEASE.BAKE_KEYS}),
                            ('image.json', self.evidence['image']), ('build.json', self.evidence['build']),
                            ('previous-rebase-release.json', self.source), ('deployed-release.json', self.source)]:
            TOOL.write(self.directory/name, value)
        (self.directory/'build-arn.txt').write_text(self.evidence['build']['image']['arn'])
        self.envelope = {'VersionId':'initial', 'SecretString':json.dumps({'keep':'synthetic', 'EZIL_AWS_KILL_SWITCH':'1',
            TOOL.KEY:{TOOL.REGION:copy.deepcopy(self.deployment), 'other': {'keep':True}}})}
        self.running_deployment = copy.deepcopy(self.deployment)
        self.running_sha = self.app['gitSha']
        self.original = copy.deepcopy(self.envelope)
        self.mutate = lambda args, value: value
        self.secret_hook = lambda: None
        self.lost_source_put = False

    def reset_namespace(self):
        RELEASE.use_namespace('mum'); TOOL.use_namespace('mum'); client.use_namespace('mum')

    def build(self, value):
        bindings = {'DesktopImageRef':value['lowerImageRef'], 'DesktopImageId':value['lowerImageDigest'],
                    'AgentSrcS3Uri':f"s3://{TOOL.BUCKET}/ami/host-agent-{value['agentCommit']}.tgz",
                    'EnrollUrl':TOOL.ORIGIN+'/api/compute/aws/enroll'}
        if value['previousLowerImageDigest']:
            bindings.update(PreviousDesktopImageRef=value['previousLowerImageRef'], PreviousDesktopImageId=value['previousLowerImageDigest'])
        return {'arn':f"arn:aws:imagebuilder:{TOOL.REGION}:{TOOL.ACCOUNT}:image/ezil-host-prd/{value['recipeVersion']}/1",
                'state':{'status':'AVAILABLE'}, 'outputResources':{'amis':[{'image':value['amiId'], 'region':TOOL.REGION, 'accountId':TOOL.ACCOUNT}]},
                'imageRecipe':{'name':'ezil-host-prd', 'version':value['recipeVersion'],
                               'components':[{'parameters':[{'name':k,'value':[v]} for k,v in bindings.items()]}]}}

    def secret_aws(self, args, payload=None, lock_fd=None):
        if hasattr(self, 'secret_hook'): self.secret_hook()
        if args[0] == 'put-secret-value' and 'ClientRequestToken' in json.loads(payload):
            # Exercise the same real lock assertion as the shared collaborator.
            shared.IntegrationTests.secret_aws(self, ['get-secret-value'], lock_fd=lock_fd)
            self.calls.append(('secret', 'put-secret-value'))
            request = json.loads(payload)
            self.assertEqual(request['SecretId'], 'ezil-os/production/app')
            self.envelope = {'VersionId':request['ClientRequestToken'], 'SecretString':request['SecretString']}
            if self.lost_source_put:
                self.lost_source_put = False
                raise TimeoutError('synthetic lost source write response')
            return {'VersionId':request['ClientRequestToken']}
        return shared.IntegrationTests.secret_aws(self, args, payload, lock_fd)

    def aws(self, *args):
        return self.mutate(args, self.provider(*args)) if hasattr(self, 'mutate') else shared.IntegrationTests.aws(self, *args)

    def provider(self, *args):
        service, op = args[:2]
        def flag(name): return args[args.index(name)+1]
        if service == 'cloudformation' and '--query' in args:
            return {'name':'ezil-prd-lifecycle', 'role':TOOL.ROLE, 'status':'UPDATE_COMPLETE', 'outputs':[
                {'OutputKey':name,'OutputValue':self.source[key]} for name,key in
                (('WorkflowVersionArn','stateMachineVersionArn'),('RecoveryVersionArn','recoveryStateMachineVersionArn')) if self.source[key] is not None]}
        if service == 'cloudformation' and op == 'describe-stacks' and flag('--stack-name') == 'ezil-os-prod-host':
            return {'Stacks':[{'StackStatus':'UPDATE_COMPLETE', 'Outputs':[{'OutputKey':'InstanceId', 'OutputValue':'i-'+'a'*17}]}]}
        if service == 'ec2' and op == 'describe-instances':
            return {'Reservations':[{'Instances':[{'InstanceId':'i-'+'a'*17, 'State':{'Name':'running'}, 'VpcId':'vpc-040bdd6e09e35425f',
                'IamInstanceProfile':{'Arn':'arn:aws:iam::452630323510:instance-profile/ezil-os-prod-host-Profile-aaa'},
                'Tags':[{'Key':k,'Value':v} for k,v in {'Name':'ezil-os-prod-host','ezil:purpose':'os','ezil:env':'production'}.items()]}]}]}
        if service == 'iam':
            return {'InstanceProfile':{'Arn':'arn:aws:iam::452630323510:instance-profile/ezil-os-prod-host-Profile-aaa',
                                       'Roles':[{'Arn':profiles.HOST}]}}
        if service == 'imagebuilder' and flag('--image-build-version-arn') == self.source_build['arn']:
            return {'image':copy.deepcopy(self.source_build)}
        if service == 'ecr':
            return {'images':[{'registryId':TOOL.ACCOUNT,'repositoryName':TOOL.REPOSITORY.split('/',1)[1],
                'imageId':{'imageDigest':self.source['lowerImageRef'].split('@')[1]},'imageManifest':self.lower_raw}]}
        if service == 'stepfunctions' and op == 'describe-state-machine':
            value = shared.IntegrationTests.aws(self, *args)
            arn = flag('--state-machine-arn')
            kind = 'Recovery' if '-recovery:' in arn else 'Lifecycle'
            value['definition'] = json.dumps({'States':{'Observe':{'Type':'Task', 'Parameters':{
                'FunctionName':f'arn:aws:lambda:{TOOL.REGION}:{TOOL.ACCOUNT}:function:ezil-prd-lifecycle-{kind}Observer:1'}}}})
            return value
        if service == 'lambda':
            arn = flag('--function-name')
            settings = self.source_config['settings'] if 'LifecycleObserver' in arn else {
                'lifecycle':self.source_config['settings'], 'recoveryVersionArn':self.source['recoveryStateMachineVersionArn']}
            return {'arn':arn, 'version':'1', 'settings':json.dumps(settings)}
        if service == 'ssm' and op == 'get-command-invocation' and '-source-init-' in self.commands[flag('--command-id')]:
            cid = flag('--command-id'); comment = self.commands[cid]
            if cid not in self.command_results:
                payload = next(body for key,body in self.payloads.items() if key.rsplit('/',1)[-1][:32] in comment)
                def install(app):
                    self.assertFalse(self.ledger.exists())
                    _, d = RELEASE.secret_deployment(self.envelope)
                    self.running_deployment = copy.deepcopy(d)
                    self.running_sha = app['gitSha']
                self.command_results[cid] = execute_app_payload(payload, install, lambda:{'EZIL_GIT_SHA':self.running_sha,
                    'EZIL_AWS_KILL_SWITCH':'1','EZIL_AWS_LIFECYCLE_DEPLOYMENTS':json.dumps({TOOL.REGION:self.running_deployment})})
            return copy.deepcopy(self.command_results[cid])
        return shared.IntegrationTests.aws(self, *args)

    def schema_receipt(self):
        value = shared.IntegrationTests.schema_receipt(self)
        value['systemIdentifier'] = context.PRODUCTION_SYSTEM_ID
        return value

    def admit(self, apply=True, version='initial'):
        return admission.initialize(RELEASE, self.source_path, self.current_config, self.source_build['arn'],
                                    self.app_path, self.ledger, apply, version)

    def first_plan(self):
        RELEASE.make_plan(self.directory, self.config, self.identity, context.PRODUCTION_SYSTEM_ID, self.rollout, self.ledger)
        return RELEASE.load_plan(self.path)

    def test_empty_bootstrap_first_plan_finalize_and_promote(self):
        self.admit()
        ledger = RELEASE.load_ledger(self.ledger)
        self.assertEqual(ledger['entries'][0]['operation'], 'source-init')
        _, current = RELEASE.secret_deployment(self.envelope)
        self.assertEqual(current, {**self.deployment, 'releases':[self.source]})
        self.assertFalse(set(manifest.TUPLE) & current.keys())
        self.assertEqual(self.first_plan()['ledgerGeneration'], 1)
        shared.IntegrationTests.through_ready(self)
        RELEASE.apply_app(self.manifest, True, self.ledger)
        RELEASE.promote(self.manifest, True, ledger_path=self.ledger)
        _, current = RELEASE.secret_deployment(self.envelope)
        self.assertEqual({k:current[k] for k in manifest.PROMOTION}, {k:self.value[k] for k in manifest.PROMOTION})
        self.assertEqual(current['releases'][0], self.source)
        self.assertEqual(len(current['releases']), 2)
        self.assertEqual(manifest.loads(self.envelope['SecretString'])['keep'], 'synthetic')
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['operation'], 'promote-canary')

    def test_bootstrap_preserves_string_encoding_and_other_regions(self):
        outer = manifest.loads(self.envelope['SecretString']); outer[TOOL.KEY] = json.dumps(outer[TOOL.KEY])
        self.envelope['SecretString'] = json.dumps(outer)
        self.admit()
        actual = manifest.loads(self.envelope['SecretString'])
        self.assertIsInstance(actual[TOOL.KEY], str)
        self.assertEqual(manifest.loads(actual[TOOL.KEY])['other'], {'keep':True})

    def test_empty_registry_and_dry_admission(self):
        outer = manifest.loads(self.envelope['SecretString']); outer[TOOL.KEY][TOOL.REGION]['releases'] = []
        self.running_deployment['releases'] = []
        self.envelope['SecretString'] = json.dumps(outer)
        original = copy.deepcopy(self.envelope)
        self.admit(apply=False)
        self.assertEqual(self.envelope, original); self.assertFalse(self.ledger.exists())
        self.admit()
        self.assertEqual(RELEASE.secret_deployment(self.envelope)[1]['releases'], [self.source])

    def test_partial_journal_and_secret_race_refuse_without_overwrite(self):
        journal = self.source_path.parent/'source-registration.json'
        TOOL.write(journal, {'schemaVersion':1})
        with self.assertRaises(ValueError): self.admit()
        journal.unlink()
        def change():
            if journal.exists(): self.envelope['VersionId'] = 'raced'
        self.secret_hook = change
        with self.assertRaises(ValueError): self.admit()
        self.assertFalse(self.ledger.exists())
        self.assertFalse(any(c == ('secret','put-secret-value') for c in self.calls))

    def test_resume_refuses_changed_running_app(self):
        self.lost_source_put = True
        with self.assertRaises(TimeoutError): self.admit()
        self.running_sha = 'b'*40
        with self.assertRaises(ValueError): self.admit()
        self.assertFalse(self.ledger.exists())

    def test_copied_journal_cannot_bypass_the_one_shot_directory(self):
        self.lost_source_put = True
        with self.assertRaises(TimeoutError): self.admit()
        other = self.root/'other-admission'; other.mkdir()
        (other/'source.json').write_bytes(self.source_path.read_bytes())
        (other/'source-registration.json').write_bytes((self.source_path.parent/'source-registration.json').read_bytes())
        self.source_path = other/'source.json'
        with self.assertRaisesRegex(ValueError, 'journal drift'): self.admit()
        self.assertFalse(self.ledger.exists())

    def test_final_readbacks_and_receipts_cannot_substitute_source(self):
        self.admit(); self.first_plan()
        shared.IntegrationTests.through_ready(self)
        plan = RELEASE.load_plan(self.path)
        for key in RELEASE.VERSION_KEYS:
            changed = copy.deepcopy(self.evidence)
            changed['versions'][key]['stateMachineVersions'] = []
            with self.assertRaises(ValueError): RELEASE.final_manifest(plan, changed)
        changed = copy.deepcopy(self.evidence); changed['image']['Images'][0]['ImageId'] = self.source['amiId']
        with self.assertRaises(ValueError): RELEASE.final_manifest(plan, changed)
        receipt_path = self.directory/'apply-schema-receipt.json'
        receipt = manifest.read(receipt_path); receipt['planSha256'] = '0'*64; TOOL.write(receipt_path, receipt)
        with self.assertRaises(ValueError): RELEASE.finalize(self.path, True)

    def test_absent_recovery_is_source_only(self):
        self.source['recoveryStateMachineVersionArn'] = None
        self.source_config.pop('recoveryVersionArn'); self.source_config['recoveryEnabled'] = False
        TOOL.write(self.source_path, self.source); TOOL.write(self.current_config, self.source_config)
        self.admit()
        with self.assertRaises(ValueError): manifest.validate(self.source, target=True)

    def test_stale_entry_secret_version_and_current_app_refused(self):
        for version in (None, 'older'):
            with self.subTest(version=version), self.assertRaises(ValueError): self.admit(version=version)
        self.running_sha = 'b'*40
        with self.assertRaises(ValueError): self.admit()
        self.assertEqual(self.envelope, self.original); self.assertFalse(self.ledger.exists())

    def test_provider_partial_foreign_and_source_drift_refused(self):
        cases = [
            (('cloudformation','describe-stacks'), lambda r:dict(r, outputs=[])),
            (('sts','get-caller-identity'), lambda r:dict(r, Account='123456789012')),
            (('ec2','describe-images'), lambda r:dict(r, NextToken='more')),
            (('ec2','describe-images'), lambda r:{'Images':[dict(r['Images'][0], ImageId=self.value['amiId'])]}),
            (('ec2','describe-launch-template-versions'), lambda r:dict(r, NextToken='more')),
            (('ec2','describe-launch-template-versions'), lambda r:{'LaunchTemplateVersions':[dict(r['LaunchTemplateVersions'][0], LaunchTemplateId='lt-'+'f'*17)]}),
            (('stepfunctions','list-state-machine-versions'), lambda r:dict(r, nextToken='more')),
            (('stepfunctions','describe-state-machine'), lambda r:dict(r, definition='{"States":{}}')),
            (('lambda','get-function-configuration'), lambda r:dict(r, settings='{}')),
            (('lambda','get-function-configuration'), lambda r:dict(r, arn=r['arn'].replace('prd','mum'))),
            (('ecr','batch-get-image'), lambda r:dict(r, failures=[{'failureCode':'ImageNotFound'}])),
            (('imagebuilder','get-image'), lambda r:{'image':dict(r['image'], outputResources={'amis':[{'image':self.value['amiId'],'region':TOOL.REGION}]})}),
        ]
        for operation, mutate in cases:
            with self.subTest(operation=operation):
                self.mutate = lambda args,r: mutate(r) if args[:2] == operation else r
                with self.assertRaises(ValueError): self.admit()
                self.assertEqual(self.envelope, self.original); self.assertFalse(self.ledger.exists())

    def test_target_foreign_namespace_account_lt_and_partial_source_refused(self):
        cases = [self.value, dict(self.source, namespace='mum'), dict(self.source, accountId='123456789012'),
                 dict(self.source, launchTemplateId='lt-'+'f'*17), dict(self.source, amiId=self.value['amiId']),
                 {k:v for k,v in self.source.items() if k != 'recoveryStateMachineVersionArn'}]
        for record in cases:
            TOOL.write(self.source_path, record)
            with self.subTest(record=record['amiId']), self.assertRaises(ValueError): self.admit()
            self.assertEqual(self.envelope, self.original)

    def test_existing_registry_ledger_and_gate_drift_refused(self):
        for registry in ([self.source], [self.value]):
            outer = manifest.loads(self.original['SecretString']); outer[TOOL.KEY][TOOL.REGION]['releases'] = registry
            self.envelope['SecretString'] = json.dumps(outer)
            with self.assertRaises(ValueError): self.admit()
        self.envelope = copy.deepcopy(self.original)
        TOOL.write(self.ledger, {'schemaVersion':1, 'entries':[]})
        with self.assertRaises(ValueError): self.admit()
        self.ledger.unlink()
        outer = manifest.loads(self.original['SecretString']); outer['EZIL_AWS_KILL_SWITCH'] = '0'
        self.envelope['SecretString'] = json.dumps(outer)
        with self.assertRaises(ValueError): self.admit()

    def test_lost_write_exact_resume_and_completed_replay_refused(self):
        self.lost_source_put = True
        with self.assertRaises(TimeoutError): self.admit()
        self.assertFalse(self.ledger.exists())
        version = self.envelope['VersionId']
        self.admit()
        self.assertEqual(self.envelope['VersionId'], version)
        self.assertEqual(sum(c == ('secret','put-secret-value') for c in self.calls), 1)
        with self.assertRaises(ValueError): self.admit()

    def test_lost_write_stale_version_and_unrelated_secret_drift_refused(self):
        self.lost_source_put = True
        with self.assertRaises(TimeoutError): self.admit()
        original = copy.deepcopy(self.envelope)
        self.envelope['VersionId'] = 'foreign-write'
        with self.assertRaises(ValueError): self.admit()
        self.envelope = original
        outer = manifest.loads(self.envelope['SecretString']); outer['keep'] = 'changed'
        self.envelope['SecretString'] = json.dumps(outer)
        with self.assertRaises(ValueError): self.admit()
        self.assertFalse(self.ledger.exists())

    def test_first_plan_refuses_stale_secret_app_and_missing_source(self):
        self.admit()
        original = copy.deepcopy(self.envelope)
        self.envelope['VersionId'] = 'unreviewed'
        with self.assertRaises(ValueError): self.first_plan()
        self.envelope = original
        self.running_sha = 'b'*40
        with self.assertRaises(ValueError): self.first_plan()
        self.running_sha = self.app['gitSha']
        outer = manifest.loads(self.envelope['SecretString']); outer[TOOL.KEY][TOOL.REGION].pop('releases')
        self.envelope['SecretString'] = json.dumps(outer)
        with self.assertRaises(ValueError): self.first_plan()

    def test_real_ledger_tuple_and_terminal_state_validation(self):
        self.admit(); ledger = RELEASE.load_ledger(self.ledger)
        for field, bad in [('amiId',None), ('launchTemplateVersion',True), ('stateMachineVersionArn',None),
                           ('stateMachineVersionArn',TOOL.MACHINE.replace('prd','mum')+':1'), ('lowerImageDigest','sha256:'+'a'*64)]:
            value = copy.deepcopy(ledger); value['entries'][0]['tuple'][field] = bad
            with self.subTest(field=field), self.assertRaises((ValueError, TypeError)): RELEASE.validate_ledger(value)
        before = {k:ledger['entries'][0][k] for k in ('secretVersionId','tuple','registrySha256','appGitSha')}
        pending = {'generation':2,'operation':'apply-app','planSha256':'a'*64,'state':'pending','before':before,
                   'expected':{k:v for k,v in before.items() if k != 'secretVersionId'}}
        end = {**ledger['entries'][0], 'generation':3, 'operation':'apply-app','planSha256':'a'*64,'appGitSha':'b'*40}
        with self.assertRaisesRegex(ValueError, 'terminal state'): RELEASE.validate_ledger({'schemaVersion':1,'entries':[*ledger['entries'],pending,end]})


if __name__ == '__main__': unittest.main(verbosity=2)
