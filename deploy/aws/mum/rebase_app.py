"""Pinned staging app installation using the established install-host.sh path."""
import hashlib
import json
import re
from pathlib import Path

import rebase_manifest as manifest
import rebase_namespace as context

need=manifest.need

# Read-only readback of the running app. The JSON is nonsecret.
NODE="""const e=process.env;if(e.EZIL_AWS_KILL_SWITCH!=='1')process.exit(1);const ds=JSON.parse(e.EZIL_AWS_LIFECYCLE_DEPLOYMENTS||'{}');const d=ds['ap-south-1'];if(!d)process.exit(1);const keys=['accountId','region','namespace','zoneId','subnetId','securityGroupId','instanceTypes','storage','dataKeyArn','amiId','launchTemplateId','launchTemplateVersion','stateMachineVersionArn','lowerImageDigest','previousLowerImageDigest','preparationStateMachineVersionArn','recoveryStateMachineVersionArn'];const deployment=Object.fromEntries(keys.filter(k=>k in d).map(k=>[k,d[k]]));if('releases' in d)deployment.releasesSha256=require('crypto').createHash('sha256').update(JSON.stringify(d.releases),'utf8').digest('hex');console.log(JSON.stringify({gitSha:e.EZIL_GIT_SHA,killSwitch:'1',deployment}));"""
# Must equal install-host.sh's jobs; the installer stops and re-enables all six.
JOBS=('telemetry-maintenance','sandbox-reap','billing-session-sweep','aws-stop-settle','pool-replenish','aws-reconcile')
PROBE=r"""
import json, subprocess, sys
def run(*command):
    return subprocess.run(list(command),cwd=APP_DIR,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
try:
    r=run('docker','compose','--env-file','compose.env','exec','-T','web','node','-e',NODE)
    if r.returncode: raise RuntimeError()
    result=json.loads(r.stdout)
    if result['killSwitch']!='1': raise RuntimeError()
    r=run('docker','container','inspect','ezil-os-staging-web-1','--format','{{.Image}}')
    if r.returncode: raise RuntimeError()
    result['imageId']=r.stdout.strip()
    r=run('docker','image','inspect','ezil-os-staging:'+TAG,'--format','{{.Id}}')
    result['tagImageId']=r.stdout.strip() if r.returncode==0 else None
    r=run('cat','compose.env')
    result['composeTag']=r.stdout[len('OS_STAGING_TAG='):-1] if r.returncode==0 and r.stdout.startswith('OS_STAGING_TAG=') and r.stdout.count('\n')==1 and r.stdout.endswith('\n') else None
    # The image a later Compose recreate or host restart would run: compose.env's tag as it resolves now.
    r=run('docker','image','inspect','ezil-os-staging:'+result['composeTag'],'--format','{{.Id}}') if result['composeTag'] else None
    result['composeImageId']=r.stdout.strip() if r is not None and r.returncode==0 else None
    # Served health through this host's Caddy, certificate verified; retries cover a just-recreated proxy.
    r=run('curl','-fsS','--connect-timeout','5','--max-time','10','--retry','5','--retry-delay','2','--retry-connrefused','--retry-max-time','40',
          '--resolve','os-staging.ezil.work:443:127.0.0.1','https://os-staging.ezil.work/api/health')
    try:
        health=json.loads(r.stdout) if r.returncode==0 else None
    except ValueError:
        health=None
    result['servedSha']=health['sha'] if isinstance(health,dict) and health.get('ok') is True and isinstance(health.get('sha'),str) else None
    result['timers']={job:{'enabled':run('systemctl','is-enabled','ezil-os-staging-'+job+'.timer').stdout.strip(),
                           'active':run('systemctl','is-active','ezil-os-staging-'+job+'.timer').stdout.strip(),
                           'service':run('systemctl','is-active','ezil-os-staging-'+job+'.service').stdout.strip()} for job in JOBS}
    # Evidence, not proof: no install-host.sh holds the host deploy lock at this instant.
    result['lockFree']=run('flock','-n','deploy.lock','true').returncode==0
    print(json.dumps(result,separators=(',',':')))
except Exception:
    print('staging app probe refused',file=sys.stderr);sys.exit(1)
"""


