"""TEST ONLY: serialize synthetic proof into the production fixed file roles."""
import json

def contents(proof):
    files = {'db-evidence.json':{'meta':proof.get('databaseMeta',{}),'usage':proof.get('usage',[])},
             'cloudtrail.json':{'Records':proof.get('cloudTrail',[])}}
    files.update(proof.get('ec2Definitions',{}))
    for i,(arn,pair) in enumerate(proof.get('executions',{}).items()):
        if 'describe' in pair:files[f'exec{i}/run.describe.json']=pair['describe']
        if 'history' in pair:files[f'exec{i}/run.history.json']=pair['history']
    return {name:json.dumps(value,sort_keys=True,separators=(',',':')) for name,value in files.items()}
