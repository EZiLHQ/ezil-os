#!/usr/bin/env python3
"""Offline stage-2 cases. All AWS/DB responses and credentials are synthetic."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
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
        records=[dict(self.source, lowerImageDigest='sha256:'+str(n)*64, createdAt=f'2026-10-{n:02}T12:00:00.000Z') for n in range(1,9)]
        original=copy.deepcopy(records)
        envelope={'SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:dict(self.source,releases=records)}})}
        with self.assertRaises(ValueError): TOOL.edit_release_secret(envelope,self.old,self.new,[self.target])
        self.assertEqual(records,original)

    def test_registry_rejects_foreign_duplicate_or_ambiguous_target(self):
        for records in ([self.source,self.source], [dict(self.source,namespace='other')], [self.target,dict(self.target,createdAt='2026-10-23T12:00:00.000Z')]):
            envelope={'SecretString':json.dumps({TOOL.KEY:{TOOL.REGION:dict(self.source,releases=records)}})}
            with self.assertRaises(ValueError): TOOL.edit_release_secret(envelope,self.old,self.new,[self.target])

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
    def templates(self):
        deny={'Effect':'Deny','Action':['ec2:DeleteSnapshot'],'Resource':'*'}
        before={'Resources':{'Boundary':{'Type':'AWS::IAM::ManagedPolicy','Properties':{'PolicyDocument':{'Statement':[deny,{'Effect':'Allow','Action':['ec2:DescribeInstances'],'Resource':'*'}]}}}}}
        after=copy.deepcopy(before)
        after['Resources']['Boundary']['Properties']['PolicyDocument']['Statement'][1]['Action'].append('ec2:DescribeSnapshots')
        review={'schemaVersion':1,'changes':{'Boundary':{'action':'Modify','properties':['PolicyDocument'],'attributes':[]}}}
        after['Resources']['ImageJobBoundary']={'Type':'AWS::IAM::ManagedPolicy','Properties':{'ManagedPolicyName':'ezil-mum-image-job-boundary','Path':'/ezil/mum/','PolicyDocument':{'Statement':[deny,{'Effect':'Allow','Action':['ec2:DescribeSnapshots'],'Resource':'*'}]}}}
        review['changes']['ImageJobBoundary']={'action':'Add','properties':[],'attributes':[]}
        return before,after,review

    def test_exact_boundary_review_retains_denies(self):
        a,b,r=self.templates();self.assertEqual(cfn.validate_templates('identity',a,b,r),r['changes'])
        b['Resources']['Boundary']['Properties']['PolicyDocument']['Statement'].pop(0)
        with self.assertRaises(ValueError):cfn.validate_templates('identity',a,b,r)

    def test_unreviewed_properties_network_storage_role_and_wildcards_refused(self):
        for mutation in ('resource','review','condition','wildcard','destructive','type'):
            a,b,r=self.templates()
            if mutation=='resource':b['Resources']['Bucket']={'Type':'AWS::S3::Bucket'}
            elif mutation=='review':r['changes']['Boundary']['properties'].append('Description')
            elif mutation=='condition':b['Conditions']={'Outside':True}
            elif mutation=='type':b['Resources']['Boundary']['Type']='AWS::IAM::Role'
            else:b['Resources']['Boundary']['Properties']['PolicyDocument']['Statement'][1]['Action'].append('*' if mutation=='wildcard' else 'ec2:DeleteVolume')
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

    def test_new_boundary_must_copy_every_shared_global_deny(self):
        a,b,r=self.templates();stmts=b['Resources']['ImageJobBoundary']['Properties']['PolicyDocument']['Statement']
        removed=stmts.pop(0)
        # Removing a deny is a widening only when the boundary allows any of its actions; allow them.
        acts=removed.get('Action') or ['*'];acts=[acts] if isinstance(acts,str) else acts
        stmts.append({'Effect':'Allow','Action':acts,'Resource':'*'})
        with self.assertRaises(ValueError):cfn.validate_templates('identity',a,b,r)


class IntegrationTests(unittest.TestCase):
    cli=stage1.ReleaseTests.cli

    def setUp(self):
        stage1.ReleaseTests.setUp(self)
        self.source=manifest.read(self.directory/'previous-rebase-release.json')
        self.source.update(launchTemplateVersion='1',stateMachineVersionArn=TOOL.MACHINE+':1')
        TOOL.write(self.directory/'previous-rebase-release.json',self.source)
        checkout=self.root/'checkout'
        installer=checkout/'deploy/aws/os-staging/install-host.sh';installer.parent.mkdir(parents=True)
        installer.write_text((HERE.parents[3]/'deploy/aws/os-staging/install-host.sh').read_text())
        self.addCleanup(patch.stopall)
        patch.object(RELEASE,'REPO',checkout).start()
        patch.object(RELEASE.json_tool,'APP_SECRET_LOCK',str(self.root/'app-secret.lock')).start()
        patch('sys.stdout',new_callable=io.StringIO).start()
        self.specs={};self.templates={};self.cloud={};self.calls=[];self.payloads={};self.commands={}
        self.fail_app=False;self.lost_put=False;self.lost_execute=False;self.bad_change=False
        self.generation=0
        self.envelope={'VersionId':'initial','SecretString':json.dumps({'keep':'synthetic','EZIL_AWS_KILL_SWITCH':'1',TOOL.KEY:{TOOL.REGION:self.source,'other':{'keep':True}}})}
        self.outer_original=manifest.loads(self.envelope['SecretString'])
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
            source=op=='describe-images' and flag('--image-ids')==self.source['amiId'] or op=='describe-launch-template-versions' and flag('--versions')=='1'
            if op=='describe-images':return {'Images':[dict(self.evidence['image']['Images'][0],ImageId=self.source['amiId'] if source else self.value['amiId'])]}
            if op=='describe-launch-template-versions':return {'LaunchTemplateVersions':[dict(self.evidence['template']['LaunchTemplateVersions'][0],VersionNumber=1 if source else 2,LaunchTemplateData={'ImageId':self.source['amiId'] if source else self.value['amiId']})]}
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
                return {'Command':{'CommandId':cid}}
            if op=='get-command-invocation':
                comment=self.commands[flag('--command-id')]
                if self.fail_app and 'promote-app' in comment:return {'Status':'Failed','ResponseCode':1,'StandardOutputContent':'suppressed'}
                if '-apply-schema-' in comment:result=self.schema_receipt()
                else:
                    ds=manifest.loads(self.envelope['SecretString'])[TOOL.KEY]
                    if isinstance(ds,str):ds=manifest.loads(ds)
                    result=dict(gitSha=self.value['agentCommit'],killSwitch='1',deployment=app_ops.public_deployment(ds[TOOL.REGION]))
                return {'Status':'Success','ResponseCode':0,'StandardOutputContent':json.dumps(result)}
        if service=='cloudformation':
            phase=next(k for k,v in cfn.STACKS.items() if v==flag('--stack-name'));before,after,review=self.templates[phase];spec=self.specs[phase]
            if op=='describe-stacks':
                params=[{'ParameterKey':'HostAmiId','ParameterValue':self.value['amiId'] if self.cloud[phase] else self.source['amiId']}] if phase=='foundation' else []
                return {'Stacks':[{'StackStatus':'UPDATE_COMPLETE','RoleARN':spec['roleArn'],'Parameters':params}]}
            if op=='get-template':return {'TemplateBody':after if '--change-set-name' in args or self.cloud[phase] else before}
            if op=='describe-change-set':
                changes=[]
                for logical,r in review['changes'].items():
                    details=[{'Target':{'Attribute':'Properties','Name':p,'RequiresRecreation':'Never'},'ChangeSource':'DirectModification','Evaluation':'Static'} for p in r['properties']]
                    changes.append({'Type':'Resource','ResourceChange':{'LogicalResourceId':logical,'ResourceType':after['Resources'][logical]['Type'],'Action':r['action'],'Replacement':'False','Scope':['Properties'] if r['action']=='Modify' else [],'Details':details}})
                if self.bad_change:changes[0]['ResourceChange']['Replacement']='True'
                return {'ChangeSetId':spec['changeSetArn'],'StackName':spec['stackName'],'Status':'CREATE_COMPLETE','ExecutionStatus':'EXECUTE_COMPLETE' if self.cloud[phase] else 'AVAILABLE','Changes':changes,'Parameters':[{'ParameterKey':'HostAmiId','ParameterValue':self.value['amiId']}] if phase=='foundation' else []}
            if op=='execute-change-set':
                self.assertEqual(manifest.read(self.directory/(phase+'-cloudformation.json'))['status'],'executing')
                self.cloud[phase]=True
                if self.lost_execute:self.lost_execute=False;raise TimeoutError('lost execute')
                return {}
        raise AssertionError(args)

    def through_app(self):
        RELEASE.apply_schema(self.path,True)
        RELEASE.apply_cloud(self.path,'apply-identity',True)
        RELEASE.apply_cloud(self.path,'apply-workflows',True)
        RELEASE.finalize(self.path,True)
        RELEASE.apply_app(self.manifest,True)

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
        RELEASE.promote(self.manifest,False);self.assertEqual(self.generation,0)
        RELEASE.promote(self.manifest,True);RELEASE.promote(self.manifest,True);self.assertEqual(self.generation,1)
        RELEASE.promote(self.manifest,True,rollback=True);self.assertEqual(self.generation,2)
        outer=manifest.loads(self.envelope['SecretString']);d=outer[TOOL.KEY][TOOL.REGION]
        self.assertEqual({k:d[k] for k in manifest.PROMOTION},{k:self.source[k] for k in manifest.PROMOTION})
        self.assertEqual(d['releases'],[self.source,manifest.read(self.manifest)])
        self.assertEqual(outer['keep'],'synthetic');self.assertEqual(outer[TOOL.KEY]['other'],{'keep':True});self.assertEqual(outer['EZIL_AWS_KILL_SWITCH'],'1')
        journal=manifest.read(self.directory/'rebase-promotion.json');self.assertEqual(journal['status'],'rolled-back')
        self.assertEqual(journal['afterDeployment']['amiId'],self.value['amiId']);self.assertEqual(journal['rollbackDeployment']['amiId'],self.source['amiId'])

    def test_lost_secret_write_reconciles_complete_tuple_without_second_put(self):
        self.through_app();self.lost_put=True
        with self.assertRaises(TimeoutError):RELEASE.promote(self.manifest,True)
        self.assertEqual(manifest.read(self.directory/'rebase-promotion.json')['status'],'promotion-pending')
        RELEASE.promote(self.manifest,True);self.assertEqual(self.generation,1)

    def test_failed_app_restart_retains_partial_promotion_and_gate(self):
        self.through_app();self.fail_app=True
        with self.assertRaises(ValueError):RELEASE.promote(self.manifest,True)
        self.assertEqual(manifest.read(self.directory/'rebase-promotion.json')['status'],'promotion-pending')
        self.assertEqual(manifest.loads(self.envelope['SecretString'])['EZIL_AWS_KILL_SWITCH'],'1')
        self.fail_app=False;RELEASE.promote(self.manifest,True);self.assertEqual(self.generation,1)

    def test_uncertain_cloud_execution_reconciles_readback_and_retains_id(self):
        RELEASE.apply_schema(self.path,True);self.lost_execute=True
        with self.assertRaises(TimeoutError):RELEASE.apply_cloud(self.path,'apply-identity',True)
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
        old={k:v for k,v in self.source.items() if k not in manifest.TUPLE}
        outer=manifest.loads(self.envelope['SecretString']);outer[TOOL.KEY]=json.dumps({TOOL.REGION:old,'other':{'keep':True}});self.envelope['SecretString']=json.dumps(outer)
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
                                   '--maintenance-release',str(source_path),'--apply'],env=env,capture_output=True,text=True)
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

    def test_legacy_source_manifest_does_not_relax_full_target_validation(self):
        source=release_record();source.update(preparationStateMachineVersionArn=None,recoveryStateMachineVersionArn=None,previousLowerImageDigest=None,previousLowerImageRef=None)
        manifest.validate(source,source=True)
        with self.assertRaises(ValueError):manifest.validate(source,target=True)


if __name__=='__main__': unittest.main(verbosity=2)
