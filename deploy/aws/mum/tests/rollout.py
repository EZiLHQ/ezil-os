#!/usr/bin/env python3
"""Offline stage-2 cases. All AWS/DB responses and credentials are synthetic."""
import ast
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rebase import TOOL, RELEASE, HERE, release_record
import rebase as stage1
import rebase_cloudformation as cfn
import rebase_app as app_ops
import rebase_manifest as manifest
import rebase_schema as schema
import rebase_ssm as ssm


def execute_app_payload(payload, install, environment):
    """Execute the generated Python guards and Node readback; fake only install/exec IO."""
    script = payload.split("<<'EZIL_APP_PY'\n", 1)[1].rsplit('\nEZIL_APP_PY', 1)[0]
    namespace = {}
    real_run = subprocess.run

    def run(command, **kwargs):
        if command == ['bash', '-s']:
            assert kwargs['input'] == namespace['SCRIPT']
            install(namespace['APP'])
            return subprocess.CompletedProcess(command, 0, stdout='', stderr='')
        assert command == ['docker', 'compose', '--env-file', 'compose.env', 'exec', '-T', 'web', 'node', '-e', namespace['NODE']]
        return real_run(['node', '-e', namespace['NODE']], env={'PATH': os.environ['PATH'], **environment()},
                        capture_output=True, text=True, timeout=10)

    with patch('subprocess.run', side_effect=run), patch('sys.stdout', new_callable=io.StringIO) as output, patch('sys.stderr', new_callable=io.StringIO):
        try:
            exec(compile(script, 'generated-app-payload', 'exec'), namespace)
        except SystemExit:
            return {'Status': 'Failed', 'ResponseCode': 1, 'StandardOutputContent': ''}
    return {'Status': 'Success', 'ResponseCode': 0, 'StandardOutputContent': output.getvalue()}


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.target = release_record()
        self.source = dict(self.target, amiId='ami-'+'1'*17, lowerImageDigest=self.target['previousLowerImageDigest'], lowerImageRef=self.target['previousLowerImageRef'], previousLowerImageDigest=None, previousLowerImageRef=None)
        self.old = TOOL.pair({'settings': {'deployment': self.source}})
        self.new = TOOL.pair({'settings': {'deployment': self.target}})

    def test_legacy_source_nullable_schema_never_a_target(self):
        value = dict(self.source, preparationStateMachineVersionArn=None, recoveryStateMachineVersionArn=None)
        self.assertEqual(manifest.validate(value, source=True), value)
        for kwargs in ({}, {'target':True}, {'target':True,'source':True}):
            with self.assertRaises(ValueError): manifest.validate(value, **kwargs)
        for key in ('stateMachineVersionArn', 'lowerImageDigest', 'agentCommit'):
            with self.assertRaises(ValueError): manifest.validate(dict(value, **{key:None}), source=True)

    def test_schema_only_four_fields_nullable(self):
        full=manifest.read(HERE.parent/'rebase-release.schema.json')
        source=manifest.read(HERE.parent/'rebase-source-release.schema.json')
        self.assertEqual(full['required'], source['required'])
        for key in full['properties']:
            if key not in ('preparationStateMachineVersionArn','recoveryStateMachineVersionArn'):
                self.assertEqual(full['properties'][key], source['properties'][key])

    def test_registry_promotion_rollback_retains_records_encoding_other_regions(self):
        for encoded in (True,False):
            d={TOOL.REGION:dict(self.source, releases=[self.source]),'other':{'keep':1}}
            raw=json.dumps(d) if encoded else d
            outer={'keep':'local-synthetic',TOOL.KEY:raw}
            after=TOOL.edit_release_secret({'SecretString':json.dumps(outer)},self.old,self.new,[self.source,self.target])
            back=TOOL.edit_release_secret({'SecretString':json.dumps(after)},self.new,self.old,[self.source])
            self.assertEqual(back['keep'],outer['keep']); self.assertEqual(isinstance(back[TOOL.KEY],str),encoded)
            result=json.loads(back[TOOL.KEY]) if encoded else back[TOOL.KEY]
            self.assertEqual(result['other'],d['other'])
            self.assertEqual(result[TOOL.REGION]['releases'],[self.source,self.target])
            self.assertEqual({k:result[TOOL.REGION][k] for k in self.old},self.old)
            again=TOOL.edit_release_secret({'SecretString':json.dumps(back)},self.old,self.old,[self.source])
            self.assertEqual(again,back)

    def test_registry_full_refuses_without_dropping_any_record(self):
        records=[self.source,*[dict(self.source,amiId='ami-'+format(n,'017x'),recipeVersion='1.0.'+str(n)) for n in range(20,29)]]
        for record in records: manifest.validate(record, source=True, repository=TOOL.REPOSITORY)
        original=copy.deepcopy(records)
        envelope={'SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:dict(self.source,releases=records)}})}
        with self.assertRaisesRegex(ValueError,'registry full'): TOOL.edit_release_secret(envelope,self.old,self.new,[self.target])
        self.assertEqual(records,original)

    def test_nine_to_ten_and_rollback_preserve_all_records(self):
        extra=[dict(self.source,amiId='ami-'+format(n,'017x'),recipeVersion='1.0.'+str(n)) for n in range(20,28)]
        records=[self.source,*extra]
        for encoded in (True,False):
            d={TOOL.REGION:dict(self.source,releases=records),'other':{'keep':True}}
            envelope={'SecretString':json.dumps({'untouched':'synthetic',TOOL.KEY:json.dumps(d) if encoded else d})}
            frozen=copy.deepcopy(envelope)
            forward=TOOL.edit_release_secret(envelope,self.old,self.new,[self.source,self.target])
            back=TOOL.edit_release_secret({'SecretString':json.dumps(forward)},self.new,self.old,[self.source])
            restored=json.loads(back[TOOL.KEY]) if encoded else back[TOOL.KEY]
            self.assertEqual(len(restored[TOOL.REGION]['releases']),10)
            self.assertEqual(restored[TOOL.REGION]['releases'],[*records,self.target])
            self.assertEqual({k:restored[TOOL.REGION][k] for k in self.old},self.old)
            self.assertEqual(restored['other'],d['other'])
            self.assertEqual(back['untouched'],'synthetic')
            self.assertEqual(isinstance(back[TOOL.KEY],str),encoded)
            self.assertEqual(envelope,frozen)
            self.assertEqual(TOOL.edit_release_secret({'SecretString':json.dumps(back)},self.old,self.old,[self.source]),back)
            eleventh=dict(self.target,amiId='ami-'+'f'*17)
            with self.assertRaisesRegex(ValueError,'registry full'):
                TOOL.edit_release_secret({'SecretString':json.dumps(back)},self.old,self.new,[eleventh])
            oversized=dict(restored[TOOL.REGION],releases=[*records,self.target,eleventh])
            with self.assertRaisesRegex(ValueError,'invalid release registry'):
                TOOL.edit_release_secret({'SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:oversized}})},self.old,self.new,[])

    def test_registry_cap_parity_with_app_source_and_manifest_contracts(self):
        # The app cannot import operator tooling; pin all five independent guards.
        root=HERE.parents[3]
        for name in ('aws-intent.ts','aws-rebase-release.ts'):
            source=(root/'app/src/server/lib/compute'/name).read_text()
            self.assertEqual(re.findall(r'z\.array\(RebaseSourceReleaseSchema\)\.min\(1\)\.max\((\d+)\)',source),['10'])
        for name, expected in (('json-tool.py',[10,10]),('registry_gc.py',[10])):
            tree=ast.parse((HERE.parent/name).read_text())
            caps=[node.comparators[-1].value for node in ast.walk(tree) if isinstance(node,ast.Compare)
                  and isinstance(node.comparators[-1],ast.Constant)
                  and any(isinstance(op,ast.LtE) for op in node.ops)
                  and any(ast.unparse(value) in ('len(retained)','len(records)') for value in [node.left,*node.comparators])]
            self.assertEqual(caps,expected)
        # JSON manifests describe ONE record, including nullable legacy sources.
        records=[dict(self.target,amiId='ami-'+format(n,'017x')) for n in range(10)]
        records[0]=dict(self.source,preparationStateMachineVersionArn=None,recoveryStateMachineVersionArn=None)
        for record in records:
            self.assertEqual(manifest.validate(record,source=True,repository=TOOL.REPOSITORY),record)
        self.assertEqual(manifest.validate(records[-1],target=True,repository=TOOL.REPOSITORY),records[-1])

    def test_ten_record_registry_rejects_invalid_retained_evidence(self):
        records=[self.source,*[dict(self.source,amiId='ami-'+format(n,'017x')) for n in range(20,28)],self.target]
        for kind in ('duplicate','foreign','malformed','mutable workflow','rewrite'):
            invalid=copy.deepcopy(records)
            incoming=[]
            if kind=='duplicate': invalid[2]=copy.deepcopy(invalid[1])
            if kind=='foreign': invalid[2]['launchTemplateId']='lt-'+'f'*17
            if kind=='malformed': invalid[2]['amiId']='malformed'
            if kind=='mutable workflow': invalid[2]['stateMachineVersionArn']=TOOL.MACHINE+':latest'
            if kind=='rewrite': incoming=[dict(invalid[2],agentCommit='f'*40)]
            envelope={'SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:dict(self.source,releases=invalid)}})}
            frozen=copy.deepcopy(envelope)
            with self.subTest(kind=kind),self.assertRaises(ValueError):
                TOOL.edit_release_secret(envelope,self.old,self.new,incoming)
            self.assertEqual(envelope,frozen)

    def test_registry_rejects_foreign_duplicate_or_ambiguous_target(self):
        for records in ([self.source,self.source], [dict(self.source,namespace='other')], [self.target,dict(self.target,createdAt='2026-10-23T12:00:00.000Z')]):
            envelope={'SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:dict(self.source,releases=records)}})}
            with self.assertRaises(ValueError): TOOL.edit_release_secret(envelope,self.old,self.new,[self.target])

    def test_shared_lower_different_amis_retained_and_same_pair_rewrite_refused(self):
        deployed=dict(self.target,amiId='ami-'+'5'*17,recipeVersion='1.0.5')
        envelope={'SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:dict(deployed,releases=[self.source,deployed])}})}
        before=TOOL.pair({'settings':{'deployment':deployed}})
        updated=TOOL.edit_release_secret(envelope,before,self.new,[self.source,deployed,self.target])
        self.assertEqual(updated[TOOL.KEY][TOOL.REGION]['releases'],[self.source,deployed,self.target])
        for changed in (dict(deployed,createdAt='2026-10-23T12:00:00.000Z'), dict(self.source,agentCommit='f'*40)):
            with self.assertRaisesRegex(ValueError,'rewrite'):
                TOOL.edit_release_secret(envelope,before,self.new,[changed,self.target])

    def test_legacy_null_fields_cannot_be_rewritten_in_place(self):
        legacy=dict(self.source,preparationStateMachineVersionArn=None,recoveryStateMachineVersionArn=None)
        envelope={'SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:dict(self.source,releases=[legacy])}})}
        with self.assertRaisesRegex(ValueError,'rewrite'):
            TOOL.edit_release_secret(envelope,self.old,self.new,[self.source,self.target])

    def test_multiple_observer_version_pairs_require_each_unchanged_code(self):
        old={}; new={}
        for i in range(3):
            function='Observer'+str(i)
            a={'Type':'AWS::Lambda::Function','Properties':{'Code':{'S3Key':'same.zip'},'Environment':{'Variables':{'EZIL_LIFECYCLE_SETTINGS':json.dumps({'deployment':dict(self.source)})}}}}
            b=copy.deepcopy(a); b['Properties']['Environment']=TOOL.promotion_substitution(a['Properties']['Environment'],self.old,self.new)
            old[function]=a; new[function]=b
            version={'Type':'AWS::Lambda::Version','Properties':{'FunctionName':{'Ref':function}},'DeletionPolicy':'Retain'}
            old['Old'+str(i)]=version; new['New'+str(i)]=version
        self.assertEqual(TOOL.lifecycle_version_pair(old,new,self.old,self.new),{'Old0':'New0','Old1':'New1','Old2':'New2'})
        new['Observer2']['Properties']['Code']['S3Key']='tampered.zip'
        with self.assertRaises(ValueError): TOOL.lifecycle_version_pair(old,new,self.old,self.new)



class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.sql=(HERE.parents[3]/'docs/aws-computers/sql/0002_image_rebase.sql.txt').read_bytes()
        self.system='1234567890123456789'
        self.expected=schema.expected_schema(self.sql.decode())

    def evidence(self):
        return {'placements':self.expected['placements'],'columns':self.expected['columns'],
                'indexes':{k:'CREATE INDEX '+k+' ON public.ezil_computer_image_jobs USING btree ('+v+')' for k,v in self.expected['indexes'].items()},
                'rls':True,'constraints':0,'defaults':0,'triggers':0,'policies':0,'grants':0}

    def receipt(self):
        return dict(schemaVersion=1,systemIdentifier=self.system,schemaSha256=hashlib.sha256(self.sql).hexdigest(),applied=True,
                    before=dict(placements={},columns={},indexes={},rls=False,constraints=0,defaults=0,triggers=0,policies=0,grants=0),after=self.evidence())

    def test_exact_draft_grammar_and_receipt(self):
        schema.validate_receipt(self.receipt(),self.sql,self.system)
        for sql in (self.sql+b'DROP TABLE users;\n', self.sql.replace(b'NULL;',b'NULL; --extra',1)):
            with self.assertRaises(ValueError): schema.body(sql,self.system)
        for field,value in [('systemIdentifier','foreign'),('schemaSha256','0'*64),('applied',False)]:
            with self.assertRaises(ValueError): schema.validate_receipt(dict(self.receipt(),**{field:value}),self.sql,self.system)

    def test_schema_resume_and_drift(self):
        receipt=self.receipt();receipt.update(applied=False,before=receipt['after'])
        schema.validate_receipt(receipt,self.sql,self.system)
        for field,value in [('grants',1),('rls',False),('policies',1),('columns',{}),('indexes',{})]:
            bad=copy.deepcopy(receipt);bad['after'][field]=value
            with self.assertRaises(ValueError): schema.validate_receipt(bad,self.sql,self.system)

    def remote(self, url='postgresql://synthetic:local@10.61.20.35:5432/postgres', after=None, before=None, exit_code=0):
        script=schema.body(self.sql,self.system).split("<<'EZIL_SCHEMA_PY'\n",1)[1].rsplit('\nEZIL_SCHEMA_PY',1)[0]
        def run(command,**kwargs):
            self.command=command;self.environment=kwargs['env'];self.sent=io.StringIO(kwargs['input'])
            observed_before=before or self.receipt()['before'];observed_after=after or self.evidence()
            receipt=self.receipt();receipt.update(before=observed_before,after=observed_after,applied=observed_before==self.receipt()['before'])
            # PostgreSQL's DO checks are rehearsed by the lead against a disposable
            # database; this transport double verifies error-stop and no output leak.
            valid=observed_after==self.evidence() and observed_before in (self.receipt()['before'],observed_after)
            return subprocess.CompletedProcess(command,exit_code if valid else 1,stdout=json.dumps(receipt))
        output=io.StringIO()
        with patch('pathlib.Path.read_text',return_value='SUPABASE_DATABASE_URL='+url),patch('subprocess.run',run),patch('sys.stdout',output),patch('sys.stderr',io.StringIO()):
            exec(compile(script,'remote-schema','exec'),{})
        return json.loads(output.getvalue())

    def test_remote_transaction_system_pin_and_exact_bytes(self):
        result=self.remote()
        schema.validate_receipt(result,self.sql,self.system)
        sent=self.sent.getvalue()
        self.assertIn(self.sql.decode(),sent)
        self.assertLess(sent.index('pg_control_system'),sent.index('ALTER TABLE'))
        self.assertIn('pg_advisory_xact_lock',sent);self.assertTrue(sent.endswith('COMMIT;\n'))
        self.assertIn('ON_ERROR_STOP=1',self.command)
        self.assertNotIn('synthetic',str(self.command));self.assertNotIn('PGOPTIONS',self.environment)

    def test_remote_existing_exact_schema_skips_ddl(self):
        result=self.remote(before=self.evidence())
        self.assertFalse(result['applied']);self.assertIn('ELSIF (SELECT evidence FROM ezil_rebase_schema_before)',self.sent.getvalue())

    def test_remote_refuses_production_routing_overrides_and_partial_schema(self):
        for url in ('postgresql://u:p@btgq.supabase.co:5432/db','postgresql://u:p@curomaa:5432/db','postgresql://u:p@10.61.20.35:5432/db?host=other','postgresql://u:p@10.61.20.35/db','postgresql://u:p@10.61.20.35:5432/db?options=bad'):
            with self.subTest(url=url),self.assertRaises(SystemExit): self.remote(url=url)
        before=dict(self.evidence(),columns={})
        with self.assertRaises(SystemExit): self.remote(before=before)
        self.assertIn("RAISE EXCEPTION 'partial schema refused'",self.sent.getvalue())


class SsmTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name);self.calls=[];self.lost=False;self.fail=False;self.unknown=False
        self.command='11111111-1111-4111-8111-111111111111';self.comment=None
        quiet=patch('sys.stdout',new_callable=io.StringIO);quiet.start();self.addCleanup(quiet.stop)

    def aws(self,*args):
        self.calls.append(args);operation=args[:2]
        if operation==('sts','get-caller-identity'):return {'Account':TOOL.ACCOUNT}
        if operation==('ec2','describe-instances'):
            return {'Reservations':[{'Instances':[{'InstanceId':ssm.HOST,'State':{'Name':'running'},'Tags':[{'Key':'ezil:purpose','Value':'os-staging'},{'Key':'ezil:env','Value':'billing-staging'}]}]}]}
        if operation==('s3api','put-object'):return {}
        if operation==('ssm','send-command'):
            self.assertTrue((self.directory/'apply-schema-ssm.json').exists())
            self.assertEqual(manifest.read(self.directory/'apply-schema-ssm.json')['status'],'submitting')
            self.comment=args[args.index('--comment')+1]
            if self.lost: raise TimeoutError('lost result')
            return {'Command':{'CommandId':self.command}}
        if operation==('ssm','list-commands'):
            return {'Commands':[] if self.unknown else [{'Comment':self.comment,'InstanceIds':[ssm.HOST],'CommandId':self.command}]}
        if operation==('ssm','get-command-invocation'):
            return {'Status':'Failed' if self.fail else 'Success','ResponseCode':1 if self.fail else 0,'StandardOutputContent':'{"ok":true}'}
        if operation==('s3api','delete-object'):return {}
        raise AssertionError(args)

    def run_phase(self,apply=True):
        return ssm.run(self.directory,'apply-schema','reviewed script',apply,self.aws,TOOL.write,lambda _:None)

    def test_dry_run_does_not_write_upload_or_submit(self):
        self.assertIsNone(self.run_phase(False));self.assertEqual(len(self.calls),2)
        self.assertFalse(list(self.directory.iterdir()))

    def test_apply_and_resume_reuses_command_then_removes_s3_payload(self):
        self.assertEqual(self.run_phase(),{'ok':True});self.run_phase()
        self.assertEqual(sum(c[:2]==('ssm','send-command') for c in self.calls),1)
        self.assertEqual(self.calls[-1][:2],('s3api','delete-object'))

    def test_lost_submission_reconciles_without_new_command(self):
        self.lost=True
        with self.assertRaises(TimeoutError):self.run_phase()
        self.lost=False;self.run_phase()
        self.assertEqual(sum(c[:2]==('ssm','send-command') for c in self.calls),1)

    def test_ambiguous_missing_command_never_retries(self):
        self.lost=True
        with self.assertRaises(TimeoutError):self.run_phase()
        self.unknown=True
        with self.assertRaises(ValueError):self.run_phase()
        self.assertEqual(sum(c[:2]==('ssm','send-command') for c in self.calls),1)

    def test_known_failure_retries_with_prior_command_retained(self):
        self.fail=True
        with self.assertRaises(ValueError):self.run_phase()
        self.fail=False;self.run_phase()
        state=manifest.read(self.directory/'apply-schema-ssm.json')
        self.assertEqual(state['attempts'],[self.command]);self.assertTrue(state['comment'].endswith('-r1'))

    def test_foreign_account_refused_before_upload(self):
        def bad(*args):return {'Account':'123456789012'}
        with self.assertRaises(ValueError):ssm.run(self.directory,'apply-schema','body',True,bad,TOOL.write)
        self.assertFalse(list(self.directory.iterdir()))



class CloudFormationTests(unittest.TestCase):
    def dynamic_templates(self):
        resources={
            'RecoveryReconciler':{'Type':'AWS::Lambda::Function','Properties':{
                'Code':{'S3Key':'before.zip'},'Environment':{'Variables':{'REVISION':'before'}}}},
            'UnmodifiedLambda':{'Type':'AWS::Lambda::Function','Properties':{'Code':{'S3Key':'same.zip'}}},
        }
        for role in ('RebasePreparationRole','RecoveryRole'):
            resources[role]={'Type':'AWS::IAM::Role','Properties':{'PermissionsBoundary':
                'arn:aws:iam::452630323510:policy/ezil/mum/ezil-mum-image-job-boundary'}}
        for suffix in ('Backstop','Interrupted'):
            resources['Recovery'+suffix]={'Type':'AWS::Events::Rule','Properties':{'Targets':[
                {'Id':'other','Arn':{'Fn::GetAtt':['UnmodifiedLambda','Arn']}},
                {'Id':'reconciler','Arn':{'Fn::GetAtt':['RecoveryReconciler','Arn']},'Input':'{}'}]}}
            resources['RecoveryAllow'+suffix]={'Type':'AWS::Lambda::Permission','Properties':{
                'FunctionName':{'Fn::GetAtt':['RecoveryReconciler','Arn']},'Action':'lambda:InvokeFunction',
                'Principal':'events.amazonaws.com'}}
        for machine in ('Lifecycle','Preparation','Recovery'):
            resources[machine]={'Type':'AWS::StepFunctions::StateMachine','Properties':{'DefinitionString':'before'}}
            resources[machine+'Version']={'Type':'AWS::StepFunctions::StateMachineVersion','Properties':{
                'StateMachineArn':{'Ref':machine},'StateMachineRevisionId':{'Fn::GetAtt':[machine,'StateMachineRevisionId']}},
                'DeletionPolicy':'Retain','UpdateReplacePolicy':'Retain'}
        resources['RecoveryPolicy']={'Type':'AWS::IAM::Policy','Properties':{'PolicyName':'before',
            'PolicyDocument':{'Statement':[]}}}
        before={'Resources':resources};after=copy.deepcopy(before)
        after['Resources']['RecoveryReconciler']['Properties'].update(
            Code={'S3Key':'after.zip'},Environment={'Variables':{'REVISION':'after'}})
        changes={'RecoveryReconciler':{'action':'Modify','properties':['Code','Environment'],'attributes':[]}}
        for logical,resource in resources.items():
            if resource['Type'] in ('AWS::Events::Rule','AWS::Lambda::Permission'):
                changes[logical]={'action':'Modify','properties':[
                    'Targets' if resource['Type']=='AWS::Events::Rule' else 'FunctionName'],'attributes':[]}
        for machine in ('Lifecycle','Preparation','Recovery'):
            after['Resources'][machine]['Properties']['DefinitionString']='after'
            changes[machine]={'action':'Modify','properties':['DefinitionString'],'attributes':[]}
            changes[machine+'Version']=copy.deepcopy(cfn.DEPENDENT_VERSION)
        after['Resources']['RecoveryPolicy']['Properties']['PolicyName']='after'
        changes['RecoveryPolicy']={'action':'Modify','properties':['PolicyName'],'attributes':[]}
        return before,after,{'schemaVersion':1,'changes':changes}

    def test_dynamic_lambda_dependents_exact_review(self):
        before,after,review=self.dynamic_templates()
        self.assertEqual(cfn.validate_templates('workflows',before,after,review),review['changes'])
        self.assertEqual(len(review['changes']),12)

    def test_dynamic_lambda_dependents_refuse_unrelated_changes(self):
        for case in ('unmodified','added','missing','non-lambda','target-input','target-id','rule-property',
                     'permission-property','rule-extra','permission-extra','rule-empty','permission-empty',
                     'rule-attributes','permission-attributes','rule-action','permission-action',
                     'unrelated','ref','wrong-attribute','extra-getatt-key','missing-lambda-review'):
            a,b,r=self.dynamic_templates();rule='RecoveryBackstop';permission='RecoveryAllowBackstop'
            if case in ('unmodified','added','missing','non-lambda'):
                source={'unmodified':'UnmodifiedLambda','added':'NewLambda','missing':'Missing','non-lambda':'RecoveryRole'}[case]
                logical=permission if case=='non-lambda' else rule
                if case=='added':
                    b['Resources'][source]={'Type':'AWS::Lambda::Function','Properties':{'Code':{'S3Key':'new.zip'}}}
                    r['changes'][source]={'action':'Add','properties':[],'attributes':[]}
                if case=='non-lambda':
                    b['Resources'][source]['Properties']['Description']='changed'
                    r['changes'][source]={'action':'Modify','properties':['Description'],'attributes':[]}
                for template in (a,b):
                    props=template['Resources'][logical]['Properties']
                    if logical==rule:props['Targets'][1]['Arn']={'Fn::GetAtt':[source,'Arn']}
                    else:props['FunctionName']={'Fn::GetAtt':[source,'Arn']}
            elif case in ('target-input','target-id'):
                b['Resources'][rule]['Properties']['Targets'][1]['Input' if case=='target-input' else 'Id']='changed'
                self.assertFalse(cfn.dependent_lambda_arns(rule,r['changes'][rule],a['Resources'],b['Resources'],r['changes']))
            elif case.startswith(('rule-','permission-')):
                entry=r['changes'][rule if case.startswith('rule-') else permission]
                field=case.split('-')[1]
                if field=='property':entry['properties']=['Arn']
                elif field=='extra':entry['properties'].append('Description')
                elif field=='empty':entry['properties']=[]
                elif field=='attributes':entry['attributes']=['Metadata']
                else:entry['action']='Add'
            elif case=='unrelated':
                for template in (a,b):
                    template['Resources'][permission]['Type']='AWS::IAM::Role'
            elif case=='missing-lambda-review':r['changes'].pop('RecoveryReconciler')
            else:
                value={'ref':{'Ref':'RecoveryReconciler'},'wrong-attribute':{'Fn::GetAtt':['RecoveryReconciler','Name']},
                       'extra-getatt-key':{'Fn::GetAtt':['RecoveryReconciler','Arn'],'extra':True}}[case]
                for template in (a,b):template['Resources'][permission]['Properties']['FunctionName']=value
            with self.subTest(case=case),self.assertRaises(ValueError):cfn.validate_templates('workflows',a,b,r)

    def execute_dynamic(self, mutate=lambda changes:None, *, apply=True, include_dependents=False,
                        mutate_ipv=lambda changes:None):
        before,after,review=self.dynamic_templates();self.cfn_calls=[];self.cfn_views=[]
        with tempfile.TemporaryDirectory() as temp:
            spec={'stackName':cfn.STACKS['workflows'],'changeSetArn':'synthetic-reviewed-change-set','roleArn':cfn.ROLE}
            for key,value in (('beforeTemplate',before),('candidateTemplate',after),('review',review)):
                path=Path(temp)/(key+'.json');TOOL.write(path,value)
                spec[key+'Path']=str(path);spec[key+'Sha256']=RELEASE.digest(path)
            changes=[]
            for logical,entry in review['changes'].items():
                resource=after['Resources'][logical];kind=resource['Type']
                version=kind=='AWS::StepFunctions::StateMachineVersion'
                dependent=version or kind in ('AWS::Events::Rule','AWS::Lambda::Permission')
                cause=(resource['Properties']['StateMachineRevisionId']['Fn::GetAtt'][0]+'.StateMachineRevisionId'
                       if version else 'RecoveryReconciler.Arn')
                details=[{'Target':{'Attribute':'Properties','Name':p,'RequiresRecreation':
                    'Always' if version or kind=='AWS::Lambda::Permission' else 'Never'},
                    'Evaluation':'Dynamic' if dependent else 'Static',
                    'ChangeSource':'ResourceAttribute' if dependent else 'DirectModification',
                    **({'CausingEntity':cause} if dependent else {})} for p in entry['properties']]
                changes.append({'Type':'Resource','ResourceChange':{'LogicalResourceId':logical,'ResourceType':kind,
                    'Action':'Modify','Replacement':'Conditional' if version or kind=='AWS::Lambda::Permission' else 'False',
                    'Details':details,'Scope':['Properties']}})
            omitted_types={'AWS::StepFunctions::StateMachineVersion'}
            if not include_dependents:omitted_types.update(('AWS::Events::Rule','AWS::Lambda::Permission'))
            omitted={logical for logical,resource in after['Resources'].items() if resource['Type'] in omitted_types}
            mutate(changes)
            ipv=copy.deepcopy([change for change in changes if change['ResourceChange']['LogicalResourceId'] not in omitted])
            mutate_ipv(ipv)
            def aws(service,operation,*args):
                self.cfn_calls.append(operation)
                if operation=='describe-change-set':
                    values='--include-property-values' in args;view=ipv if values else changes
                    self.cfn_views.append((values,len(view)))
                    return {'ChangeSetId':spec['changeSetArn'],'StackName':spec['stackName'],
                        'ExecutionStatus':'AVAILABLE','Status':'CREATE_COMPLETE','Changes':view,'Parameters':[]}
                if operation=='describe-stacks':return {'Stacks':[{'RoleARN':cfn.ROLE,'Parameters':[],'StackStatus':'UPDATE_COMPLETE'}]}
                if operation=='get-template':return {'TemplateBody':after if '--change-set-name' in args or 'execute-change-set' in self.cfn_calls else before}
                if operation=='execute-change-set':return {}
                raise AssertionError(operation)
            result=cfn.execute('workflows',spec,temp,apply,aws,TOOL.write,RELEASE.digest)
            if not apply:self.assertFalse((Path(temp)/'workflows-cloudformation.json').exists())
            return result

    def test_dynamic_dependents_live_shape_dry_run_and_apply(self):
        self.assertIsNone(self.execute_dynamic(apply=False))
        self.assertNotIn('execute-change-set',self.cfn_calls)
        self.assertEqual(self.cfn_views,[(True,5),(False,12)])
        self.assertEqual(self.execute_dynamic()['status'],'complete')
        self.assertEqual(self.cfn_calls.count('execute-change-set'),1)
        self.assertEqual(self.cfn_views,[(True,5),(False,12)])
        self.assertEqual(self.execute_dynamic(include_dependents=True)['status'],'complete')
        self.assertEqual(self.cfn_views,[(True,9),(False,12)])
        # Permissions also accept an explicit non-replacement in either view.
        for included in (False,True):
            def no_replacement(changes):
                for change in changes:
                    if change['ResourceChange']['ResourceType']=='AWS::Lambda::Permission':
                        change['ResourceChange']['Replacement']='False'
            self.assertEqual(self.execute_dynamic(no_replacement,include_dependents=included)['status'],'complete')

    def test_dynamic_dependents_omission_guards(self):
        for logical in ('RecoveryBackstop','RecoveryAllowBackstop','LifecycleVersion'):
            with self.subTest(logical=logical),self.assertRaisesRegex(ValueError,'change-set omits reviewed changes'):
                self.execute_dynamic(lambda changes:changes.__setitem__(slice(None),[
                    c for c in changes if c['ResourceChange']['LogicalResourceId']!=logical]))
            self.assertNotIn('execute-change-set',self.cfn_calls)
        with self.assertRaisesRegex(ValueError,'change-set omits reviewed changes'):
            self.execute_dynamic(mutate_ipv=lambda changes:changes.__setitem__(slice(None),[
                c for c in changes if c['ResourceChange']['LogicalResourceId']!='RecoveryPolicy']))
        self.assertEqual(len(self.cfn_views),1)  # Non-dependents must refuse before consulting the plain view.
        self.assertNotIn('execute-change-set',self.cfn_calls)

    def test_dynamic_dependents_detail_guards_in_both_views(self):
        cases=(('Action','Add','change-set action/type mismatch'),
               ('ResourceType','AWS::IAM::Role','change-set action/type mismatch'),
               ('Replacement','True','unexpected resource replacement'),
               ('Scope',[],'change-set scope mismatch'),
               ('Details',[],'change-set property details differ from exact review'),
               ('Evaluation','Static','unexplained Lambda ARN dependency'),
               ('CausingEntity','UnmodifiedLambda.Arn','unexplained Lambda ARN dependency'),
               ('ChangeSource','DirectModification','unexplained Lambda ARN dependency'),
               ('RequiresRecreation',None,'unexplained property recreation'),
               ('extra-property',None,'change-set property details differ from exact review'),
               ('Name','Description','change-set property details differ from exact review'),
               ('Attribute','Metadata','change-set property details differ from exact review'))
        for included in (False,True):
            for logical in ('RecoveryBackstop','RecoveryAllowBackstop'):
                for field,value,message in cases:
                    def mutate(changes):
                        r=next(c['ResourceChange'] for c in changes if c['ResourceChange']['LogicalResourceId']==logical)
                        if field in ('Action','ResourceType','Replacement','Scope','Details'):r[field]=value
                        elif field=='extra-property':
                            extra=copy.deepcopy(r['Details'][0]);extra['Target']['Name']='Description';r['Details'].append(extra)
                        elif field=='RequiresRecreation':
                            r['Details'][0]['Target'][field]='Never' if logical=='RecoveryAllowBackstop' else 'Always'
                        elif field in ('Name','Attribute'):r['Details'][0]['Target'][field]=value
                        else:r['Details'][0][field]=value
                    with self.subTest(included=included,logical=logical,field=field),self.assertRaisesRegex(ValueError,message):
                        self.execute_dynamic(mutate,include_dependents=included)
                    self.assertNotIn('execute-change-set',self.cfn_calls)

    def test_dynamic_lambda_dependents_execute_and_replacement_guard(self):
        self.assertEqual(self.execute_dynamic()['status'],'complete')
        self.assertEqual(self.cfn_calls.count('execute-change-set'),1)
        for index in (0,1,2):
            with self.subTest(index=index),self.assertRaisesRegex(ValueError,'unexpected resource replacement'):
                self.execute_dynamic(lambda changes:changes[index]['ResourceChange'].update(Replacement='True'))
            self.assertNotIn('execute-change-set',self.cfn_calls)

    def test_dynamic_lambda_dependents_execute_cause_guards(self):
        for field,value in (('Evaluation','Static'),('ChangeSource','DirectModification'),('CausingEntity','UnmodifiedLambda.Arn')):
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'unexplained Lambda ARN dependency'):
                self.execute_dynamic(lambda changes:changes[2]['ResourceChange']['Details'][0].update({field:value}))
            self.assertNotIn('execute-change-set',self.cfn_calls)
        with self.assertRaisesRegex(ValueError,'unexplained property recreation'):
            self.execute_dynamic(lambda changes:changes[0]['ResourceChange']['Details'][0]['Target'].update(RequiresRecreation='Always'))
        with self.assertRaisesRegex(ValueError,'change-set omits reviewed changes'):
            self.execute_dynamic(lambda changes:changes.pop())

    def templates(self):
        deny={'Effect':'Deny','Action':['ec2:DeleteSnapshot'],'Resource':'*'}
        before={'Resources':{'BoundaryEA298153':{'Type':'AWS::IAM::ManagedPolicy','Properties':{'PolicyDocument':{'Statement':[deny,{'Effect':'Allow','Action':['ec2:DescribeInstances'],'Resource':'*'}]}}}}}
        after=copy.deepcopy(before)
        after['Resources']['BoundaryEA298153']['Properties']['PolicyDocument']['Statement'][1]['Action'].append('ec2:DescribeSnapshots')
        review={'schemaVersion':1,'changes':{'BoundaryEA298153':{'action':'Modify','properties':['PolicyDocument'],'attributes':[]}}}
        after['Resources']['ImageJobBoundary']={'Type':'AWS::IAM::ManagedPolicy','Properties':{'ManagedPolicyName':'ezil-mum-image-job-boundary','Path':'/ezil/mum/','PolicyDocument':{'Statement':[deny,{'Effect':'Allow','Action':['ec2:DescribeSnapshots'],'Resource':'*'}]}}}
        review['changes']['ImageJobBoundary']={'action':'Add','properties':[],'attributes':[]}
        return before,after,review

    def test_exact_boundary_review_retains_denies(self):
        a,b,r=self.templates();self.assertEqual(cfn.validate_templates('identity',a,b,r),r['changes'])
        b['Resources']['BoundaryEA298153']['Properties']['PolicyDocument']['Statement'].pop(0)
        with self.assertRaises(ValueError):cfn.validate_templates('identity',a,b,r)

    def test_unreviewed_properties_network_storage_role_and_wildcards_refused(self):
        for mutation in ('resource','review','condition','wildcard','destructive','type'):
            a,b,r=self.templates()
            if mutation=='resource':b['Resources']['Bucket']={'Type':'AWS::S3::Bucket'}
            elif mutation=='review':r['changes']['BoundaryEA298153']['properties'].append('Description')
            elif mutation=='condition':b['Conditions']={'Outside':True}
            elif mutation=='type':b['Resources']['BoundaryEA298153']['Type']='AWS::IAM::Role'
            else:b['Resources']['BoundaryEA298153']['Properties']['PolicyDocument']['Statement'][1]['Action'].append('*' if mutation=='wildcard' else 'ec2:DeleteVolume')
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):cfn.validate_templates('identity',a,b,r)

    def test_foundation_template_is_unchanged_parameter_only(self):
        a={'Resources':{'ComputerLaunchTemplate':{'Type':'AWS::EC2::LaunchTemplate','Properties':{'LaunchTemplateData':{'ImageId':{'Ref':'HostAmiId'}}}}}}
        r={'schemaVersion':1,'changes':{'ComputerLaunchTemplate':{'action':'Modify','properties':['LaunchTemplateData'],'attributes':[]}}}
        cfn.validate_templates('foundation',a,copy.deepcopy(a),r)
        b=copy.deepcopy(a);b['Resources']['ComputerLaunchTemplate']['Properties']['LaunchTemplateData']['InstanceType']='p5.48xlarge'
        with self.assertRaises(ValueError):cfn.validate_templates('foundation',a,b,r)

    def test_exact_boundary_condition_expansion_preserves_identity_role(self):
        a,b,r=self.templates()
        role={'Type':'AWS::IAM::Role','Properties':{'RoleName':'unchanged','Policies':[{'PolicyDocument':{'Statement':[{'Effect':'Deny','Action':['iam:CreateRole'],'Resource':'*','Condition':{'StringNotEquals':{'iam:PermissionsBoundary':'arn:aws:iam::452630323510:policy/ezil/identity/ezil-mum-boundary'}}}]}}]}}
        a['Resources']['ExecRole']=role;b['Resources']['ExecRole']=cfn.image_boundary_condition(role)
        r['changes']['ExecRole']={'action':'Modify','properties':['Policies'],'attributes':[]}
        cfn.validate_templates('identity',a,b,r)
        b['Resources']['ExecRole']['Properties']['RoleName']='changed'
        with self.assertRaises(ValueError):cfn.validate_templates('identity',a,b,r)

    def test_role_write_tightening_is_accepted_but_widening_is_refused(self):
        a,b,r=self.templates()
        prefix='arn:aws:iam::452630323510:'
        role={'Type':'AWS::IAM::Role','Properties':{'RoleName':'unchanged','Policies':[{'PolicyName':'exec','PolicyDocument':{'Statement':[
            {'Effect':'Allow','Action':['iam:CreateRole'],'Resource':prefix+'role/ezil/mum/*','Condition':{'StringEquals':{'iam:PermissionsBoundary':prefix+'policy/ezil/identity/ezil-mum-boundary'}}}]}}]}}
        a['Resources']['ExecRole']=role;b['Resources']['ExecRole']=json.loads(json.dumps(role))
        narrow={'Effect':'Allow','Action':['iam:CreateRole','iam:DeleteRole'],'Resource':[prefix+'role/ezil/mum/ezil-mum-rebase-preparation',prefix+'role/ezil/mum/ezil-mum-recovery'],
                'Condition':{'StringEquals':{'iam:PermissionsBoundary':prefix+'policy/ezil/mum/ezil-mum-image-job-boundary'}}}
        b['Resources']['ExecRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'].append(narrow)
        b['Resources']['ExecRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'].append({'Effect':'Deny','Action':['iam:CreateRole'],'NotResource':narrow['Resource']})
        r['changes']['ExecRole']={'action':'Modify','properties':['Policies'],'attributes':[]}
        cfn.validate_templates('identity',a,b,r)
        for widen in ({'Resource':prefix+'role/ezil/mum/*'},{'Action':['iam:CreateRole','iam:PassRole']},{'Condition':{}}):
            c=json.loads(json.dumps(b));c['Resources']['ExecRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'][1].update(widen)
            with self.assertRaises(ValueError):cfn.validate_templates('identity',a,c,r)

    def test_image_role_existence_read_is_exact(self):
        a,b,r=self.templates()
        prefix='arn:aws:iam::452630323510:'
        role={'Type':'AWS::IAM::Role','Properties':{'RoleName':'unchanged','Policies':[{'PolicyName':'exec','PolicyDocument':{'Statement':[
            {'Effect':'Allow','Action':['iam:GetRole'],'Resource':prefix+'role/ezil/mum/*'}]}}]}}
        a['Resources']['ExecRole']=role;b['Resources']['ExecRole']=json.loads(json.dumps(role))
        read={'Effect':'Allow','Action':'iam:GetRole','Resource':[prefix+'role/ezil-mum-rebase-preparation',prefix+'role/ezil-mum-recovery']}
        b['Resources']['ExecRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'].append(read)
        r['changes']['ExecRole']={'action':'Modify','properties':['Policies'],'attributes':[]}
        cfn.validate_templates('identity',a,b,r)
        for widen in ({'Resource':prefix+'role/*'},{'Resource':[prefix+'role/ezil-mum-observer']},{'Action':['iam:GetRole','iam:PassRole']},
                      {'Action':'iam:GetRolePolicy'},{'Condition':{'StringEquals':{'aws:RequestedRegion':'ap-south-1'}}}):
            c=json.loads(json.dumps(b));c['Resources']['ExecRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'][1].update(widen)
            with self.assertRaises(ValueError,msg=str(widen)):cfn.validate_templates('identity',a,c,r)

    def test_new_boundary_must_copy_every_shared_global_deny(self):
        a,b,r=self.templates();stmts=b['Resources']['ImageJobBoundary']['Properties']['PolicyDocument']['Statement']
        removed=stmts.pop(0)
        # Removing a deny is a widening only when the boundary allows any of its actions; allow them.
        acts=removed.get('Action') or ['*'];acts=[acts] if isinstance(acts,str) else acts
        stmts.append({'Effect':'Allow','Action':acts,'Resource':'*'})
        with self.assertRaises(ValueError):cfn.validate_templates('identity',a,b,r)


class PoolIamTests(unittest.TestCase):
    boundary='BoundaryEA298153'
    controller='LifecycleControllerRoleDefaultPolicy31C0D948'

    def setUp(self):
        self.fixtures=manifest.read(HERE/'fixtures/pool-iam-templates.json')
        self.artifact=manifest.read(HERE.parent/'fixtures/pool-iam-review.mum.json')

    @staticmethod
    def exact_review(before,after):
        old,new=cfn.canonical_template(before)['Resources'],cfn.canonical_template(after)['Resources'];changes={}
        for key in old.keys() | new.keys():
            a,b=old.get(key),new.get(key)
            if a==b:continue
            if a is None or b is None:
                changes[key]={'action':'Add' if a is None else 'Remove','properties':[],'attributes':[]}
            else:
                changes[key]={'action':'Modify','properties':sorted(k for k in a.get('Properties',{}).keys() | b.get('Properties',{}).keys()
                    if cfn.ascii_view(a.get('Properties',{}).get(k))!=cfn.ascii_view(b.get('Properties',{}).get(k))),
                    'attributes':sorted(k for k in a.keys() | b.keys() if k!='Properties' and a.get(k)!=b.get(k))}
        return {'schemaVersion':1,'changes':changes}

    def policy(self,phase,logical,label='after'):
        return self.fixtures[phase][label]['Resources'][logical]['Properties']['PolicyDocument']['Statement']

    def repin(self,phase):
        f=self.fixtures[phase];self.artifact['stacks'][phase]=cfn.iam_delta(f['before'],f['after'])

    def validate(self,phase,artifact=True):
        f=self.fixtures[phase];review=self.exact_review(f['before'],f['after'])
        result=cfn.validate_templates(phase,f['before'],f['after'],review,pool_iam=self.artifact if artifact else None)
        self.assertEqual(result,review['changes'])
        return result

    def test_real_pool_templates_and_exact_artifact(self):
        for phase in self.fixtures:
            with self.subTest(phase=phase):self.validate(phase)
        self.assertNotIn('ImageJobBoundary',str(self.artifact))
        self.assertEqual(len(self.artifact['stacks']['workflows']),3)

    def test_pool_without_artifact_refused(self):
        for phase in self.fixtures:
            with self.subTest(phase=phase),self.assertRaises(ValueError):self.validate(phase,False)

    def test_pool_artifact_must_match_every_statement(self):
        original=copy.deepcopy(self.artifact)
        for phase,logical in (('identity',self.boundary),('workflows',self.controller)):
            for change in ('extra','duplicate','missing','wrong-resource','removed'):
                self.artifact=copy.deepcopy(original);delta=self.artifact['stacks'][phase][logical]
                if change=='extra':delta['added'].append({'Effect':'Allow','Action':'ec2:DescribeVpcs','Resource':'*'})
                elif change=='duplicate':delta['added'].append(copy.deepcopy(delta['added'][0]))
                elif change=='missing':delta['added'].pop(0)
                elif change=='removed':delta['removed'].pop(0)
                else:self.artifact['stacks'][phase][logical+'Wrong']=self.artifact['stacks'][phase].pop(logical)
                with self.subTest(phase=phase,change=change),self.assertRaisesRegex(ValueError,'statement delta differs'):
                    self.validate(phase)

    def test_pool_allow_requires_both_resource_tag_conditions(self):
        original=copy.deepcopy(self.fixtures)
        for action in ('ec2:DetachVolume','ec2:DeleteTags','ec2:TerminateInstances'):
            for tag in ('managed-by','stage'):
                for change in ('missing','wrong','request-tag','if-exists','list'):
                    self.fixtures=copy.deepcopy(original)
                    s=next(s for s in self.policy('workflows',self.controller) if s['Effect']=='Allow' and s['Action']==action)
                    equals=s['Condition']['StringEquals'];key='ec2:ResourceTag/ezil:'+tag;value=equals.pop(key)
                    if change=='wrong':equals[key]='wrong'
                    elif change=='request-tag':equals['aws:RequestTag/ezil:'+tag]=value
                    elif change=='if-exists':s['Condition']['StringEqualsIfExists']={key:value}
                    elif change=='list':equals[key]=[value,'other']
                    self.repin('workflows')
                    with self.subTest(action=action,tag=tag,change=change),self.assertRaisesRegex(ValueError,'Allow requires managed-by and stage'):
                        self.validate('workflows')

    def test_pool_resource_tag_forms_accepted(self):
        for s in self.policy('workflows',self.controller):
            equals=s.get('Condition',{}).get('StringEquals',{})
            for tag in ('managed-by','stage'):
                key='ec2:ResourceTag/ezil:'+tag
                if key in equals:equals['aws:ResourceTag/ezil:'+tag]=equals.pop(key)
        self.repin('workflows');self.validate('workflows')

    def test_pool_mixed_case_unconditioned_actions_refused(self):
        for action in ('ec2:terminateinstances','EC2:DeleteVolume','Ec2:DetachVolume'):
            self.setUp()
            self.policy('workflows',self.controller).append({'Effect':'Allow','Action':action})
            self.repin('workflows')
            with self.subTest(action=action),self.assertRaises(ValueError):self.validate('workflows')

    def test_pool_mixed_case_condition_keys_accepted(self):
        for prefix in ('AWS:resourcetag','eC2:rEsOuRcEtAg'):
            self.setUp()
            for s in self.policy('workflows',self.controller):
                equals=s.get('Condition',{}).get('StringEquals',{})
                for tag in ('managed-by','stage'):
                    key='ec2:ResourceTag/ezil:'+tag
                    if key in equals:equals[prefix+'/EZIL:'+tag.upper()]=equals.pop(key)
            self.repin('workflows');self.validate('workflows')

    def test_pool_tag_values_remain_case_sensitive(self):
        for tag in ('managed-by','stage'):
            self.setUp()
            s=next(s for s in self.policy('workflows',self.controller) if s['Action']=='ec2:TerminateInstances')
            equals=s['Condition']['StringEquals'];key='ec2:ResourceTag/ezil:'+tag
            equals['AWS:resourcetag/ezil:'+tag]=equals.pop(key).upper()
            self.repin('workflows')
            with self.subTest(tag=tag),self.assertRaisesRegex(ValueError,'Allow requires managed-by and stage'):
                self.validate('workflows')

    def test_pool_action_case_normalization(self):
        self.assertEqual(cfn.action_set({'Action':'Ec2:TerminateInstances'}),{'ec2:terminateinstances'})
        self.assertEqual(cfn.action_set({'Action':['EC2:DeleteVolume','Ec2:DetachVolume']}),
                         {'ec2:deletevolume','ec2:detachvolume'})
        for key in ('Action','NotAction'):
            for action in ('EC2:DescribeInstances',['EC2:DescribeInstances','ec2:DescribeVolumes']):
                original={'Effect':'Deny',key:action}
                lower=action.casefold() if isinstance(action,str) else sorted(a.casefold() for a in action)
                self.assertEqual(cfn.canonical_iam(original),{'Effect':'Deny',key:lower})
                self.assertEqual(cfn.statement_key(original),cfn.statement_key({'Effect':'Deny',key:lower}))
        # Case-only edits create no delta, and changed templates still pair mixed-case denies.
        for phase,f in self.fixtures.items():
            for label in ('before','after'):
                original=copy.deepcopy(f[label])
                for s in cfn.statements(f[label]):
                    if 'Action' in s:
                        a=s['Action'];s['Action']=a.swapcase() if isinstance(a,str) else [v.swapcase() for v in a]
                self.assertEqual(cfn.iam_delta(original,f[label]),{})
            self.validate(phase)

    def test_pool_review_action_case_ignored(self):
        for resources in self.artifact['stacks'].values():
            for delta in resources.values():
                for ss in delta.values():
                    for s in ss:
                        if 'Action' in s:
                            a=s['Action'];s['Action']=a.swapcase() if isinstance(a,str) else [v.swapcase() for v in a]
        for phase in self.fixtures:self.validate(phase)

    def test_pool_mixed_case_kms_wildcards(self):
        original=copy.deepcopy(self.fixtures)
        for resource,accepted in (({'Fn::GetAtt':['PoolTestKey','Arn']},True),('*',False)):
            self.fixtures=copy.deepcopy(original);f=self.fixtures['workflows']
            for label in ('before','after'):f[label]['Resources']['PoolTestKey']={'Type':'AWS::KMS::Key'}
            self.policy('workflows',self.controller).append({'Effect':'Allow',
                'Action':['KMS:gEnErAtEdAtAkEy*','KmS:ReEncrypt*'],'Resource':resource})
            self.repin('workflows')
            if accepted:self.validate('workflows')
            else:
                with self.assertRaisesRegex(ValueError,'unreviewed destructive/wildcard'):self.validate('workflows')

    def test_pool_second_boundary_is_not_shared(self):
        f=self.fixtures['identity'];alias='Boundary2EA298153'
        for label in ('before','after'):
            f[label]['Resources'][alias]=copy.deepcopy(f['before']['Resources'][self.boundary])
        self.validate('identity')  # A second, unchanged ManagedPolicy is not the shared boundary.
        f['after']['Resources'][alias]=copy.deepcopy(f['after']['Resources'][self.boundary])
        self.repin('identity')
        with self.assertRaisesRegex(ValueError,'deny removal exceeds shared boundary allowance'):
            cfn.validate_pool_iam('identity',f['before'],f['after'],self.artifact)

    def test_pool_shared_boundary_resource_type_required(self):
        f=self.fixtures['identity']
        for label in ('before','after'):f[label]['Resources'][self.boundary]['Type']='AWS::IAM::Policy'
        with self.assertRaisesRegex(ValueError,'deny removal exceeds shared boundary allowance'):
            cfn.validate_pool_iam('identity',f['before'],f['after'],self.artifact)

    def test_pool_controller_exact_id_and_type_required(self):
        for change in ('alias','type','deny-alias'):
            self.setUp();f=self.fixtures['workflows']
            for label in ('before','after'):
                resources=f[label]['Resources']
                if change=='alias':resources[self.controller+'Extra']=resources.pop(self.controller)
                elif change=='type':resources[self.controller]['Type']='AWS::IAM::ManagedPolicy'
                else:
                    policy=self.policy('workflows',self.controller,label)
                    denies=[s for s in policy if cfn.statement_key(s)==cfn.statement_key(cfn.pool_type_deny())]
                    for deny in denies:policy.remove(deny)
                    resources[self.controller+'Extra']={'Type':'AWS::IAM::Policy','Properties':{'PolicyDocument':{'Statement':denies}}}
            self.repin('workflows')
            if change=='alias':
                with self.assertRaisesRegex(ValueError,'RunInstances type Deny required'):self.validate('identity')
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'RunInstances type Deny required'):
                self.validate('workflows')

    def test_pool_other_deny_removals_refused(self):
        original=copy.deepcopy(self.fixtures)
        cases=[('identity',self.boundary),('identity',next(k for k in self.fixtures['identity']['after']['Resources'] if k.startswith('ImageJobBoundary'))),
               ('workflows','RecoveryRecoveryRoleDefaultPolicy2A415109')]
        for phase,logical in cases:
            for action in ('ec2:DeleteVolume','ec2:DetachVolume','ec2:DeleteTags'):
                self.fixtures=copy.deepcopy(original)
                # Shared boundary already removed both pool denies; remove another deny instead.
                if logical==self.boundary and action!='ec2:DeleteVolume':continue
                s=next(s for s in self.policy(phase,logical) if s['Effect']=='Deny' and action.casefold() in cfn.action_set(s))
                s['Action'].remove(action);self.repin(phase)
                with self.subTest(phase=phase,logical=logical,action=action),self.assertRaisesRegex(ValueError,'deny removal exceeds'):
                    self.validate(phase)

    def test_pool_boundary_matching_allow_required(self):
        old=next(s for s in self.policy('identity',self.boundary,'before') if s['Effect']=='Allow' and 'ec2:attachvolume' in cfn.action_set(s))
        statements=self.policy('identity',self.boundary)
        index=next(i for i,s in enumerate(statements) if s['Effect']=='Allow' and 'ec2:detachvolume' in cfn.action_set(s))
        statements[index]=copy.deepcopy(old);self.repin('identity')
        with self.assertRaisesRegex(ValueError,'boundary requires matching conditioned Allow'):self.validate('identity')

    def test_pool_shared_boundary_has_no_other_allow_changes(self):
        old=next(s for s in self.policy('identity',self.boundary,'before')
                 if s['Effect']=='Allow' and 'ec2:attachvolume' not in cfn.action_set(s))
        statement=next(s for s in self.policy('identity',self.boundary) if cfn.statement_key(s)==cfn.statement_key(old))
        statement['Action']=sorted(cfn.action_set(statement) | {'ec2:DescribeHosts'})
        self.repin('identity')
        with self.assertRaisesRegex(ValueError,'shared boundary change exceeds DescribeSnapshots'):self.validate('identity')

    def test_pool_type_deny_required(self):
        original=copy.deepcopy(self.fixtures)
        for change in ('missing','extra-type','no-pool-condition','wrong-resource','other-policy'):
            self.fixtures=copy.deepcopy(original)
            statements=self.policy('workflows',self.controller)
            s=next(s for s in statements if s['Effect']=='Deny' and s['Action']=='ec2:RunInstances')
            if change=='missing':statements.remove(s)
            elif change=='extra-type':s['Condition']['StringNotEquals']['ec2:InstanceType'].append('m6i.2xlarge')
            elif change=='no-pool-condition':del s['Condition']['Null']
            elif change=='wrong-resource':s['Resource']='arn:aws:ec2:ap-south-1:452630323510:volume/*'
            else:
                statements.remove(s);self.policy('workflows','RecoveryRecoveryRoleDefaultPolicy2A415109').append(s)
            self.repin('workflows')
            for phase in ('identity','workflows'):
                with self.subTest(change=change,phase=phase),self.assertRaisesRegex(ValueError,'RunInstances type Deny required'):
                    self.validate(phase)

    def test_pool_artifact_schema_and_namespace(self):
        original=copy.deepcopy(self.artifact)
        for change in ('version','extra','delta-extra','namespace'):
            self.artifact=copy.deepcopy(original)
            if change=='version':self.artifact['schemaVersion']=True
            elif change=='extra':self.artifact['unreviewed']=True
            elif change=='delta-extra':self.artifact['stacks']['identity'][self.boundary]['unreviewed']=[]
            else:self.artifact['namespace']='production'
            message='namespace mismatch' if change=='namespace' else 'invalid pool IAM review'
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,message):self.validate('identity')

    def test_pool_action_reorder_is_unchanged(self):
        for phase in self.fixtures:
            f=self.fixtures[phase];f['after']=copy.deepcopy(f['before'])
            for s in cfn.statements(f['after']):
                if isinstance(s.get('Action'),list):s['Action'].reverse()
            self.assertEqual(cfn.iam_delta(f['before'],f['after']),{})
            self.assertEqual(self.validate(phase,False),{})

    def test_pool_provider_can_review_exact_reordered_property(self):
        f=self.fixtures['identity'];review=self.exact_review(f['before'],f['after'])
        logical=next(k for k in f['after']['Resources'] if k.startswith('ImageJobBoundary'))
        review['changes'][logical]={'action':'Modify','properties':['PolicyDocument'],'attributes':[]}
        self.assertEqual(cfn.validate_templates('identity',f['before'],f['after'],review,pool_iam=self.artifact),review['changes'])
        for change in ('extra-property','missing-property','attribute','action'):
            bad=copy.deepcopy(review);entry=bad['changes'][logical]
            if change=='extra-property':entry['properties'].append('Description')
            elif change=='missing-property':entry['properties']=[]
            elif change=='attribute':entry['attributes']=['Metadata']
            else:entry['action']='Add'
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'exactly enumerate template changes'):
                cfn.validate_templates('identity',f['before'],f['after'],bad,pool_iam=self.artifact)

    def test_pool_review_action_and_statement_order_ignored(self):
        for resources in self.artifact['stacks'].values():
            for delta in resources.values():
                for ss in delta.values():
                    ss.reverse()
                    for s in ss:
                        if isinstance(s.get('Action'),list):s['Action'].reverse()
        for phase in self.fixtures:self.validate(phase)

    def test_pool_action_normalization_does_not_hide_non_iam_changes(self):
        f=self.fixtures['workflows'];f['after']=copy.deepcopy(f['before'])
        for label in ('before','after'):
            f[label]['Resources']['Observer']={'Type':'AWS::Lambda::Function','Properties':{'Metadata':{'Effect':'Allow','Action':['first','second']}}}
        f['after']['Resources']['Observer']['Properties']['Metadata']['Action'].reverse()
        with self.assertRaisesRegex(ValueError,'exactly enumerate template changes'):
            cfn.validate_templates('workflows',f['before'],f['after'],{'schemaVersion':1,'changes':{}})

    def test_pool_does_not_bypass_other_guards(self):
        original=copy.deepcopy(self.fixtures)
        for change in ('wildcard','delete-volume','inverse','boundary-property','deny-condition','other-array'):
            self.fixtures=copy.deepcopy(original);phase='workflows'
            statements=self.policy(phase,self.controller)
            if change=='boundary-property':
                phase='identity';self.fixtures[phase]['after']['Resources'][self.boundary]['Properties']['Description']='unreviewed'
            elif change=='deny-condition':
                phase='identity';s=next(s for s in self.policy(phase,self.boundary) if s['Effect']=='Deny' and 'ec2:deletevolume' in cfn.action_set(s))
                s['Condition']={'StringEquals':{'aws:RequestedRegion':'ap-south-1'}}
            elif change=='other-array':
                s=next(s for s in statements if s['Action']=='ec2:DeleteTags')
                s['Condition']['StringEquals']['ec2:InstanceType'].reverse()
            else:
                s=next(s for s in statements if s['Action']=='ec2:DetachVolume')
                if change=='inverse':s['NotResource']=s.pop('Resource')
                else:s['Action']=['ec2:DetachVolume','*' if change=='wildcard' else 'ec2:DeleteVolume']
            if change!='other-array':self.repin(phase)
            with self.subTest(change=change),self.assertRaises(ValueError):self.validate(phase)

    def test_pool_pin_verify_and_execute(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);specs={}
            for phase,f in self.fixtures.items():
                spec={'stackName':cfn.STACKS[phase],'changeSetArn':'arn:aws:cloudformation:ap-south-1:452630323510:changeSet/pool/123',
                      'roleArn':None if phase=='identity' else cfn.ROLE}
                for name,value in (('beforeTemplate',f['before']),('candidateTemplate',f['after']),('review',self.exact_review(f['before'],f['after']))):
                    path=root/(phase+'-'+name+'.json');TOOL.write(path,value);spec[name+'Path']=str(path)
                specs[phase]=spec
            foundation=root/'foundation.json';TOOL.write(foundation,{'Resources':{}})
            review=root/'foundation-review.json';TOOL.write(review,{'schemaVersion':1,'changes':{'ComputerLaunchTemplate':{'action':'Modify','properties':['LaunchTemplateData'],'attributes':[]}}})
            specs['foundation']={**specs['workflows'],'stackName':cfn.STACKS['foundation'],'beforeTemplatePath':str(foundation),
                                 'candidateTemplatePath':str(foundation),'reviewPath':str(review)}
            artifact=root/'pool-iam-review.json';TOOL.write(artifact,self.artifact)
            path=root/'rollout.json';TOOL.write(path,{'schemaVersion':1,'poolIam':str(artifact),'stacks':specs,
                'app':{'tag':'reviewed-pool','gitSha':'a'*40,'checksumSha256':'f'*64}})
            pinned=RELEASE.pin_rollout(path,{'agentCommit':'a'*40})
            self.assertEqual(pinned['poolIam'],str(artifact));self.assertEqual(pinned['poolIamSha256'],RELEASE.digest(artifact))
            RELEASE.verify_rollout(pinned)
            def offline_aws(*args):raise RuntimeError('offline read reached')
            # Reaching the first mocked read proves execute revalidates with the pinned review.
            for phase in ('identity','workflows'):
                with self.assertRaisesRegex(RuntimeError,'offline read reached'):
                    cfn.execute(phase,pinned['stacks'][phase],root,False,offline_aws,TOOL.write,RELEASE.digest,pool_iam=pinned)
            artifact.write_text(artifact.read_text()+'\n')
            with self.assertRaisesRegex(ValueError,'reviewed pool IAM artifact changed'):RELEASE.verify_rollout(pinned)
            with self.assertRaisesRegex(ValueError,'reviewed pool IAM artifact changed'):
                cfn.execute('identity',pinned['stacks']['identity'],root,False,offline_aws,TOOL.write,RELEASE.digest,pool_iam=pinned)


class PoolIamIncrementalTests(unittest.TestCase):
    controller=PoolIamTests.controller
    exact_review=staticmethod(PoolIamTests.exact_review)
    policy=PoolIamTests.policy
    repin=PoolIamTests.repin

    def setUp(self):
        fixture=manifest.read(HERE/'fixtures/pool-iam-incremental.json')
        self.fixtures={phase:fixture[phase] for phase in ('identity','workflows')}
        self.artifact=fixture['artifact'];self.review=fixture['review']

    def validate(self,phase,artifact=True):
        f=self.fixtures[phase];review=self.exact_review(f['before'],f['after'])
        result=cfn.validate_templates(phase,f['before'],f['after'],review,
            unchanged=phase=='identity',pool_iam=self.artifact if artifact else None)
        self.assertEqual(result,review['changes'])
        return result

    def test_real_incremental_delta_accepted(self):
        f=self.fixtures['workflows'];delta=self.artifact['stacks']['workflows']
        self.assertEqual(cfn.iam_delta(f['before'],f['after']),delta)
        self.assertEqual({k:len(v) for k,v in delta[self.controller].items()},{'added':3,'removed':3})
        self.assertEqual(self.artifact['stacks']['identity'],{})
        self.assertEqual(self.validate('workflows'),self.review['changes'])
        self.assertEqual(self.validate('identity'),{})

    def test_incremental_without_artifact_refused(self):
        with self.assertRaisesRegex(ValueError,'unreviewed destructive/wildcard IAM grants'):
            self.validate('workflows',False)

    def test_incremental_after_type_deny_required(self):
        for change in ('missing','extra-type','no-pool-condition','wrong-resource','other-policy','metadata'):
            self.setUp();policy=self.policy('workflows',self.controller)
            deny=next(s for s in policy if s['Effect']=='Deny')
            if change=='extra-type':deny['Condition']['StringNotEquals']['ec2:InstanceType'].append('m6i.2xlarge')
            elif change=='no-pool-condition':del deny['Condition']['Null']
            elif change=='wrong-resource':deny['Resource']='*'
            else:
                policy.remove(deny)
                resources=self.fixtures['workflows']['after']['Resources']
                if change=='other-policy':resources[self.controller+'Extra']={'Type':'AWS::IAM::Policy',
                    'Properties':{'PolicyDocument':{'Statement':[deny]}}}
                elif change=='metadata':resources[self.controller]['Metadata']['decoy']=deny
            # Keep the artifact unchanged: the live BEFORE Deny cannot prove AFTER presence.
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'RunInstances type Deny required'):
                self.validate('workflows')

    def test_incremental_controller_exact_id_and_type_required(self):
        for change in ('alias','managed-policy','role'):
            self.setUp()
            for label in ('before','after'):
                resources=self.fixtures['workflows'][label]['Resources']
                if change=='alias':resources[self.controller+'Extra']=resources.pop(self.controller)
                else:resources[self.controller]['Type']='AWS::IAM::ManagedPolicy' if change=='managed-policy' else 'AWS::IAM::Role'
            self.repin('workflows')
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'RunInstances type Deny required'):
                self.validate('workflows')

    def test_incremental_type_deny_removal_refused(self):
        for change in ('removed','mixed-case','broader-deny','other-policy','added-again'):
            self.setUp();policy=self.policy('workflows',self.controller)
            deny=next(s for s in policy if s['Effect']=='Deny')
            if change=='broader-deny':deny['Action']=['ec2:RunInstances','ec2:StartInstances']
            elif change=='other-policy':
                for label in ('before','after'):
                    self.fixtures['workflows'][label]['Resources']['OtherPolicy']={'Type':'AWS::IAM::Policy',
                        'Properties':{'PolicyDocument':{'Statement':[copy.deepcopy(deny)] if label=='before' else []}}}
            else:policy.remove(deny)
            self.repin('workflows')
            delta=self.artifact['stacks']['workflows'][self.controller]
            if change=='mixed-case':
                next(s for s in delta['removed'] if s['Effect']=='Deny')['Action']='eC2:rUNiNSTANCES'
            elif change=='added-again':delta['added'].append(copy.deepcopy(deny))
            for phase in ('identity','workflows'):
                with self.subTest(change=change,phase=phase),self.assertRaisesRegex(ValueError,'RunInstances type Deny removal refused'):
                    self.validate(phase)

    def test_incremental_detach_requires_both_resource_conditions(self):
        for index in (0,1):
            for tag in ('managed-by','stage'):
                for action in ('ec2:DetachVolume','EC2:DETACHVOLUME','eC2:dEtAcHvOlUmE'):
                    self.setUp()
                    added=[s for s in self.policy('workflows',self.controller) if 'ec2:detachvolume' in cfn.action_set(s)]
                    self.assertEqual(len(added),2)
                    statement=added[index];statement['Action']=[action if a.casefold()=='ec2:detachvolume' else a for a in statement['Action']]
                    del statement['Condition']['StringEquals']['ec2:ResourceTag/ezil:'+tag]
                    self.repin('workflows')
                    for phase in ('identity','workflows'):
                        with self.subTest(index=index,tag=tag,action=action,phase=phase),self.assertRaisesRegex(ValueError,'Allow requires managed-by and stage'):
                            self.validate(phase)

    def test_incremental_artifact_must_match_every_statement(self):
        for change in ('added','removed','extra','duplicate'):
            self.setUp();delta=self.artifact['stacks']['workflows'][self.controller]
            if change in ('added','removed'):delta[change].pop()
            elif change=='extra':delta['added'].append({'Effect':'Allow','Action':'ec2:DescribeVpcs','Resource':'*'})
            else:delta['added'].append(copy.deepcopy(delta['added'][0]))
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'statement delta differs'):
                self.validate('workflows')

    def test_incremental_unreviewed_identity_delta_refused(self):
        self.fixtures['identity']['after']['Resources']['UnreviewedPolicy']={'Type':'AWS::IAM::Policy',
            'Properties':{'PolicyDocument':{'Statement':[{'Effect':'Allow','Action':'ec2:DescribeVpcs','Resource':'*'}]}}}
        with self.assertRaisesRegex(ValueError,'statement delta differs'):self.validate('identity')

    def test_incremental_identity_change_requires_enable_review(self):
        # An incremental artifact (no type Deny added) may not carry an identity delta: identity
        # would otherwise apply before workflows proves the Deny.
        self.fixtures['identity']['after']['Resources']['UnreviewedPolicy']={'Type':'AWS::IAM::Policy',
            'Properties':{'PolicyDocument':{'Statement':[{'Effect':'Allow','Action':'ec2:DescribeVpcs','Resource':'*'}]}}}
        # A controller-named policy carrying the Deny in the identity template must not satisfy the rule.
        self.fixtures['identity']['after']['Resources'][self.controller]={'Type':'AWS::IAM::Policy',
            'Properties':{'PolicyDocument':{'Statement':[cfn.pool_type_deny()]}}}
        self.artifact['stacks']['identity']=cfn.iam_delta(self.fixtures['identity']['before'],self.fixtures['identity']['after'])
        with self.assertRaisesRegex(ValueError,'RunInstances type Deny required'):self.validate('identity')

    def test_incremental_deny_case_folding(self):
        for label in ('before','after'):
            deny=next(s for s in self.policy('workflows',self.controller,label) if s['Effect']=='Deny')
            deny['Action']='eC2:rUNiNSTANCES'
        self.validate('workflows')

    def test_incremental_empty_stacks_and_schema(self):
        self.fixtures['workflows']['after']=copy.deepcopy(self.fixtures['workflows']['before'])
        self.artifact['stacks']['workflows']={}
        self.validate('identity')
        f=self.fixtures['workflows']
        self.assertEqual(cfn.validate_pool_iam('workflows',f['before'],f['after'],self.artifact),{})
        original=copy.deepcopy(self.artifact)
        for key in ('identity','workflows'):
            self.artifact=copy.deepcopy(original);del self.artifact['stacks'][key]
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'invalid pool IAM review'):
                self.validate('identity')

    def test_incremental_presence_exception_only_identity_and_workflows(self):
        f=self.fixtures['workflows']
        # Foundation (release 1.0.9, live 2026-10-24) runs with the pinned artifact but gains no allowance.
        self.assertEqual(cfn.validate_pool_iam('foundation',f['before'],f['after'],self.artifact),{})
        stripped=copy.deepcopy(f['after'])
        policy=stripped['Resources'][self.controller]['Properties']['PolicyDocument']['Statement']
        policy[:]=[s for s in policy if cfn.statement_key(s)!=cfn.statement_key(cfn.pool_type_deny())]
        # Workflows still proves the Deny itself; foundation cannot stand in for it.
        with self.assertRaisesRegex(ValueError,'RunInstances type Deny required'):
            cfn.validate_pool_iam('workflows',f['before'],stripped,self.artifact)
        removal=copy.deepcopy(self.artifact)
        removal['stacks']['workflows'][self.controller]['removed'].append(cfn.pool_type_deny())
        with self.assertRaisesRegex(ValueError,'type Deny removal refused'):
            cfn.validate_pool_iam('foundation',f['before'],f['after'],removal)


