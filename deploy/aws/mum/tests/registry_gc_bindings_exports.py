#!/usr/bin/env python3
"""Read-only full-analyze checks of authorized local exports; no network clients.
Usage: python3 registry_gc_bindings_exports.py EVIDENCE_DIR EVENTS_DIR RELEASE_DIR
Does not copy exports into the repository or print raw evidence.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import registry_gc as gc
import registry_gc_bindings as b

root, events, release = map(Path, sys.argv[1:])
read = lambda path: gc.manifest.loads(path.read_text())
records = read(root / 'registry-snapshot.json')
candidate = next(r for r in records if r['recipeVersion'] == '1.0.7')
db = read(root / 'db-evidence.json')
e = {k:candidate[k] for k in ('accountId','region','namespace')}
e['sources'] = {name:{'rows':[]} for name in gc.SOURCES}
for name,key in (('placements','placements'),('imageJobs','image_jobs')):
    e['sources'][name]['rows'] = db[key]
e['sources']['instances']['rows'] = [i for r in read(root/'ec2-instances.json')['Reservations'] for i in r['Instances']]
e['proof'] = {'cloudTrail':[read(p) for p in sorted(events.glob('*.json'))]}
assert len(e['proof']['cloudTrail']) == 6
raw = (release/'rebase-plan.json').read_text()
target = read(release/'rebase-release.json')
e['proof']['originalPlanJson'] = raw
e['planSha256'] = hashlib.sha256(raw.encode()).hexdigest()
e['sources']['releasePlans']['rows'] = [gc.manifest.loads(raw)]
original = copy.deepcopy(e)
for source,kind in (('placements','placement_image'),('imageJobs','image_job_releases'),('releasePlans','original_plan_target')):
    rows = [r for r in e['sources'][source]['rows'] if gc.references(r,candidate)]
    e['referenceBindings'] = [{'kind':kind,'source':source,'rowSha256':b.sha(r),'proofSha256':b.sha(e['proof'])} for r in rows]
    try:
        views = b.analyze(e,records,candidate,gc.references,target)
        assert len(views) == len(rows)
        print(source, len(views), 'PASS')
    except (ValueError,KeyError,TypeError) as error:
        print(source, 'REFUSED', str(error))
        raise
assert {k:v for k,v in e.items() if k != 'referenceBindings'} == original
print('original exports unchanged; six provider receipts; full analyze PASS')

e['proof']['ec2Definitions'] = {p.name:read(p) for p in root.glob('ec2-*.json')
                              if p.name not in ('ec2-instances.json','ec2-volumes.json','ec2-snapshots.json')}
row = next(r for r in read(root/'ec2-snapshots.json')['Snapshots']
           if r['SnapshotId'] == 'snap-046b0cf486287e1f0')
e['sources']['snapshots']['rows'] = [row]
e['referenceBindings'] = [{'kind':'historical_imagebuilder_root','source':'snapshots',
                          'rowSha256':b.sha(row),'proofSha256':b.sha(e['proof'])}]
try:
    b.analyze(e,records,candidate,gc.references,target)
except ValueError as error:
    assert str(error) == 'binding incomplete snapshot child coverage'
    print('archived root correctly REFUSED: incomplete snapshot child coverage')
else:
    raise AssertionError('snapshot must refuse without complete child coverage')
