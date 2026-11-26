#!/usr/bin/env python3
"""Pinned, read-only OS catalog/timer transport. No deployment or service operations.

emit MODE prints the self-contained host command for the DB/host owner.
run MODE OUTPUT reads the pinned existing host with its ordinary app DB identity.
The companion MJS is piped to node; neither file nor environment is written remotely.
"""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import zlib

TARGETS = {
    'production': ('i-0787618eac20b7e1c', '86a6e55dd33275098f62a829e4d9493184cbdd9a',
                   ['ezil-os-prod web', 'ezil-os-production web'], 'ezil-os-production-'),
    'staging': ('i-014810524754b9ed0', '308447f793384e100efc87ec35739304327a48dc',
                ['ezil-os-staging web'], 'ezil-os-staging-'),
}
JOBS = ['aws-reconcile', 'aws-stop-settle', 'billing-session-sweep', 'pool-replenish',
        'sandbox-reap', 'telemetry-maintenance']
DOCUMENT_HASH = '99749de5e62f71e5ebe9a55c2321e2c394796afe7208cff048696541e6f6771e'
AWS = ['aws', '--profile', 'ezil-admin', '--region', 'ap-south-1', '--no-cli-pager', '--output', 'json']

HOST = r'''
import base64, hashlib, json, pathlib, re, subprocess, sys, zlib
def run(*args, stdin=None, timeout=12):
    return subprocess.run(args, input=stdin, text=True, capture_output=True, check=True, timeout=timeout).stdout
try:
    containers=[]
    for cid in run('docker', 'ps', '-q').split():
        label=run('docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}', cid).strip()
        if label in services: containers.append(cid)
    if len(containers)!=1: raise RuntimeError('container_identity')
    info=json.loads(run('docker', 'inspect', containers[0]))[0]
    env=dict(v.split('=',1) for v in info['Config']['Env'] if '=' in v)
    if info['State']['Status']!='running' or env.get('EZIL_GIT_SHA')!=expected: raise RuntimeError('source_identity')
    result={'mode':mode, 'source':expected, 'preflight_sha256':hashlib.sha256(db_source.encode()).hexdigest(), 'timers':{}}
    for job in jobs:
        for kind in ['timer','service']:
            name=prefix+job+'.'+kind
            props=dict(v.split('=',1) for v in run('systemctl','show',name,'--property=ActiveState,UnitFileState,FragmentPath,DropInPaths').splitlines() if '=' in v)
            fragment=props.get('FragmentPath','')
            if fragment!='/etc/systemd/system/'+name: raise RuntimeError('unit_identity')
            result['timers'][name]={'active':props.get('ActiveState')=='active', 'enabled':props.get('UnitFileState')=='enabled', 'sha256':hashlib.sha256(pathlib.Path(fragment).read_bytes()).hexdigest(), 'dropins_present':bool(props.get('DropInPaths'))}
    answer=subprocess.run(['docker','exec','-i',containers[0],'node','--input-type=module','-',mode], input=db_source, text=True, capture_output=True, timeout=65)
    result['database']=json.loads(answer.stdout)
    result['database_exit_code']=answer.returncode
    encoded=base64.b64encode(zlib.compress(json.dumps(result,sort_keys=True).encode())).decode()
    if len(encoded)>22000: raise RuntimeError('receipt_size')
    print(json.dumps({'encoding':'zlib-base64','payload':encoded}))
except Exception as error:
    # Never emit subprocess output, connection strings, environment, or DB errors.
    print(json.dumps({'mode':mode,'source':expected,'status':'refused','failure_class':type(error).__name__}))
    sys.exit(1)
'''


def host_payload(mode):
    _, expected, services, prefix = TARGETS[mode]
    source = Path(__file__).with_suffix('.mjs').read_text()
    definitions = {'mode': mode, 'expected': expected, 'services': services,
                   'prefix': prefix, 'jobs': JOBS, 'db_source': source}
    return '\n'.join(f'{key}={value!r}' for key, value in definitions.items()) + '\n' + HOST


def aws(*args):
    result = subprocess.run([*AWS, *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('AWS read transport refused; use pinned operator preflight')
    return json.loads(result.stdout)


def main():
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ('emit', 'run') or sys.argv[2] not in TARGETS:
        raise SystemExit('Usage: parity-schema-preflight.py emit MODE | run MODE OUTPUT.json')
    action, mode = sys.argv[1:3]
    payload = host_payload(mode)
    commands = ['set -eu', "python3 -I -B - <<'EZIL_PARITY_READ_ONLY'", payload, 'EZIL_PARITY_READ_ONLY']
    if action == 'emit':
        print('\n'.join(commands))
        return
    if len(sys.argv) != 4:
        raise SystemExit('An output path is required')
    destination = Path(sys.argv[3])
    if destination.exists():
        raise SystemExit('Refusing to replace an existing receipt')
    if aws('sts', 'get-caller-identity')['Account'] != '452630323510':
        raise RuntimeError('AWS account mismatch')
    document = aws('ssm', 'describe-document', '--name', 'AWS-RunShellScript', '--document-version', '1')['Document']
    if document['Owner'] != 'Amazon' or document['Hash'] != DOCUMENT_HASH:
        raise RuntimeError('SSM document mismatch')
    instance = TARGETS[mode][0]
    command = aws('ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript',
                  '--document-version', '1', '--timeout-seconds', '100',
                  '--comment', 'Pinned OS read-only catalog ledger and timer hashes; no DDL or service actions',
                  '--parameters', json.dumps({'commands': commands}))['Command']['CommandId']
    print('SSM ' + command, flush=True)
    for _ in range(50):
        time.sleep(2)
        try:
            answer = aws('ssm', 'get-command-invocation', '--instance-id', instance, '--command-id', command)
        except RuntimeError:
            continue
        if answer['Status'] in ('Pending', 'InProgress', 'Delayed'):
            continue
        # Failure stdout is our sanitized contract; raw remote stderr is never copied.
        try:
            observation = json.loads(answer.get('StandardOutputContent', ''))
            if observation.get('encoding') == 'zlib-base64':
                observation = json.loads(zlib.decompress(base64.b64decode(observation['payload'])))
        except ValueError:
            observation = {'status': 'refused', 'failure_class': 'host_transport'}
        receipt = {'ssm': command, 'at': answer.get('ExecutionEndDateTime'), 'transport_status': answer['Status'],
                   'transport_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'observation': observation}
        destination.write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
        print(destination)
        if answer['Status'] != 'Success':
            raise SystemExit(2)
        return
    raise RuntimeError('Read-only SSM observation timed out; inspect this command ID before retry')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Local/AWS errors may contain credentials. Report class only.
        raise SystemExit('Read-only preflight refused (' + type(exc).__name__ + ')') from None
