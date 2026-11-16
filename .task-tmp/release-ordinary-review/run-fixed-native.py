import subprocess, pathlib, json, hashlib, os, uuid, time
b=pathlib.Path('/dev/shm/ezil-unified-20261026/os-credits');old=pathlib.Path('/dev/shm/ezil-osphase2-pgqa-4bdd87d398');tag=uuid.uuid4().hex[:10];q=pathlib.Path('/dev/shm/ezil-osphase2-fixed-pgqa-'+tag);q.mkdir();(q/'logs').mkdir();sock=q/'sock';data=q/'pgdata';sock.mkdir();data.mkdir();sock.chmod(0o777);data.chmod(0o777)
label='ordinary-oscredits-fixed-20261026';name='ezil-osphase2-fixed-'+tag;db='ezil_test_fixed_'+tag;image='sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';cid=None
manifest=json.loads((b/'.task-tmp/phase2-patch-manifest.json').read_text()); hashes={f:hashlib.sha256((b/f).read_bytes()).hexdigest() for f in manifest['final_file_sha256']}
pin=hashlib.sha256((b/'.task-tmp/o-credits-full-final.patch').read_bytes()).hexdigest();assert pin=='a6d5ed97fa3dfd2485d1fe534cccbef0d26bc369209908bd49282dc6fec837cf'
summary={'patch_sha256':pin,'source_hashes':hashes,'evidence_root':str(q),'container_removed':False,'network':'none','host_ports':[],'issues':[]}
def run(a,log,input=None,check=True,env=None,cwd=None):
 p=subprocess.run(a,input=input,text=True,capture_output=True,env=env,cwd=cwd,timeout=120);(q/'logs'/log).write_text(p.stdout+p.stderr)
 if check and p.returncode:raise RuntimeError(log+' exit '+str(p.returncode))
 return p
