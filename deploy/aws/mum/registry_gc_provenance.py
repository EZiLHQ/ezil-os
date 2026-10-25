"""Trusted E1 collection receipts. Integrity checks do not authenticate an issuer.
E1 must emit receipts during collection under the maintained writer fence.
"""
from datetime import datetime
import hashlib
import json
from pathlib import PurePosixPath
import rebase_manifest as manifest
need = manifest.need


def sha(v):
    return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',', ':'),ensure_ascii=False).encode()).hexdigest()


def time(v):
    need(type(v) is str, 'E1 timestamp type')
    d = datetime.fromisoformat(v.replace('Z','+00:00'))
    need(d.tzinfo is not None, 'E1 timestamp timezone')
    return d


def validate(evidence, system_id, now):
    proof = evidence['proof']
    receipt = proof.get('collectionReceipts')
    need(isinstance(receipt,dict) and set(receipt) == {'schemaVersion','accountId','region','namespace',
         'planSha256','databaseSystemIdentifier','fenceActivatedAt','files','sources'}, 'E1 receipt manifest missing/schema')
    need(type(receipt['schemaVersion']) is int and receipt['schemaVersion'] == 1, 'E1 schema version')
    need(all(receipt[k] == evidence[k] for k in ('accountId','region','namespace','planSha256'))
         and type(system_id) is str and receipt['databaseSystemIdentifier'] == system_id,
         'E1 foreign scope/plan/database')
    need(receipt['fenceActivatedAt'] == proof['fenceActivatedAt'], 'E1 fence mismatch')
    raw = proof.get('originalPlanJson')
    need(type(raw) is str and hashlib.sha256(raw.encode()).hexdigest() == receipt['planSha256']
         and manifest.loads(raw).get('databaseSystemIdentifier') == system_id, 'E1 original plan/database pin')
    fence, capture = time(receipt['fenceActivatedAt']), time(evidence['capturedAt'])
    files = receipt['files']
    collection = evidence.get('collection', {})
    need(collection.get('receiptManifestSha256') == sha(receipt), 'E1 manifest hash mismatch')
    need(isinstance(files,dict) and files and set(files) == set(collection.get('filesSha256',{})), 'E1 file coverage')
    for path, r in files.items():
        need(type(path) is str and not PurePosixPath(path).is_absolute() and '..' not in PurePosixPath(path).parts,
             'E1 unsafe file path')
        need(isinstance(r,dict) and set(r) == {'sha256','capturedAt','complete','query'}, 'E1 file receipt schema')
        need(r['complete'] is True and type(r['query']) is str and r['query'].strip(), 'E1 incomplete/query')
        need(manifest.matches(r'[0-9a-f]{64}',r['sha256']) and r['sha256'] == collection['filesSha256'][path],
             'E1 file hash mismatch')
        at = time(r['capturedAt'])
        need(fence <= at <= now and abs((at-capture).total_seconds()) <= 300
             and (now-at).total_seconds() < 900, 'E1 stale/future/outside fence capture')
    need(isinstance(receipt['sources'],dict) and set(receipt['sources']) == set(evidence['sources']), 'E1 source coverage')
    used = set()
    for name, source in evidence['sources'].items():
        r = receipt['sources'][name]
        need(isinstance(r,dict) and set(r) == {'files','rowsSha256','query'}, 'E1 source receipt schema')
        need(isinstance(r['files'],list) and r['files'] and len(set(r['files'])) == len(r['files'])
             and set(r['files']) <= set(files), 'E1 source files missing/duplicate')
        used.update(r['files'])
        need(r['rowsSha256'] == source['rowsSha256'] == sha(source['rows'])
             and r['query'] == source['query'], 'E1 source hash/query mismatch')
    validate_proof_files(evidence)
    # Supplemental files (AMI/LT/history/provider receipts) may not produce rows,
    # but still require file receipts and are checked above.