class PoolIamPremiumTests(unittest.TestCase):
    """Actual full validator, with the approved replacement on an existing pool."""
    controller=PoolIamIncrementalTests.controller
    policy=PoolIamIncrementalTests.policy
    repin=PoolIamIncrementalTests.repin
    exact_review=staticmethod(PoolIamIncrementalTests.exact_review)
    validate=PoolIamIncrementalTests.validate

    def setUp(self):
        PoolIamIncrementalTests.setUp(self)
        policy=self.policy('workflows',self.controller)
        deny=next(s for s in policy if cfn.statement_key(s)==cfn.statement_key(cfn.pool_type_deny()))
        deny['Condition']['StringNotEquals']['ec2:InstanceType'].append('m6i.2xlarge')
        self.repin('workflows')

    def test_premium_transition_requires_explicit_exact_review(self):
        self.validate('identity');self.validate('workflows')
        with self.assertRaisesRegex(ValueError,'existing IAM deny weakened'):self.validate('workflows',False)
        self.artifact['stacks']['workflows'][self.controller]['added'].pop()
        with self.assertRaises(ValueError):self.validate('workflows')

    def test_premium_steady_state_and_fourth_type_refusal(self):
        prior=next(s for s in self.policy('workflows',self.controller,'before')
                   if cfn.statement_key(s)==cfn.statement_key(cfn.pool_type_deny()))
        prior['Condition']['StringNotEquals']['ec2:InstanceType'].append('m6i.2xlarge')
        self.repin('workflows');self.validate('workflows')
        deny=next(s for s in self.policy('workflows',self.controller) if cfn.statement_key(s)==cfn.statement_key(cfn.pool_type_deny(True)))
        deny['Condition']['StringNotEquals']['ec2:InstanceType'].append('m6i.4xlarge')
        self.repin('workflows')
        with self.assertRaises(ValueError):self.validate('workflows')

    def test_premium_exact_statement_and_controller_matrix(self):
        for change in ('action','extra-action','not-action','resource','not-resource','tag','null','extra-condition',
                       'fourth-type','partial-types','effect','extra-field','other-controller','attachment','duplicate-old'):
            with self.subTest(change=change):
                self.setUp()
                policy=self.policy('workflows',self.controller)
                deny=next(s for s in policy if cfn.statement_key(s)==cfn.statement_key(cfn.pool_type_deny(True)))
                if change=='action':deny['Action']='ec2:StartInstances'
                elif change=='extra-action':deny['Action']=['ec2:RunInstances','ec2:StartInstances']
                elif change=='not-action':deny['NotAction']=deny.pop('Action')
                elif change=='resource':deny['Resource']='*'
                elif change=='not-resource':deny['NotResource']=deny.pop('Resource')
                elif change=='tag':deny['Condition']['Null']={'aws:RequestTag/ezil:other':'false'}
                elif change=='null':deny['Condition']['Null']['aws:RequestTag/ezil:pool']='true'
                elif change=='extra-condition':deny['Condition']['StringEquals']={'aws:RequestTag/ezil:stage':'mum'}
                elif change=='fourth-type':deny['Condition']['StringNotEquals']['ec2:InstanceType'].append('m6i.4xlarge')
                elif change=='partial-types':deny['Condition']['StringNotEquals']['ec2:InstanceType'].remove('m6i.large')
                elif change=='effect':deny['Effect']='Allow'
                elif change=='extra-field':deny['Sid']='not-the-exact-reviewed-deny'
                elif change=='other-controller':
                    policy.remove(deny)
                    self.fixtures['workflows']['after']['Resources']['OtherController']={'Type':'AWS::IAM::Policy',
                        'Properties':{'PolicyDocument':{'Statement':[deny]}}}
                elif change=='attachment':
                    self.fixtures['workflows']['after']['Resources'][self.controller]['Properties']['Roles']=[{'Ref':'OtherRole'}]
                else:self.policy('workflows',self.controller,'before').append(copy.deepcopy(cfn.pool_type_deny()))
                self.repin('workflows')
                with self.assertRaises(ValueError):self.validate('workflows')

    def test_premium_does_not_exempt_other_denies_or_inverse_wildcard_grants(self):
        for change in ('other-deny','inverse','wildcard','forbidden'):
            with self.subTest(change=change):
                self.setUp()
                if change=='other-deny':
                    self.policy('workflows',self.controller,'before').append({'Effect':'Deny','Action':'ec2:DeleteVolume','Resource':'*'})
                else:
                    self.policy('workflows',self.controller).append({'Effect':'Allow',
                        ('NotAction' if change=='inverse' else 'Action'): 'ec2:DescribeInstances' if change=='inverse' else 'ec2:*' if change=='wildcard' else 'ec2:DeleteVolume',
                        'Resource':'*'})
                self.repin('workflows')
                with self.assertRaises(ValueError):self.validate('workflows')


