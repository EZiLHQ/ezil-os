"""Pinned staging app installation using the established install-host.sh path."""
import hashlib
import json
import re
from pathlib import Path

import rebase_manifest as manifest

need=manifest.need


def gate(outer):
    need(outer.get('EZIL_AWS_KILL_SWITCH')=='1','admission must remain gated by the existing kill switch')


def body(install_script, app, deployment=None, install=True):
    need(manifest.matches(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',app['tag']) and manifest.matches(r'[0-9a-f]{40}',app['gitSha']) and manifest.matches(r'[0-9a-f]{64}',app['checksumSha256']),'invalid reviewed app artifact')
    anchor='python3 - "$temporary" "$tag" <<\'PY\''
    need(install_script.count(anchor)==1,'staging installer changed; review integration')
    # Keep all existing installer checks and additionally pin the checksum marker.
    guard='printf "%s  %s\\n" '+app['checksumSha256']+' "$temporary/$tag.sha256" | sha256sum --check --status\n'
    install_script=install_script.replace(anchor,guard+anchor)
    command='set -- '+app['tag']+' ezil-main-preview-artifacts-452630323510-aps1\n'+install_script
    # JSON.stringify(d.releases) matches public_deployment's compact UTF-8 JSON:
    # registry strings are ASCII, numbers are ints, nulls match, and both parsers preserve insertion order.
    node="""const e=process.env;if(e.EZIL_AWS_KILL_SWITCH!=='1')process.exit(1);const ds=JSON.parse(e.EZIL_AWS_LIFECYCLE_DEPLOYMENTS||'{}');const d=ds['ap-south-1'];if(!d)process.exit(1);const keys=['accountId','region','namespace','zoneId','subnetId','securityGroupId','instanceTypes','storage','dataKeyArn','amiId','launchTemplateId','launchTemplateVersion','stateMachineVersionArn','lowerImageDigest','previousLowerImageDigest','preparationStateMachineVersionArn','recoveryStateMachineVersionArn'];const deployment=Object.fromEntries(keys.filter(k=>k in d).map(k=>[k,d[k]]));if('releases' in d)deployment.releasesSha256=require('crypto').createHash('sha256').update(JSON.stringify(d.releases),'utf8').digest('hex');console.log(JSON.stringify({gitSha:e.EZIL_GIT_SHA,killSwitch:'1',deployment}));"""
    program=r'''
import json, subprocess, sys
try:
    if INSTALL:
        r=subprocess.run(['bash','-s'],input=SCRIPT,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=840)
        if r.returncode: raise RuntimeError()
    r=subprocess.run(['docker','compose','--env-file','compose.env','exec','-T','web','node','-e',NODE],cwd='/opt/ezil-os-staging',text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if r.returncode: raise RuntimeError()
    result=json.loads(r.stdout)
    if result['killSwitch']!='1': raise RuntimeError()
    if INSTALL and result['gitSha']!=APP['gitSha']: raise RuntimeError()
    if EXPECTED is not None and result['deployment']!=EXPECTED: raise RuntimeError()
    print(json.dumps(result,separators=(',',':')))
except Exception:
    print('staging app operation refused',file=sys.stderr);sys.exit(1)
'''
    constants={'INSTALL':install,'SCRIPT':command,'NODE':node,'APP':app,'EXPECTED':deployment}
    return "set -euo pipefail\nset +x\npython3 - <<'EZIL_APP_PY'\n"+'\n'.join(k+' = '+repr(v) for k,v in constants.items())+program+"\nEZIL_APP_PY\n"


def public_deployment(d):
    keys=('accountId','region','namespace','zoneId','subnetId','securityGroupId','instanceTypes','storage','dataKeyArn','amiId','launchTemplateId','launchTemplateVersion',
          'stateMachineVersionArn',*manifest.TUPLE)
    result={k:d[k] for k in keys if k in d}
    if 'releases' in d:
        releases=json.dumps(d['releases'],separators=(',',':'),ensure_ascii=False)
        result['releasesSha256']=hashlib.sha256(releases.encode('utf-8')).hexdigest()
    return result