try:
 a=['docker','create','--pull=never','--name',name,'--label','ezil.qa.task='+label,'--label','ezil.qa.instance='+tag,'--network','none','--read-only','--log-driver','none','--pids-limit','128','--memory','512m','--cpus','1','--mount','type=bind,src='+str(data)+',dst=/var/lib/postgresql/data','--mount','type=bind,src='+str(sock)+',dst=/var/run/postgresql','--tmpfs','/tmp:rw,nosuid,nodev,size=128m','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB='+db,image,'postgres','-c','listen_addresses=','-c','unix_socket_directories=/var/run/postgresql','-c','shared_buffers=32MB','-c','max_connections=20']
 cid=run(a,'create.log').stdout.strip();run(['docker','start',cid],'start.log')
 deadline=time.monotonic()+45;success=0
 while time.monotonic()<deadline:
  p=run(['docker','exec',cid,'pg_isready','-U','postgres','-d',db],'ready.log',check=False)
  success=success+1 if p.returncode==0 else 0
  if success>=3:break
  time.sleep(1)
 else:raise RuntimeError('postgres readiness timeout')
 inspect=json.loads(run(['docker','inspect',cid],'inspect.json').stdout)[0];assert inspect['Config']['Labels']['ezil.qa.instance']==tag and inspect['HostConfig']['NetworkMode']=='none' and not inspect['HostConfig']['PortBindings']
 fixture=['migration-fixture-roles.sql','migration-auth-fixture.sql']+[p.name for p in sorted((old/'snapshots').glob('migration-0*.sql'))]
 for f in fixture:run(['docker','exec','-i',cid,'psql','-X','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],f+'.log',input=(old/'snapshots'/f).read_text())
 proof=run(['docker','exec',cid,'psql','-X','-U','postgres','-d',db,'-At','-c',"select json_build_object('db',current_database(),'addr',inet_server_addr(),'listen',current_setting('listen_addresses'),'version',version())"],'db-proof.log').stdout;pv=json.loads(proof);assert pv['db']==db and pv['addr'] is None and pv['listen']==''
 env={'PATH':os.environ['PATH'],'PGHOST':str(sock),'PGPORT':'5432','PGUSER':'postgres','BILLING_TEST_DATABASE_URL':'postgres:///'+db+'?ssl=false&connect_timeout=5','NODE_DISABLE_COMPILE_CACHE':'1','TMPDIR':str(q)}
 cfg={'root':str(b/'app'),'resolve':{'alias':{'@':str(b/'app/src')}},'test':{'environment':'node','include':['src/**/*.test.ts',str(b/'.task-tmp/release-ordinary-review/native-local-refund.test.ts'),str(b/'.task-tmp/release-ordinary-review/local-refund-current.test.ts')],'maxWorkers':1,'minWorkers':1,'cache':False}}
 (q/'vitest.config.mjs').write_text('export default '+json.dumps(cfg)+';')
 suites=['ai-credits.test.ts','ai-credit-outbox.test.ts','ai-credit-outbox.pg.test.ts','ai-gateway-client.test.ts','processor.test.ts','store.test.ts','http/stripe-webhook.test.ts','__contract__/catalog.contract.test.ts','stripe/client.test.ts'];node=['node','node_modules/vitest/vitest.mjs','run','--config',str(q/'vitest.config.mjs'),'--configLoader','runner','--no-cache','--reporter=default','--reporter=json','--outputFile='+str(q/'test-results.json')]
 p=run(node+['src/server/billing/'+s for s in suites]+[str(b/'.task-tmp/release-ordinary-review/native-local-refund.test.ts')],'tests.log',env=env,cwd=b/'app',check=False)
 summary['maintained_and_native_exit']=p.returncode
 if (q/'test-results.json').exists():
  j=json.loads((q/'test-results.json').read_text());summary['tests']={k:j[k] for k in ['numPassedTests','numFailedTests','numPendingTests','numTotalTests']}
 p2=run(['node','node_modules/vitest/vitest.mjs','run','--config',str(q/'vitest.config.mjs'),'--configLoader','runner','--no-cache','--reporter=dot',str(b/'.task-tmp/release-ordinary-review/local-refund-current.test.ts'),'-t','independent ordinary refund deduction once'],'reproductions.log',env=env,cwd=b/'app',check=False);summary['current_fixture_reproductions_exit']=p2.returncode
 summary['zero_audit_schema_check']=run(['docker','exec',cid,'psql','-X','-U','postgres','-d',db,'-At','-c',"select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.ezil_billing_grants'::regclass"],'grant-constraints.log').stdout
 summary['post_test_counts']=run(['docker','exec',cid,'psql','-X','-U','postgres','-d',db,'-At','-c',"select json_build_object('users',(select count(*) from auth.users),'outbox',(select count(*) from public.ezil_billing_outbox),'grants',(select count(*) from public.ezil_billing_grants))"],'post-test-counts.log').stdout.strip()
 summary['source_unchanged']=all(hashlib.sha256((b/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
 summary['result']='PASS' if p.returncode==0 and p2.returncode==0 and summary['source_unchanged'] else 'FAIL'
except Exception as e:summary['result']='ERROR';summary['issues'].append(str(e))
finally:
 if cid:
  current=json.loads(run(['docker','inspect',cid],'cleanup-inspect.json').stdout)[0];assert current['Config']['Labels']['ezil.qa.instance']==tag
  run(['docker','stop','-t','10',cid],'stop.log');run(['docker','rm',cid],'remove.log');absent=run(['docker','inspect',cid],'absence.log',check=False);summary['container_removed']=absent.returncode!=0
 (q/'qa-summary.json').write_text(json.dumps(summary,indent=2));(b/'.task-tmp/release-ordinary-review/latest-fixed-qa-path.txt').write_text(str(q)+'\n');print(json.dumps({k:v for k,v in summary.items() if k not in ['source_hashes','zero_audit_schema_check']},indent=2))