class IntegrationTests(unittest.TestCase):
    cli=stage1.ReleaseTests.cli

    def setUp(self):
        stage1.ReleaseTests.setUp(self)
        self.source=manifest.read(self.directory/'previous-rebase-release.json')
        self.source.update(launchTemplateVersion='1',stateMachineVersionArn=TOOL.MACHINE+':1')
        TOOL.write(self.directory/'previous-rebase-release.json',self.source)
        TOOL.write(self.directory/'deployed-release.json',self.source)
        checkout=self.root/'checkout'
        installer=checkout/'deploy/aws/os-staging/install-host.sh';installer.parent.mkdir(parents=True)
        installer.write_text((HERE.parents[3]/'deploy/aws/os-staging/install-host.sh').read_text())
        self.addCleanup(patch.stopall)
        patch.object(RELEASE,'REPO',checkout).start()
        patch.object(RELEASE,'LEDGER_PATH',self.ledger).start()
        patch.object(RELEASE.json_tool,'APP_SECRET_LOCK',str(self.root/'app-secret.lock')).start()
        patch('sys.stdout',new_callable=io.StringIO).start()
        self.specs={};self.templates={};self.cloud={};self.calls=[];self.payloads={};self.commands={}
        self.running_sha='e'*40;self.command_results={};self.bad_install=False;self.lt_override={}
        self.stale_install=False;self.invocation_status={};self.command_status={};self.status_errors=set()
        self.delay_install=False;self.crash_poll=None;self.lost_send=None;self.lookup_page=False;self.lookup_submission_page=False
        self.fail_app=False;self.lost_put=False;self.lost_execute=False;self.bad_change=False;self.null_params=False
        self.identity_status='UPDATE_COMPLETE';self.identity_parameters=[];self.identity_live=None
        self.generation=0
        self.envelope={'VersionId':'initial','SecretString':json.dumps({'keep':'synthetic','EZIL_AWS_KILL_SWITCH':'1',TOOL.KEY:{TOOL.REGION:dict(self.source,releases=[self.source]),'other':{'keep':True}}})}
        stage1.seed_ledger(self.ledger,self.envelope)
        self.outer_original=manifest.loads(self.envelope['SecretString'])
        self.running_deployment=app_ops.public_deployment(self.outer_original[TOOL.KEY][TOOL.REGION])
        for phase in cfn.STACKS:
            if phase=='identity':before,after,review=CloudFormationTests().templates()
            elif phase=='foundation':
                before={'Resources':{'ComputerLaunchTemplate':{'Type':'AWS::EC2::LaunchTemplate','Properties':{'LaunchTemplateData':{'ImageId':{'Ref':'HostAmiId'}}}}}}
                after=copy.deepcopy(before);review={'schemaVersion':1,'changes':{'ComputerLaunchTemplate':{'action':'Modify','properties':['LaunchTemplateData'],'attributes':[]}}}
            else:
                before={'Resources':{'Observer':{'Type':'AWS::Lambda::Function','Properties':{'Code':{'S3Key':'before.zip'}}}}}
                for role in ('RebasePreparationRole','RecoveryRole'):
                    before['Resources'][role]={'Type':'AWS::IAM::Role','Properties':{'PermissionsBoundary':'arn:aws:iam::452630323510:policy/ezil/mum/ezil-mum-image-job-boundary'}}
                after=copy.deepcopy(before);after['Resources']['Observer']['Properties']['Code']['S3Key']='reviewed.zip'
                review={'schemaVersion':1,'changes':{'Observer':{'action':'Modify','properties':['Code'],'attributes':[]}}}
            spec={'stackName':cfn.STACKS[phase],'changeSetArn':'arn:aws:cloudformation:ap-south-1:452630323510:changeSet/rebase-'+phase+'/11111111-1111-4111-8111-111111111111','roleArn':None if phase=='identity' else cfn.ROLE}
            for key,value in (('beforeTemplate',before),('candidateTemplate',after),('review',review)):
                path=self.root/(phase+'-'+key+'.json');TOOL.write(path,value);spec[key+'Path']=str(path)
            self.specs[phase]=spec;self.templates[phase]=(before,after,review);self.cloud[phase]=False
        self.rollout=self.root/'rollout.json'
        TOOL.write(self.rollout,{'schemaVersion':1,'stacks':self.specs,'app':{'tag':'reviewed-v1','gitSha':self.value['agentCommit'],'checksumSha256':'f'*64}})
        patch.object(RELEASE,'aws',self.aws).start();patch.object(RELEASE.json_tool,'secret_aws',self.secret_aws).start()
        RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout)
        self.path=self.directory/'rebase-plan.json';self.manifest=self.directory/'rebase-release.json'

    def secret_aws(self,args,payload=None,lock_fd=None):
        self.assertIsNotNone(lock_fd)
        # The real flock remains held throughout reads, write, restart and verify.
        import fcntl
        with (self.root/'app-secret.lock').open('r+') as lock:
            with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.calls.append(('secret',args[0]))
        if args[0]=='put-secret-value':
            self.generation+=1;self.envelope={'VersionId':str(self.generation),'SecretString':json.loads(payload)['SecretString']}
            if self.lost_put:self.lost_put=False;raise TimeoutError('lost put')
            return {'VersionId':str(self.generation)}
        return copy.deepcopy(self.envelope)

    def schema_receipt(self):
        sql=Path(manifest.read(self.path)['schemaPath']).read_bytes();shape=schema.expected_schema(sql.decode())
        return {'schemaVersion':1,'systemIdentifier':'1234567890123456789','schemaSha256':hashlib.sha256(sql).hexdigest(),'applied':True,
                'before':dict(placements={},columns={},indexes={},rls=False,constraints=0,defaults=0,triggers=0,policies=0,grants=0),
                'after':dict(placements=shape['placements'],columns=shape['columns'],indexes={k:'CREATE INDEX '+k+' ON public.ezil_computer_image_jobs USING btree ('+v+')' for k,v in shape['indexes'].items()},rls=True,constraints=0,defaults=0,triggers=0,policies=0,grants=0)}

    def aws(self,*args):
        self.calls.append(args);service,op=args[:2]
        def flag(key):return args[args.index(key)+1]
        if service=='sts':return {'Account':TOOL.ACCOUNT}
        if service=='ec2':
            if op=='describe-instances':return {'Reservations':[{'Instances':[{'InstanceId':ssm.HOST,'State':{'Name':'running'},'Tags':[{'Key':'ezil:purpose','Value':'os-staging'},{'Key':'ezil:env','Value':'billing-staging'}]}]}]}
            source=op=='describe-images' and flag('--image-ids')==self.source['amiId'] or op=='describe-launch-template-versions' and flag('--versions')==self.source['launchTemplateVersion']
            if op=='describe-images':return {'Images':[dict(self.evidence['image']['Images'][0],ImageId=self.source['amiId'] if source else self.value['amiId'])]}
            if op=='describe-launch-template-versions':
                data={'ImageId':self.source['amiId'] if source else self.value['amiId'], 'InstanceType':'m6i.large',
                      'SecurityGroupIds':['sg-0123456789abcdef0'], 'MetadataOptions':{'HttpTokens':'required','HttpEndpoint':'enabled'},
                      'BlockDeviceMappings':[{'DeviceName':'/dev/xvda','Ebs':{'VolumeSize':32,'VolumeType':'gp3','Encrypted':True}}]}
                if not source:data.update(self.lt_override)
                return {'LaunchTemplateVersions':[dict(self.evidence['template']['LaunchTemplateVersions'][0],VersionNumber=int(self.source['launchTemplateVersion'] if source else self.value['launchTemplateVersion']),LaunchTemplateData=data)]}
        if service=='imagebuilder':return self.evidence['build']
        if service=='stepfunctions':
            arn=flag('--state-machine-arn')
            if op=='describe-state-machine':return dict(stateMachineArn=arn,type='STANDARD',status='ACTIVE')
            key=next(k for k in RELEASE.VERSION_KEYS if self.value[k].rsplit(':',1)[0]==arn)
            return {'stateMachineVersions':[{'stateMachineVersionArn':v} for v in sorted(v for v in {self.value[key],self.source[key]} if v is not None)]}
        if service=='s3api':
            if op=='put-object':self.payloads[flag('--key')]=Path(flag('--body')).read_text()
            return {}
        if service=='ssm':
            if op=='send-command':
                cid=f'{len(self.commands)+1:08x}-1111-4111-8111-111111111111';comment=flag('--comment');self.commands[cid]=comment
                if any('-'+name+'-g' in comment for name in ('apply-app','promote-app','rollback-app')) and '-verify' not in comment:
                    if self.delay_install:
                        self.invocation_status[cid]=self.command_status[cid]='InProgress';self.crash_poll=cid
                    if self.lost_send:
                        if self.lost_send=='absent':del self.commands[cid]
                        self.lost_send=None
                        raise TimeoutError('lost submission')
                return {'Command':{'CommandId':cid}}
            if op=='list-commands':
                cid=flag('--command-id') if '--command-id' in args else None
                if (op,cid) in self.status_errors:raise TimeoutError('synthetic status read failure')
                records=[{'CommandId':key,'Comment':comment,'InstanceIds':[ssm.HOST],
                          'Status':self.command_status.get(key,self.command_results.get(key,{}).get('Status','Pending'))}
                         for key,comment in self.commands.items() if cid is None or cid==key]
                return dict(Commands=records,**({'NextToken':'more'} if self.lookup_page or cid is None and self.lookup_submission_page else {}))
            if op=='get-command-invocation':
                cid=flag('--command-id');comment=self.commands[cid]
                if (op,cid) in self.status_errors:raise TimeoutError('synthetic status read failure')
                if self.crash_poll==cid:
                    self.crash_poll=None
                    raise TimeoutError('worker crashed while install running')
                status=self.invocation_status.get(cid,'Success')
                if status!='Success':return {'Status':status,'ResponseCode':1,'StandardOutputContent':''}
                if self.fail_app and 'promote-app' in comment:return {'Status':'Failed','ResponseCode':1,'StandardOutputContent':'suppressed'}
                if cid not in self.command_results:
                    if '-apply-schema-' in comment:
                        result={'Status':'Success','ResponseCode':0,'StandardOutputContent':json.dumps(self.schema_receipt())}
                    else:
                        payload=next(body for key,body in self.payloads.items() if key.rsplit('/',1)[-1][:32] in comment)
                        def install(app):
                            # Installation changes running state once; gates observe it independently.
                            self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'pending')
                            ds=manifest.loads(self.envelope['SecretString'])[TOOL.KEY]
                            if isinstance(ds,str):ds=manifest.loads(ds)
                            self.running_sha='9'*40 if self.bad_install else app['gitSha']
                            if not self.stale_install:self.running_deployment=app_ops.public_deployment(ds[TOOL.REGION])
                        result=execute_app_payload(payload,install,lambda:{'EZIL_GIT_SHA':self.running_sha,'EZIL_AWS_KILL_SWITCH':'1',
                                                   'EZIL_AWS_LIFECYCLE_DEPLOYMENTS':json.dumps({TOOL.REGION:self.running_deployment})})
                    self.command_results[cid]=copy.deepcopy(result)
                return copy.deepcopy(self.command_results[cid])
        if service=='cloudformation':
            phase=next(k for k,v in cfn.STACKS.items() if v==flag('--stack-name'));before,after,review=self.templates[phase];spec=self.specs[phase]
            if phase=='identity' and spec['changeSetArn'] is None:
                import fcntl
                with (self.root/'app-secret.lock').open('r+') as lock:
                    with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertIn(op,('get-template','describe-stacks'))
                self.assertNotIn('--change-set-name',args)
            if op=='describe-stacks':
                params=[{'ParameterKey':'HostAmiId','ParameterValue':self.value['amiId'] if self.cloud[phase] else self.source['amiId']}] if phase=='foundation' else []
                if phase=='identity':params=self.identity_parameters
                stack={'StackStatus':'UPDATE_COMPLETE','RoleARN':spec['roleArn'],'Parameters':params}
                if phase=='identity':stack['StackStatus']=self.identity_status
                if self.null_params and not params:del stack['Parameters']
                return {'Stacks':[stack]}
            if op=='get-template':
                if phase=='identity' and self.identity_live is not None:return {'TemplateBody':self.identity_live}
                return {'TemplateBody':after if '--change-set-name' in args or self.cloud[phase] else before}
            if op=='describe-change-set':
                changes=[]
                for logical,r in review['changes'].items():
                    details=[{'Target':{'Attribute':'Properties','Name':p,'RequiresRecreation':'Never'},'ChangeSource':'DirectModification','Evaluation':'Static'} for p in r['properties']]
                    changes.append({'Type':'Resource','ResourceChange':{'LogicalResourceId':logical,'ResourceType':after['Resources'][logical]['Type'],'Action':r['action'],'Replacement':'False','Scope':['Properties'] if r['action']=='Modify' else [],'Details':details}})
                if self.bad_change:changes[0]['ResourceChange']['Replacement']='True'
                params=[{'ParameterKey':'HostAmiId','ParameterValue':self.value['amiId']}] if phase=='foundation' else (None if self.null_params else [])
                return {'ChangeSetId':spec['changeSetArn'],'StackName':spec['stackName'],'Status':'CREATE_COMPLETE','ExecutionStatus':'EXECUTE_COMPLETE' if self.cloud[phase] else 'AVAILABLE','Changes':changes,'Parameters':params}
            if op=='execute-change-set':
                self.assertEqual(manifest.read(self.directory/(phase+'-cloudformation.json'))['status'],'executing')
                self.cloud[phase]=True
                if self.lost_execute:self.lost_execute=False;raise TimeoutError('lost execute')
                return {}
        raise AssertionError(args)

    def through_ready(self):
        RELEASE.apply_schema(self.path,True)
        RELEASE.apply_cloud(self.path,'apply-identity',True)
        RELEASE.apply_cloud(self.path,'apply-workflows',True)
        RELEASE.finalize(self.path,True)

    def test_pool_rollout_reaches_cloud_with_pinned_artifact(self):
        fixtures=manifest.read(HERE/'fixtures/pool-iam-templates.json')
        for phase,f in fixtures.items():
            before,after=f['before'],f['after'];review=PoolIamTests.exact_review(before,after)
            if phase=='identity':
                logical=next(k for k in after['Resources'] if k.startswith('ImageJobBoundary'))
                review['changes'][logical]={'action':'Modify','properties':['PolicyDocument'],'attributes':[]}
            self.templates[phase]=(before,after,review)
            for name,value in (('beforeTemplate',before),('candidateTemplate',after),('review',review)):
                TOOL.write(self.specs[phase][name+'Path'],value)
        artifact=self.root/'pool-iam-review.json';TOOL.write(artifact,manifest.read(HERE.parent/'fixtures/pool-iam-review.mum.json'))
        rollout=manifest.read(self.rollout);rollout['poolIam']=str(artifact);TOOL.write(self.rollout,rollout)
        self.path.unlink();RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout)
        self.through_ready()
        self.assertTrue(all(self.cloud.values()))
        artifact.write_text(artifact.read_text()+'\n')
        calls=len(self.calls)
        with self.assertRaisesRegex(ValueError,'reviewed pool IAM artifact changed'):RELEASE.load_plan(self.path)
        self.assertEqual(len(self.calls),calls)

    def through_app(self):
        self.through_ready()
        RELEASE.apply_app(self.manifest,True)

    def unchanged_identity_plan(self,before_parameters=None):
        spec=self.specs['identity'];spec['changeSetArn']=None
        # Existing metadata carry is applied before either artifact is reviewed/pinned.
        after=copy.deepcopy(self.templates['identity'][1]);before=copy.deepcopy(after)
        before['Resources']['CDKMetadata']={'Type':'AWS::CDK::Metadata','Properties':{'Analytics':'reviewed'}}
        live=self.root/'identity-live.json';TOOL.write(live,{'TemplateBody':before})
        TOOL.write(spec['beforeTemplatePath'],before);TOOL.write(spec['candidateTemplatePath'],after)
        TOOL.main(['carry-cdk-metadata',str(live),spec['beforeTemplatePath'],spec['candidateTemplatePath']])
        before=manifest.read(spec['beforeTemplatePath']);after=manifest.read(spec['candidateTemplatePath'])
        # JSON ordering/whitespace must not be treated as template changes.
        Path(spec['beforeTemplatePath']).write_text(json.dumps(before,sort_keys=True))
        review={'schemaVersion':1,'changes':{}};TOOL.write(spec['reviewPath'],review)
        self.templates['identity']=(before,after,review)
        if before_parameters is not None:spec['beforeParameters']=before_parameters
        rollout=manifest.read(self.rollout);rollout['stacks']=self.specs;TOOL.write(self.rollout,rollout)
        self.path.unlink();RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout)

    def prepare_registry_gc(self):
        import registry_gc as gc
        patch.object(gc, 'release', RELEASE).start()
        patch.object(gc, 'tool', RELEASE.json_tool).start()
        rollout = manifest.read(self.rollout); rollout['app']['tag'] = '478c66b3559c'
        TOOL.write(self.rollout, rollout)
        self.path.unlink(); RELEASE.make_plan(self.directory, self.config, self.identity, '1234567890123456789', self.rollout)
        outer = manifest.loads(self.envelope['SecretString']); d = outer[TOOL.KEY][TOOL.REGION]
        for n in range(3, 10):
            d['releases'].append(dict(self.source, amiId='ami-' + format(n, '017x'), recipeVersion='1.0.' + str(n), launchTemplateVersion=str(n)))
        self.envelope['SecretString'] = json.dumps(outer)
        stage1.seed_ledger(self.ledger, self.envelope)
        self.running_deployment = app_ops.public_deployment(d)
        self.through_app()
        snapshot = {'VersionId': self.envelope['VersionId'], 'deployment': copy.deepcopy(d)}
        after = copy.deepcopy(d); after['releases'].pop(4)
        plan = RELEASE.load_plan(self.path)
        directory = gc.operation_directory(self.path, RELEASE.load_ledger(self.ledger)['entries'][-1]['generation'] + 1)
        directory.mkdir(); gc.backup_registry(directory, snapshot)
        def commit():
            with RELEASE.json_tool.app_secret_lock() as fd:
                def transport(op, value=None):
                    return self.secret_aws(['get-secret-value'] if op == 'get' else ['put-secret-value'],
                        None if op == 'get' else json.dumps({'SecretString': json.dumps(value)}), lock_fd=fd)
                return gc.commit(directory, snapshot, after, RELEASE.digest(self.path), 'e' * 64, transport,
                                 self.ledger, lambda: None, path=self.path, plan=plan, fd=fd)
        return commit, after

    def test_ten_record_rollback_retains_invoking_compatible_app(self):
        outer=manifest.loads(self.envelope['SecretString']);d=outer[TOOL.KEY][TOOL.REGION]
        extra=[dict(self.source,amiId='ami-'+format(n,'017x'),recipeVersion='1.0.'+str(n)) for n in range(20,28)]
        d['releases'].extend(extra)
        self.envelope['SecretString']=json.dumps(outer)
        stage1.seed_ledger(self.ledger,self.envelope)
        self.running_deployment=app_ops.public_deployment(d)
        self.value['agentCommit']='9'*40  # new registry-compatible app, different from source
        self.restage(self.source)
        self.through_app();RELEASE.promote(self.manifest,True)
        target=manifest.read(self.manifest)
        self.assertNotEqual(target['agentCommit'],self.source['agentCommit'])
        self.assertEqual(len(self.running_deployment['releases']),10)
        RELEASE.promote(self.manifest,True,rollback=True)
        self.assertEqual(len(self.running_deployment['releases']),10)
        self.assertCountEqual(self.running_deployment['releases'],[self.source,*extra,target])
        self.assertEqual(self.running_deployment['amiId'],self.source['amiId'])
        self.assertEqual(self.running_sha,target['agentCommit'])
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['appGitSha'],target['agentCommit'])

    def test_registry_gc_refresh_then_unchanged_promote_at_capacity(self):
        commit, after = self.prepare_registry_gc()
        plan_bytes = self.path.read_bytes(); old = RELEASE.load_ledger(self.ledger)['entries']
        commit()
        entries = RELEASE.load_ledger(self.ledger)['entries']
        self.assertEqual(entries[:-2], old)
        self.assertEqual([e['operation'] for e in entries[-2:]], ['registry-gc'] * 2)
        self.assertEqual(entries[-1]['registrySha256'], RELEASE.release_state(after, self.running_sha)['registrySha256'])
        self.assertEqual(self.running_deployment, app_ops.public_deployment(after))
        self.assertEqual(self.path.read_bytes(), plan_bytes)
        self.assertTrue(any('registry-gc-app-g' in c for c in self.commands.values()))
        RELEASE.promote(self.manifest, True)
        self.assertEqual(len(self.running_deployment['releases']), 8)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['operation'], 'promote-canary')

    def test_registry_gc_requires_current_live_registry_before_write(self):
        commit, after = self.prepare_registry_gc()
        self.running_deployment = copy.deepcopy(after)
        before = self.ledger.read_bytes(); version = self.envelope['VersionId']
        with self.assertRaisesRegex(ValueError, 'SSM operation failed'):
            commit()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual(self.envelope['VersionId'], version)

    def test_registry_gc_pending_reconcile_never_marks_promotion(self):
        commit, after = self.prepare_registry_gc()
        with self.completion_failure('registry-gc'), self.assertRaises(OSError):
            commit()
        with self.assertRaisesRegex(ValueError, 'pending operation differs'):
            RELEASE.promote(self.manifest, True)
        journal = self.directory / 'rebase-promotion.json'
        journal.write_text('{"status":"planned","planSha256":"different"}')
        original = journal.read_bytes()
        RELEASE.ledger_reconcile(self.path, True)
        self.assertEqual(journal.read_bytes(), original)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'], 'completed')
        journal.unlink(); RELEASE.promote(self.manifest, True)

    def test_registry_gc_stale_refresh_and_unknown_remote_remain_pending(self):
        commit, after = self.prepare_registry_gc()
        self.stale_install = True
        with self.assertRaisesRegex(ValueError, 'SSM operation failed'):
            commit()
        pending = self.ledger.read_bytes()
        with self.assertRaisesRegex(ValueError, 'registry not adopted'):
            RELEASE.ledger_reconcile(self.path, True)
        with patch.object(ssm, 'generation_terminal', return_value=False):
            with self.assertRaisesRegex(ValueError, 'remote command not terminal'):
                RELEASE.ledger_reconcile(self.path, True)
        self.assertEqual(self.ledger.read_bytes(), pending)

    def test_unchanged_identity_all_phases_and_resume(self):
        self.unchanged_identity_plan()
        self.assertNotEqual(RELEASE.digest(self.specs['identity']['beforeTemplatePath']),RELEASE.digest(self.specs['identity']['candidateTemplatePath']))
        self.through_app();RELEASE.promote(self.manifest,True)
        evidence=RELEASE.require_receipt(self.path,'apply-identity')['identity']
        self.assertIsNone(evidence['changeSetArn']);self.assertEqual(evidence['status'],'unchanged')
        self.assertEqual(evidence['candidateSha256'],RELEASE.digest(self.specs['identity']['candidateTemplatePath']))
        self.assertEqual(evidence['liveTemplateSha256'],cfn.template_sha256(self.templates['identity'][1]))
        self.assertEqual(evidence['parameters'],[])
        self.assertFalse(self.cloud['identity']);self.assertTrue(self.cloud['foundation']);self.assertTrue(self.cloud['workflows'])
        self.assertEqual(self.generation,1)

    def test_unchanged_identity_dry_run_stable_states_and_parameters(self):
        self.unchanged_identity_plan();RELEASE.apply_schema(self.path,True)
        receipt=self.directory/'apply-identity-receipt.json';before=copy.deepcopy(self.envelope)
        files={p.name:p.read_bytes() for p in self.directory.iterdir() if p.is_file()}
        RELEASE.apply_cloud(self.path,'apply-identity',False)
        self.assertEqual(files,{p.name:p.read_bytes() for p in self.directory.iterdir() if p.is_file()})
        self.assertFalse(receipt.exists())
        self.identity_parameters=[{'ParameterKey':'Z','ParameterValue':'literal','ResolvedValue':'fixed'},
                                  {'ParameterKey':'A','ParameterValue':'another'}]
        for status in ('CREATE_COMPLETE','UPDATE_COMPLETE','IMPORT_COMPLETE'):
            self.identity_status=status
            RELEASE.apply_cloud(self.path,'apply-identity',True)
            evidence=RELEASE.require_receipt(self.path,'apply-identity')['identity']
            self.assertEqual(evidence['parameters'],list(reversed(self.identity_parameters)))
        self.assertEqual(self.envelope,before);self.assertEqual(self.running_sha,'e'*40)
        self.assertFalse((self.directory/'identity-cloudformation.json').exists())
        self.assertFalse(any(c[:2]==('cloudformation','execute-change-set') for c in self.calls))

    def test_unchanged_identity_live_drift_refuses(self):
        self.unchanged_identity_plan();RELEASE.apply_schema(self.path,True)
        self.identity_live=dict(self.templates['identity'][1],Description='unreviewed drift')
        for apply in (False,True):
            with self.assertRaisesRegex(ValueError,'identity stack drifted from the reviewed template'):
                RELEASE.apply_cloud(self.path,'apply-identity',apply)
        self.assertFalse((self.directory/'apply-identity-receipt.json').exists())
        self.identity_live=None;RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.identity_live={}
        with self.assertRaisesRegex(ValueError,'identity stack drifted from the reviewed template'):
            RELEASE.apply_cloud(self.path,'apply-identity',True)

    def test_null_change_set_refused_outside_identity(self):
        self.unchanged_identity_plan();original=manifest.read(self.rollout)
        for phase in ('foundation','workflows'):
            bad=copy.deepcopy(original);bad['stacks'][phase]['changeSetArn']=None;TOOL.write(self.rollout,bad)
            with self.assertRaisesRegex(ValueError,'invalid staged change set identity'):
                RELEASE.pin_rollout(self.rollout,self.plan['bake'])
            with self.assertRaisesRegex(ValueError,'null change set is only allowed for identity'):
                cfn.validate_templates(phase,*self.templates['identity'],unchanged=True)

    def test_unchanged_identity_unequal_templates_refused(self):
        self.unchanged_identity_plan();spec=self.specs['identity']
        for field in ('Description','Outputs','Resources'):
            bad=copy.deepcopy(self.templates['identity'][1]);bad[field]={} if field!='Description' else 'drift'
            TOOL.write(spec['candidateTemplatePath'],bad)
            with self.assertRaisesRegex(ValueError,'unchanged identity requires equal reviewed templates'):
                RELEASE.pin_rollout(self.rollout,self.plan['bake'])

    def test_unchanged_identity_nonempty_review_refused(self):
        self.unchanged_identity_plan()
        TOOL.write(self.specs['identity']['reviewPath'],{'schemaVersion':1,'changes':{'BoundaryEA298153':{'action':'Modify','properties':[],'attributes':[]}}})
        with self.assertRaisesRegex(ValueError,'unchanged identity review must show no changes'):
            RELEASE.pin_rollout(self.rollout,self.plan['bake'])

    def test_unchanged_identity_unstable_or_rollback_refused(self):
        self.unchanged_identity_plan();RELEASE.apply_schema(self.path,True)
        for status in ('UPDATE_IN_PROGRESS','UPDATE_COMPLETE_CLEANUP_IN_PROGRESS','CREATE_FAILED','ROLLBACK_COMPLETE',
                       'UPDATE_ROLLBACK_COMPLETE','IMPORT_ROLLBACK_COMPLETE','DELETE_COMPLETE','COMPLETE','',None,17):
            self.identity_status=status
            for apply in (False,True):
                with self.subTest(status=status,apply=apply),self.assertRaisesRegex(ValueError,'identity stack must be stable COMPLETE without rollback'):
                    RELEASE.apply_cloud(self.path,'apply-identity',apply)
        self.assertFalse((self.directory/'apply-identity-receipt.json').exists())

    def test_unchanged_identity_parameter_drift_refused(self):
        baseline=[{'ParameterKey':'Keep','ParameterValue':'literal','ResolvedValue':'fixed'}]
        self.unchanged_identity_plan(baseline);RELEASE.apply_schema(self.path,True)
        for current in ([],[dict(baseline[0],ParameterValue='drift')],[dict(baseline[0],ResolvedValue='drift')],
                        baseline+[{'ParameterKey':'Extra','ParameterValue':'new'}]):
            self.identity_parameters=current
            for apply in (False,True):
                with self.assertRaisesRegex(ValueError,'identity stack parameters drifted from the review'):
                    RELEASE.apply_cloud(self.path,'apply-identity',apply)
        self.assertFalse((self.directory/'apply-identity-receipt.json').exists())
        self.identity_parameters=baseline;RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.assertEqual(RELEASE.require_receipt(self.path,'apply-identity')['identity']['parameters'],baseline)

    def test_unchanged_identity_parameter_snapshot_guards(self):
        for bad in (None,{},[{}],[{'ParameterKey':'K','ParameterValue':None}],
                    [{'ParameterKey':'K','UsePreviousValue':True}],[{'ParameterKey':'','ParameterValue':'v'}]):
            with self.assertRaisesRegex(ValueError,'invalid identity parameter snapshot'):cfn.parameters(bad)
        with self.assertRaisesRegex(ValueError,'duplicate identity parameter keys'):
            cfn.parameters([{'ParameterKey':'K','ParameterValue':'v'}]*2)
        rollout=manifest.read(self.rollout);rollout['stacks']['identity']['beforeParameters']=[];TOOL.write(self.rollout,rollout)
        with self.assertRaisesRegex(ValueError,'beforeParameters requires unchanged identity'):
            RELEASE.pin_rollout(self.rollout,self.plan['bake'])

    def test_unchanged_identity_stack_count_role_and_gate_guards(self):
        self.unchanged_identity_plan();RELEASE.apply_schema(self.path,True)
        for stacks,message in (([],'one unchanged identity stack required'),
                               ([{},{}],'one unchanged identity stack required'),
                               ([{'StackStatus':'UPDATE_COMPLETE','RoleARN':'unreviewed'}],'unchanged identity execution role drift')):
            def aws(*args):
                return {'Stacks':stacks} if args[:2]==('cloudformation','describe-stacks') else self.aws(*args)
            with patch.object(RELEASE,'aws',side_effect=aws),self.assertRaisesRegex(ValueError,message):
                RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.calls=[]
        with patch.object(RELEASE,'app_operation',side_effect=ValueError('closed gate')):
            with self.assertRaisesRegex(ValueError,'closed gate'):RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.assertFalse(any(c[0]=='cloudformation' for c in self.calls))
        self.assertFalse((self.directory/'apply-identity-receipt.json').exists())

    def test_unchanged_identity_tampered_receipt_refused(self):
        self.unchanged_identity_plan([]);RELEASE.apply_schema(self.path,True);RELEASE.apply_cloud(self.path,'apply-identity',True)
        path=self.directory/'apply-identity-receipt.json';original=manifest.read(path)
        for key,value in (('changeSetArn','forged'),('candidateSha256','0'*64),('liveTemplateSha256','0'*64),
                          ('status','complete'),('extra',True),('parameters',[{'ParameterKey':'K','ParameterValue':'forged'}])):
            bad=copy.deepcopy(original);bad['evidence']['identity'][key]=value;TOOL.write(path,bad)
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'invalid unchanged identity evidence'):
                RELEASE.require_receipt(self.path,'apply-identity')
        TOOL.write(path,original)
        plan=manifest.read(self.path);plan['rollout']['stacks']['identity']['changeSetArn']='arn:aws:cloudformation:ap-south-1:452630323510:changeSet/forged/id'
        # Isolate the receipt's status/plan binding from template-review validation.
        with patch.object(RELEASE,'load_plan',return_value=plan):
            with self.assertRaisesRegex(ValueError,'invalid cloud completion evidence'):
                RELEASE.require_receipt(self.path,'apply-identity')

    def test_unchanged_identity_real_cli_live_readback(self):
        self.unchanged_identity_plan();RELEASE.apply_schema(self.path,True)
        TOOL.write(self.root/'secret.json',self.envelope)
        TOOL.write(self.root/'schema-readback.json',{'gitSha':self.running_sha,'killSwitch':'1','deployment':self.running_deployment})
        TOOL.write(self.root/'identity-live-template.json',{'TemplateBody':json.dumps(self.templates['identity'][1],sort_keys=True)})
        TOOL.write(self.root/'identity-live-stack.json',{'Stacks':[{'StackStatus':'CREATE_COMPLETE','Parameters':None}]})
        self.cli('apply-identity','--plan',str(self.path))
        self.assertFalse((self.directory/'apply-identity-receipt.json').exists())
        self.cli('apply-identity','--plan',str(self.path),'--apply')
        RELEASE.require_receipt(self.path,'apply-identity')
        TOOL.write(self.root/'identity-live-template.json',{'TemplateBody':{}})
        result=self.cli('apply-identity','--plan',str(self.path),'--apply',expected=1)
        self.assertIn('identity stack drifted from the reviewed template',result.stderr)
        calls=[json.loads(v) for v in (self.root/'calls.jsonl').read_text().splitlines()]
        self.assertFalse(any('execute-change-set' in c or 'describe-change-set' in c or 'put-secret-value' in c for c in calls))

    def test_all_phases_dry_apply_finalize_promote_rollback_and_resume(self):
        RELEASE.apply_schema(self.path,False)
        self.assertFalse(any(c[:2] in (('s3api','put-object'),('ssm','send-command')) for c in self.calls))
        RELEASE.apply_schema(self.path,True)
        RELEASE.apply_cloud(self.path,'apply-identity',False)
        self.assertFalse(any(c[:2]==('cloudformation','execute-change-set') for c in self.calls))
        RELEASE.apply_cloud(self.path,'apply-identity',True)
        RELEASE.apply_cloud(self.path,'apply-workflows',True)
        RELEASE.finalize(self.path,False);self.assertFalse(self.manifest.exists())
        RELEASE.finalize(self.path,True);first=self.manifest.read_bytes();RELEASE.finalize(self.path,True);self.assertEqual(first,self.manifest.read_bytes())
        RELEASE.apply_app(self.manifest,False);RELEASE.apply_app(self.manifest,True)
        ledger=RELEASE.load_ledger(self.ledger)
        RELEASE.apply_app(self.manifest,True)
        retried=RELEASE.load_ledger(self.ledger)['entries']
        self.assertEqual(retried[:-2],ledger['entries'])
        self.assertEqual(retried[-1]['generation'],ledger['entries'][-1]['generation']+2)
        self.assertEqual(retried[-1]['operation'],'apply-app')
        RELEASE.promote(self.manifest,False);self.assertEqual(self.generation,0)
        RELEASE.promote(self.manifest,True);RELEASE.promote(self.manifest,True);self.assertEqual(self.generation,1)
        RELEASE.promote(self.manifest,True,rollback=True);self.assertEqual(self.generation,2)
        outer=manifest.loads(self.envelope['SecretString']);d=outer[TOOL.KEY][TOOL.REGION]
        self.assertEqual({k:d[k] for k in manifest.PROMOTION},{k:self.source[k] for k in manifest.PROMOTION})
        self.assertEqual(d['releases'],[self.source,manifest.read(self.manifest)])
        self.assertEqual(outer['keep'],'synthetic');self.assertEqual(outer[TOOL.KEY]['other'],{'keep':True});self.assertEqual(outer['EZIL_AWS_KILL_SWITCH'],'1')
        journal=manifest.read(self.directory/'rebase-promotion.json');self.assertEqual(journal['status'],'rolled-back')
        self.assertEqual(journal['afterDeployment']['amiId'],self.value['amiId']);self.assertEqual(journal['rollbackDeployment']['amiId'],self.source['amiId'])

    def test_lost_secret_write_resumes_without_second_put(self):
        self.through_app();self.lost_put=True
        with self.assertRaises(TimeoutError):RELEASE.promote(self.manifest,True)
        self.assertEqual(manifest.read(self.directory/'rebase-promotion.json')['status'],'promotion-pending')
        RELEASE.promote(self.manifest,True)
        self.assertEqual(self.generation,1)

    def test_failed_app_restart_retains_partial_promotion_and_gate(self):
        self.through_app();self.fail_app=True
        with self.assertRaises(ValueError):RELEASE.promote(self.manifest,True)
        self.assertEqual(manifest.read(self.directory/'rebase-promotion.json')['status'],'promotion-pending')
        self.assertEqual(manifest.loads(self.envelope['SecretString'])['EZIL_AWS_KILL_SWITCH'],'1')
        self.fail_app=False
        RELEASE.promote(self.manifest,True)
        self.assertEqual(self.generation,1)

    def test_uncertain_cloud_execution_reconciles_readback_and_retains_id(self):
        RELEASE.apply_schema(self.path,True);self.lost_execute=True
        with self.assertRaises(TimeoutError):RELEASE.apply_cloud(self.path,'apply-identity',True)
        RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.assertEqual(sum(c[:2]==('cloudformation','execute-change-set') for c in self.calls),1)

    def test_parameterless_stack_null_change_set_parameters_apply(self):
        # Real CloudFormation omits a parameterless stack's Parameters and returns a change set's as null.
        RELEASE.apply_schema(self.path,True);self.null_params=True
        RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.assertEqual(sum(c[:2]==('cloudformation','execute-change-set') for c in self.calls),1)

    def test_change_set_replacement_refused_before_execute(self):
        RELEASE.apply_schema(self.path,True);self.bad_change=True
        with self.assertRaises(ValueError):RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.assertFalse(any(c[:2]==('cloudformation','execute-change-set') for c in self.calls))

    def test_missing_gate_manifest_receipts_and_artifact_drift_refuse(self):
        with self.assertRaises((ValueError,FileNotFoundError)):RELEASE.finalize(self.path,True)
        self.assertFalse(self.manifest.exists())
        outer=manifest.loads(self.envelope['SecretString']);outer['EZIL_AWS_KILL_SWITCH']='0';self.envelope['SecretString']=json.dumps(outer)
        RELEASE.apply_schema(self.path,True)
        with self.assertRaises(ValueError):RELEASE.apply_cloud(self.path,'apply-identity',True)
        Path(self.specs['identity']['candidateTemplatePath']).write_text('{}')
        with self.assertRaises(ValueError):RELEASE.load_plan(self.path)

    def test_apply_schema_real_cli_uses_fake_aws_and_validates_receipt(self):
        # This CLI uses a plan without CF/app artifacts; only schema is requested.
        standalone=self.directory/'rebase-plan.json';value=manifest.read(standalone);value['rollout']=None;TOOL.write(standalone,value)
        TOOL.write(self.root/'schema-readback.json',self.schema_receipt())
        self.cli('apply-schema','--plan',str(standalone))
        self.assertFalse((self.directory/'apply-schema-ssm.json').exists())
        self.cli('apply-schema','--plan',str(standalone),'--apply')
        self.cli('apply-schema','--plan',str(standalone),'--apply')
        RELEASE.require_receipt(standalone,'apply-schema')
        calls=[json.loads(v) for v in (self.root/'calls.jsonl').read_text().splitlines()]
        self.assertEqual(sum('send-command' in c for c in calls),1)


    def test_legacy_source_string_encoded_tuple_promotes_and_rolls_back(self):
        self.source.update(preparationStateMachineVersionArn=None,recoveryStateMachineVersionArn=None)
        TOOL.write(self.directory/'previous-rebase-release.json',self.source)
        TOOL.write(self.directory/'deployed-release.json',self.source)
        old={k:v for k,v in self.source.items() if k not in manifest.TUPLE}
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY]=json.dumps({TOOL.REGION:dict(old,releases=[self.source]),'other':{'keep':True}});self.envelope['SecretString']=json.dumps(outer)
        stage1.seed_ledger(self.ledger,self.envelope)
        self.path.unlink();RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout)
        self.through_app();RELEASE.promote(self.manifest,True);RELEASE.promote(self.manifest,True,rollback=True)
        outer=manifest.loads(self.envelope['SecretString']);self.assertIsInstance(outer[TOOL.KEY],str)
        d=manifest.loads(outer[TOOL.KEY])[TOOL.REGION]
        self.assertFalse(set(manifest.TUPLE)&d.keys());self.assertEqual(d['releases'][0],self.source)
        with self.assertRaises(ValueError):RELEASE.promote(self.manifest,True)

    def test_rollback_can_restore_source_when_target_build_is_unavailable(self):
        self.through_app();RELEASE.promote(self.manifest,True)
        original=RELEASE.aws
        def failed(*args):
            if args[:2]==('imagebuilder','get-image'):raise ValueError('target gone')
            return original(*args)
        with patch.object(RELEASE,'aws',failed):RELEASE.promote(self.manifest,True,rollback=True)
        self.assertEqual(manifest.read(self.directory/'rebase-promotion.json')['status'],'rolled-back')

    def test_static_deployment_drift_refuses_before_cloud_execution(self):
        RELEASE.apply_schema(self.path,True)
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]['storage']={'rootGiB':64};self.envelope['SecretString']=json.dumps(outer)
        with self.assertRaises(ValueError):RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.assertFalse(any(c[:2]==('cloudformation','execute-change-set') for c in self.calls))

    def test_low_level_secret_update_retains_existing_registry_under_lock(self):
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]['releases']=[self.source];self.envelope['SecretString']=json.dumps(outer)
        before=self.root/'before-secret-config.json';after=self.root/'after-secret-config.json'
        TOOL.write(before,{'settings':{'deployment':self.source}})
        TOOL.write(after,{'settings':{'deployment':dict(self.value,releases=[self.source,self.value])}})
        RELEASE.json_tool.secret_update(before,after,True)
        d=manifest.loads(self.envelope['SecretString'])[TOOL.KEY][TOOL.REGION]
        self.assertEqual(d['releases'],[self.source,self.value]);self.assertEqual(d['amiId'],self.value['amiId'])

    def replan(self):
        self.path.unlink(missing_ok=True)
        RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout)

    def restage(self, predecessor):
        """Write a new bake and desired config, preserving older plan inputs."""
        bake={k:self.value[k] for k in RELEASE.BAKE_KEYS}
        build=self.evidence['build']['image']
        build['arn']='arn:aws:imagebuilder:ap-south-1:452630323510:image/ezil-host-mum/'+self.value['recipeVersion']+'/1'
        build['imageRecipe']['version']=self.value['recipeVersion']
        build['outputResources']['amis'][0]['image']=self.value['amiId']
        values={'DesktopImageRef':self.value['lowerImageRef'],'DesktopImageId':self.value['lowerImageDigest'],
                'PreviousDesktopImageRef':self.value['previousLowerImageRef'],'PreviousDesktopImageId':self.value['previousLowerImageDigest'],
                'AgentSrcS3Uri':'s3://ezil-mum-deploy-assets-452630323510/ami/host-agent-'+self.value['agentCommit']+'.tgz'}
        build['imageRecipe']['components'][0]['parameters']=[{'name':k,'value':[v]} for k,v in values.items()]
        self.evidence['image']['Images'][0]['ImageId']=self.value['amiId']
        self.evidence['template']['LaunchTemplateVersions'][0].update(VersionNumber=int(self.value['launchTemplateVersion']),LaunchTemplateData={'ImageId':self.value['amiId']})
        self.config=self.directory/'candidate-config.json'
        TOOL.write(self.config,{'settings':{'deployment':self.value,'authorityOrigin':'https://os-staging.ezil.work'}})
        for name,data in [('bake-inputs.json',bake),('build.json',self.evidence['build']),('image.json',self.evidence['image']),
                          ('deployed-release.json',self.source),('previous-rebase-release.json',predecessor)]:
            TOOL.write(self.directory/name,data)
        (self.directory/'build-arn.txt').write_text(build['arn'])
        self.rollout=self.directory/'rollout-review.json'
        TOOL.write(self.rollout,{'schemaVersion':1,'stacks':self.specs,'app':{'tag':'reviewed-'+self.value['recipeVersion'],'gitSha':self.value['agentCommit'],'checksumSha256':'f'*64}})
        self.replan()

    def promoted_105(self, legacy=False, legacy_deployment=False):
        self.source.update(recipeVersion='1.0.2',lowerImageDigest='sha256:8dbc'+'a'*60)
        self.value.update(recipeVersion='1.0.5',agentCommit='279b2443'+'5'*32,lowerImageDigest='sha256:34ac'+'b'*60,previousLowerImageDigest=self.source['lowerImageDigest'])
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]=dict(self.source,releases=[self.source])
        if legacy_deployment:
            self.source.update(previousLowerImageDigest=None,previousLowerImageRef=None,
                               preparationStateMachineVersionArn=None,recoveryStateMachineVersionArn=None)
            deployment={k:v for k,v in self.source.items() if k not in manifest.TUPLE}
            deployment['releases']=[self.source]
            outer[TOOL.KEY]=json.dumps({TOOL.REGION:deployment,'other':{'keep':True}})
            self.running_deployment=app_ops.public_deployment(deployment)
        self.envelope['SecretString']=json.dumps(outer);stage1.seed_ledger(self.ledger,self.envelope)
        self.restage(self.source)
        self.through_app();RELEASE.promote(self.manifest,True)
        if legacy:
            plan=manifest.read(self.path);plan.pop('ledgerGeneration');plan['evidence'].pop('deployed-release.json')
            TOOL.write(self.path,plan);(self.directory/'deployed-release.json').unlink()
            for name in ('apply-schema-receipt.json','apply-identity-receipt.json','apply-workflows-receipt.json','apply-app-receipt.json','rebase-promotion.json'):
                data=manifest.read(self.directory/name);data['planSha256']=RELEASE.digest(self.path);TOOL.write(self.directory/name,data)
            # Preserve the unsuffixed transport format of the pre-ledger 1.0.5 release.
            for transport in list(self.directory.glob('*-g*-ssm.json')):
                import re
                data=manifest.read(transport)
                operation=re.sub(r'-g[0-9]+', '', data['operation'])
                TOOL.write(self.directory/(operation+'-ssm.json'),dict(data,operation=operation))
                transport.unlink()
            self.ledger.unlink();RELEASE.ledger_init(self.manifest,True)

    def next_106(self):
        predecessor=manifest.read(self.directory/'previous-rebase-release.json')
        self.source=manifest.read(self.manifest)
        self.value=dict(self.source,recipeVersion='1.0.6',amiId='ami-'+'6'*17,launchTemplateVersion='3',agentCommit='6'*40)
        self.evidence=copy.deepcopy(self.evidence)
        self.directory=self.root/'release-1.0.6';self.directory.mkdir()
        self.path=self.directory/'rebase-plan.json';self.manifest=self.directory/'rebase-release.json'
        self.cloud={k:False for k in cfn.STACKS}
        self.restage(predecessor)
        return predecessor

    def test_106_shared_lower_full_rollout_and_rollback_installs_invoking_app(self):
        self.promoted_105(legacy=True)
        predecessor=self.next_106();deployed=copy.deepcopy(self.source)
        self.through_app();RELEASE.promote(self.manifest,True)
        target=manifest.read(self.manifest)
        RELEASE.promote(self.manifest,True,rollback=True)
        d=manifest.loads(self.envelope['SecretString'])[TOOL.KEY][TOOL.REGION]
        self.assertEqual({k:d[k] for k in manifest.PROMOTION},{k:deployed[k] for k in manifest.PROMOTION})
        self.assertCountEqual(d['releases'],[predecessor,deployed,target])
        journal=manifest.read(self.directory/'rebase-promotion.json')
        self.assertEqual(journal['source'],deployed);self.assertNotEqual(journal['source'],predecessor)
        entries=RELEASE.load_ledger(self.ledger)['entries']
        self.assertEqual([e['generation'] for e in entries],list(range(1,8)))
        self.assertEqual([e['operation'] for e in RELEASE.completed_entries({'entries':entries})],['promote-canary','apply-app','promote-canary','rollback'])
        self.assertEqual(entries[-1]['appGitSha'],'6'*40)
        rollback_payload=self.payloads[manifest.read(next(p for p in self.directory.glob('rollback-app-g*-ssm.json') if '-verify-' not in p.name))['key']]
        self.assertIn("'gitSha': '"+'6'*40+"'",rollback_payload)
        self.assertNotIn("'gitSha': '"+deployed['agentCommit']+"'",rollback_payload)
        self.assertEqual(entries[-1]['tuple'],RELEASE.ledger_tuple(deployed))

    def assert_no_mutation(self, action, message):
        calls=len(self.calls);ledger=self.ledger.read_bytes();secret=copy.deepcopy(self.envelope)
        with self.assertRaisesRegex(ValueError,message):action()
        self.assertEqual(self.envelope,secret);self.assertEqual(self.ledger.read_bytes(),ledger)
        self.assertFalse(any(c[:2] in (('secret','put-secret-value'),('ssm','send-command'),('s3api','put-object'),('cloudformation','execute-change-set')) for c in self.calls[calls:]))

    def test_stale_105_all_app_operations_after_106_apply_promote_and_rollback(self):
        self.promoted_105(legacy=True)
        old_manifest=self.manifest;old_plan=RELEASE.load_plan(self.path);old_evidence=copy.deepcopy(self.evidence)
        self.next_106();self.through_app()
        real_readbacks=RELEASE.readbacks
        for phase in ('apply-app','promote-canary','rollback'):
            if phase=='promote-canary':RELEASE.promote(self.manifest,True)
            if phase=='rollback':RELEASE.promote(self.manifest,True,rollback=True)
            with patch.object(RELEASE,'readbacks',side_effect=lambda p: old_evidence if p==old_plan else real_readbacks(p)), patch.object(RELEASE,'source_readbacks'):
                for operation in ('apply-app','promote-canary','rollback'):
                    with self.subTest(after=phase,operation=operation):
                        action=lambda: RELEASE.apply_app(old_manifest,True) if operation=='apply-app' else RELEASE.promote(old_manifest,True,rollback=operation=='rollback')
                        self.assert_no_mutation(action,'stale plan')

    def test_first_operation_generation_pin_refuses_even_when_tuple_unchanged(self):
        self.through_app()
        plan=manifest.read(self.path);plan['ledgerGeneration']=1
        # A distinct, reviewed plan hash with no history cannot reuse the old generation.
        plan['rollout']['app']['tag']='second-plan';TOOL.write(self.path,plan)
        for phase in ('apply-schema','apply-identity','apply-workflows'):
            receipt=manifest.read(self.directory/(phase+'-receipt.json'));receipt['planSha256']=RELEASE.digest(self.path);TOOL.write(self.directory/(phase+'-receipt.json'),receipt)
        self.assert_no_mutation(lambda:RELEASE.apply_app(self.manifest,True),'ledger generation advanced')

    def test_legacy_directory_loads_and_only_own_latest_entry_admits(self):
        self.promoted_105(legacy=True)
        plan=RELEASE.load_plan(self.path)
        self.assertNotIn('ledgerGeneration',plan)
        deployed,predecessor=RELEASE.plan_roles(self.path,plan);self.assertEqual(deployed,predecessor)
        legacy=self.directory/'promote-app-ssm.json';original=legacy.read_bytes()
        RELEASE.promote(self.manifest,True)
        imported=self.directory/'promote-app-g2-ssm.json'
        self.assertEqual(manifest.read(imported)['commandId'],manifest.read(legacy)['commandId'])
        self.assertEqual(legacy.read_bytes(),original)
        RELEASE.promote(self.manifest,True,rollback=True)

    def test_double_rollback_refused_before_app_or_secret_mutation(self):
        self.through_app();RELEASE.promote(self.manifest,True);RELEASE.promote(self.manifest,True,rollback=True)
        self.assert_no_mutation(lambda:RELEASE.promote(self.manifest,True,rollback=True),'already rolled back')

    def test_rollback_requires_own_ledger_promotion(self):
        self.through_app();RELEASE.promote(self.manifest,True)
        ledger=RELEASE.load_ledger(self.ledger);ledger['entries'][-1]['operation']='apply-app';ledger['entries'][-2]['operation']='apply-app';TOOL.write(self.ledger,ledger)
        self.assert_no_mutation(lambda:RELEASE.promote(self.manifest,True,rollback=True),'requires a ledger promotion')

    def toggle_gate(self):
        for gate in ('0','1'):
            outer=manifest.loads(self.envelope['SecretString']);outer['EZIL_AWS_KILL_SWITCH']=gate
            self.generation+=1
            self.envelope={'VersionId':str(self.generation),'SecretString':json.dumps(outer)}

    def test_gate_toggle_admits_rollback(self):
        self.through_app();RELEASE.promote(self.manifest,True)
        before=RELEASE.load_ledger(self.ledger);self.toggle_gate()
        self.assertNotEqual(before['entries'][-1]['secretVersionId'],self.envelope['VersionId'])
        RELEASE.promote(self.manifest,True,rollback=True)
        after=RELEASE.load_ledger(self.ledger)
        self.assertEqual(after['entries'][:-2],before['entries'])
        self.assertEqual(after['entries'][-1]['operation'],'rollback')

    def test_gate_toggle_admits_new_plan_first_operation(self):
        self.promoted_105();before=RELEASE.load_ledger(self.ledger);self.toggle_gate()
        self.next_106();self.through_app()
        after=RELEASE.load_ledger(self.ledger)
        self.assertEqual(after['entries'][:-2],before['entries'])
        self.assertEqual(after['entries'][-1]['operation'],'apply-app')

    def test_legacy_ledger_projection_and_registry_hash(self):
        before=RELEASE.load_ledger(self.ledger);self.assertNotIn('registrySha256',before['entries'][0])
        self.toggle_gate();_,d=RELEASE.secret_deployment(self.envelope)
        RELEASE.ledger_drift(before,self.envelope,dict(d,releases=[]),self.running_sha)
        with self.assertRaisesRegex(ValueError,'ledger drift'):
            RELEASE.ledger_drift(before,self.envelope,d,'9'*40)
        self.through_app();after=RELEASE.load_ledger(self.ledger)
        self.assertEqual(after['entries'][0],before['entries'][0])
        expected=hashlib.sha256(json.dumps(d['releases'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        for snapshot in (after['entries'][-1],after['entries'][-2]['before'],after['entries'][-2]['expected']):
            self.assertEqual(snapshot['registrySha256'],expected)
        reordered=dict(d,releases=[dict(reversed(list(record.items()))) for record in d['releases']])
        self.assertEqual(RELEASE.release_state(reordered,self.running_sha)['registrySha256'],expected)
        self.assertEqual(after['entries'][-1]['secretVersionId'],self.envelope['VersionId'])

    def test_ledger_tuple_and_registry_drift_refuse_all_app_operations(self):
        self.through_app();RELEASE.promote(self.manifest,True)
        original=copy.deepcopy(self.envelope)
        for drift in ('tuple','registry','registry-order'):
            self.envelope=copy.deepcopy(original)
            outer=manifest.loads(self.envelope['SecretString']);d=outer[TOOL.KEY][TOOL.REGION]
            if drift=='tuple':d['amiId']='ami-'+'9'*17
            elif drift=='registry':d['releases'][0]['createdAt']='2026-10-23T12:00:00.000Z'
            else:d['releases'].reverse()
            self.envelope['SecretString']=json.dumps(outer)
            for operation in ('apply-app','promote-canary','rollback'):
                with self.subTest(drift=drift,operation=operation):
                    action=lambda:RELEASE.apply_app(self.manifest,True) if operation=='apply-app' else RELEASE.promote(self.manifest,True,rollback=operation=='rollback')
                    self.assert_no_mutation(action,'ledger drift')

    def test_ledger_running_sha_drift_refuses(self):
        self.through_app();RELEASE.promote(self.manifest,True);self.running_sha='9'*40
        original=self.ledger.read_bytes();envelope=copy.deepcopy(self.envelope)
        for operation in ('apply-app','promote-canary','rollback'):
            with self.subTest(operation=operation),self.assertRaisesRegex(ValueError,'ledger drift'):
                if operation=='apply-app':RELEASE.apply_app(self.manifest,True)
                else:RELEASE.promote(self.manifest,True,rollback=operation=='rollback')
        self.assertEqual(self.ledger.read_bytes(),original);self.assertEqual(self.envelope,envelope)

    def test_pending_registry_drift_and_hash_schema_refused(self):
        self.prepared_106();self.crash_before_install();original=RELEASE.load_ledger(self.ledger)
        for snapshot_name in ('before','expected','completed'):
            for bad in ('bad',None,'A'*64,1):
                changed=copy.deepcopy(original)
                snapshot=changed['entries'][0] if snapshot_name=='completed' else changed['entries'][-1][snapshot_name]
                snapshot['registrySha256']=bad;TOOL.write(self.ledger,changed)
                with self.subTest(snapshot=snapshot_name,bad=bad),self.assertRaisesRegex(ValueError,'invalid ledger registry hash'):
                    RELEASE.load_ledger(self.ledger)
        TOOL.write(self.ledger,original)
        changed=copy.deepcopy(original);changed['entries'][-1]['expected']['registrySha256']='0'*64
        TOOL.write(self.ledger,changed)
        with self.assertRaisesRegex(ValueError,'expected state changed'):RELEASE.apply_app(self.manifest,True)
        TOOL.write(self.ledger,original)
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]['releases'].reverse()
        self.envelope['SecretString']=json.dumps(outer);self.toggle_gate()
        with self.assertRaisesRegex(ValueError,'manual reconciliation required'):RELEASE.ledger_reconcile(self.path,True)
        with self.assertRaisesRegex(ValueError,'ledger drift'):RELEASE.apply_app(self.manifest,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger),original)

    def test_wrong_deployed_refused_at_plan_cloud_app_and_first_promotion(self):
        self.through_app()
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]['amiId']='ami-'+'9'*17;self.envelope['SecretString']=json.dumps(outer)
        # Keep ledger coherent to isolate deployed identity from drift detection.
        ledger=RELEASE.load_ledger(self.ledger);ledger['entries'][-1]['tuple']=RELEASE.ledger_tuple(outer[TOOL.KEY][TOOL.REGION]);TOOL.write(self.ledger,ledger)
        for action in (lambda:RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout),
                       lambda:RELEASE.apply_cloud(self.path,'apply-identity',True),lambda:RELEASE.apply_cloud(self.path,'apply-workflows',True),
                       lambda:RELEASE.apply_app(self.manifest,True),lambda:RELEASE.promote(self.manifest,True)):
            self.assert_no_mutation(action,'deployed release')

    def test_predecessor_must_be_retained_and_match_both_bake_fields(self):
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]['releases']=[];self.envelope['SecretString']=json.dumps(outer)
        self.assert_no_mutation(lambda:RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout),'not retained')
        self.envelope['SecretString']=json.dumps(self.outer_original)
        for field,value in (('lowerImageDigest','sha256:'+'f'*64),('lowerImageRef',TOOL.REPOSITORY+'@sha256:'+'f'*64)):
            changed=dict(self.source,**{field:value});TOOL.write(self.directory/'previous-rebase-release.json',changed)
            self.assert_no_mutation(lambda:RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout),'predecessor and bake')

    def test_both_artifact_hashes_are_pinned_and_generation_is_strict(self):
        for name in ('deployed-release.json','previous-rebase-release.json'):
            path=self.directory/name;original=path.read_bytes();path.write_bytes(original+b' ')
            with self.assertRaisesRegex(ValueError,'bake evidence changed'):RELEASE.load_plan(self.path)
            path.write_bytes(original)
        plan=manifest.read(self.path)
        for bad in (True,0,-1,'1',None):
            TOOL.write(self.path,dict(plan,ledgerGeneration=bad))
            with self.assertRaisesRegex(ValueError,'generation pin'):RELEASE.load_plan(self.path)
        TOOL.write(self.path,plan)
        changed=copy.deepcopy(plan);changed['evidence'].pop('deployed-release.json');TOOL.write(self.path,changed)
        with self.assertRaisesRegex(ValueError,'evidence fields'):RELEASE.load_plan(self.path)
        TOOL.write(self.path,plan)

    def test_ledger_schema_and_entry_guards(self):
        original=RELEASE.load_ledger(self.ledger)
        cases=[({'schemaVersion':2,'entries':original['entries']},'invalid promotion ledger'),
               ({'schemaVersion':1,'entries':[]},'empty promotion ledger')]
        for field,value,message in [('extra',1,'invalid ledger entry'),('generation',2,'invalid ledger generation'),
                                    ('planSha256','bad','invalid ledger source pin'),('appGitSha','bad','invalid ledger source pin'),
                                    ('operation','unknown','invalid ledger operation/version'),('secretVersionId',None,'invalid ledger operation/version'),
                                    ('tuple',{},'invalid ledger tuple')]:
            changed=copy.deepcopy(original);changed['entries'][0][field]=value;cases.append((changed,message))
        for value,message in cases:
            TOOL.write(self.ledger,value)
            with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):RELEASE.load_ledger(self.ledger)
        TOOL.write(self.ledger,original)
        with self.assertRaisesRegex(ValueError,'running app gitSha'):
            RELEASE.ledger_entry(self.path,'apply-app',self.envelope,self.source,'bad',2)

    def test_ledger_append_rechecks_plan_and_ledger_before_atomic_write(self):
        plan=RELEASE.load_plan(self.path);ledger=RELEASE.load_ledger(self.ledger)
        with patch.object(RELEASE,'load_plan',return_value=dict(plan,maintenance=True)):
            self.assert_no_mutation(lambda:RELEASE.append_ledger(self.ledger,ledger,self.path,plan,'apply-app',self.envelope,self.source,'e'*40),'plan changed before ledger append')
        with patch.object(RELEASE,'load_ledger',return_value={**ledger,'entries':[]}):
            self.assert_no_mutation(lambda:RELEASE.append_ledger(self.ledger,ledger,self.path,plan,'apply-app',self.envelope,self.source,'e'*40),'ledger changed during operation')

    def test_dry_run_and_failed_app_verification_do_not_append_ledger(self):
        self.through_app();original=RELEASE.load_ledger(self.ledger)
        RELEASE.apply_app(self.manifest,False);RELEASE.promote(self.manifest,False)
        self.assertEqual(RELEASE.load_ledger(self.ledger),original)
        real=RELEASE.app_operation
        def missing(*args,**kwargs):
            return None if kwargs.get('install',True) else real(*args,**kwargs)
        for action in (lambda:RELEASE.apply_app(self.manifest,True),lambda:RELEASE.promote(self.manifest,True)):
            with patch.object(RELEASE,'app_operation',side_effect=missing):
                with self.assertRaisesRegex(ValueError,'app verification missing'):action()
            pending=RELEASE.load_ledger(self.ledger)
            self.assertEqual(pending['entries'][:-1],original['entries'])
            self.assertEqual(pending['entries'][-1]['state'],'pending')
            if pending['entries'][-1]['operation']=='promote-canary':
                with self.assertRaisesRegex(ValueError,'secret written; app not yet adopted'):
                    RELEASE.ledger_reconcile(self.path,True)
                RELEASE.promote(self.manifest,True)
            else:
                RELEASE.ledger_reconcile(self.path,True)
            original=RELEASE.load_ledger(self.ledger)

    def prepared_106(self):
        self.promoted_105(legacy=True)
        self.old_manifest=self.manifest;self.old_plan=RELEASE.load_plan(self.path);self.old_evidence=copy.deepcopy(self.evidence)
        self.assertNotIn('ledgerGeneration',self.old_plan)
        self.assertTrue((self.directory/'apply-app-ssm.json').exists())
        self.next_106();self.through_ready()

    def completion_failure(self, operation):
        real=RELEASE.json_tool.write
        def fail(path,value,**kwargs):
            if Path(path)==self.ledger and value['entries'][-1].get('state')=='completed' and value['entries'][-1]['operation']==operation:
                raise OSError('injected completion append failure')
            return real(path,value,**kwargs)
        return patch.object(RELEASE.json_tool,'write',side_effect=fail)

    def crash_before_install(self):
        real=RELEASE.app_operation
        def crash(*args,**kwargs):
            if kwargs.get('install',True):raise TimeoutError('crash before install')
            return real(*args,**kwargs)
        with patch.object(RELEASE,'app_operation',side_effect=crash):
            with self.assertRaisesRegex(TimeoutError,'crash before install'):RELEASE.apply_app(self.manifest,True)

    def test_pending_apply_completion_failure_fences_legacy_and_reconciles(self):
        self.prepared_106();original=RELEASE.load_ledger(self.ledger)
        with self.completion_failure('apply-app'):
            with self.assertRaises(OSError):RELEASE.apply_app(self.manifest,True)
        pending=RELEASE.load_ledger(self.ledger)
        self.assertEqual(pending['entries'][:-1],original['entries'])
        self.assertEqual(pending['entries'][-1]['state'],'pending')
        self.assertEqual(self.running_sha,'6'*40)
        real=RELEASE.readbacks
        with patch.object(RELEASE,'readbacks',side_effect=lambda p:self.old_evidence if p==self.old_plan else real(p)),patch.object(RELEASE,'source_readbacks'):
            for op in ('apply-app','promote-canary','rollback'):
                action=lambda:RELEASE.apply_app(self.old_manifest,True) if op=='apply-app' else RELEASE.promote(self.old_manifest,True,rollback=op=='rollback')
                self.assert_no_mutation(action,'pending operation of another plan')
        self.assert_no_mutation(lambda:RELEASE.ledger_reconcile(self.old_manifest.parent/'rebase-plan.json',True),'requires this plan pending entry')
        self.assert_no_mutation(lambda:RELEASE.promote(self.manifest,True),'pending operation differs')
        with self.assertRaisesRegex(ValueError,'before planning'):
            RELEASE.make_plan(self.directory,self.config,self.identity,'1234567890123456789',self.rollout)
        RELEASE.ledger_reconcile(self.path,False)
        self.assertEqual(RELEASE.load_ledger(self.ledger),pending)
        RELEASE.ledger_reconcile(self.path,True)
        completed=RELEASE.load_ledger(self.ledger)
        self.assertEqual(completed['entries'][:-1],pending['entries'])
        self.assertEqual(completed['entries'][-1]['state'],'completed')
        self.assertEqual(completed['entries'][-1]['secretVersionId'],self.envelope['VersionId'])
        RELEASE.promote(self.manifest,True)

    def test_promote_and_rollback_completion_failures_reconcile(self):
        self.prepared_106();RELEASE.apply_app(self.manifest,True)
        for operation in ('promote-canary','rollback'):
            with self.completion_failure(operation):
                with self.assertRaises(OSError):RELEASE.promote(self.manifest,True,rollback=operation=='rollback')
            pending=RELEASE.load_ledger(self.ledger);self.toggle_gate();version=self.envelope['VersionId']
            _,d=RELEASE.secret_deployment(self.envelope)
            self.assertEqual(pending['entries'][-1]['expected']['registrySha256'],RELEASE.release_state(d,self.running_sha)['registrySha256'])
            self.assertEqual(pending['entries'][-1]['state'],'pending')
            RELEASE.ledger_reconcile(self.path,True)
            completed=RELEASE.load_ledger(self.ledger)
            self.assertEqual(completed['entries'][:-1],pending['entries'])
            self.assertEqual(completed['entries'][-1]['state'],'completed')
            self.assertEqual(completed['entries'][-1]['secretVersionId'],version)
            self.assertEqual(self.envelope['VersionId'],version)

    def test_legacy_105_rollback_completion_failure_reconciles(self):
        self.promoted_105(legacy=True,legacy_deployment=True)
        journal_path=self.directory/'rebase-promotion.json'
        journal=manifest.read(journal_path)
        self.assertEqual(journal['source']['recipeVersion'],'1.0.2')
        self.assertEqual(journal['target']['recipeVersion'],'1.0.5')
        self.assertEqual(set(journal['before']),set(manifest.PROMOTION[:3]))
        self.assertFalse(set(manifest.TUPLE)&journal['beforeDeployment'].keys())
        self.assertNotIn('ledgerGeneration',RELEASE.load_plan(self.path))
        original=RELEASE.load_ledger(self.ledger)
        with self.completion_failure('rollback'):
            with self.assertRaisesRegex(OSError,'completion append failure'):
                RELEASE.promote(self.manifest,True,rollback=True)
        pending=RELEASE.load_ledger(self.ledger)
        self.assertEqual(pending['entries'][:-1],original['entries'])
        self.assertEqual(pending['entries'][-1]['state'],'pending')
        self.assertEqual({k:pending['entries'][-1]['expected']['tuple'][k] for k in manifest.TUPLE},
                         dict.fromkeys(manifest.TUPLE))
        outer=manifest.loads(self.envelope['SecretString'])
        self.assertIsInstance(outer[TOOL.KEY],str)
        deployment=manifest.loads(outer[TOOL.KEY])[TOOL.REGION]
        self.assertFalse(set(manifest.TUPLE)&deployment.keys())
        self.assertEqual({k:deployment[k] for k in journal['before']},journal['before'])
        self.assertEqual(self.running_deployment,app_ops.public_deployment(deployment))
        self.assertEqual({k:v for k,v in self.running_deployment.items() if k!='releases'},
                         {k:v for k,v in journal['beforeDeployment'].items() if k!='releases'})
        self.assertEqual(deployment['releases'],[journal['source'],journal['target']])
        self.assertEqual(self.running_sha,journal['target']['agentCommit'])
        envelope=copy.deepcopy(self.envelope)
        puts=self.calls.count(('secret','put-secret-value'))
        RELEASE.ledger_reconcile(self.path,True)
        completed=RELEASE.load_ledger(self.ledger)
        self.assertEqual(completed['entries'][:-1],pending['entries'])
        self.assertEqual(completed['entries'][-1],{
            'generation':pending['entries'][-1]['generation']+1,'planSha256':RELEASE.digest(self.path),
            'operation':'rollback','state':'completed','secretVersionId':envelope['VersionId'],
            **RELEASE.release_state(deployment,self.running_sha)})
        RELEASE.ledger_drift(completed,self.envelope,deployment,self.running_sha)
        self.assertEqual(manifest.read(journal_path)['status'],'rolled-back')
        self.assertEqual(self.envelope,envelope)
        self.assertEqual(self.calls.count(('secret','put-secret-value')),puts)

    def test_pending_crash_aborts_and_retry_gets_new_generation(self):
        self.prepared_106();before=copy.deepcopy(self.envelope)
        self.crash_before_install()
        pending=RELEASE.load_ledger(self.ledger)
        self.assertEqual(pending['entries'][-1]['state'],'pending')
        self.assertEqual(self.envelope,before);self.assertEqual(self.running_sha,'279b2443'+'5'*32)
        self.assertFalse([p for p in self.directory.glob('apply-app-g*-ssm.json') if '-verify-' not in p.name])
        self.toggle_gate()
        RELEASE.ledger_reconcile(self.path,True)
        aborted=RELEASE.load_ledger(self.ledger)
        self.assertEqual(aborted['entries'][:-1],pending['entries'])
        self.assertEqual(aborted['entries'][-1]['state'],'aborted')
        # No mutation occurred: the older completed owner's admission is unchanged.
        _,d=RELEASE.secret_deployment(self.envelope)
        RELEASE.ledger_admit(self.ledger,self.old_manifest.parent/'rebase-plan.json',self.old_plan,self.envelope,d,'apply-app')
        RELEASE.apply_app(self.manifest,True)
        done=RELEASE.load_ledger(self.ledger)['entries']
        self.assertEqual(done[-2]['generation'],pending['entries'][-1]['generation']+2)
        self.assertEqual(done[-1]['state'],'completed')

    def test_same_pending_generation_resumes_existing_transport(self):
        self.prepared_106()
        with self.completion_failure('apply-app'):
            with self.assertRaises(OSError):RELEASE.apply_app(self.manifest,True)
        journals=[p for p in self.directory.glob('apply-app-g*-ssm.json') if '-verify-' not in p.name];self.assertEqual(len(journals),1)
        first=manifest.read(journals[0]);pending=RELEASE.load_ledger(self.ledger)
        RELEASE.apply_app(self.manifest,True)
        self.assertEqual([p for p in self.directory.glob('apply-app-g*-ssm.json') if '-verify-' not in p.name],journals)
        self.assertEqual(manifest.read(journals[0])['commandId'],first['commandId'])
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][:-1],pending['entries'])

    def delayed_106_install(self):
        self.prepared_106();self.delay_install=True
        with self.assertRaisesRegex(TimeoutError,'worker crashed'):
            RELEASE.apply_app(self.manifest,True)
        self.delay_install=False
        journal=next(self.directory.glob('apply-app-g*-ssm.json'))
        return journal,manifest.read(journal)['commandId']

    def assert_remote_fence(self):
        before=self.ledger.read_bytes();calls=len(self.calls)
        for apply in (False,True):
            with self.assertRaisesRegex(ValueError,'remote command not terminal; wait or cancel'):
                RELEASE.ledger_reconcile(self.path,apply)
        self.assertEqual(self.ledger.read_bytes(),before)
        # Terminal checking must precede secret snapshots and new gate submissions.
        self.assertTrue(all(call[:2] in (('ssm','get-command-invocation'),('ssm','list-commands')) for call in self.calls[calls:]))

    def test_reconcile_inprogress_install_then_completes(self):
        _,cid=self.delayed_106_install()
        self.command_status[cid]='Failed'
        for status in ('Pending','InProgress','Delayed','Cancelling','Unknown'):
            self.invocation_status[cid]=status
            self.assert_remote_fence()
        self.invocation_status[cid]=self.command_status[cid]='Success'
        # Simulate the remote worker finishing, independently of reconciliation.
        self.aws('ssm','get-command-invocation','--command-id',cid,'--instance-id',ssm.HOST)
        # Even expected live state cannot close a still-running parent command.
        for status in ('Pending','InProgress','Delayed','Cancelling','Unknown'):
            self.command_status[cid]=status
            self.assert_remote_fence()
        self.command_status[cid]='Success'
        RELEASE.ledger_reconcile(self.path,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'completed')

    def test_reconcile_terminal_failed_install_aborts_and_retry_succeeds(self):
        _,cid=self.delayed_106_install()
        before=copy.deepcopy(self.envelope);running=self.running_sha
        for status in ('Failed','Cancelled','TimedOut'):
            self.invocation_status[cid]=self.command_status[cid]=status
            RELEASE.ledger_reconcile(self.path,False)
            self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'pending')
        self.invocation_status[cid]=self.command_status[cid]='Failed'
        RELEASE.ledger_reconcile(self.path,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'aborted')
        self.assertEqual(self.envelope,before);self.assertEqual(self.running_sha,running)
        RELEASE.apply_app(self.manifest,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'completed')

    def test_reconcile_status_read_errors_keep_fence(self):
        _,cid=self.delayed_106_install()
        self.invocation_status[cid]=self.command_status[cid]='Failed'
        for op in ('get-command-invocation','list-commands'):
            self.status_errors={(op,cid)}
            self.assert_remote_fence()
        self.status_errors=set();self.lookup_page=True
        self.assert_remote_fence()

    def test_reconcile_lost_submission_absence_is_not_proof(self):
        self.prepared_106();self.lost_send='absent'
        with self.assertRaisesRegex(TimeoutError,'lost submission'):RELEASE.apply_app(self.manifest,True)
        journal=next(self.directory.glob('apply-app-g*-ssm.json'));state=manifest.read(journal)
        self.assertIsNone(state['commandId']);self.assertEqual(state['status'],'submitting')
        for page,error in ((False,False),(True,False),(False,True)):
            self.lookup_page=page;self.status_errors={('list-commands',None)} if error else set()
            self.assert_remote_fence()
        self.assertEqual(manifest.read(journal),state)

    def test_reconcile_unsubmitted_upload_can_abort(self):
        self.prepared_106();real=self.aws
        # Stop only the mutating payload upload, after the intent/gate succeeds.
        def upload(*args):
            if args[:2]==('s3api','put-object'):
                payload=Path(args[args.index('--body')+1]).read_text()
                if 'INSTALL = True' in payload:raise TimeoutError('upload interrupted')
            return real(*args)
        with patch.object(RELEASE,'aws',side_effect=upload):
            with self.assertRaisesRegex(TimeoutError,'upload interrupted'):RELEASE.apply_app(self.manifest,True)
        state=manifest.read(next(self.directory.glob('apply-app-g*-ssm.json')))
        self.assertEqual(state['status'],'uploading');self.assertIsNone(state['commandId'])
        RELEASE.ledger_reconcile(self.path,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'aborted')

    def test_reconcile_lost_submission_found_requires_terminal(self):
        self.prepared_106();self.lost_send='exists'
        with self.assertRaisesRegex(TimeoutError,'lost submission'):RELEASE.apply_app(self.manifest,True)
        cid=next(reversed(self.commands))
        self.invocation_status[cid]=self.command_status[cid]='InProgress'
        self.assert_remote_fence()
        self.invocation_status[cid]=self.command_status[cid]='Failed'
        self.lookup_submission_page=True
        self.assert_remote_fence()
        self.lookup_submission_page=False
        RELEASE.ledger_reconcile(self.path,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'aborted')

    def test_reconcile_all_generation_journals_and_retry_ids(self):
        self.prepared_106()
        with self.completion_failure('apply-app'):
            with self.assertRaises(OSError):RELEASE.apply_app(self.manifest,True)
        journals=list(self.directory.glob('apply-app-g*-ssm.json'))
        self.assertEqual(len(journals),2)
        for journal in journals:
            cid=manifest.read(journal)['commandId']
            self.command_status[cid]='InProgress'
            self.assert_remote_fence()
            self.command_status[cid]='Success'
        state=manifest.read(journals[0]);cid='ffffffff-1111-4111-8111-111111111111'
        self.commands[cid]=state['comment']+'-prior'
        self.invocation_status[cid]=self.command_status[cid]='InProgress'
        TOOL.write(journals[0],dict(state,attempts=[cid]))
        self.assert_remote_fence()
        self.invocation_status[cid]=self.command_status[cid]='Failed'
        RELEASE.ledger_reconcile(self.path,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'completed')

    def test_secret_written_stale_app_reconcile_refuses_same_plan_resumes(self):
        self.prepared_106();RELEASE.apply_app(self.manifest,True)
        for rollback in (False,True):
            self.lost_put=True;stale=copy.deepcopy(self.running_deployment)
            with self.assertRaisesRegex(TimeoutError,'lost put'):RELEASE.promote(self.manifest,True,rollback=rollback)
            pending=RELEASE.load_ledger(self.ledger);puts=self.generation
            _,d=RELEASE.secret_deployment(self.envelope)
            self.assertEqual(RELEASE.ledger_tuple(d),pending['entries'][-1]['expected']['tuple'])
            self.assertEqual(self.running_sha,pending['entries'][-1]['expected']['appGitSha'])
            self.assertNotEqual(self.running_deployment,app_ops.public_deployment(d))
            with self.assertRaisesRegex(ValueError,'secret written; app not yet adopted — resume the same operation'):
                RELEASE.ledger_reconcile(self.path,True)
            self.assertEqual(RELEASE.load_ledger(self.ledger),pending);self.assertEqual(self.running_deployment,stale)
            RELEASE.promote(self.manifest,True,rollback=rollback)
            entries=RELEASE.load_ledger(self.ledger)['entries']
            self.assertEqual(entries[:-1],pending['entries']);self.assertEqual(entries[-1]['state'],'completed')
            self.assertEqual(self.generation,puts);self.assertEqual(self.running_deployment,app_ops.public_deployment(d))

    def test_normal_promotion_and_rollback_require_running_deployment(self):
        self.prepared_106();RELEASE.apply_app(self.manifest,True)
        for rollback in (False,True):
            self.stale_install=True
            with self.assertRaisesRegex(ValueError,'SSM operation failed'):RELEASE.promote(self.manifest,True,rollback=rollback)
            self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'pending')
            cid=next(reversed(self.commands))
            self.assertEqual(self.command_results[cid]['Status'],'Failed')
            self.stale_install=False
            RELEASE.promote(self.manifest,True,rollback=rollback)
            self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'completed')

    def test_local_running_deployment_receipt_guard(self):
        plan=RELEASE.load_plan(self.path)
        receipt={'gitSha':plan['rollout']['app']['gitSha'],'killSwitch':'1',
                 'deployment':dict(self.running_deployment,amiId='ami-'+'9'*17)}
        with patch.object(ssm,'run',return_value=receipt):
            for install in (False,True):
                with self.assertRaisesRegex(ValueError,'running app deployment mismatch'):
                    RELEASE.app_operation(self.path,plan,'promote-app',True,self.running_deployment,install=install)

    def test_exact_p1_delayed_106_reconcile_then_105_rollback_refuses(self):
        _,cid=self.delayed_106_install()
        self.assert_remote_fence()
        with patch.object(RELEASE,'source_readbacks'):
            self.assert_no_mutation(lambda:RELEASE.promote(self.old_manifest,True,rollback=True),'pending operation of another plan')
        self.assertEqual(self.running_sha,self.old_plan['rollout']['app']['gitSha'])
        self.invocation_status[cid]=self.command_status[cid]='Success'
        self.aws('ssm','get-command-invocation','--command-id',cid,'--instance-id',ssm.HOST)
        RELEASE.ledger_reconcile(self.path,True)
        with patch.object(RELEASE,'source_readbacks'):
            self.assert_no_mutation(lambda:RELEASE.promote(self.old_manifest,True,rollback=True),'stale plan')
        self.assertEqual(self.running_sha,'6'*40)

    def test_reconcile_neither_state_refuses_nonsecret_diff_and_retry_drift(self):
        self.prepared_106();self.crash_before_install()
        pending=self.ledger.read_bytes();self.running_sha='9'*40
        with patch('sys.stdout',new_callable=io.StringIO) as output:
            with self.assertRaisesRegex(ValueError,'manual reconciliation required'):RELEASE.ledger_reconcile(self.path,True)
        diff=json.loads(output.getvalue())
        self.assertEqual(diff['expected']['gitSha']['live'],'9'*40)
        self.assertNotIn('synthetic',output.getvalue());self.assertEqual(self.ledger.read_bytes(),pending)
        with self.assertRaisesRegex(ValueError,'ledger drift'):RELEASE.apply_app(self.manifest,True)
        self.assertEqual(self.ledger.read_bytes(),pending)
        # VersionId changes alone are allowed; a registry edit still differs from both snapshots.
        self.running_sha='279b2443'+'5'*32;self.envelope['VersionId']='external'
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]['releases'].reverse()
        self.envelope['SecretString']=json.dumps(outer)
        with self.assertRaisesRegex(ValueError,'manual reconciliation required'):RELEASE.ledger_reconcile(self.path,True)
        self.assertEqual(self.ledger.read_bytes(),pending)
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]['amiId']='ami-'+'9'*17
        self.envelope['SecretString']=json.dumps(outer)
        with patch('sys.stdout',new_callable=io.StringIO) as output:
            with self.assertRaisesRegex(ValueError,'manual reconciliation required'):RELEASE.ledger_reconcile(self.path,True)
        self.assertIn('amiId',json.loads(output.getvalue())['expected']['tupleKeys'])
        self.assertEqual(self.ledger.read_bytes(),pending)

    def test_apply_retry_after_promote_and_rollback_uses_distinct_journals(self):
        self.prepared_106();RELEASE.apply_app(self.manifest,True)
        first=next(p for p in self.directory.glob('apply-app-g*-ssm.json') if '-verify-' not in p.name);original=first.read_bytes()
        RELEASE.promote(self.manifest,True);RELEASE.apply_app(self.manifest,True)
        self.assertEqual(len([p for p in self.directory.glob('apply-app-g*-ssm.json') if '-verify-' not in p.name]),2)
        RELEASE.promote(self.manifest,True,rollback=True);RELEASE.apply_app(self.manifest,True)
        journals=[p for p in self.directory.glob('apply-app-g*-ssm.json') if '-verify-' not in p.name]
        self.assertEqual(len(journals),3);self.assertEqual(first.read_bytes(),original)
        self.assertEqual(len({manifest.read(p)['commandId'] for p in journals}),3)

    def test_pending_expected_guard_and_readback_guards(self):
        self.prepared_106();self.crash_before_install()
        original=RELEASE.load_ledger(self.ledger);bad=copy.deepcopy(original)
        bad['entries'][-1]['expected']['appGitSha']='8'*40;TOOL.write(self.ledger,bad)
        with self.assertRaisesRegex(ValueError,'expected state changed'):RELEASE.apply_app(self.manifest,True)
        TOOL.write(self.ledger,original)
        with patch.object(RELEASE,'app_operation',return_value=None):
            with self.assertRaisesRegex(ValueError,'ledger app readback missing'):RELEASE.ledger_reconcile(self.path,True)
        def drift(*args,**kwargs):
            self.envelope['VersionId']='changed-during-read';return {'gitSha':self.running_sha}
        with patch.object(RELEASE,'app_operation',side_effect=drift):
            with self.assertRaisesRegex(ValueError,'inputs changed during readback'):RELEASE.ledger_reconcile(self.path,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger),original)

    def test_reconcile_requires_pending_and_matching_promotion_journal(self):
        self.prepared_106()
        self.assert_no_mutation(lambda:RELEASE.ledger_reconcile(self.path,True),'requires this plan pending entry')
        RELEASE.apply_app(self.manifest,True)
        with self.completion_failure('promote-canary'):
            with self.assertRaises(OSError):RELEASE.promote(self.manifest,True)
        journal=self.directory/'rebase-promotion.json';data=manifest.read(journal);data['planSha256']='0'*64;TOOL.write(journal,data)
        before=self.ledger.read_bytes()
        with self.assertRaisesRegex(ValueError,'journal belongs to another plan'):RELEASE.ledger_reconcile(self.path,True)
        self.assertEqual(self.ledger.read_bytes(),before)

    def test_new_ledger_schema_guards(self):
        self.prepared_106();self.crash_before_install();original=RELEASE.load_ledger(self.ledger)
        cases=[]
        def changed(field,value,message):
            data=copy.deepcopy(original);data['entries'][-1][field]=value;cases.append((data,message))
        invalid_state=RELEASE.ledger_entry(self.path,'apply-app',self.envelope,self.source,self.running_sha,2)
        invalid_state['state']='other'
        cases.append((dict(original,entries=[original['entries'][0],invalid_state]),'invalid ledger state'))
        changed('before',{},'invalid pending snapshots')
        for field in ('planSha256','operation','state'):
            terminal=RELEASE.ledger_entry(self.path,'apply-app',self.envelope,self.source,self.running_sha,3)
            terminal[field]={'planSha256':'0'*64,'operation':'rollback','state':'pending'}[field]
            if field=='state':terminal=dict(original['entries'][-1],generation=3)
            cases.append((dict(original,entries=original['entries']+[terminal]),'unresolved pending ledger entry'))
        terminal=RELEASE.ledger_entry(self.path,'apply-app',self.envelope,self.source,self.running_sha,2)
        cases.append((dict(original,entries=[original['entries'][0],terminal]),'terminal ledger entry requires pending'))
        for data,message in cases:
            TOOL.write(self.ledger,data)
            with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):RELEASE.load_ledger(self.ledger)
        TOOL.write(self.ledger,original)

    def test_reconcile_cli_dry_run_and_apply(self):
        self.prepared_106();self.crash_before_install()
        TOOL.write(self.root/'secret.json',self.envelope)
        TOOL.write(self.root/'schema-readback.json',{'gitSha':self.running_sha,'killSwitch':'1','deployment':self.running_deployment})
        before=self.ledger.read_bytes()
        result=self.cli('ledger-reconcile','--plan',str(self.path))
        self.assertIn('would append aborted',result.stdout);self.assertEqual(self.ledger.read_bytes(),before)
        result=self.cli('ledger-reconcile','--plan',str(self.path),'--apply')
        self.assertIn('Ledger reconciled: aborted',result.stdout)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'aborted')

    def test_reconcile_cli_reports_remote_and_adoption_refusals(self):
        _,cid=self.delayed_106_install()
        TOOL.write(self.root/'secret.json',self.envelope)
        TOOL.write(self.root/'schema-readback.json',{'gitSha':self.running_sha,'killSwitch':'1','deployment':self.running_deployment})
        TOOL.write(self.root/'scenario.json',{'rebase_ssm_status':'InProgress'})
        before=self.ledger.read_bytes()
        result=self.cli('ledger-reconcile','--plan',str(self.path),'--apply',expected=1)
        self.assertIn('remote command not terminal; wait or cancel',result.stderr)
        self.assertEqual(self.ledger.read_bytes(),before)
        TOOL.write(self.root/'scenario.json',{})
        self.invocation_status[cid]=self.command_status[cid]='Failed'
        RELEASE.ledger_reconcile(self.path,True);RELEASE.apply_app(self.manifest,True)
        self.lost_put=True
        with self.assertRaises(TimeoutError):RELEASE.promote(self.manifest,True)
        TOOL.write(self.root/'secret.json',self.envelope)
        TOOL.write(self.root/'schema-readback.json',{'gitSha':self.running_sha,'killSwitch':'1','deployment':self.running_deployment})
        before=self.ledger.read_bytes()
        result=self.cli('ledger-reconcile','--plan',str(self.path),'--apply',expected=1)
        self.assertIn('secret written; app not yet adopted — resume the same operation',result.stderr)
        self.assertEqual(self.ledger.read_bytes(),before)

    def test_pending_write_failure_prevents_install_and_secret_put(self):
        self.prepared_106()
        real=RELEASE.json_tool.write
        def fail(path,value,**kwargs):
            if Path(path)==self.ledger and value['entries'][-1].get('state')=='pending':raise OSError('pending write failed')
            return real(path,value,**kwargs)
        for operation in ('apply-app','promote-canary','rollback'):
            if operation=='promote-canary':RELEASE.apply_app(self.manifest,True)
            if operation=='rollback':RELEASE.promote(self.manifest,True)
            before=self.ledger.read_bytes();secret=copy.deepcopy(self.envelope);running=self.running_sha
            with patch.object(RELEASE.json_tool,'write',side_effect=fail):
                with self.assertRaisesRegex(OSError,'pending write failed'):
                    if operation=='apply-app':RELEASE.apply_app(self.manifest,True)
                    else:RELEASE.promote(self.manifest,True,rollback=operation=='rollback')
            self.assertEqual(self.ledger.read_bytes(),before);self.assertEqual(self.envelope,secret);self.assertEqual(self.running_sha,running)

    def test_reconcile_cli_requires_plan(self):
        self.cli('ledger-reconcile',expected=1)
        with patch.object(sys,'argv',['release','ledger-reconcile']),patch.object(RELEASE,'ledger_reconcile') as reconcile:
            with self.assertRaisesRegex(ValueError,'ledger-reconcile requires --plan'):RELEASE.main()
            reconcile.assert_not_called()

    def test_new_plan_never_imports_unsuffixed_transport(self):
        self.prepared_106();RELEASE.apply_app(self.manifest,True)
        prior=next(p for p in self.directory.glob('apply-app-g*-ssm.json') if '-verify-' not in p.name)
        legacy=self.directory/'apply-app-ssm.json';data=manifest.read(prior)
        TOOL.write(legacy,dict(data,operation='apply-app'));original=legacy.read_bytes()
        RELEASE.apply_app(self.manifest,True)
        journal=self.directory/'apply-app-g4-ssm.json'
        self.assertNotEqual(manifest.read(journal)['commandId'],data['commandId'])
        self.assertEqual(legacy.read_bytes(),original)

    def test_completed_state_running_sha_drift_refuses_every_app_operation(self):
        self.prepared_106();RELEASE.apply_app(self.manifest,True);RELEASE.promote(self.manifest,True)
        self.running_sha='9'*40;before=self.ledger.read_bytes();secret=copy.deepcopy(self.envelope)
        for operation in ('apply-app','promote-canary','rollback'):
            for apply in (False,True):
                with self.subTest(operation=operation,apply=apply),self.assertRaisesRegex(ValueError,'ledger drift'):
                    if operation=='apply-app':RELEASE.apply_app(self.manifest,apply)
                    else:RELEASE.promote(self.manifest,apply,rollback=operation=='rollback')
                self.assertEqual(self.ledger.read_bytes(),before);self.assertEqual(self.envelope,secret)
                self.assertEqual(self.running_sha,'9'*40)

    def test_non_ami_launch_template_difference_refuses(self):
        RELEASE.apply_schema(self.path,True);RELEASE.apply_cloud(self.path,'apply-identity',True)
        self.lt_override={'InstanceType':'p5.48xlarge'}
        with self.assertRaisesRegex(ValueError,'launch data changed outside AMI'):RELEASE.apply_cloud(self.path,'apply-workflows',True)
        self.assertFalse((self.directory/'apply-workflows-receipt.json').exists())

    def test_ssm_installed_sha_must_match_plan(self):
        self.prepared_106();self.bad_install=True
        with self.assertRaisesRegex(ValueError,'SSM operation failed'):RELEASE.apply_app(self.manifest,True)
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][-1]['state'],'pending')
        self.assertFalse((self.directory/'apply-app-receipt.json').exists())
        # Also exercise the independent local receipt guard against forged remote output.
        with patch.object(ssm,'run',return_value={'gitSha':'9'*40,'killSwitch':'1','deployment':self.running_deployment}):
            with self.assertRaisesRegex(ValueError,'installed app commit mismatch'):
                RELEASE.app_operation(self.path,RELEASE.load_plan(self.path),'apply-app',True)

    def test_schema_path_pin_is_not_relaxed(self):
        plan=manifest.read(self.path);plan['schemaPath']='/tmp/another-checkout/schema.sql';TOOL.write(self.path,plan)
        with self.assertRaisesRegex(ValueError,'unreviewed schema path'):RELEASE.load_plan(self.path)

    def test_ledger_init_dry_run_exists_tuple_and_journal_status_guards(self):
        self.promoted_105(legacy=True)
        self.assert_no_mutation(lambda:RELEASE.ledger_init(self.manifest,True),'already exists')
        self.ledger.unlink()
        RELEASE.ledger_init(self.manifest,False);self.assertFalse(self.ledger.exists())
        original=copy.deepcopy(self.envelope);outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY][TOOL.REGION]['amiId']=self.source['amiId'];self.envelope['SecretString']=json.dumps(outer)
        with self.assertRaisesRegex(ValueError,'live tuple mismatch'):RELEASE.ledger_init(self.manifest,True)
        self.assertFalse(self.ledger.exists());self.envelope=original
        journal_path=self.directory/'rebase-promotion.json';journal=manifest.read(journal_path);journal['status']='rolled-back';TOOL.write(journal_path,journal)
        with self.assertRaisesRegex(ValueError,'promoted journal'):RELEASE.ledger_init(self.manifest,True)
        journal['status']='promoted';TOOL.write(journal_path,journal)
        good=copy.deepcopy(journal);journal['after']['amiId']='ami-'+'9'*17;TOOL.write(journal_path,journal)
        with self.assertRaisesRegex(ValueError,'journal target mismatch'):RELEASE.ledger_init(self.manifest,True)
        TOOL.write(journal_path,good)
        with patch.object(RELEASE,'app_operation',side_effect=lambda *args,**kwargs:self.envelope.update(VersionId='drift')):
            with self.assertRaisesRegex(ValueError,'inputs changed during readback'):RELEASE.ledger_init(self.manifest,True)
        self.envelope=original
        RELEASE.ledger_init(self.manifest,True)
        latest=RELEASE.load_ledger(self.ledger)['entries'][-1]
        self.assertEqual(latest['generation'],1);self.assertEqual(latest['planSha256'],RELEASE.digest(self.path));self.assertEqual(latest['secretVersionId'],self.envelope['VersionId'])

    def test_ledger_init_real_cli_override_dry_run_and_running_app_readback(self):
        self.promoted_105(legacy=True);self.ledger.unlink()
        TOOL.write(self.root/'secret.json',self.envelope)
        self.cli('ledger-init','--manifest',str(self.manifest))
        self.assertFalse(self.ledger.exists())
        d=manifest.loads(self.envelope['SecretString'])[TOOL.KEY][TOOL.REGION]
        # The synthetic gate result intentionally differs from the old apply-app receipt.
        TOOL.write(self.root/'schema-readback.json',{'gitSha':'7'*40,'killSwitch':'1','deployment':app_ops.public_deployment(d)})
        self.cli('ledger-init','--manifest',str(self.manifest),'--apply')
        self.assertEqual(RELEASE.load_ledger(self.ledger)['entries'][0]['appGitSha'],'7'*40)
        self.cli('ledger-init','--manifest',str(self.manifest),'--apply',expected=1)

    def test_maintenance_promotion_and_invalid_target_lineage_still_refuse(self):
        self.through_app()
        with patch.object(RELEASE,'load_plan',return_value=dict(RELEASE.load_plan(self.path),maintenance=True)):
            self.assert_no_mutation(lambda:RELEASE.promote(self.manifest,True),'maintenance releases')
        for changes in ({'previousLowerImageDigest':None,'previousLowerImageRef':None},
                        {'previousLowerImageDigest':self.value['lowerImageDigest'],'previousLowerImageRef':self.value['lowerImageRef']}):
            with self.assertRaises(ValueError):manifest.validate(dict(self.value,**changes),target=True)
        with self.assertRaisesRegex(ValueError,'maintenance previous must be null'):
            RELEASE.lineage(self.value,self.source,True)
        bake=dict(self.value,previousLowerImageDigest=None,previousLowerImageRef=None)
        with self.assertRaisesRegex(ValueError,'maintenance source lower/new agent mismatch'):
            RELEASE.lineage(bake,self.source,True)