def strict_retirement(document, output, work=None):
    """Required runtime fields before equality; bool is never an integer."""
    need(isinstance(document,dict) and isinstance(output,dict), 'GC retirement not confirmed: object')
    for obj, ints, strings in (
        (document, ('schemaVersion','targetGeneration','leaseEpoch','poolGeneration'),
         ('jobId','computerId','fenceToken','poolHostId','providerInstanceId')),
        (output, ('schemaVersion','generation','leaseEpoch','poolGeneration'),
         ('jobId','computerId','fenceToken','poolHostId','instanceId','digest','state'))):
        need(all(k in obj and type(obj[k]) is int and obj[k] >= 1 for k in ints)
             and all(k in obj and type(obj[k]) is str and bool(obj[k]) for k in strings)
             and obj['schemaVersion'] == 1, 'GC retirement not confirmed: required field/type')
    need('volumeId' in output and output['volumeId'] is None, 'GC retirement not confirmed: explicit null volume')
    need(manifest.matches(r'i-[a-f0-9]{17}',output['instanceId']), 'GC retirement not confirmed: instance type')

    # Invoke the same complete intent and receipt schemas used by the runtime.
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parents[3] / 'infra/app-computers'
    if work is None:
        raw = json.dumps(document, separators=(',', ':'))
        work = {'schemaVersion': 1, 'document': raw, 'digest': hashlib.sha256(raw.encode()).hexdigest()}
    try:
        result = subprocess.run(['node', '--import', 'tsx', 'validate-gc-retirement.ts'],
            cwd=root, input=json.dumps({'work': work, 'output': output}), text=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        need(result.returncode == 0, 'GC retirement not confirmed: full runtime contract')
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('GC retirement not confirmed: runtime validator unavailable')


def proof_targets(proof):
    targets = {}
    for key in ('usage', 'databaseMeta'):
        if key in proof: targets[json.dumps([key])] = proof[key]
    for index, value in enumerate(proof.get('cloudTrail', [])):
        targets[json.dumps(['cloudTrail', index])] = value
    for key, value in proof.get('ec2Definitions', {}).items():
        targets[json.dumps(['ec2Definitions', key])] = value
    for name, value in proof.get('executionObservations', {}).items():
        targets[json.dumps(['executionObservations',name])] = value
    for arn, pair in proof.get('executions', {}).items():
        for key, value in pair.items():
            targets[json.dumps(['executions', arn, key])] = value
    return targets


def select(value, selector):
    need(isinstance(selector, list), 'E1 selector type')
    for key in selector:
        if key == '$json': value = manifest.loads(value)
        elif isinstance(value, list) and type(key) is int: value = value[key]
        elif isinstance(value, dict) and type(key) is str: value = value[key]
        else: raise ValueError('E1 selector mismatch')
    return value


def reconstruct_proof(contents):
    """Fixed, whole-file roles. Never search for a supplied value in subtrees."""
    proof = {'cloudTrail': [], 'ec2Definitions': {}, 'executions': {}, 'executionObservations': {}}
    bindings = {}
    describes = {}
    ambiguous = set()
    histories = {}
    def put(path, value, file, selector):
        bindings[json.dumps(path)] = {'file':file, 'selector':selector}
    for name, raw in sorted(contents.items()):
        data = manifest.loads(raw)
        base = PurePosixPath(name).name
        if base == 'db-evidence.json':
            need('databaseMeta' not in proof, 'E1 duplicate database export')
            for dest, src in (('databaseMeta','meta'), ('usage','usage')):
                proof[dest] = data[src]; put([dest],data[src],name,[src])
        if base.startswith('ec2-') and base.endswith('.json') and base not in ('ec2-instances.json','ec2-volumes.json','ec2-snapshots.json'):
            need(base not in proof['ec2Definitions'], 'E1 duplicate EC2 definition')
            proof['ec2Definitions'][base] = data; put(['ec2Definitions',base],data,name,[])
        if base.endswith(('.describe.json','.history.json')) or base.startswith('sfn-'):
            proof['executionObservations'][name] = data
            put(['executionObservations',name],data,name,[])
        if base.endswith('.describe.json'):
            arn = data['executionArn']
            if arn in describes: ambiguous.add(arn)
            else: describes[arn] = (name,data)
        if base.endswith('.history.json'): histories[name] = data
        named = any(token in name.lower() for token in ('cloudtrail','termination','terminateinstances','runinstances','run-instances','events.json'))
        shaped = isinstance(data,dict) and ('eventName' in data or 'Events' in data or 'Records' in data or 'event' in data)
        if not (named or shaped): continue
        if isinstance(data,dict) and ('Events' in data or 'Records' in data):
            key = 'Events' if 'Events' in data else 'Records'; events = data[key]; prefix=[key]
        elif isinstance(data,list): events=data; prefix=[]
        else: events=[data]; prefix=None
        need(isinstance(events,list), 'E1 invalid CloudTrail envelope')
        for index,event in enumerate(events):
            selector = [] if prefix is None else [*prefix,index]
            if isinstance(event,dict) and 'event' in event:
                event=event['event']; selector+=['event']
            if isinstance(event,dict) and 'CloudTrailEvent' in event:
                event=manifest.loads(event['CloudTrailEvent']); selector+=['CloudTrailEvent','$json']
            need(isinstance(event,dict) and type(event.get('eventName')) is str, 'E1 invalid CloudTrail record')
            pos=len(proof['cloudTrail']); proof['cloudTrail'].append(event)
            put(['cloudTrail',pos],event,name,selector)
    for arn,(name,d) in describes.items():
        if arn in ambiguous: continue  # all observations retained, never last-write wins
        history=name[:-len('.describe.json')]+'.history.json'
        if history not in histories: continue
        proof['executions'][arn]={'describe':d,'history':histories[history]}
        put(['executions',arn,'describe'],d,name,[])
        put(['executions',arn,'history'],histories[history],history,[])
    return proof, bindings


def bind_proof_files(evidence, contents):
    expected, bindings = reconstruct_proof(contents)
    # This collector-owned audit field preserves every describe/history/list,
    # including duplicates that cannot be used as settled execution proof.
    evidence['proof']['executionObservations'] = expected['executionObservations']
    evidence['collection']['fileContents'] = contents
    evidence['collection']['proofFileBindings'] = bindings


def validate_proof_files(evidence):
    c = evidence['collection']; files = evidence['proof']['collectionReceipts']['files']
    contents, bindings = c.get('fileContents'), c.get('proofFileBindings')
    need(isinstance(contents,dict) and set(contents)==set(files), 'E1 consumed bytes coverage')
    parsed = {}
    for name, raw in contents.items():
        need(type(raw) is str and hashlib.sha256(raw.encode()).hexdigest()==files[name]['sha256'],
             'E1 consumed bytes mismatch')
        parsed[name] = manifest.loads(raw)
    expected, required_bindings = reconstruct_proof(contents)
    for name in ('cloudTrail','ec2Definitions','executions','executionObservations','databaseMeta','usage'):
        need(sha(evidence['proof'].get(name, {} if name not in ('cloudTrail','usage') else [])) ==
             sha(expected.get(name, {} if name not in ('cloudTrail','usage') else [])),
             'E1 complete supplemental proof mismatch: ' + name)
    need(bindings == required_bindings, 'E1 fixed extraction selector mismatch')
    targets = proof_targets(expected)
    need(isinstance(bindings,dict) and set(bindings)==set(targets), 'E1 supplemental binding coverage')
    for key, value in targets.items():
        b = bindings[key]
        need(isinstance(b,dict) and set(b)=={'file','selector'} and b['file'] in parsed,
             'E1 supplemental binding schema')
        try: selected = select(parsed[b['file']], b['selector'])
        except (KeyError,IndexError,TypeError): raise ValueError('E1 supplemental selector invalid')
        need(sha(selected)==sha(value), 'E1 supplemental proof substitution')