def gate(outer):
    need(outer.get('EZIL_AWS_KILL_SWITCH')=='1','admission must remain gated by the existing kill switch')


def body(install_script, app, deployment=None, install=True):
    need(manifest.matches(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',app['tag']) and manifest.matches(r'[0-9a-f]{40}',app['gitSha']) and manifest.matches(r'[0-9a-f]{64}',app['checksumSha256']),'invalid reviewed app artifact')
    anchor='python3 - "$temporary" "$tag" <<\'PY\''
    need(install_script.count(anchor)==1,'staging installer changed; review integration')
    # Keep all existing installer checks and additionally pin the checksum marker.
    guard='printf "%s  %s\\n" '+app['checksumSha256']+' "$temporary/$tag.sha256" | sha256sum --check --status\n'
    install_script=install_script.replace(anchor,guard+anchor)
    command='set -- '+app['tag']+' '+context.ARTIFACT_BUCKET+' '+context.ENVIRONMENT+'\n'+install_script
    # JSON.stringify(d.releases) matches public_deployment's compact UTF-8 JSON:
    # registry strings are ASCII, numbers are ints, nulls match, and both parsers preserve insertion order.
    program=r'''
import json, subprocess, sys
try:
    if INSTALL:
        r=subprocess.run(['bash','-s'],input=SCRIPT,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=840)
        if r.returncode: raise RuntimeError()
    r=subprocess.run(['docker','compose','--env-file','compose.env','exec','-T','web','node','-e',NODE],cwd=APP_DIR,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if r.returncode: raise RuntimeError()
    result=json.loads(r.stdout)
    if result['killSwitch']!='1': raise RuntimeError()
    if INSTALL and result['gitSha']!=APP['gitSha']: raise RuntimeError()
    if EXPECTED is not None and result['deployment']!=EXPECTED: raise RuntimeError()
    print(json.dumps(result,separators=(',',':')))
except Exception:
    print('staging app operation refused',file=sys.stderr);sys.exit(1)
'''
    constants={'INSTALL':install,'SCRIPT':command,'NODE':NODE,'APP':app,'EXPECTED':deployment,'APP_DIR':'/opt/'+context.SLUG}
    return "set -euo pipefail\nset +x\npython3 - <<'EZIL_APP_PY'\n"+'\n'.join(k+' = '+repr(v) for k,v in constants.items())+program+"\nEZIL_APP_PY\n"


def public_deployment(d):
    keys=('accountId','region','namespace','zoneId','subnetId','securityGroupId','instanceTypes','storage','dataKeyArn','amiId','launchTemplateId','launchTemplateVersion',
          'stateMachineVersionArn',*manifest.TUPLE)
    result={k:d[k] for k in keys if k in d}
    if 'releases' in d:
        releases=json.dumps(d['releases'],separators=(',',':'),ensure_ascii=False)
        result['releasesSha256']=hashlib.sha256(releases.encode('utf-8')).hexdigest()
    return result


def probe_body(tag):
    """Read-only host probe: app identity, web image ID, candidate tag owner, compose.env tag and its image, served health, timers and deploy lock."""
    need(context.NAMESPACE == 'mum', 'app-swap probe is staging-only')
    need(manifest.matches(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',tag),'invalid probe tag')
    constants={'NODE':NODE,'TAG':tag,'JOBS':JOBS,'APP_DIR':'/opt/'+context.SLUG}
    return "set -euo pipefail\nset +x\npython3 - <<'EZIL_APP_PY'\n"+'\n'.join(k+' = '+repr(v) for k,v in constants.items())+PROBE+"\nEZIL_APP_PY\n"