class MaintenanceBakeTests(unittest.TestCase):
    def run_bake(self, mismatch=False, same_agent=False, containerd=False):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'case'
            subprocess.run([sys.executable,str(HERE/'fixture.py'),str(root),json.dumps({'image_index_ok':containerd})],check=True)
            source=release_record();source.update(amiId='ami-'+'1'*17,lowerImageDigest='sha256:'+('a' if mismatch else 'e' if containerd else 'b')*64,
                                               previousLowerImageDigest=None,previousLowerImageRef=None,agentCommit=('a' if same_agent else 'e')*40)
            source_path=root/'source-release.json';TOOL.write(source_path,source)
            TOOL.write(root/'secret.json',{'VersionId':'initial','SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:source}})})
            env=dict(os.environ,PATH=str(root/'bin')+':'+os.environ['PATH'])
            result=subprocess.run(['bash',str(root/'checkout/deploy/aws/mum/rebuild-ami.sh'),'--desktop-image','desktop:test','--source-sha','aaaaaaaa',
                                   '--recipe-version','1.0.2','--config',str(root/'ami-config.json'),'--release-dir',str(root/'release'),
                                   '--maintenance-release',str(source_path),'--deployed-release',str(source_path),'--apply'],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,1 if mismatch or same_agent else 0,result.stdout+result.stderr)
            calls=[json.loads(line) for line in (root/'calls.jsonl').read_text().splitlines()]
            if mismatch or same_agent:
                self.assertFalse(any('execute-change-set' in call for call in calls))
                if same_agent:self.assertFalse(any('push' in call for call in calls))
            else:
                bake=manifest.read(root/'release/bake-inputs.json')
                self.assertEqual(bake['lowerImageDigest'],source['lowerImageDigest']);self.assertIsNone(bake['previousLowerImageDigest']);self.assertIsNone(bake['previousLowerImageRef'])
                self.assertEqual(bake['agentCommit'],'a'*40)
                self.assertEqual(manifest.read(root/'release/maintenance-source-release.json'),source)
                params={v['ParameterKey']:v for v in manifest.read(root/'release/ami-parameters.json')}
                self.assertEqual(params['PreviousDesktopImageDigest']['ParameterValue'],'');self.assertEqual(params['PreviousDesktopImageId']['ParameterValue'],'')

    def test_maintenance_keeps_same_classic_lower_with_new_agent(self):self.run_bake()
    def test_maintenance_keeps_resolved_containerd_child_lower(self):self.run_bake(containerd=True)
    def test_maintenance_refuses_different_lower_before_ami_mutation(self):self.run_bake(mismatch=True)
    def test_maintenance_refuses_same_agent_before_push(self):self.run_bake(same_agent=True)


class AppPayloadTests(unittest.TestCase):
    def test_remote_deployment_guard_executes_for_install_and_gate(self):
        installer=(HERE.parents[3]/'deploy/aws/os-staging/install-host.sh').read_text()
        app={'tag':'reviewed-v1','gitSha':'e'*40,'checksumSha256':'f'*64}
        expected=app_ops.public_deployment(release_record())
        for install in (False,True):
            payload=app_ops.body(installer,app,expected,install)
            for stale in (False,True):
                deployment=dict(expected,amiId='ami-'+'9'*17) if stale else expected
                environment={'EZIL_GIT_SHA':app['gitSha'],'EZIL_AWS_KILL_SWITCH':'1',
                             'EZIL_AWS_LIFECYCLE_DEPLOYMENTS':json.dumps({TOOL.REGION:deployment})}
                result=execute_app_payload(payload,lambda _:None,lambda:environment)
                self.assertEqual(result['Status'],'Failed' if stale else 'Success')
                if stale:self.assertEqual(result['StandardOutputContent'],'')
                else:self.assertEqual(json.loads(result['StandardOutputContent'])['deployment'],expected)
            for broken in ({'EZIL_AWS_KILL_SWITCH':'0'},{'EZIL_AWS_LIFECYCLE_DEPLOYMENTS':'{}'}):
                environment.update(broken)
                self.assertEqual(execute_app_payload(payload,lambda _:None,lambda:environment)['Status'],'Failed')

    def test_installer_and_marker_hash_pinned_without_changing_existing_checks(self):
        installer=(HERE.parents[3]/'deploy/aws/os-staging/install-host.sh').read_text()
        app={'tag':'reviewed-v1','gitSha':'e'*40,'checksumSha256':'f'*64}
        body=app_ops.body(installer,app)
        script=body.split("<<'EZIL_APP_PY'\n",1)[1].rsplit('\nEZIL_APP_PY',1)[0]
        import ast
        constants={n.targets[0].id:ast.literal_eval(n.value) for n in ast.parse(script).body if isinstance(n,ast.Assign)}
        self.assertIn(app['checksumSha256'],constants['SCRIPT'])
        self.assertIn('sha256sum --check --status',constants['SCRIPT'])
        self.assertIn('Checksum mismatch',constants['SCRIPT']);self.assertIn('Invalid runtime bundle',constants['SCRIPT'])
        self.assertIn('EZIL_AWS_KILL_SWITCH',constants['NODE'])
        with self.assertRaises(ValueError):app_ops.body(installer,dict(app,tag='bad;command'))
        with self.assertRaises(ValueError):app_ops.body(installer.replace('python3 - "$temporary" "$tag"','drift'),app)

    def test_remote_installed_sha_guard_executes(self):
        installer=(HERE.parents[3]/'deploy/aws/os-staging/install-host.sh').read_text()
        app={'tag':'reviewed-v1','gitSha':'e'*40,'checksumSha256':'f'*64}
        body=app_ops.body(installer,app)
        script=body.split("<<'EZIL_APP_PY'\n",1)[1].rsplit('\nEZIL_APP_PY',1)[0]
        for sha in ('e'*40,'9'*40):
            def run(command,**kwargs):
                return subprocess.CompletedProcess(command,0,stdout=json.dumps({'gitSha':sha,'killSwitch':'1','deployment':{}}))
            with patch('subprocess.run',side_effect=run),patch('sys.stdout',new_callable=io.StringIO) as output,patch('sys.stderr',new_callable=io.StringIO):
                if sha==app['gitSha']:
                    exec(compile(script,'remote-app','exec'),{})
                    self.assertEqual(json.loads(output.getvalue())['gitSha'],sha)
                else:
                    with self.assertRaises(SystemExit):exec(compile(script,'remote-app','exec'),{})
                    self.assertEqual(output.getvalue(),'')

    def test_checksum_marker_guard_executes_and_refuses_mismatch(self):
        installer=(HERE.parents[3]/'deploy/aws/os-staging/install-host.sh').read_text()
        anchor='python3 - "$temporary" "$tag" <<\'PY\''
        # Execute the real archive verifier plus the generated marker guard;
        # substitute only host setup/downloads and the container readback.
        verifier=anchor+installer.split(anchor,1)[1].split('\nPY\n',1)[0]+'\nPY\n'
        installer='set -euo pipefail\ntag=$1\ntemporary=$PYREL_MARKER_DIR\n'+verifier
        real_run=subprocess.run
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary);tag='reviewed-v1';lines=[]
            for suffix in ('tar.gz','runtime.tar.gz'):
                name=tag+'.'+suffix;data=('synthetic '+suffix).encode()
                (directory/name).write_bytes(data)
                lines.append(hashlib.sha256(data).hexdigest()+'  '+name+'\n')
            marker=''.join(lines).encode();(directory/(tag+'.sha256')).write_bytes(marker)
            for mismatch in (False,True):
                with self.subTest(mismatch=mismatch):
                    app={'tag':tag,'gitSha':'e'*40,'checksumSha256':'0'*64 if mismatch else hashlib.sha256(marker).hexdigest()}
                    payload=app_ops.body(installer,app)
                    script=payload.split("<<'EZIL_APP_PY'\n",1)[1].rsplit('\nEZIL_APP_PY',1)[0]
                    shell_results=[];readbacks=[]
                    def run(command,**kwargs):
                        if command==['bash','-s']:
                            result=real_run(command,env=dict(os.environ,PYREL_MARKER_DIR=temporary),**kwargs)
                            shell_results.append(result.returncode)
                            return result
                        self.assertEqual(command[:2],['docker','compose'])
                        readbacks.append(command)
                        return subprocess.CompletedProcess(command,0,stdout=json.dumps({'gitSha':app['gitSha'],'killSwitch':'1','deployment':{}}))
                    with patch('subprocess.run',side_effect=run),patch('sys.stdout',new_callable=io.StringIO) as output,patch('sys.stderr',new_callable=io.StringIO) as error:
                        if mismatch:
                            with self.assertRaises(SystemExit) as refused:exec(compile(script,'remote-app','exec'),{})
                            self.assertEqual(refused.exception.code,1)
                            self.assertEqual(output.getvalue(),'')
                            self.assertIn('staging app operation refused',error.getvalue())
                        else:
                            exec(compile(script,'remote-app','exec'),{})
                            self.assertEqual(json.loads(output.getvalue())['gitSha'],app['gitSha'])
                    self.assertEqual(shell_results,[1 if mismatch else 0])
                    self.assertEqual(len(readbacks),0 if mismatch else 1)

    def test_legacy_source_manifest_does_not_relax_full_target_validation(self):
        source=release_record();source.update(preparationStateMachineVersionArn=None,recoveryStateMachineVersionArn=None,previousLowerImageDigest=None,previousLowerImageRef=None)
        manifest.validate(source,source=True)
        with self.assertRaises(ValueError):manifest.validate(source,target=True)


if __name__=='__main__': unittest.main(verbosity=2)
